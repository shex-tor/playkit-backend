// server.js - PLAYKIT Movie Download Server
// Run: npm install express cors ytdl-core fluent-ffmpeg @ffmpeg-installer/ffmpeg axios

const express  = require('express');
const cors     = require('cors');
const ytdl     = require('ytdl-core');
const ffmpeg   = require('fluent-ffmpeg');
const ffmpegI  = require('@ffmpeg-installer/ffmpeg');
const fs       = require('fs');
const path     = require('path');
const axios    = require('axios');
const os       = require('os');

ffmpeg.setFfmpegPath(ffmpegI.path);

const app  = express();
const PORT = process.env.PORT || 3000;

// ================================================================
// CORS — MUST be the VERY FIRST middleware, before everything else.
// Using open wildcard (*) so Railway sleeping/wake-up pages and any
// frontend origin can always reach the server.
// ================================================================
app.use(cors({
    origin: '*',                   // allow all origins
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'Accept'],
    exposedHeaders: ['Content-Length', 'Content-Disposition', 'X-Exact-Size', 'X-Movie-Title']
}));

// Handle all OPTIONS pre-flight requests immediately
app.options('*', (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, Accept');
    res.sendStatus(204);
});

// Body parser AFTER cors
app.use(express.json());
app.use(express.static('public'));

// ================================================================
// CONFIG
// ================================================================
const TMDB_KEY = '480f73d92f9395eb2140f092c746b3bc';
const TEMP_DIR = path.join(os.tmpdir(), 'playkit-downloads');
if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });

// ================================================================
// QUALITY PRESETS  (H.265/HEVC — sizeFactor = MB per runtime minute)
// ================================================================
const QUALITY_PRESETS = {
    '240p':  { bitrate: '300k',  audioBitrate: '64k',  resolution: '426:240',  label: '240p (H.265)',  sizeFactor: 0.27 },
    '360p':  { bitrate: '450k',  audioBitrate: '64k',  resolution: '640:360',  label: '360p (H.265)',  sizeFactor: 0.38 },
    '480p':  { bitrate: '600k',  audioBitrate: '96k',  resolution: '854:480',  label: '480p (H.265)',  sizeFactor: 0.52 },
    '720p':  { bitrate: '900k',  audioBitrate: '96k',  resolution: '1280:720', label: '720p (H.265)',  sizeFactor: 0.75 },
    '1080p': { bitrate: '1400k', audioBitrate: '128k', resolution: '1920:1080',label: '1080p (H.265)', sizeFactor: 1.15 }
};

function clampMB(mb)       { return Math.min(1400, Math.max(240, Math.round(mb))); }
function sizeText(mb)      { return mb >= 1024 ? `${(mb / 1024).toFixed(2)} GB` : `${mb} MB`; }
function cleanup(...files) { files.forEach(f => { try { if (f && fs.existsSync(f)) fs.unlinkSync(f); } catch {} }); }

// ================================================================
// ROUTES
// ================================================================

/**
 * GET /api/health
 * Frontend pings this first to wake Railway up before opening the
 * download modal — avoids the "no CORS headers on wake-up" problem.
 */
app.get('/api/health', (_req, res) => {
    res.json({ status: 'ok', message: 'PLAYKIT server is running', ts: Date.now() });
});

/**
 * GET /api/movie/:id
 * Full TMDB movie object + trailerKey
 */
