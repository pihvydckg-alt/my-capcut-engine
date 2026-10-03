import http from 'http';
import https from 'https';
import dns from 'dns/promises';
import net from 'net';

const PORT = process.env.PORT || 3000;

const HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'Accept-Encoding': 'identity',
  Referer: 'https://www.capcut.com/',
};

const isCapcutHost = (h) => /(^|\.)capcut\.com$/i.test(h);
const clean = (s) => (typeof s === 'string' ? s.replace(/\\u002F/g, '/').replace(/\\\//g, '/') : s);
const isUrl = (s) => typeof s === 'string' && /^https?:\/\//i.test(clean(s));

function parseCapcutUrl(raw) {
  let u = String(raw || '').trim();
  if (!u) throw new Error('URL দিন।');
  if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
  let p;
  try { p = new URL(u); } catch { throw new Error('অবৈধ URL।'); }
  if (!isCapcutHost(p.hostname)) throw new Error('এটি CapCut লিংক নয়।');
  return p.href;
}

function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a >= 224;
  }
  const l = ip.toLowerCase();
  return l === '::1' || l === '::' || l.startsWith('fc') || l.startsWith('fd') || l.startsWith('fe80') || l.startsWith('::ffff:');
}

// পেজ ফেচ (রিডাইরেক্ট ফলো, প্রতিটি ধাপে CapCut হোস্ট চেক)
function fetchPage(url, left = 6) {
  return new Promise((resolve, reject) => {
    if (left <= 0) return reject(new Error('অনেক বেশি রিডাইরেক্ট।'));
    const client = url.startsWith('https:') ? https : http;
    const req = client.get(url, { headers: HEADERS }, (res) => {
      const code = res.statusCode;
      if ([301, 302, 303, 307, 308].includes(code) && res.headers.location) {
        res.resume();
        let next;
        try { next = new URL(res.headers.location, url); } catch { return reject(new Error('খারাপ রিডাইরেক্ট।')); }
        if (!isCapcutHost(next.hostname)) return reject(new Error('অন্য ডোমেইনে রিডাইরেক্ট ব্লক করা হয়েছে।'));
        return resolve(fetchPage(next.href, left - 1));
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: code, html: Buffer.concat(chunks).toString('utf8'), finalUrl: url }));
      res.on('error', reject);
    });
    req.setTimeout(20000, () => req.destroy(new Error('টাইমআউট: CapCut সাড়া দেয়নি।')));
    req.on('error', reject);
  });
}

function walk(node, fn, path = '', depth = 0) {
  if (depth > 25 || node === null || typeof node !== 'object') return;
  for (const [k, v] of Object.entries(node)) {
    const p = path ? `${path}.${k}` : k;
    fn(k, v, p, node);
    if (v && typeof v === 'object') walk(v, fn, p, depth + 1);
  }
}

function score(key, url, path) {
  const k = (key + path).toLowerCase();
  const u = url.toLowerCase();
  let s = 0;
  if (/\.mp4(\?|$)/.test(u) || u.includes('mime_type=video')) s += 5;
  if (/video|play|download|src/.test(key.toLowerCase())) s += 3;
  if (/nowatermark|no_watermark|origin|original|raw|clean/.test(k)) s += 6;
  if (/watermark|wm/.test(k) && !/no_?watermark|nowm/.test(k)) s -= 6;
  if (/audio|music|cover|thumb|image|avatar|icon|poster|\.jpe?g|\.png|\.webp|\.mp3|\.m4a/.test(k + u)) s -= 10;
  return s;
}

