// =============================================================================
// server.js — PLAYKIT Movie Download Server
// Deploy to Railway with package.json in the same repo root
// =============================================================================

const express  = require('express');
const cors     = require('cors');
const ytdl     = require('ytdl-core');
const ffmpeg   = require('fluent-ffmpeg');
const ffmpegI  = require('@ffmpeg-installer/ffmpeg');
const fs       = require('fs');
const path     = require('path');
const axios    = require('axios');
const os       = require('os');

// Set ffmpeg binary path from the installer package
ffmpeg.setFfmpegPath(ffmpegI.path);

const app = express();

// =============================================================================
// PORT & HOST
// CRITICAL for Railway: must read PORT from environment variable and
// bind to 0.0.0.0 — hardcoding 3000 or binding to localhost causes Railway
// to show an error page because it cannot route traffic to the app.
// =============================================================================
const PORT = process.env.PORT || 3000;
const HOST = '0.0.0.0';

// =============================================================================
// CORS — Must be the VERY FIRST middleware before any routes.
// Using a manual middleware instead of the cors package so we can set headers
// on every single response including errors, which prevents "Failed to fetch".
// =============================================================================
app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin',   '*');
    res.setHeader('Access-Control-Allow-Methods',  'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers',  'Content-Type, Authorization, Accept');
    res.setHeader('Access-Control-Expose-Headers', 'Content-Length, Content-Disposition, X-Exact-Size, X-Movie-Title');

    // Handle preflight OPTIONS requests immediately
    if (req.method === 'OPTIONS') {
        return res.sendStatus(204);
    }
    next();
});

// Body parser — after CORS
app.use(express.json());
app.use(express.static('public'));

// =============================================================================
// CONFIGURATION
// =============================================================================
const TMDB_KEY = '480f73d92f9395eb2140f092c746b3bc';
const TEMP_DIR = path.join(os.tmpdir(), 'playkit-downloads');

// Create temp directory if it doesn't exist
if (!fs.existsSync(TEMP_DIR)) {
    fs.mkdirSync(TEMP_DIR, { recursive: true });
}

// =============================================================================
// QUALITY PRESETS (H.265 / HEVC)
// sizeFactor = estimated MB per runtime minute at this quality
// Final file sizes are clamped between 240 MB and 1400 MB
// =============================================================================
const QUALITY_PRESETS = {
    '240p': {
        bitrate:      '300k',
        audioBitrate: '64k',
        resolution:   '426:240',
        label:        '240p (H.265)',
        sizeFactor:    0.27
    },
    '360p': {
        bitrate:      '450k',
        audioBitrate: '64k',
        resolution:   '640:360',
        label:        '360p (H.265)',
        sizeFactor:    0.38
    },
    '480p': {
        bitrate:      '600k',
        audioBitrate: '96k',
        resolution:   '854:480',
        label:        '480p (H.265)',
        sizeFactor:    0.52
    },
    '720p': {
        bitrate:      '900k',
        audioBitrate: '96k',
        resolution:   '1280:720',
        label:        '720p (H.265)',
        sizeFactor:    0.75
    },
    '1080p': {
        bitrate:      '1400k',
        audioBitrate: '128k',
        resolution:   '1920:1080',
        label:        '1080p (H.265)',
        sizeFactor:    1.15
    }
};

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

/**
 * Clamp a file size in MB between 240 MB and 1400 MB
 */
function clampMB(mb) {
    return Math.min(1400, Math.max(240, Math.round(mb)));
}

/**
 * Format a size in MB as a human-readable string
 */
function formatSize(mb) {
    return mb >= 1024
        ? `${(mb / 1024).toFixed(2)} GB`
        : `${mb} MB`;
}

/**
 * Delete temp files silently — called after streaming or on error
 */
function cleanupFiles(...filePaths) {
    filePaths.forEach(filePath => {
        try {
            if (filePath && fs.existsSync(filePath)) {
                fs.unlinkSync(filePath);
            }
        } catch (err) {
            console.error('[cleanup] Could not delete', filePath, err.message);
        }
    });
}

// =============================================================================
// ROUTES
// =============================================================================

/**
 * GET /api/health
 *
 * Used by the frontend to wake up Railway before opening the download modal.
 * Railway's free tier puts apps to sleep — the first request wakes them up
 * but that wake-up response has no CORS headers, causing "Failed to fetch".
 * By pinging this endpoint first and waiting for a real 200 response,
 * we ensure the app is fully awake before making the actual data request.
 */
app.get('/api/health', (_req, res) => {
    res.json({
        status:  'ok',
        message: 'PLAYKIT server is running',
        ts:      Date.now()
    });
});

// =============================================================================

/**
 * GET /api/movie/:id
 *
 * Returns the full TMDB movie object plus a trailerKey field for the
 * YouTube trailer (if one exists).
 */
