import http from 'http';
import https from 'https';
import dns from 'dns/promises';
import net from 'net';

const PORT = process.env.PORT || 3000;

const BROWSER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1',
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

async function extractCapCut(inputUrl) {
  const { html } = await fetchCapCutPage(inputUrl);

  let title = 'CapCut Video';
  let thumbnail = '';
  let videoUrl = null;

  const scriptMatches = html.match(/<script[^>]*>([\s\S]*?)<\/script>/gi) || [];
  for (const scriptTag of scriptMatches) {
    if (scriptTag.includes('templateDetail') || scriptTag.includes('videoUrl')) {
      const cleanJson = scriptTag.replace(/<\/?script[^>]*>/gi, '').trim();
      try {
        const parsed = JSON.parse(cleanJson);
        const td = parsed?.loaderData?.['template-detail_$']?.templateDetail;
        if (td && td.videoUrl && !td.videoUrl.includes('video_en2.mp4')) {
          title = td.title || title;
          thumbnail = td.coverUrl || '';
          videoUrl = td.videoUrl;
          break;
        }
      } catch {}
    }
  }

  if (!videoUrl) {
    const vodMatch = html.match(/"videoUrl"\s*:\s*"(https?:[^"]+capcutvod\.com[^"]+)"/);
    if (vodMatch) {
      videoUrl = clean(vodMatch[1]);
    }
  }

  if (title === 'CapCut Video') {
    const tMatch = html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']*)["']/i);
    if (tMatch) title = tMatch[1];
  }
  if (!thumbnail) {
    const imgMatch = html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']*)["']/i);
    if (imgMatch) thumbnail = clean(imgMatch[1]);
  }

  if (!videoUrl) {
    throw new Error('ভিডিও লিঙ্কটি পাওয়া যায়নি। লিংকটি সঠিক কি না চেক করুন।');
  }

  return { title, thumbnail, videoUrl };
}

const HTML_FRONTEND = `<!DOCTYPE html>
<html lang="bn"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>CapCut Video Downloader</title>
<style>
*{box-sizing:border-box;margin:0;padding:0;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif}
body{background:#0b1329;color:#f8fafc;display:flex;justify-content:center;min-height:100vh;padding:20px}
.c{width:100%;max-width:480px;margin-top:40px;text-align:center}
h1{font-size:26px;color:#38bdf8;margin-bottom:8px}
.s{color:#94a3b8;font-size:14px;margin-bottom:24px}
.b{background:#1e293b;padding:24px;border-radius:16px;box-shadow:0 10px 25px rgba(0,0,0,0.3)}
input{width:100%;padding:14px;border-radius:10px;border:1px solid #334155;background:#0f172a;color:#fff;font-size:15px;margin-bottom:14px;outline:none}
button{width:100%;padding:14px;border:0;border-radius:10px;background:#0284c7;color:#fff;font-weight:700;font-size:16px;cursor:pointer}
button:disabled{opacity:.6}
#l,#r,#e{display:none;margin-top:16px}
#l{color:#38bdf8;font-weight:600}#e{color:#f87171;font-size:14px;word-break:break-word}
#r{background:#0f172a;border:1px solid #334155;border-radius:12px;padding:16px}
#r img{width:100%;max-height:260px;object-fit:cover;border-radius:8px;margin-bottom:12px}
#r h3{font-size:16px;margin-bottom:14px;text-align:left}
.d{display:block;text-decoration:none;padding:14px;border-radius:10px;background:#10b981;color:#fff;font-weight:700;font-size:16px;margin-top:8px}
</style></head><body>
<div class="c">
<h1>CapCut Downloader</h1>
<p class="s">সরাসরি দ্রুত ও নিরাপদ ডাউনলোড</p>
<div class="b">
<input id="u" placeholder="CapCut লিংক দিন...">
<button id="go">ভিডিও আনুন</button>
<div id="l">খোঁজা হচ্ছে...</div><div id="e"></div>
<div id="r">
<img id="t" alt="">
<h3 id="n"></h3>
<a id="a" class="d" href="#">ভিডিও ডাউনলোড করুন (MP4)</a>
</div>
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
    $('r').style.display='block';
  }catch(x){$('e').textContent=x.message||'ব্যর্থ হয়েছে।';$('e').style.display='block';}
  finally{$('l').style.display='none';$('go').disabled=false;}
};
</script></body></html>`;

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
        if (target.protocol !== 'https:') throw new Error();
        if (net.isIP(target.hostname)) throw new Error();
        const addrs = await dns.lookup(target.hostname, { all: true });
        if (!addrs.length || addrs.some((a) => isPrivateIp(a.address))) throw new Error();
      } catch {
        res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end('অবৈধ ডাউনলোড লিংক।');
      }

      const up = https.get(target.href, { headers: { Referer: 'https://www.capcut.com/', 'User-Agent': BROWSER_HEADERS['User-Agent'] } }, (r) => {
        if (r.statusCode !== 200) {
          r.resume();
          res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
          return res.end(`ত্রুটি: HTTP ${r.statusCode}`);
        }
        res.writeHead(200, {
          'Content-Type': 'video/mp4',
          'Content-Disposition': 'attachment; filename="capcut_video.mp4"',
          'Content-Length': r.headers['content-length'] || ''
        });
        r.pipe(res);
      });
      up.on('error', () => { 
        if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' }); 
        res.end('ডাউনলোড ব্যর্থ।'); 
      });
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