app.get('/api/movie/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const [mRes, vRes] = await Promise.all([
            axios.get(`https://api.themoviedb.org/3/movie/${id}?api_key=${TMDB_KEY}`),
            axios.get(`https://api.themoviedb.org/3/movie/${id}/videos?api_key=${TMDB_KEY}`)
        ]);
        const trailer = vRes.data.results.find(v => v.type === 'Trailer' && v.site === 'YouTube');
        res.json({ ...mRes.data, trailerKey: trailer?.key || null });
    } catch (err) {
        console.error('[/api/movie] error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

/**
 * GET /api/download/options/:id
 * Returns quality options with estimated sizes based on movie runtime.
 * Called when the Download modal opens.
 */
app.get('/api/download/options/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const mRes     = await axios.get(`https://api.themoviedb.org/3/movie/${id}?api_key=${TMDB_KEY}`);
        const movie    = mRes.data;
        const duration = movie.runtime || 120;

        const options = Object.entries(QUALITY_PRESETS).map(([key, p]) => {
            const mb = clampMB(duration * p.sizeFactor);
            return {
                quality:      key,
                label:        p.label,
                size:         mb,
                sizeText:     sizeText(mb),
                bitrate:      p.bitrate,
                audioBitrate: p.audioBitrate,
                resolution:   p.resolution
            };
        });

        res.json({
            movie: {
                id:      movie.id,
                title:   movie.title,
                runtime: duration,
                poster:  `https://image.tmdb.org/t/p/w500${movie.poster_path}`,
                year:    movie.release_date?.substring(0, 4)
            },
            options
        });
    } catch (err) {
        console.error('[/api/download/options] error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

/**
 * GET /api/download
 * Streams a transcoded H.265 mp4 to the browser.
 *
 * Query params:
 *   movieId  — TMDB movie ID
 *   quality  — 240p | 360p | 480p | 720p | 1080p
 *   title    — filename-safe string
 */
app.get('/api/download', async (req, res) => {
    let tempIn  = null;
    let tempOut = null;

    try {
        const { movieId, quality, title } = req.query;

        if (!movieId || !quality || !title) {
            return res.status(400).json({ error: 'Missing params: movieId, quality, title' });
        }

        const preset = QUALITY_PRESETS[quality];
        if (!preset) {
            return res.status(400).json({
                error: `Invalid quality "${quality}". Use: ${Object.keys(QUALITY_PRESETS).join(', ')}`
            });
        }

        // Fetch movie runtime + trailer key in parallel
        const [mRes, vRes] = await Promise.all([
            axios.get(`https://api.themoviedb.org/3/movie/${movieId}?api_key=${TMDB_KEY}`),
            axios.get(`https://api.themoviedb.org/3/movie/${movieId}/videos?api_key=${TMDB_KEY}`)
        ]);

        const movie    = mRes.data;
        const duration = movie.runtime || 120;
        const sizeMB   = clampMB(duration * preset.sizeFactor);
        const trailer  = vRes.data.results.find(v => v.type === 'Trailer' && v.site === 'YouTube');

        if (!trailer) {
            return res.status(404).json({ error: 'No YouTube trailer found — cannot generate download.' });
        }

        const safeTitle = (title || 'movie').replace(/[^a-z0-9_]/gi, '_');
        const ts        = Date.now();
        tempIn          = path.join(TEMP_DIR, `in_${ts}.mp4`);
        tempOut         = path.join(TEMP_DIR, `out_${ts}.mp4`);

        // Set response headers (Content-Length lets the browser show a progress %)
        res.setHeader('Content-Type',        'video/mp4');
        res.setHeader('Content-Disposition', `attachment; filename="${safeTitle}_${quality}.mp4"`);
        res.setHeader('Content-Length',      sizeMB * 1024 * 1024);
        res.setHeader('X-Exact-Size',        sizeMB);
        res.setHeader('X-Movie-Title',       movie.title);

        const ytUrl = `https://www.youtube.com/watch?v=${trailer.key}`;
        console.log(`[Download] "${movie.title}" ${quality} → source: ${ytUrl}`);

        // Step 1: Download YouTube stream to temp file
        const ytStream = ytdl(ytUrl, {
            quality: 'highestvideo',
            filter:  fmt => fmt.hasVideo && fmt.hasAudio
        });
        const writeStream = fs.createWriteStream(tempIn);

        await new Promise((resolve, reject) => {
            ytStream.pipe(writeStream);
            ytStream.on('end',   resolve);
            ytStream.on('error', reject);
            writeStream.on('error', reject);
        });

        console.log(`[Download] Source ready (${(fs.statSync(tempIn).size / 1048576).toFixed(1)} MB). Transcoding...`);

        // Step 2: Transcode with ffmpeg then stream output to client
        await new Promise((resolve, reject) => {
            ffmpeg(tempIn)
                .videoCodec('libx265')
                .audioCodec('aac')
                .videoBitrate(preset.bitrate)
                .audioBitrate(preset.audioBitrate)
                .size(preset.resolution)
                .autopad()
                .outputOptions([
                    '-movflags', 'frag_keyframe+empty_moov+default_base_moof',
                    '-preset',   'ultrafast',
                    '-tune',     'fastdecode'
                ])
                .format('mp4')
                .on('start',    cmd  => console.log('[ffmpeg cmd]', cmd))
                .on('progress', prog => process.stdout.write(`\r[ffmpeg] ${Math.round(prog.percent || 0)}%`))
                .on('end', () => {
                    console.log('\n[ffmpeg] Done.');
                    const readStream = fs.createReadStream(tempOut);
                    readStream.pipe(res);
                    readStream.on('end',   () => { cleanup(tempIn, tempOut); resolve(); });
                    readStream.on('error', err => { cleanup(tempIn, tempOut); reject(err); });
                })
                .on('error', err => { cleanup(tempIn, tempOut); reject(err); })
                .save(tempOut);
        });

    } catch (err) {
        console.error('[/api/download] error:', err.message);
        cleanup(tempIn, tempOut);
        if (!res.headersSent) {
            res.status(500).json({ error: err.message });
        } else {
            res.end();
        }
    }
});

/**
 * GET /api/download/progress/:id  (Server-Sent Events)
 * Simulated progress feed. Wire up to a real event emitter for
 * accurate ffmpeg progress in production.
 */
app.get('/api/download/progress/:id', (req, res) => {
    res.setHeader('Content-Type',  'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection',    'keep-alive');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.flushHeaders();

    let pct = 0;
    const iv = setInterval(() => {
        pct += Math.random() * 8 + 2;
        if (pct >= 100) {
            pct = 100;
            clearInterval(iv);
            res.write(`data: ${JSON.stringify({ progress: 100, completed: true })}\n\n`);
            res.end();
        } else {
            res.write(`data: ${JSON.stringify({ progress: Math.round(pct), downloadedMB: Math.round(pct * 1.5) })}\n\n`);
        }
    }, 800);

    req.on('close', () => clearInterval(iv));
});

/**
 * GET /api/downloads/history
 */
app.get('/api/downloads/history', (_req, res) => {
    const file = path.join(TEMP_DIR, 'history.json');
    res.json(fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : []);
});

/**
 * POST /api/downloads/history
 */
app.post('/api/downloads/history', (req, res) => {
    const { movie, quality, size } = req.body;
    const file = path.join(TEMP_DIR, 'history.json');
    let history = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : [];
    history.push({ ...movie, quality, size, downloadedAt: new Date().toISOString(), id: Date.now() });
    if (history.length > 20) history = history.slice(-20);
    fs.writeFileSync(file, JSON.stringify(history, null, 2));
    res.json({ success: true, history });
});

// ================================================================
// START
// ================================================================
app.listen(PORT, () => {
    console.log(`
╔══════════════════════════════════════════╗
║        PLAYKIT Download Server           ║
║   Running on http://localhost:${PORT}    ║
║                                          ║
║  GET  /api/health                        ║
║  GET  /api/movie/:id                     ║
║  GET  /api/download/options/:id          ║
║  GET  /api/download                      ║
║  GET  /api/download/progress/:id (SSE)   ║
║  GET  /api/downloads/history             ║
║  POST /api/downloads/history             ║
╚══════════════════════════════════════════╝
    `);
});