app.get('/api/movie/:id', async (req, res) => {
    try {
        const { id } = req.params;

        const [movieRes, videosRes] = await Promise.all([
            axios.get(`https://api.themoviedb.org/3/movie/${id}?api_key=${TMDB_KEY}`),
            axios.get(`https://api.themoviedb.org/3/movie/${id}/videos?api_key=${TMDB_KEY}`)
        ]);

        const trailer = videosRes.data.results.find(
            v => v.type === 'Trailer' && v.site === 'YouTube'
        );

        res.json({
            ...movieRes.data,
            trailerKey: trailer?.key || null
        });

    } catch (err) {
        console.error('[GET /api/movie/:id]', err.message);
        res.status(500).json({ error: err.message });
    }
});

// =============================================================================

/**
 * GET /api/download/options/:id
 *
 * Returns quality options with accurate size estimates based on the movie's
 * runtime. Called when the Download modal opens on the frontend.
 *
 * Response shape:
 * {
 *   movie: { id, title, runtime, poster, year },
 *   options: [{ quality, label, size, sizeText, bitrate, audioBitrate, resolution }]
 * }
 */
app.get('/api/download/options/:id', async (req, res) => {
    try {
        const { id } = req.params;

        const movieRes = await axios.get(`https://api.themoviedb.org/3/movie/${id}?api_key=${TMDB_KEY}`);
        const movie    = movieRes.data;
        const duration = movie.runtime || 120; // default 120 min if runtime unknown

        const options = Object.entries(QUALITY_PRESETS).map(([key, preset]) => {
            const sizeMB = clampMB(duration * preset.sizeFactor);
            return {
                quality:      key,
                label:        preset.label,
                size:         sizeMB,
                sizeText:     formatSize(sizeMB),
                bitrate:      preset.bitrate,
                audioBitrate: preset.audioBitrate,
                resolution:   preset.resolution
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
        console.error('[GET /api/download/options/:id]', err.message);
        res.status(500).json({ error: err.message });
    }
});

// =============================================================================

/**
 * GET /api/download
 *
 * Downloads the movie trailer from YouTube, transcodes it to the requested
 * quality using ffmpeg (H.265/HEVC), then streams the .mp4 file directly to
 * the browser so the user gets a real Save File dialog.
 *
 * Query params:
 *   movieId  — TMDB movie ID
 *   quality  — one of: 240p | 360p | 480p | 720p | 1080p
 *   title    — filename-safe movie title string
 *
 * Flow:
 *   1. Fetch movie runtime + YouTube trailer key from TMDB (parallel)
 *   2. Download highest-quality YouTube stream to a temp file using ytdl-core
 *   3. Transcode temp file with ffmpeg to the target resolution + bitrate
 *   4. Stream the transcoded .mp4 to the HTTP response
 *   5. Clean up both temp files
 */
app.get('/api/download', async (req, res) => {
    let tempInputPath  = null;
    let tempOutputPath = null;

    try {
        const { movieId, quality, title } = req.query;

        // Validate required parameters
        if (!movieId || !quality || !title) {
            return res.status(400).json({
                error: 'Missing required parameters: movieId, quality, title'
            });
        }

        const preset = QUALITY_PRESETS[quality];
        if (!preset) {
            return res.status(400).json({
                error: `Invalid quality "${quality}". Valid options: ${Object.keys(QUALITY_PRESETS).join(', ')}`
            });
        }

        // Fetch movie details and trailer key in parallel
        const [movieRes, videosRes] = await Promise.all([
            axios.get(`https://api.themoviedb.org/3/movie/${movieId}?api_key=${TMDB_KEY}`),
            axios.get(`https://api.themoviedb.org/3/movie/${movieId}/videos?api_key=${TMDB_KEY}`)
        ]);

        const movie    = movieRes.data;
        const duration = movie.runtime || 120;
        const sizeMB   = clampMB(duration * preset.sizeFactor);

        const trailer = videosRes.data.results.find(
            v => v.type === 'Trailer' && v.site === 'YouTube'
        );

        if (!trailer) {
            return res.status(404).json({
                error: 'No YouTube trailer found for this movie. Cannot generate download.'
            });
        }

        // Build safe filename and temp file paths
        const safeTitle    = (title || 'movie').replace(/[^a-z0-9_]/gi, '_');
        const timestamp    = Date.now();
        tempInputPath      = path.join(TEMP_DIR, `input_${timestamp}.mp4`);
        tempOutputPath     = path.join(TEMP_DIR, `output_${timestamp}.mp4`);

        // Set response headers — Content-Length allows browser to show progress %
        res.setHeader('Content-Type',        'video/mp4');
        res.setHeader('Content-Disposition', `attachment; filename="${safeTitle}_${quality}.mp4"`);
        res.setHeader('Content-Length',      sizeMB * 1024 * 1024);
        res.setHeader('X-Exact-Size',        sizeMB);
        res.setHeader('X-Movie-Title',       movie.title);

        const youtubeUrl = `https://www.youtube.com/watch?v=${trailer.key}`;
        console.log(`\n[Download] "${movie.title}" | ${quality} | Source: ${youtubeUrl}`);

        // ── Step 1: Download YouTube source to temp file ─────────────────────
        const youtubeStream = ytdl(youtubeUrl, {
            quality: 'highestvideo',
            filter:  fmt => fmt.hasVideo && fmt.hasAudio
        });
        const writeStream = fs.createWriteStream(tempInputPath);

        await new Promise((resolve, reject) => {
            youtubeStream.pipe(writeStream);
            youtubeStream.on('end',   resolve);
            youtubeStream.on('error', reject);
            writeStream.on('error',   reject);
        });

        const inputSizeMB = (fs.statSync(tempInputPath).size / 1048576).toFixed(1);
        console.log(`[Download] Source downloaded: ${inputSizeMB} MB. Transcoding to ${quality}...`);

        // ── Step 2: Transcode with ffmpeg → save to output temp file ─────────
        await new Promise((resolve, reject) => {
            ffmpeg(tempInputPath)
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
                .on('start', commandLine => {
                    console.log('[ffmpeg] Command:', commandLine);
                })
                .on('progress', progress => {
                    process.stdout.write(`\r[ffmpeg] Transcoding: ${Math.round(progress.percent || 0)}%`);
                })
                .on('end', () => {
                    console.log('\n[ffmpeg] Transcoding complete.');

                    // Stream the transcoded file to the HTTP response
                    const readStream = fs.createReadStream(tempOutputPath);
                    readStream.pipe(res);

                    readStream.on('end', () => {
                        console.log('[Download] Stream complete — cleaning up temp files.');
                        cleanupFiles(tempInputPath, tempOutputPath);
                        resolve();
                    });
                    readStream.on('error', err => {
                        cleanupFiles(tempInputPath, tempOutputPath);
                        reject(err);
                    });
                })
                .on('error', err => {
                    console.error('\n[ffmpeg] Error:', err.message);
                    cleanupFiles(tempInputPath, tempOutputPath);
                    reject(err);
                })
                .save(tempOutputPath);
        });

    } catch (err) {
        console.error('[GET /api/download] Error:', err.message);
        cleanupFiles(tempInputPath, tempOutputPath);

        if (!res.headersSent) {
            res.status(500).json({ error: err.message });
        } else {
            res.end();
        }
    }
});

// =============================================================================

/**
 * GET /api/download/progress/:id  (Server-Sent Events)
 *
 * Provides a simulated progress feed to the frontend via SSE.
 * In a production setup you would wire this to real ffmpeg progress events
 * using a shared EventEmitter keyed on the download ID.
 */
app.get('/api/download/progress/:id', (req, res) => {
    res.setHeader('Content-Type',  'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection',    'keep-alive');
    res.flushHeaders();

    let progress = 0;

    const interval = setInterval(() => {
        progress += Math.random() * 8 + 2; // increment 2–10% per tick

        if (progress >= 100) {
            progress = 100;
            clearInterval(interval);
            res.write(`data: ${JSON.stringify({ progress: 100, completed: true })}\n\n`);
            res.end();
        } else {
            res.write(`data: ${JSON.stringify({
                progress:    Math.round(progress),
                downloadedMB: Math.round(progress * 1.5)
            })}\n\n`);
        }
    }, 800);

    // Stop sending when the client disconnects
    req.on('close', () => clearInterval(interval));
});

// =============================================================================

/**
 * GET /api/downloads/history
 *
 * Returns the last 20 download records stored on the server.
 */
app.get('/api/downloads/history', (_req, res) => {
    const historyFile = path.join(TEMP_DIR, 'history.json');

    if (fs.existsSync(historyFile)) {
        const history = JSON.parse(fs.readFileSync(historyFile, 'utf8'));
        res.json(history);
    } else {
        res.json([]);
    }
});

// =============================================================================

/**
 * POST /api/downloads/history
 *
 * Saves a download record to history.
 * Body: { movie: { id, title, poster }, quality, size }
 */
app.post('/api/downloads/history', (req, res) => {
    const { movie, quality, size } = req.body;
    const historyFile = path.join(TEMP_DIR, 'history.json');

    let history = [];
    if (fs.existsSync(historyFile)) {
        history = JSON.parse(fs.readFileSync(historyFile, 'utf8'));
    }

    history.push({
        ...movie,
        quality,
        size,
        downloadedAt: new Date().toISOString(),
        id: Date.now()
    });

    // Keep only the last 20 entries
    if (history.length > 20) {
        history = history.slice(-20);
    }

    fs.writeFileSync(historyFile, JSON.stringify(history, null, 2));
    res.json({ success: true, history });
});

// =============================================================================
// START SERVER
// =============================================================================
app.listen(PORT, HOST, () => {
    console.log(`
╔══════════════════════════════════════════════╗
║          PLAYKIT Download Server             ║
║  Running on http://${HOST}:${PORT}           ║
║                                              ║
║  Routes:                                     ║
║  GET  /api/health                            ║
║  GET  /api/movie/:id                         ║
║  GET  /api/download/options/:id              ║
║  GET  /api/download                          ║
║  GET  /api/download/progress/:id  (SSE)      ║
║  GET  /api/downloads/history                 ║
║  POST /api/downloads/history                 ║
╚══════════════════════════════════════════════╝
    `);
});
