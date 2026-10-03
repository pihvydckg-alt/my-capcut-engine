import http from 'http';
import https from 'https';
import { URL } from 'url';

const PORT = process.env.PORT || 3000;

// ১. ব্রাউজার হেডার
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Referer': 'https://www.capcut.com/'
};

// ২. রিডাইরেক্ট হ্যান্ডেল করে HTML ফেচ করার ফাংশন
function fetchUrl(targetUrl, maxRedirects = 5) {
  return new Promise((resolve, reject) => {
    if (maxRedirects <= 0) return reject(new Error('Too many redirects'));

    const parsedUrl = new URL(targetUrl);
    const client = parsedUrl.protocol === 'https:' ? https : http;

    client.get(targetUrl, { headers: HEADERS }, (res) => {
      // রিডাইরেক্ট হলে নতুন URL ফলো করা
      if ([301, 302, 307, 308].includes(res.statusCode) && res.headers.location) {
        const redirectUrl = new URL(res.headers.location, targetUrl).href;
        return resolve(fetchUrl(redirectUrl, maxRedirects - 1));
      }

      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ html: data, finalUrl: targetUrl }));
    }).on('error', reject);
  });
}

// ৩. CapCut ডেটা এক্সট্র্যাক্ট করার মূল লজিক
async function extractCapCutData(capcutUrl) {
  const { html, finalUrl } = await fetchUrl(capcutUrl);

  let title = 'CapCut Video';
  let thumbnail = '';
  let videoUrl = null;
  let author = { name: 'CapCut Creator' };

  // মেটা ট্যাগ থেকে টাইটেল ও থাম্বনেইল নেওয়া
  const ogTitleMatch = html.match(/<meta\s+property=["']og:title["']\s+content=["']([^"']+)["']/i);
  if (ogTitleMatch) title = ogTitleMatch[1];

  const ogImageMatch = html.match(/<meta\s+property=["']og:image["']\s+content=["']([^"']+)["']/i);
  if (ogImageMatch) thumbnail = ogImageMatch[1];

  // __NEXT_DATA__ স্ক্রিপ্ট থেকে ভিডিও তথ্য খোঁজা
  const nextDataMatch = html.match(/<script\s+id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i);
  if (nextDataMatch) {
    try {
      const parsed = JSON.parse(nextDataMatch[1]);
      const pageProps = parsed?.props?.pageProps;
      const info = pageProps?.templateInfo || pageProps?.videoData || pageProps?.detail || {};

      if (info.title) title = info.title;
      if (info.cover_url) thumbnail = info.cover_url;
      if (info.play_url || info.video_url) videoUrl = info.play_url || info.video_url;
      if (info.author?.name) author.name = info.author.name;
    } catch (e) {
      // JSON পার্স ব্যর্থ হলে পরবর্তী নিয়মে যাবে
    }
  }

  // সরাসরি ভিডিওর নো-ওয়াটারমার্ক CDN লিংক খোঁজা
  if (!videoUrl) {
    const playMatch = html.match(/"play_url"\s*:\s*"([^"]+)"/) || html.match(/"video_url"\s*:\s*"([^"]+)"/);
    if (playMatch) {
      videoUrl = playMatch[1].replace(/\\u002F/g, '/');
    }
  }

  if (!videoUrl) {
    throw new Error('No-watermark video link could not be found.');
  }

  return {
    success: true,
    title,
    thumbnail,
    no_watermark_url: videoUrl,
    author,
    original_url: capcutUrl,
    resolved_url: finalUrl,
    timestamp: new Date().toISOString()
  };
}

// ৪. সার্ভার ও API রাউট
const server = http.createServer(async (req, res) => {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Access-Control-Allow-Origin', '*');

  const reqUrl = new URL(req.url, `http://${req.headers.host}`);

  // হেলথ চেক রুট
  if (reqUrl.pathname === '/') {
    res.writeHead(200);
    return res.end(JSON.stringify({ 
      status: 'active', 
      usage: 'Visit /download?url=YOUR_CAPCUT_URL' 
    }));
  }

  // ভিডিও ডাউনলোড API রুট
  if (reqUrl.pathname === '/download') {
    const targetUrl = reqUrl.searchParams.get('url');

    if (!targetUrl) {
      res.writeHead(400);
      return res.end(JSON.stringify({ success: false, error: 'URL parameter is missing' }));
    }

    try {
      const data = await extractCapCutData(targetUrl);
      res.writeHead(200);
      return res.end(JSON.stringify(data, null, 2));
    } catch (err) {
      res.writeHead(500);
      return res.end(JSON.stringify({ success: false, error: err.message }));
    }
  }

  res.writeHead(404);
  res.end(JSON.stringify({ error: 'Not Found' }));
});

server.listen(PORT, () => {
  console.log(`CapCut Engine Server is running on port ${PORT}`);
});
