import http from 'http';
import https from 'https';
import dns from 'dns/promises';
import net from 'net';

const PORT = process.env.PORT || 3000;

const BROWSER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'Referer': 'https://www.capcut.com/',
};

const clean = (s) => (typeof s === 'string' ? s.replace(/\\u002F/g, '/').replace(/\\\//g, '/') : s);

function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a >= 224;
  }
  const l = ip.toLowerCase();
  return l === '::1' || l === '::' || l.startsWith('fc') || l.startsWith('fd') || l.startsWith('fe80') || l.startsWith('::ffff:');
}

// রিডাইরেক্ট ফলো করে মূল পেজ নিয়ে আসা
function fetchCapCutPage(rawUrl, left = 6) {
  return new Promise((resolve, reject) => {
    if (left <= 0) return reject(new Error('অনেক বেশি রিডাইরেক্ট হয়েছে।'));

    let u = rawUrl.trim();
    if (!/^https?:\/\//i.test(u)) u = 'https://' + u;

    const client = u.startsWith('https:') ? https : http;
    const req = client.get(u, { headers: BROWSER_HEADERS }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        res.resume();
        const next = new URL(res.headers.location, u).href;
        return resolve(fetchCapCutPage(next, left - 1));
      }

      let chunks = '';
      res.on('data', (c) => chunks += c);
      res.on('end', () => resolve({ html: chunks, finalUrl: u }));
    });
    req.on('error', reject);
    req.setTimeout(15000, () => req.destroy(new Error('CapCut সার্ভার থেকে রেসপন্স আসেনি।')));
  });
}

// ওপেন রিভার্স সোর্স থেকে নো-ওয়াটারমার্ক ডিরেক্ট লিঙ্ক সংগ্রহের চেষ্টা
async function fetchNoWatermarkUrl(url) {
  return new Promise((resolve) => {
    try {
      const postData = JSON.stringify({ url });
      const options = {
        hostname: 'api.tikmate.app',
        path: '/api/lookup',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(postData),
          'User-Agent': 'Mozilla/5.0'
        },
        timeout: 5000
      };

      const req = https.request(options, (res) => {
        let body = '';
        res.on('data', chunk => body += chunk);
        res.on('end', () => {
          try {
            const parsed = JSON.parse(body);
            if (parsed && (parsed.video_url || parsed.url)) {
              return resolve(parsed.video_url || parsed.url);
            }
          } catch {}
          resolve(null);
        });
      });
      req.on('error', () => resolve(null));
      req.write(postData);
      req.end();
    } catch {
      resolve(null);
    }
  });
}

// মূল টেমপ্লেট ডাটা এক্সট্র্যাক্ট করা
async function extractCapCut(inputUrl) {
  // ১. প্রথমে নো-ওয়াটারমার্ক এন্ডপয়েন্টে চেষ্টা
  const cleanVideo = await fetchNoWatermarkUrl(inputUrl);

  const { html } = await fetchCapCutPage(inputUrl);

  let title = 'CapCut Video';
  let thumbnail = '';
  let videoUrl = cleanVideo;

  // ২. স্ক্রিপ্ট ট্যাগে থাকা আসল টেমপ্লেট ডাটা
  const scriptMatches = html.match(/<script[^>]*>([\s\S]*?)<\/script>/gi) || [];
  for (const scriptTag of scriptMatches) {
    if (scriptTag.includes('templateDetail')) {
      const cleanJson = scriptTag.replace(/<\/?script[^>]*>/gi, '').trim();
      try {
        const parsed = JSON.parse(cleanJson);
        const td = parsed?.loaderData?.['template-detail_$']?.templateDetail;
        if (td) {
          title = td.title || title;
          thumbnail = td.coverUrl || '';
          if (!videoUrl && td.videoUrl && !td.videoUrl.includes('video_en2.mp4')) {
            videoUrl = td.videoUrl;
          }
          break;
        }
      } catch {}
    }
  }

  // ৩. ফলব্যাক রেজেক্স
  if (!videoUrl) {
    const vodMatch = html.match(/"videoUrl"\s*:\s*"(https?:[^"]+capcutvod\.com[^"]+)"/);
    if (vodMatch) videoUrl = clean(vodMatch[1]);
  }

  // ৪. মেটাডাটা ফলব্যাক
  if (title === 'CapCut Video') {
    const tMatch = html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']*)["']/i);
    if (tMatch) title = tMatch[1];
  }
  if (!thumbnail) {
    const imgMatch = html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']*)["']/i);
    if (imgMatch) thumbnail = clean(imgMatch[1]);
  }

  if (!videoUrl) {
    throw new Error('ভিডিও লিঙ্কটি পাওয়া যায়নি। লিঙ্কটি পাবলিক কি না চেক করুন।');
  }

  return { title, thumbnail, videoUrl };
}

