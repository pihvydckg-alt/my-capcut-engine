import http from 'http';
import https from 'https';
import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import ffmpegPath from 'ffmpeg-static';

const PORT = process.env.PORT || 3000;
const TEMP_DIR = '/tmp';

const BROWSER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Referer': 'https://www.capcut.com/',
};

// ১. পেজ থেকে ক্যাপকাটের আসল ভিডিও লিংক সংগ্রহ
function fetchCapCutHtml(rawUrl, left = 5) {
  return new Promise((resolve, reject) => {
    if (left <= 0) return reject(new Error('অনেক বেশি রিডাইরেক্ট হয়েছে।'));
    let u = rawUrl.trim();
    if (!/^https?:\/\//i.test(u)) u = 'https://' + u;

    const client = u.startsWith('https:') ? https : http;
    const req = client.get(u, { headers: BROWSER_HEADERS }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        res.resume();
        const next = new URL(res.headers.location, u).href;
        return resolve(fetchCapCutHtml(next, left - 1));
      }
      let chunks = '';
      res.on('data', (c) => chunks += c);
      res.on('end', () => resolve(chunks));
    });
    req.on('error', reject);
    req.setTimeout(15000, () => req.destroy(new Error('CapCut থেকে রেসপন্স আসেনি।')));
  });
}

async function extractVideoDetails(inputUrl) {
  const html = await fetchCapCutHtml(inputUrl);
  let title = 'CapCut Video';
  let thumbnail = '';
  let videoUrl = null;

  const scriptMatches = html.match(/<script[^>]*>([\s\S]*?)<\/script>/gi) || [];
  for (const scriptTag of scriptMatches) {
    if (scriptTag.includes('templateDetail')) {
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
    const vodMatch = html.match(/"videoUrl"\s*:\s*"(https?:[^"]+)"/);
    if (vodMatch) videoUrl = vodMatch[1].replace(/\\u002F/g, '/').replace(/\\\//g, '/');
  }

  if (!videoUrl) throw new Error('ভিডিওর লিংক খুঁজে পাওয়া যায়নি।');
  return { title, thumbnail, videoUrl };
}

// ২. ভিডিও ফাইল ডাউনলোড করা
function downloadFile(url, destPath) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(destPath);
    const client = url.startsWith('https:') ? https : http;
    client.get(url, { headers: BROWSER_HEADERS }, (res) => {
      if (res.statusCode !== 200) return reject(new Error('ভিডিও ফাইল ডাউনলোড ব্যর্থ।'));
      res.pipe(file);
      file.on('finish', () => file.close(resolve));
    }).on('error', (err) => {
      fs.unlink(destPath, () => {});
      reject(err);
    });
  });
}

// ৩. FFmpeg দিয়ে ওয়াটারমার্ক ক্লিন করা
// ক্যাপকাটের ওয়াটারমার্ক: প্রথম অর্ধেকের জন্য ডান-উপর, পরের অর্ধেকের জন্য বাম-নিচ
function cleanWatermarkWithFFmpeg(inputPath, outputPath) {
  return new Promise((resolve, reject) => {
    // delogo ফিল্টার দুটি কোণায় লোগো ব্লেন্ড করে রিমুভ করে
    const filter = "delogo=x=W-w-15:y=15:w=140:h=70,delogo=x=15:y=H-h-15:w=140:h=70";
    
    const args = [
      '-y',
      '-i', inputPath,
      '-vf', filter,
      '-c:a', 'copy',
      '-preset', 'ultrafast',
      outputPath
    ];

    const proc = spawn(ffmpegPath, args);
    proc.on('close', (code) => {
      if (code === 0) resolve(outputPath);
      else reject(new Error('FFmpeg প্রসেসিং ব্যর্থ হয়েছে।'));
    });
    proc.on('error', reject);
  });
}

