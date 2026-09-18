/**
 * Mini video streaming platform.
 *
 * Implements the four "hard parts" of a real streaming pipeline:
 *   1. Chunked / resumable uploads
 *   2. FFmpeg transcoding into multiple renditions
 *   3. Adaptive bitrate streaming via HLS
 *   4. Range-request handling + CDN-style caching headers
 *
 * In-memory Maps stand in for a database/Redis. Swap them out
 * (and the single-process transcode loop) for a real queue like
 * BullMQ if you need this to survive a restart or scale past one box.
 */

const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
const ffmpeg = require('fluent-ffmpeg');

// On some systems (Windows especially) fluent-ffmpeg's PATH-based lookup
// of ffmpeg/ffprobe is unreliable -- particularly right after installing
// FFmpeg, since an already-open terminal or IDE won't see a PATH change
// until it's fully restarted. Setting these explicitly sidesteps PATH
// entirely. Leave the env vars unset to fall back to normal PATH lookup.
if (process.env.FFMPEG_PATH) ffmpeg.setFfmpegPath(process.env.FFMPEG_PATH);
if (process.env.FFPROBE_PATH) ffmpeg.setFfprobePath(process.env.FFPROBE_PATH);

const app = express();
app.use(cors());
app.use(express.json());

const ROOT = __dirname;
const TMP_DIR = path.join(ROOT, 'tmp');
const RAW_DIR = path.join(ROOT, 'raw');
const VIDEOS_DIR = path.join(ROOT, 'videos');

for (const dir of [TMP_DIR, RAW_DIR, VIDEOS_DIR]) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

// uploadId -> { filename, totalChunks, receivedChunks: Set<number> }
const uploads = new Map();
// videoId -> { status: 'queued'|'processing'|'ready'|'error', renditions: {}, error }
const jobs = new Map();

// ---------------------------------------------------------------------------
// 1. Chunked / resumable uploads
// ---------------------------------------------------------------------------

const chunkStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(TMP_DIR, req.body.uploadId);
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => cb(null, `chunk-${req.body.chunkIndex}`),
});
// Reject any single chunk over 5MB (matches the client's CHUNK_SIZE).
// This bounds per-request size; it does NOT cap total file size --
// add a check in /api/upload/init against upload.totalChunks if you
// want a hard ceiling on whole-file size too.
const uploadChunk = multer({
  storage: chunkStorage,
  limits: { fileSize: 5 * 1024 * 1024 },
});

const MAX_FILE_SIZE = 2 * 1024 * 1024 * 1024; // 2GB ceiling for this demo

// Client tells us up front how big the file is and how many chunks it'll
// be split into, so we can reject anything over the size ceiling before
// a single byte is uploaded.
app.post('/api/upload/init', (req, res) => {
  const { filename, fileSize, totalChunks } = req.body;
  if (!filename || !fileSize || !totalChunks) {
    return res.status(400).json({ error: 'filename, fileSize, and totalChunks are required' });
  }
  if (Number(fileSize) > MAX_FILE_SIZE) {
    return res.status(413).json({
      error: `file too large: ${fileSize} bytes exceeds the ${MAX_FILE_SIZE}-byte limit`,
    });
  }
  const uploadId = uuidv4();
  uploads.set(uploadId, {
    filename,
    fileSize: Number(fileSize),
    totalChunks: Number(totalChunks),
    receivedChunks: new Set(),
  });
  res.json({ uploadId });
});

// Lets the client resume after a refresh/network drop by diffing
// "chunks the server already has" against "chunks the file needs".
app.get('/api/upload/status/:uploadId', (req, res) => {
  const upload = uploads.get(req.params.uploadId);
  if (!upload) return res.status(404).json({ error: 'unknown uploadId' });
  res.json({
    totalChunks: upload.totalChunks,
    receivedChunks: Array.from(upload.receivedChunks),
  });
});

app.post('/api/upload/chunk', (req, res) => {
  uploadChunk.single('chunk')(req, res, (err) => {
    if (err instanceof multer.MulterError) {
      return res.status(413).json({ error: `chunk rejected: ${err.message}` });
    }
    if (err) return res.status(500).json({ error: err.message });

    const { uploadId, chunkIndex } = req.body;
    const upload = uploads.get(uploadId);
    if (!upload) return res.status(404).json({ error: 'unknown uploadId' });
    upload.receivedChunks.add(Number(chunkIndex));
    res.json({ received: upload.receivedChunks.size, total: upload.totalChunks });
  });
});

// Concatenates chunks in order into a final file, then kicks off
// transcoding in the background without blocking the response.
app.post('/api/upload/complete', async (req, res) => {
  const { uploadId } = req.body;
  const upload = uploads.get(uploadId);
  if (!upload) return res.status(404).json({ error: 'unknown uploadId' });

  const missing = [...Array(upload.totalChunks).keys()].filter(
    (i) => !upload.receivedChunks.has(i)
  );
  if (missing.length) {
    return res.status(400).json({ error: 'missing chunks', missing });
  }

  const videoId = uuidv4();
  const ext = path.extname(upload.filename) || '.mp4';
  const finalPath = path.join(RAW_DIR, `${videoId}${ext}`);

  try {
    const writeStream = fs.createWriteStream(finalPath);
    for (let i = 0; i < upload.totalChunks; i++) {
      const chunkPath = path.join(TMP_DIR, uploadId, `chunk-${i}`);
      const data = await fsp.readFile(chunkPath);
      writeStream.write(data);
    }
    await new Promise((resolve, reject) => {
      writeStream.end(resolve);
      writeStream.on('error', reject);
    });

    await fsp.rm(path.join(TMP_DIR, uploadId), { recursive: true, force: true });
    uploads.delete(uploadId);

    jobs.set(videoId, { status: 'queued', renditions: {}, error: null });
    res.json({ videoId });

    transcodeToHLS(finalPath, videoId).catch((err) => {
      const job = jobs.get(videoId);
      if (job) {
        job.status = 'error';
        job.error = err.message;
      }
      console.error(`Transcode failed for ${videoId}:`, err.message);
    });
  } catch (err) {
    res.status(500).json({ error: 'failed to assemble upload', detail: err.message });
  }
});

