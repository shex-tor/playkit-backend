// server.js - PLAYKIT Movie Download Server
// Run with: npm install express cors ytdl-core fluent-ffmpeg @ffmpeg-installer/ffmpeg axios

const express = require('express');
const cors    = require('cors');
const ytdl    = require('ytdl-core');
const ffmpeg  = require('fluent-ffmpeg');
const ffmpegI = require('@ffmpeg-installer/ffmpeg');
const fs      = require('fs');
const path    = require('path');
const axios   = require('axios');
const os      = require('os');

ffmpeg.setFfmpegPath(ffmpegI.path);

const app  = express();
const PORT = process.env.PORT || 3000;

// ================================================================
// CORS — allow your Netlify frontend + localhost dev
// ================================================================
const ALLOWED_ORIGINS = [
    'https://playkitmovies.netlify.app',
    'http://localhost:3000',
    'http://127.0.0.1:5500'   // Live Server / VS Code
];

app.use(cors({
    origin: (origin, cb) => {
        // allow requests with no origin (e.g. mobile apps, curl)
        if (!origin || ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
        cb(new Error(`CORS policy: origin ${origin} not allowed`));
    },
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    exposedHeaders: ['Content-Length', 'Content-Disposition', 'X-Exact-Size'],
    credentials: true
}));

app.options('*', cors());   // pre-flight
app.use(express.json());
app.use(express.static('public'));

// ================================================================
// CONFIG
// ================================================================
const TMDB_API_KEY = '480f73d92f9395eb2140f092c746b3bc';
const TEMP_DIR     = path.join(os.tmpdir(), 'playkit-downloads');

if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });

// ================================================================
// QUALITY PRESETS  (H.265 / HEVC — sizes in MB per runtime minute)
// ================================================================
const QUALITY_PRESETS = {
    '240p':  { bitrate: '300k',  audioBitrate: '64k',  resolution: '426:240',  label: '240p (H.265)',  sizeFactor: 0.27 },
    '360p':  { bitrate: '450k',  audioBitrate: '64k',  resolution: '640:360',  label: '360p (H.265)',  sizeFactor: 0.38 },
    '480p':  { bitrate: '600k',  audioBitrate: '96k',  resolution: '854:480',  label: '480p (H.265)',  sizeFactor: 0.52 },
    '720p':  { bitrate: '900k',  audioBitrate: '96k',  resolution: '1280:720', label: '720p (H.265)',  sizeFactor: 0.75 },
    '1080p': { bitrate: '1400k', audioBitrate: '128k', resolution: '1920:1080',label: '1080p (H.265)', sizeFactor: 1.15 }
};

// ================================================================
// HELPERS
// ================================================================
function clampSize(mb) {
    return Math.min(1400, Math.max(240, Math.round(mb)));
}

function buildSizeText(mb) {
    return mb >= 1024 ? `${(mb / 1024).toFixed(2)} GB` : `${mb} MB`;
}

// ================================================================
// ROUTES
// ================================================================

/**
 * GET /api/health
 * Simple health check — frontend can ping this before showing download UI
 */
app.get('/api/health', (_req, res) => {
    res.json({ status: 'ok', message: 'PLAYKIT download server is running' });
});

/**
 * GET /api/movie/:id
 * Full TMDB movie object + trailerKey
 */