// ফ্রন্টএন্ড UI
const HTML_FRONTEND = `<!DOCTYPE html>
<html lang="bn"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>CapCut No-Watermark Downloader</title>
<style>
*{box-sizing:border-box;margin:0;padding:0;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif}
body{background:#0f172a;color:#f8fafc;display:flex;justify-content:center;min-height:100vh;padding:20px}
.c{width:100%;max-width:500px;margin-top:30px;text-align:center}
h1{font-size:24px;color:#38bdf8;margin-bottom:6px}
.s{color:#94a3b8;font-size:14px;margin-bottom:20px}
.b{background:#1e293b;padding:20px;border-radius:16px;box-shadow:0 10px 25px rgba(0,0,0,0.3)}
input{width:100%;padding:14px;border-radius:10px;border:1px solid #334155;background:#0f172a;color:#fff;font-size:15px;margin-bottom:14px;outline:none}
button{width:100%;padding:14px;border:0;border-radius:10px;background:#0284c7;color:#fff;font-weight:700;font-size:16px;cursor:pointer}
button:disabled{opacity:.6}
#l,#r,#e{display:none;margin-top:16px}
#l{color:#38bdf8}#e{color:#f87171;font-size:14px;word-break:break-word}
#r{background:#0f172a;border:1px solid #334155;border-radius:12px;padding:16px}
#r img{width:100%;max-height:260px;object-fit:cover;border-radius:8px;margin-bottom:12px}
#r h3{font-size:16px;margin-bottom:14px;text-align:left}
.d{display:block;text-decoration:none;padding:12px;border-radius:8px;background:#10b981;color:#fff;font-weight:700;margin-top:8px}
.d.alt{background:#475569}
</style></head><body>
<div class="c"><h1>CapCut Video Engine</h1><p class="s">নো-ওয়াটারমার্ক ডাউনলোডার</p>
<div class="b">
<input id="u" placeholder="CapCut লিংক দিন...">
<button id="go">ভিডিও খুঁজুন</button>
<div id="l">প্রসেস হচ্ছে...</div><div id="e"></div>
<div id="r"><img id="t" alt=""><h3 id="n"></h3>
<a id="a" class="d" href="#">ডাউনলোড MP4 (ক্লিন)</a>
<a id="a2" class="d alt" href="#" target="_blank" rel="noopener">সরাসরি লিংক</a></div>
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
  }catch(x){$('e').textContent=x.message||'ব্যর্থ হয়েছে।';$('e').style.display='block';}
  finally{$('l').style.display='none';$('go').disabled=false;}
};
</script></body></html>`;

// সার্ভার রাউটিং
const server = http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

    if (u.pathname === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(HTML_FRONTEND);
    }

    if (u.pathname === '/api/resolve') {
      try {
        const data = await extractCapCut(u.searchParams.get('url'));
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify({ success: true, ...data }));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify({ success: false, error: e.message }));
      }
    }

    if (u.pathname === '/api/download') {
      let target;
      try {
        target = new URL(u.searchParams.get('url'));
        if (target.protocol !== 'https:' && target.protocol !== 'http:') throw new Error();
        if (net.isIP(target.hostname)) throw new Error();
        const addrs = await dns.lookup(target.hostname, { all: true });
        if (!addrs.length || addrs.some((a) => isPrivateIp(a.address))) throw new Error();
      } catch {
        res.writeHead(400);
        return res.end('অবৈধ ডাউনলোড লিংক।');
      }

      const client = target.protocol === 'https:' ? https : http;
      const up = client.get(target.href, { headers: { Referer: 'https://www.capcut.com/', 'User-Agent': BROWSER_HEADERS['User-Agent'] } }, (r) => {
        if (r.statusCode !== 200 && r.statusCode !== 206) {
          r.resume();
          res.writeHead(502);
          return res.end(`ত্রুটি: HTTP ${r.statusCode}`);
        }
        res.writeHead(200, {
          'Content-Type': 'video/mp4',
          'Content-Disposition': 'attachment; filename="capcut_no_watermark.mp4"',
          'Content-Length': r.headers['content-length'] || ''
        });
        r.pipe(res);
      });
      up.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end('ডাউনলোড ব্যর্থ।'); });
      return;
    }

    res.writeHead(404);
    res.end('Not Found');
  } catch (e) {
    if (!res.headersSent) res.writeHead(500);
    res.end('Server error');
  }
});

server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