function parsePage(html) {
  const blobs = [];
  const nd = html.match(/<script[^>]+id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i);
  if (nd) { try { blobs.push(JSON.parse(nd[1])); } catch {} }
  const ld = [...html.matchAll(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)];
  for (const m of ld) { try { blobs.push(JSON.parse(m[1])); } catch {} }

  const og = (name) => {
    const a = html.match(new RegExp(`<meta[^>]+property=["']${name}["'][^>]+content=["']([^"']*)["']`, 'i'));
    const b = html.match(new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]+property=["']${name}["']`, 'i'));
    return (a && a[1]) || (b && b[1]) || null;
  };

  const cands = [];
  for (const b of blobs) {
    walk(b, (k, v, p, parent) => {
      if (!isUrl(v)) return;
      const url = clean(v);
      const sc = score(k, url, p);
      if (sc > 0) cands.push({ url, sc, path: p, width: Number(parent.width) || null, height: Number(parent.height) || null });
    });
  }
  const ogVideo = og('og:video') || og('og:video:url') || og('og:video:secure_url');
  if (ogVideo) cands.push({ url: clean(ogVideo), sc: 4, path: 'meta.og:video' });

  for (const m of html.matchAll(/"(?:play_url|playUrl|video_url|videoUrl|download_url|downloadUrl)"\s*:\s*"(https?:[^"]+)"/g)) {
    cands.push({ url: clean(m[1]), sc: 3, path: 'regex.html' });
  }

  const seen = new Set();
  const uniq = cands.filter((c) => (seen.has(c.url) ? false : seen.add(c.url))).sort((a, b) => b.sc - a.sc);

  let title = og('og:title'), thumb = og('og:image');
  for (const b of blobs) {
    walk(b, (k, v) => {
      const kl = k.toLowerCase();
      if (!title && typeof v === 'string' && v && (kl === 'title' || kl === 'template_title')) title = v;
      if (!thumb && isUrl(v) && (kl === 'cover_url' || kl === 'coverurl' || kl === 'cover')) thumb = clean(v);
    });
  }
  return { blobs, cands: uniq, title: title || 'CapCut Video', thumbnail: thumb || '' };
}

async function extractCapCut(raw) {
  const url = parseCapcutUrl(raw);
  const { status, html, finalUrl } = await fetchPage(url);
  if (status === 403 || status === 429) throw new Error(`CapCut এই সার্ভার ব্লক করেছে (HTTP ${status}).`);
  if (status === 404) throw new Error('লিংকটি এক্সপায়ার্ড বা পাওয়া যায়নি।');
  const p = parsePage(html);
  if (!p.cands.length) throw new Error('ভিডিও লিংক পাওয়া যায়নি। /api/debug?url=... দিয়ে চেক করুন।');
  const best = p.cands[0];
  return {
    title: p.title,
    thumbnail: p.thumbnail,
    videoUrl: best.url,
    width: best.width,
    height: best.height,
    matchedPath: best.path,
    otherCandidates: p.cands.slice(1, 4).map((c) => c.url),
    finalUrl,
    originalUrl: raw,
  };
}

// ডিবাগ: CapCut পেজে কী কী ভিডিও-সদৃশ লিংক আছে তা দেখায়
async function debugCapCut(raw) {
  const url = parseCapcutUrl(raw);
  const { status, html, finalUrl } = await fetchPage(url);
  const p = parsePage(html);
  const h = html.replace(/\\u002F/g, '/').replace(/\\\//g, '/');

  const pairs = [];
  const seen = new Set();
  for (const m of h.matchAll(/"([A-Za-z_0-9]+)"\s*:\s*"(https?:\/\/[^"]+)"/g)) {
    if (!/capcutcdn|\.mp4|video|play|origin|download|wm|watermark/i.test(m[1] + m[2])) continue;
    if (/\.(jpe?g|png|webp|gif|svg|css|js)(\?|$)/i.test(m[2])) continue;
    if (seen.has(m[2])) continue;
    seen.add(m[2]);
    pairs.push({ key: m[1], url: m[2].slice(0, 250) });
  }

  return {
    status,
    finalUrl,
    htmlLength: html.length,
    hasNextData: /__NEXT_DATA__/.test(html),
    jsonBlobs: p.blobs.length,
    topKeys: p.blobs[0] ? Object.keys(p.blobs[0]) : [],
    videoLikeUrls: pairs.slice(0, 40),
  };
}

