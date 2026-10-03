import http from 'http';
import https from 'https';
import { URL } from 'url';

const PORT = process.env.PORT || 3000;

// ব্রাউজার হেডার (CapCut ব্লকিং বাইপাস করার জন্য)
const BROWSER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'Referer': 'https://www.capcut.com/'
};

// ১. রিডাইরেক্ট সমাধান ও পেজ ফেচ ফাংশন
function fetchHtmlWithRedirects(targetUrl, maxRedirects = 5) {
  return new Promise((resolve, reject) => {
    if (maxRedirects <= 0) return reject(new Error('অনেকগুলো রিডাইরেক্ট হয়েছে। লিংকটি সঠিক নয়।'));

    try {
      const parsedUrl = new URL(targetUrl);
      const client = parsedUrl.protocol === 'https:' ? https : http;

      client.get(targetUrl, { headers: BROWSER_HEADERS }, (res) => {
        if ([301, 302, 307, 308].includes(res.statusCode) && res.headers.location) {
          const nextUrl = new URL(res.headers.location, targetUrl).href;
          return resolve(fetchHtmlWithRedirects(nextUrl, maxRedirects - 1));
        }

        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => resolve({ html: data, finalUrl: targetUrl }));
      }).on('error', reject);
    } catch (e) {
      reject(new Error('অবৈধ URL ফরম্যাট।'));
    }
  });
}

