import http from 'http';
import https from 'https';
import dns from 'dns/promises';
import net from 'net';

const PORT = process.env.PORT || 3000;

// র‍্যান্ডম ১৯ ডিজিটের ভার্চুয়াল ডিভাইস আইডি জেনারেটর
const genDeviceId = () => '7' + Math.floor(Math.random() * 899999999999999999 + 100000000000000000);

const MOBILE_HEADERS = {
  'User-Agent': 'com.lemon.lvoverseas/19.7.0 (Linux; U; Android 13; en_US; Pixel 7 Pro; Build/TQ3A.230901.001; Cronet/TTNetVersion:53f40d39)',
  'Accept': 'application/json',
  'Accept-Language': 'en-US,en;q=0.9',
  'Referer': 'https://www.capcut.com/',
};

const isCapcutHost = (h) => /(^|\.)capcut\.com$/i.test(h);
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

// ১. শেয়ার লিংক থেকে রিডাইরেক্ট করে মূল Template ID বের করা
function resolveTemplateId(rawUrl, left = 6) {
  return new Promise((resolve, reject) => {
    if (left <= 0) return reject(new Error('অনেক বেশি রিডাইরেক্ট হয়েছে।'));
    
    let u = rawUrl.trim();
    if (!/^https?:\/\//i.test(u)) u = 'https://' + u;

    const client = u.startsWith('https:') ? https : http;
    const req = client.get(u, { headers: { 'User-Agent': MOBILE_HEADERS['User-Agent'] } }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        res.resume();
        const next = new URL(res.headers.location, u).href;
        return resolve(resolveTemplateId(next, left - 1));
      }

      const idMatch = u.match(/template-detail\/(\d+)/i) || u.match(/template_id=(\d+)/i);
      const tid = idMatch ? idMatch[1] : null;
      resolve({ tid, finalUrl: u });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => req.destroy(new Error('CapCut লিংক রেসপন্স করছে না।')));
  });
}

// ২. CapCut মোবাইল API গেটওয়ে কল করা
function fetchMobileApi(templateId) {
  return new Promise((resolve, reject) => {
    const deviceId = genDeviceId();
    const apiUrl = `https://www.capcut.com/luckycat/i18n/capcut/thirdpatry_share/v1/landing_page/template_detail_v2?template_id=${templateId}&aid=2928&device_id=${deviceId}&iid=${deviceId}&app_version=19.7.0&os_version=13&device_platform=android`;

    https.get(apiUrl, { headers: MOBILE_HEADERS }, (res) => {
      let chunks = '';
      res.on('data', (c) => chunks += c);
      res.on('end', () => {
        try {
          const json = JSON.parse(chunks);
          resolve(json);
        } catch {
          reject(new Error('API থেকে সঠিক JSON পাওয়া যায়নি।'));
        }
      });
    }).on('error', reject);
  });
}

// ৩. রেজলভ ইঞ্জিন (মোবাইল API ডেটা পার্সিং)
async function extractCapCut(inputUrl) {
  const { tid, finalUrl } = await resolveTemplateId(inputUrl);

  if (!tid) {
    throw new Error('CapCut Template ID শনাক্ত করা যায়নি। সঠিক লিংক দিন।');
  }

  const apiRes = await fetchMobileApi(tid);
  const detail = apiRes?.data?.template_detail;

  if (!detail || !detail.videoUrl) {
    throw new Error('ক্যাপকাট সার্ভার থেকে ভিডিও লিংক পাওয়া যায়নি।');
  }

  return {
    title: detail.title || 'CapCut Template Video',
    thumbnail: detail.coverUrl || '',
    videoUrl: detail.videoUrl,
    author: detail.author?.name || 'Unknown',
    width: detail.videoWidth || null,
    height: detail.videoHeight || null
  };
}

// ৪. ওয়েব ফ্রন্টএন্ড UI
const HTML_FRONTEND = `<!DOCTYPE html>
<html lang="bn"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>CapCut Video Engine</title>
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
<div class="c"><h1>CapCut Video Engine</h1><p class="s">মোবাইল API চালিত ফাস্ট ডাউনলোডার</p>
<div class="b">
<input id="u" placeholder="CapCut লিংক দিন...">
<button id="go">ভিডিও খুঁজুন</button>
<div id="l">প্রসেস হচ্ছে...</div><div id="e"></div>
<div id="r"><img id="t" alt=""><h3 id="n"></h3>
<a id="a" class="d" href="#">ডাউনলোড MP4</a>
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
  }catch(x){$('e').textContent=x.message||'ব্যর্থ হয়েছে।';$('e').style.display='block';}
  finally{$('l').style.display='none';$('go').disabled=false;}
};
</script></body></html>`;

// ৫. মূল সার্ভার হ্যান্ডলার
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
        res.writeHead(400);
        return res.end('অবৈধ বা নিষিদ্ধ ডাউনলোড URL।');
      }

      const up = https.get(target.href, { headers: { Referer: 'https://www.capcut.com/', 'User-Agent': MOBILE_HEADERS['User-Agent'] } }, (r) => {
        if (r.statusCode !== 200) {
          r.resume();
          res.writeHead(502);
          return res.end(`আপস্ট্রিম ত্রুটি: HTTP ${r.statusCode}`);
        }
        res.writeHead(200, {
          'Content-Type': r.headers['content-type'] || 'video/mp4',
          'Content-Disposition': 'attachment; filename="capcut_video.mp4"',
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