const HTML_FRONTEND = `<!DOCTYPE html>
<html lang="bn"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>CapCut Downloader</title>
<style>
*{box-sizing:border-box;margin:0;padding:0;font-family:-apple-system,Segoe UI,Roboto,sans-serif}
body{background:#0f172a;color:#f8fafc;display:flex;justify-content:center;min-height:100vh;padding:20px}
.c{width:100%;max-width:500px;margin-top:40px;text-align:center}
h1{font-size:26px;color:#38bdf8;margin-bottom:8px}
.s{color:#94a3b8;font-size:14px;margin-bottom:24px}
.b{background:#1e293b;padding:20px;border-radius:16px}
input{width:100%;padding:14px;border-radius:10px;border:1px solid #334155;background:#0f172a;color:#fff;font-size:15px;margin-bottom:14px;outline:none}
button{width:100%;padding:14px;border:0;border-radius:10px;background:#0284c7;color:#fff;font-weight:700;font-size:16px}
button:disabled{opacity:.6}
#l,#r,#e{display:none;margin-top:16px}
#l{color:#38bdf8}#e{color:#f87171;font-size:14px;word-break:break-word}
#r{background:#0f172a;border:1px solid #334155;border-radius:12px;padding:16px}
#r img{width:100%;max-height:250px;object-fit:cover;border-radius:8px;margin-bottom:12px}
#r h3{font-size:16px;margin-bottom:14px;text-align:left}
.d{display:block;text-decoration:none;padding:12px;border-radius:8px;background:#10b981;color:#fff;font-weight:700;margin-top:8px}
.d.alt{background:#475569}
</style></head><body>
<div class="c"><h1>CapCut Downloader</h1><p class="s">ওয়াটারমার্ক ছাড়া ভিডিও ডাউনলোড</p>
<div class="b">
<input id="u" placeholder="CapCut লিংক পেস্ট করুন...">
<button id="go">ভিডিও খুঁজুন</button>
<div id="l">প্রসেস হচ্ছে...</div><div id="e"></div>
<div id="r"><img id="t" alt=""><h3 id="n"></h3>
<a id="a" class="d" href="#">Download MP4</a>
<a id="a2" class="d alt" href="#" target="_blank" rel="noopener">সরাসরি CDN লিংক</a></div>
</div></div>
<script>
const $=id=>document.getElementById(id);
$('go').onclick=async()=>{
  const url=$('u').value.trim(); if(!url) return;
  $('e').style.display='none';$('r').style.display='none';$('l').style.display='block';$('go').disabled=true;
  try{
    const res=await fetch('/api/resolve?url='+encodeURIComponent(url));
    const d=await res.json(); if(!d.success) throw new Error(d.error);
    $('t').style.display=d.thumbnail?'block':'none'; $('t').src=d.thumbnail||'';
    $('n').textContent=d.title;
    $('a').href='/api/download?url='+encodeURIComponent(d.videoUrl);
    $('a2').href=d.videoUrl;
    $('r').style.display='block';
  }catch(x){$('e').textContent=x.message||'ব্যর্থ হয়েছে।';$('e').style.display='block';}
  finally{$('l').style.display='none';$('go').disabled=false;}
};
</script></body></html>`;

const json = (res, code, obj) => {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj, null, 2));
};

const server = http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

    if (u.pathname === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(HTML_FRONTEND);
    }
    if (u.pathname === '/health') return json(res, 200, { ok: true });

    if (u.pathname === '/api/resolve') {
      try {
        return json(res, 200, { success: true, ...(await extractCapCut(u.searchParams.get('url'))) });
      } catch (e) {
        return json(res, 500, { success: false, error: e.message });
      }
    }

    if (u.pathname === '/api/debug') {
      try {
        return json(res, 200, await debugCapCut(u.searchParams.get('url')));
      } catch (e) {
        return json(res, 500, { error: e.message });
      }
    }

    if (u.pathname === '/api/download') {
      let target;
      try {
        target = new URL(u.searchParams.get('url'));
        if (target.protocol !== 'https:') throw new Error();
        if (net.isIP(target.hostname)) throw new Error();
        const addrs = await dns.lookup(target.hostname, { all: true });
        if (!addrs.length || addrs.some((a) => isPrivateIp(a.address))) throw new Error();
      } catch {
        res.writeHead(400);
        return res.end('অবৈধ বা নিষিদ্ধ ডাউনলোড URL।');
      }

      const up = https.get(target.href, { headers: { Referer: 'https://www.capcut.com/', 'User-Agent': HEADERS['User-Agent'] } }, (r) => {
        if (r.statusCode !== 200) {
          r.resume();
          res.writeHead(502);
          return res.end(`আপস্ট্রিম ত্রুটি: HTTP ${r.statusCode}`);
        }
        const h = {
          'Content-Type': r.headers['content-type'] || 'video/mp4',
          'Content-Disposition': 'attachment; filename="capcut_video.mp4"',
        };
        if (r.headers['content-length']) h['Content-Length'] = r.headers['content-length'];
        res.writeHead(200, h);
        r.pipe(res);
      });
      up.setTimeout(30000, () => up.destroy());
      up.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end('ডাউনলোড ব্যর্থ।'); });
      res.on('close', () => up.destroy());
      return;
    }

    res.writeHead(404);
    res.end('Not Found');
  } catch (e) {
    if (!res.headersSent) res.writeHead(500);
    res.end('Server error');
  }
});

server.listen(PORT, () => console.log(`Running on port ${PORT}`));