// ২. CapCut নো-ওয়াটারমার্ক ভিডিও এক্সট্র্যাক্টর
async function extractCapCut(url) {
  const { html, finalUrl } = await fetchHtmlWithRedirects(url);

  let title = 'CapCut Video';
  let thumbnail = '';
  let videoUrl = null;

  // মেটাডাটা রিড করা
  const ogTitle = html.match(/<meta\s+property=["']og:title["']\s+content=["']([^"']+)["']/i);
  if (ogTitle) title = ogTitle[1];

  const ogImage = html.match(/<meta\s+property=["']og:image["']\s+content=["']([^"']+)["']/i);
  if (ogImage) thumbnail = ogImage[1];

  // Next.js ডেটা স্টেট থেকে ডিরেক্ট CDN লিঙ্ক খোঁজা
  const nextData = html.match(/<script\s+id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i);
  if (nextData) {
    try {
      const json = JSON.parse(nextData[1]);
      const p = json?.props?.pageProps;
      const item = p?.templateInfo || p?.videoData || p?.detail || {};
      if (item.title) title = item.title;
      if (item.cover_url) thumbnail = item.cover_url;
      if (item.play_url || item.video_url) videoUrl = item.play_url || item.video_url;
    } catch (e) {}
  }

  // সরাসরি ভিডিও ট্যাগের CDN URL ম্যাচিং
  if (!videoUrl) {
    const directMatch = html.match(/"play_url"\s*:\s*"([^"]+)"/) || html.match(/"video_url"\s*:\s*"([^"]+)"/);
    if (directMatch) {
      videoUrl = directMatch[1].replace(/\\u002F/g, '/');
    }
  }

  if (!videoUrl) {
    throw new Error('ওয়াটারমার্ক ছাড়া আসল ভিডিও লিংক পাওয়া যায়নি। লিংকটি প্রাইভেট বা এক্সপায়ার্ড হতে পারে।');
  }

  return { title, thumbnail, videoUrl, originalUrl: url };
}

// ৩. রেসপন্সিভ প্রিমিয়াম ওয়েব ডিজাইন (HTML/CSS/JS)
const HTML_FRONTEND = `
<!DOCTYPE html>
<html lang="bn">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>CapCut Video Downloader - No Watermark</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
    body { background: #0f172a; color: #f8fafc; display: flex; justify-content: center; min-height: 100vh; padding: 20px; }
    .container { width: 100%; max-width: 500px; margin-top: 40px; text-align: center; }
    h1 { font-size: 26px; font-weight: 800; margin-bottom: 8px; color: #38bdf8; }
    p.subtitle { color: #94a3b8; font-size: 14px; margin-bottom: 24px; }
    .box { background: #1e293b; padding: 20px; border-radius: 16px; box-shadow: 0 10px 25px rgba(0,0,0,0.3); }
    input { width: 100%; padding: 14px; border-radius: 10px; border: 1px solid #334155; background: #0f172a; color: #fff; font-size: 15px; margin-bottom: 14px; outline: none; }
    input:focus { border-color: #38bdf8; }
    button { width: 100%; padding: 14px; border: none; border-radius: 10px; background: #0284c7; color: white; font-weight: 700; font-size: 16px; cursor: pointer; transition: 0.2s; }
    button:hover { background: #0369a1; }
    #loader { display: none; margin: 20px 0; color: #38bdf8; font-weight: 600; }
    #result { display: none; margin-top: 20px; background: #0f172a; border-radius: 12px; padding: 16px; border: 1px solid #334155; }
    #result img { width: 100%; max-height: 250px; object-fit: cover; border-radius: 8px; margin-bottom: 12px; }
    #result h3 { font-size: 16px; margin-bottom: 14px; color: #f1f5f9; text-align: left; }
    .download-btn { display: block; text-decoration: none; padding: 12px; border-radius: 8px; background: #10b981; color: white; font-weight: bold; font-size: 15px; }
    .error { color: #f87171; margin-top: 14px; font-size: 14px; display: none; }
  </style>
</head>
<body>
  <div class="container">
    <h1>CapCut Downloader</h1>
    <p class="subtitle">ওয়াটারমার্ক ছাড়া অরিজিনাল ভিডিও ডাউনলোড ইঞ্জিন</p>
    
    <div class="box">
      <input type="text" id="capcutUrl" placeholder="CapCut লিংক এখানে পেস্ট করুন...">
      <button onclick="processLink()" id="btnText">ভিডিও খুঁজুন</button>
      <div id="loader">অরিজিনাল ভিডিও লিংক প্রসেস হচ্ছে...</div>
      <div id="error" class="error"></div>

      <div id="result">
        <img id="thumb" src="" alt="Thumbnail">
        <h3 id="videoTitle"></h3>
        <a id="dlLink" class="download-btn" href="#" target="_blank">Download MP4 (No Watermark)</a>
      </div>
    </div>
  </div>

  <script>
    async function processLink() {
      const url = document.getElementById('capcutUrl').value.trim();
      const loader = document.getElementById('loader');
      const result = document.getElementById('result');
      const err = document.getElementById('error');
      const btn = document.getElementById('btnText');

      if (!url) return alert('দয়া করে একটি CapCut লিংক দিন!');

      err.style.display = 'none';
      result.style.display = 'none';
      loader.style.display = 'block';
      btn.disabled = true;

      try {
        const res = await fetch('/api/resolve?url=' + encodeURIComponent(url));
        const data = await res.json();

        if (!data.success) throw new Error(data.error);

        document.getElementById('thumb').src = data.thumbnail || 'https://via.placeholder.com/400x250?text=No+Thumbnail';
        document.getElementById('videoTitle').innerText = data.title;
        // রিয়েল ডাউনলোডের জন্য প্রক্সি রুট ব্যবহার
        document.getElementById('dlLink').href = '/api/download?url=' + encodeURIComponent(data.videoUrl);
        result.style.display = 'block';
      } catch (e) {
        err.innerText = e.message || 'ভিডিও প্রসেস করতে ব্যর্থ হয়েছে।';
        err.style.display = 'block';
      } finally {
        loader.style.display = 'none';
        btn.disabled = false;
      }
    }
  </script>
</body>
</html>
`;

// ৪. মূল সার্ভার হ্যান্ডলার
const server = http.createServer(async (req, res) => {
  const reqUrl = new URL(req.url, `http://${req.headers.host}`);

  // ১. হোমপেজে সরাসরি ডিজাইন দেখানো
  if (reqUrl.pathname === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(HTML_FRONTEND);
  }

  // ২. ভিডিও রেজলভ API
  if (reqUrl.pathname === '/api/resolve') {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    const targetUrl = reqUrl.searchParams.get('url');

    if (!targetUrl) {
      res.writeHead(400);
      return res.end(JSON.stringify({ success: false, error: 'URL প্যারামিটার প্রয়োজন।' }));
    }

    try {
      const data = await extractCapCut(targetUrl);
      res.writeHead(200);
      return res.end(JSON.stringify({ success: true, ...data }));
    } catch (err) {
      res.writeHead(500);
      return res.end(JSON.stringify({ success: false, error: err.message }));
    }
  }

  // ৩. ডিরেক্ট ফাইল ডাউনলোড প্রক্সি (ব্রাউজারে সরাসরি সেভ করার জন্য)
  if (reqUrl.pathname === '/api/download') {
    const videoStreamUrl = reqUrl.searchParams.get('url');
    if (!videoStreamUrl) {
      res.writeHead(400);
      return res.end('Video URL is missing');
    }

    try {
      const parsed = new URL(videoStreamUrl);
      const client = parsed.protocol === 'https:' ? https : http;

      client.get(videoStreamUrl, { headers: { 'Referer': 'https://www.capcut.com/' } }, (streamRes) => {
        res.writeHead(200, {
          'Content-Type': 'video/mp4',
          'Content-Disposition': 'attachment; filename="capcut_no_watermark.mp4"',
          'Content-Length': streamRes.headers['content-length'] || ''
        });
        streamRes.pipe(res);
      }).on('error', (e) => {
        res.writeHead(500);
        res.end('Download failed');
      });
    } catch (e) {
      res.writeHead(500);
      res.end('Invalid download stream URL');
    }
    return;
  }

  res.writeHead(404);
  res.end('Not Found');
});

server.listen(PORT, () => {
  console.log(`Professional CapCut Downloader running on port ${PORT}`);
});