app.get('/api/movie/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const [movieRes, videosRes] = await Promise.all([
            axios.get(`https://api.themoviedb.org/3/movie/${id}?api_key=${TMDB_API_KEY}`),
            axios.get(`https://api.themoviedb.org/3/movie/${id}/videos?api_key=${TMDB_API_KEY}`)
        ]);
        const trailer = videosRes.data.results.find(v => v.type === 'Trailer' && v.site === 'YouTube');
        res.json({ ...movieRes.data, trailerKey: trailer?.key || null });
    } catch (err) {
        console.error('Movie details error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

/**
 * GET /api/download/options/:id
 * Returns quality options with accurate size estimates based on movie runtime.
 * This is what the frontend calls first when the Download modal opens.
 */
app.get('/api/download/options/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const movieRes = await axios.get(`https://api.themoviedb.org/3/movie/${id}?api_key=${TMDB_API_KEY}`);
        const movie    = movieRes.data;
        const duration = movie.runtime || 120;

        const options = Object.entries(QUALITY_PRESETS).map(([key, preset]) => {
            const sizeMB = clampSize(duration * preset.sizeFactor);
            return {
                quality:       key,
                label:         preset.label,
                size:          sizeMB,
                sizeText:      buildSizeText(sizeMB),
                bitrate:       preset.bitrate,
                audioBitrate:  preset.audioBitrate,
                resolution:    preset.resolution
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
        console.error('Options error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

/**
 * GET /api/download
 * Streams the transcoded mp4 file back to the browser.
 *
 * Query params:
 *   movieId  — TMDB movie ID
 *   quality  — one of 240p | 360p | 480p | 720p | 1080p
 *   title    — safe filename (alphanumeric + underscores)
 *
 * Flow:
 *   1. Fetch trailer YouTube key from TMDB
 *   2. Download highest-quality YouTube stream to a temp file
 *   3. Transcode with ffmpeg (H.265, target bitrate, target resolution)
 *   4. Stream the output mp4 to the client
 *   5. Clean up temp files
 */
app.get('/api/download', async (req, res) => {
    let tempIn  = null;
    let tempOut = null;

    try {
        const { movieId, quality, title } = req.query;

        if (!movieId || !quality || !title) {
            return res.status(400).json({ error: 'Missing required params: movieId, quality, title' });
        }

        const preset = QUALITY_PRESETS[quality];
        if (!preset) {
            return res.status(400).json({ error: `Invalid quality "${quality}". Valid: ${Object.keys(QUALITY_PRESETS).join(', ')}` });
        }

        // Get movie details (runtime for size calculation)
        const [movieRes, videosRes] = await Promise.all([
            axios.get(`https://api.themoviedb.org/3/movie/${movieId}?api_key=${TMDB_API_KEY}`),
            axios.get(`https://api.themoviedb.org/3/movie/${movieId}/videos?api_key=${TMDB_API_KEY}`)
        ]);

        const movie    = movieRes.data;
        const duration = movie.runtime || 120;
        const sizeMB   = clampSize(duration * preset.sizeFactor);

        const trailer  = videosRes.data.results.find(v => v.type === 'Trailer' && v.site === 'YouTube');
        if (!trailer) {
            return res.status(404).json({ error: 'No YouTube trailer found for this movie. Cannot generate download.' });
        }

        // Build temp paths
        const ts   = Date.now();
        tempIn     = path.join(TEMP_DIR, `in_${ts}.mp4`);
        tempOut    = path.join(TEMP_DIR, `out_${ts}.mp4`);

        const safeTitle = (title || 'movie').replace(/[^a-z0-9_]/gi, '_');

        // Set response headers before streaming
        res.setHeader('Content-Type', 'video/mp4');
        res.setHeader('Content-Disposition', `attachment; filename="${safeTitle}_${quality}.mp4"`);
        res.setHeader('Content-Length', sizeMB * 1024 * 1024);
        res.setHeader('X-Exact-Size', sizeMB);
        res.setHeader('X-Movie-Title', movie.title);

        const ytUrl = `https://www.youtube.com/watch?v=${trailer.key}`;
        console.log(`[Download] "${movie.title}" ${quality} — fetching source: ${ytUrl}`);

        // 1. Download YouTube video to temp file
        const videoStream = ytdl(ytUrl, {
            quality: 'highestvideo',
            filter: format => format.hasVideo && format.hasAudio
        });
        const writeStream = fs.createWriteStream(tempIn);

        await new Promise((resolve, reject) => {
            videoStream.pipe(writeStream);
            videoStream.on('end',   resolve);
            videoStream.on('error', reject);
            writeStream.on('error', reject);
        });

        console.log(`[Download] Source downloaded (${(fs.statSync(tempIn).size / 1048576).toFixed(1)} MB). Transcoding...`);

        // 2. Transcode with ffmpeg → output file → stream to client
        await new Promise((resolve, reject) => {
            ffmpeg(tempIn)
                .videoCodec('libx265')
                .audioCodec('aac')
                .videoBitrate(preset.bitrate)
                .audioBitrate(preset.audioBitrate)
                .size(preset.resolution)
                .autopad()
                .outputOptions(['-movflags', 'frag_keyframe+empty_moov', '-preset', 'ultrafast'])
                .format('mp4')
                .on('start',    cmd  => console.log('[ffmpeg]', cmd))
                .on('progress', prog => process.stdout.write(`\r[ffmpeg] ${Math.round(prog.percent||0)}%`))
                .on('end', () => {
                    console.log('\n[ffmpeg] Transcoding complete');
                    // Stream the output file to the client
                    const readStream = fs.createReadStream(tempOut);
                    readStream.pipe(res);
                    readStream.on('end',   () => { cleanup(tempIn, tempOut); resolve(); });
                    readStream.on('error', err => { cleanup(tempIn, tempOut); reject(err); });
                })
                .on('error', err => { cleanup(tempIn, tempOut); reject(err); })
                .save(tempOut);
        });

    } catch (err) {
        console.error('[Download error]', err.message);
        cleanup(tempIn, tempOut);
        if (!res.headersSent) {
            res.status(500).json({ error: err.message });
        } else {
            res.end();
        }
    }
});

/**
 * GET /api/download/progress/:id
 * Server-Sent Events — progress simulation.
 * In production, wires up to real ffmpeg progress via a shared event emitter.
 */
app.get('/api/download/progress/:id', (req, res) => {
    res.setHeader('Content-Type',  'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection',    'keep-alive');
    res.flushHeaders();

    let progress = 0;
    const interval = setInterval(() => {
        progress += Math.random() * 8 + 2;
        if (progress >= 100) {
            progress = 100;
            clearInterval(interval);
            res.write(`data: ${JSON.stringify({ progress: 100, completed: true })}\n\n`);
            res.end();
        } else {
            res.write(`data: ${JSON.stringify({ progress: Math.round(progress), downloadedMB: Math.round(progress * 1.5) })}\n\n`);
        }
    }, 800);

    req.on('close', () => clearInterval(interval));
});

/**
 * GET /api/downloads/history
 * Returns the last 20 downloads
 */
app.get('/api/downloads/history', (_req, res) => {
    const file = path.join(TEMP_DIR, 'history.json');
    if (fs.existsSync(file)) {
        res.json(JSON.parse(fs.readFileSync(file, 'utf8')));
    } else {
        res.json([]);
    }
});

/**
 * POST /api/downloads/history
 * Saves a download record  { movie, quality, size }
 */
app.post('/api/downloads/history', (req, res) => {
    const { movie, quality, size } = req.body;
    const file = path.join(TEMP_DIR, 'history.json');

    let history = [];
    if (fs.existsSync(file)) history = JSON.parse(fs.readFileSync(file, 'utf8'));

    history.push({ ...movie, quality, size, downloadedAt: new Date().toISOString(), id: Date.now() });
    if (history.length > 20) history = history.slice(-20);

    fs.writeFileSync(file, JSON.stringify(history, null, 2));
    res.json({ success: true, history });
});

// ================================================================
// HELPERS
// ================================================================
function cleanup(...files) {
    files.forEach(f => {
        try { if (f && fs.existsSync(f)) fs.unlinkSync(f); } catch {}
    });
}

// ================================================================
// START
// ================================================================
app.listen(PORT, () => {
    console.log(`
╔══════════════════════════════════════════╗
║        PLAYKIT Download Server           ║
║   Running on http://localhost:${PORT}    ║
║                                          ║
║  Endpoints:                              ║
║  GET  /api/health                        ║
║  GET  /api/movie/:id                     ║
║  GET  /api/download/options/:id          ║
║  GET  /api/download                      ║
║  GET  /api/download/progress/:id  (SSE)  ║
║  GET  /api/downloads/history             ║
║  POST /api/downloads/history             ║
╚══════════════════════════════════════════╝
    `);
});