// ফ্রন্টএন্ড UI
const HTML_FRONTEND = `<!DOCTYPE html>
<html lang="bn"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>CapCut Clean Video Downloader</title>
<style>
*{box-sizing:border-box;margin:0;padding:0;font-family:system-ui,-apple-system,sans-serif}
body{background:#0b0f19;color:#f8fafc;display:flex;justify-content:center;min-height:100vh;padding:16px}
.c{width:100%;max-width:480px;margin-top:20px;text-align:center}
h1{font-size:22px;color:#38bdf8;margin-bottom:6px}
p.sub{color:#94a3b8;font-size:13px;margin-bottom:18px}
.box{background:#1e293b;padding:18px;border-radius:14px;box-shadow:0 8px 20px rgba(0,0,0,0.4)}
input{width:100%;padding:14px;border-radius:10px;border:1px solid #334155;background:#0f172a;color:#fff;font-size:15px;margin-bottom:12px;outline:none}
button{width:100%;padding:14px;border:0;border-radius:10px;background:#0284c7;color:#fff;font-weight:700;font-size:16px;cursor:pointer}
button:disabled{opacity:.6}
#st{display:none;margin-top:14px;font-size:14px;color:#38bdf8}
#err{display:none;margin-top:14px;color:#f87171;font-size:14px;word-break:break-word}
#res{display:none;margin-top:16px;background:#0f172a;border:1px solid #334155;border-radius:12px;padding:14px}
#thumb{width:100%;max-height:240px;object-fit:cover;border-radius:8px;margin-bottom:10px}
#name{font-size:15px;text-align:left;margin-bottom:12px}
.btn{display:block;text-decoration:none;padding:12px;border-radius:8px;background:#10b981;color:#fff;font-weight:700}
</style></head><body>
<div class="c">
<h1>CapCut Watermark Remover</h1>
<p class="sub">স্বয়ংক্রিয় FFmpeg ইঞ্জিন চালিত</p>
<div class="box">
<input id="url" placeholder="ক্যাপকাটের লিংক পেস্ট করুন...">
<button id="btn">ওয়াটারমার্ক ছাড়া ডাউনলোড করুন</button>
<div id="st">সার্ভারে ভিডিও প্রসেস হচ্ছে, কিছুক্ষণ অপেক্ষা করুন...</div>
<div id="err"></div>
<div id="res">
<img id="thumb" alt="">
<div id="name"></div>
<a id="dl" class="btn" href="#">ডাউনলোড করুন (ক্লিন MP4)</a>
</div>
</div></div>
<script>
const $ = id => document.getElementById(id);
$('btn').onclick = async () => {
  const u = $('url').value.trim();
  if(!u) return;
  $('err').style.display = 'none'; $('res').style.display = 'none';
  $('st').style.display = 'block'; $('btn').disabled = true;

  try {
    const r = await fetch('/api/resolve?url=' + encodeURIComponent(u));
    const d = await r.json();
    if(!d.success) throw new Error(d.error);

    $('thumb').src = d.thumbnail;
    $('name').textContent = d.title;
    $('dl').href = '/api/clean-download?url=' + encodeURIComponent(d.videoUrl);
    $('res').style.display = 'block';
  } catch(e) {
    $('err').textContent = e.message || 'ব্যর্থ হয়েছে।';
    $('err').style.display = 'block';
  } finally {
    $('st').style.display = 'none';
    $('btn').disabled = false;
  }
};
</script></body></html>`;

// সার্ভার রুট
const server = http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

    if (u.pathname === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(HTML_FRONTEND);
    }

    if (u.pathname === '/api/resolve') {
      try {
        const details = await extractVideoDetails(u.searchParams.get('url'));
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify({ success: true, ...details }));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify({ success: false, error: e.message }));
      }
    }

    if (u.pathname === '/api/clean-download') {
      const rawUrl = u.searchParams.get('url');
      if (!rawUrl) {
        res.writeHead(400);
        return res.end('লিংক দেওয়া হয়নি।');
      }

      const id = Date.now();
      const inPath = path.join(TEMP_DIR, `in_${id}.mp4`);
      const outPath = path.join(TEMP_DIR, `clean_${id}.mp4`);

      try {
        // ১. ফাইল নামানো
        await downloadFile(rawUrl, inPath);

        // ২. FFmpeg দিয়ে লোগো রিমুভ ও প্রসেসিং
        await cleanWatermarkWithFFmpeg(inPath, outPath);

        // ৩. ইউজারের কাছে ক্লিন ফাইল স্ট্রিম করা
        const stat = fs.statSync(outPath);
        res.writeHead(200, {
          'Content-Type': 'video/mp4',
          'Content-Disposition': 'attachment; filename="capcut_clean.mp4"',
          'Content-Length': stat.size
        });

        const readStream = fs.createReadStream(outPath);
        readStream.pipe(res);
        readStream.on('close', () => {
          fs.unlink(inPath, () => {});
          fs.unlink(outPath, () => {});
        });
      } catch (e) {
        fs.unlink(inPath, () => {});
        fs.unlink(outPath, () => {});
        res.writeHead(500);
        res.end('প্রসেসিংয়ে সমস্যা হয়েছে: ' + e.message);
      }
      return;
    }

    res.writeHead(404);
    res.end('Not Found');
  } catch (err) {
    if (!res.headersSent) res.writeHead(500);
    res.end('Server error');
  }
});

server.listen(PORT, () => console.log(`Engine running on port ${PORT}`));