// ---------------------------------------------------------------------------
// 2 & 3. FFmpeg transcoding pipeline -> adaptive bitrate HLS
// ---------------------------------------------------------------------------

const RENDITIONS = [
  { name: '1080p', height: 1080, videoBitrate: '5000k', audioBitrate: '192k', bandwidth: 5128000, resolution: '1920x1080' },
  { name: '720p', height: 720, videoBitrate: '2800k', audioBitrate: '128k', bandwidth: 2928000, resolution: '1280x720' },
  { name: '480p', height: 480, videoBitrate: '1400k', audioBitrate: '128k', bandwidth: 1528000, resolution: '854x480' },
  { name: '360p', height: 360, videoBitrate: '800k', audioBitrate: '96k', bandwidth: 896000, resolution: '640x360' },
];

function probeHeight(filePath) {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(filePath, (err, data) => {
      if (err) return reject(err);
      const stream = (data.streams || []).find((s) => s.codec_type === 'video');
      resolve(stream ? stream.height : 0);
    });
  });
}

function transcodeRendition(inputPath, outDir, rendition) {
  const renditionDir = path.join(outDir, rendition.name);
  fs.mkdirSync(renditionDir, { recursive: true });

  return new Promise((resolve, reject) => {
    ffmpeg(inputPath)
      .videoCodec('libx264')
      .audioCodec('aac')
      .size(`?x${rendition.height}`)
      .videoBitrate(rendition.videoBitrate)
      .audioBitrate(rendition.audioBitrate)
      .outputOptions([
        '-preset', 'veryfast',
        '-g', '48',
        '-sc_threshold', '0',
        '-hls_time', '6',
        '-hls_playlist_type', 'vod',
        '-hls_segment_filename', path.join(renditionDir, 'segment-%03d.ts'),
      ])
      .output(path.join(renditionDir, 'playlist.m3u8'))
      .on('end', resolve)
      .on('error', reject)
      .run();
  });
}

function writeMasterPlaylist(outDir, renditions) {
  let content = '#EXTM3U\n#EXT-X-VERSION:3\n';
  for (const r of renditions) {
    content += `#EXT-X-STREAM-INF:BANDWIDTH=${r.bandwidth},RESOLUTION=${r.resolution}\n`;
    content += `${r.name}/playlist.m3u8\n`;
  }
  fs.writeFileSync(path.join(outDir, 'master.m3u8'), content);
}

async function transcodeToHLS(inputPath, videoId) {
  const job = jobs.get(videoId);
  job.status = 'processing';

  const outDir = path.join(VIDEOS_DIR, videoId);
  fs.mkdirSync(outDir, { recursive: true });

  const sourceHeight = await probeHeight(inputPath);
  // Never upscale a low-res source; always keep at least the smallest rendition.
  const targets = RENDITIONS.filter(
    (r, i) => r.height <= sourceHeight || i === RENDITIONS.length - 1
  );

  for (const rendition of targets) {
    job.renditions[rendition.name] = 'processing';
    await transcodeRendition(inputPath, outDir, rendition);
    job.renditions[rendition.name] = 'ready';
  }

  writeMasterPlaylist(outDir, targets);
  job.status = 'ready';
}

app.get('/api/videos/:videoId/status', (req, res) => {
  const job = jobs.get(req.params.videoId);
  if (!job) return res.status(404).json({ error: 'unknown videoId' });
  res.json(job);
});

// ---------------------------------------------------------------------------
// 4. Serving: CDN-style caching for HLS output + manual range requests
// ---------------------------------------------------------------------------

// Segments (.ts) are immutable once written, so they get a long, cacheable
// lifetime -- exactly what a real CDN edge would do. Playlists (.m3u8) are
// left uncached since they can still be rewritten while a job is processing.
app.use(
  '/videos',
  express.static(VIDEOS_DIR, {
    setHeaders: (res, filePath) => {
      if (filePath.endsWith('.m3u8')) {
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
      } else if (filePath.endsWith('.ts')) {
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      }
    },
  })
);

// Manual HTTP range-request handling for the original file, so a browser
// can seek/scrub via progressive download even before HLS renditions
// exist (or as a fallback for browsers that don't run hls.js).
app.get('/raw/:videoId', (req, res) => {
  const file = fs.readdirSync(RAW_DIR).find((f) => f.startsWith(req.params.videoId));
  if (!file) return res.status(404).end();

  const filePath = path.join(RAW_DIR, file);
  const stat = fs.statSync(filePath);
  const range = req.headers.range;

  if (!range) {
    res.writeHead(200, { 'Content-Length': stat.size, 'Content-Type': 'video/mp4' });
    return fs.createReadStream(filePath).pipe(res);
  }

  const [startStr, endStr] = range.replace(/bytes=/, '').split('-');
  const start = parseInt(startStr, 10);
  const end = endStr ? parseInt(endStr, 10) : stat.size - 1;

  res.writeHead(206, {
    'Content-Range': `bytes ${start}-${end}/${stat.size}`,
    'Accept-Ranges': 'bytes',
    'Content-Length': end - start + 1,
    'Content-Type': 'video/mp4',
  });
  fs.createReadStream(filePath, { start, end }).pipe(res);
});

app.use(express.static(path.join(ROOT, 'public')));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Video streaming platform running at http://localhost:${PORT}`);
});
