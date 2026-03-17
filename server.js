// =============================================================================
// server.js — PLAYKIT Movie Download Server with Async Job Processing
// Deploy to Railway with package.json in the same repo root
// =============================================================================

const express = require('express');
const ytdl = require('ytdl-core');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegI = require('@ffmpeg-installer/ffmpeg');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const os = require('os');
const crypto = require('crypto');

ffmpeg.setFfmpegPath(ffmpegI.path);

const app = express();
const PORT = process.env.PORT || 3000;
const HOST = '0.0.0.0';

// =============================================================================
// CONFIGURATION
// =============================================================================
const TMDB_KEY = '480f73d92f9395eb2140f092c746b3bc';
const TEMP_DIR = path.join(os.tmpdir(), 'playkit-downloads');
const JOBS_DIR = path.join(TEMP_DIR, 'jobs');
const COMPLETED_DIR = path.join(TEMP_DIR, 'completed');
const HISTORY_FILE = path.join(TEMP_DIR, 'history.json');

// Create directories if they don't exist
[TEMP_DIR, JOBS_DIR, COMPLETED_DIR].forEach(dir => {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

// =============================================================================
// IN-MEMORY JOB STORE (persisted to disk for recovery)
// =============================================================================
const JOBS_FILE = path.join(TEMP_DIR, 'active-jobs.json');
let jobs = new Map();

// Load jobs from disk on startup
try {
    if (fs.existsSync(JOBS_FILE)) {
        const saved = JSON.parse(fs.readFileSync(JOBS_FILE, 'utf8'));
        jobs = new Map(Object.entries(saved));
        console.log(`[Startup] Loaded ${jobs.size} active jobs`);
    }
} catch (err) {
    console.error('[Startup] Failed to load jobs:', err.message);
}

// Save jobs periodically
const saveJobs = () => {
    try {
        const obj = Object.fromEntries(jobs);
        fs.writeFileSync(JOBS_FILE, JSON.stringify(obj, null, 2));
    } catch (err) {
        console.error('[Jobs] Failed to save:', err.message);
    }
};

// =============================================================================
// CORS MIDDLEWARE
// =============================================================================
app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, Accept');
    res.setHeader('Access-Control-Expose-Headers', 'Content-Length, Content-Disposition, X-Exact-Size, X-Movie-Title, X-Job-ID');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
});

app.use(express.json());
app.use(express.static('public'));

// =============================================================================
// QUALITY PRESETS (H.265 / HEVC)
// =============================================================================
const QUALITY_PRESETS = {
    '240p': { bitrate: '300k', audioBitrate: '64k', resolution: '426:240', label: '240p (H.265)', sizeFactor: 0.27 },
    '360p': { bitrate: '450k', audioBitrate: '64k', resolution: '640:360', label: '360p (H.265)', sizeFactor: 0.38 },
    '480p': { bitrate: '600k', audioBitrate: '96k', resolution: '854:480', label: '480p (H.265)', sizeFactor: 0.52 },
    '720p': { bitrate: '900k', audioBitrate: '96k', resolution: '1280:720', label: '720p (H.265)', sizeFactor: 0.75 },
    '1080p': { bitrate: '1400k', audioBitrate: '128k', resolution: '1920:1080', label: '1080p (H.265)', sizeFactor: 1.15 }
};

function clampMB(mb) { return Math.min(1400, Math.max(240, Math.round(mb))); }
function fmtSize(mb) { return mb >= 1024 ? `${(mb / 1024).toFixed(2)} GB` : `${mb} MB`; }
function cleanup(...files) {
    files.forEach(f => {
        try { if (f && fs.existsSync(f)) fs.unlinkSync(f); } catch { }
    });
}

// =============================================================================
// BACKGROUND JOB PROCESSOR
// =============================================================================
async function processDownloadJob(jobId, movieId, quality, title, webhookUrl = null) {
    const job = jobs.get(jobId);
    if (!job) return;

    let tempIn = null;
    let tempOut = null;
    let outputFilename = null;

    try {
        // Update status
        job.status = 'processing';
        job.startedAt = Date.now();
        saveJobs();

        const preset = QUALITY_PRESETS[quality];
        if (!preset) throw new Error(`Invalid quality: ${quality}`);

        // Fetch movie details and trailer
        const [mRes, vRes] = await Promise.all([
            axios.get(`https://api.themoviedb.org/3/movie/${movieId}?api_key=${TMDB_KEY}`),
            axios.get(`https://api.themoviedb.org/3/movie/${movieId}/videos?api_key=${TMDB_KEY}`)
        ]);

        const movie = mRes.data;
        const duration = movie.runtime || 120;
        const sizeMB = clampMB(duration * preset.sizeFactor);
        const trailer = vRes.data.results.find(v => v.type === 'Trailer' && v.site === 'YouTube');

        if (!trailer) throw new Error('No YouTube trailer found');

        // Update job with movie info
        job.movieTitle = movie.title;
        job.moviePoster = movie.poster_path ? `https://image.tmdb.org/t/p/w500${movie.poster_path}` : null;
        job.estimatedSize = sizeMB;
        saveJobs();

        const ytUrl = `https://www.youtube.com/watch?v=${trailer.key}`;
        const safeTitle = (title || movie.title).replace(/[^a-z0-9_]/gi, '_');
        const timestamp = Date.now();

        tempIn = path.join(JOBS_DIR, `in_${jobId}_${timestamp}.mp4`);
        tempOut = path.join(JOBS_DIR, `out_${jobId}_${timestamp}.mp4`);
        outputFilename = `${safeTitle}_${quality}_${timestamp}.mp4`;
        const finalPath = path.join(COMPLETED_DIR, outputFilename);

        console.log(`\n[JOB ${jobId}] Processing "${movie.title}" (${quality})`);

        // Step 1: Download YouTube video
        job.progress = 5;
        job.message = 'Downloading source video...';
        saveJobs();

        const ys = ytdl(ytUrl, { quality: 'highestvideo', filter: f => f.hasVideo && f.hasAudio });
        const ws = fs.createWriteStream(tempIn);

        await new Promise((resolve, reject) => {
            ys.pipe(ws);
            ys.on('end', resolve);
            ys.on('error', reject);
            ws.on('error', reject);
        });

        const sourceSize = (fs.statSync(tempIn).size / 1048576).toFixed(1);
        console.log(`[JOB ${jobId}] Source downloaded: ${sourceSize} MB`);

        // Step 2: Transcode video
        job.progress = 30;
        job.message = 'Transcoding video...';
        saveJobs();

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
                    '-preset', 'ultrafast',
                    '-tune', 'fastdecode'
                ])
                .format('mp4')
                .on('progress', prog => {
                    if (prog.percent) {
                        job.progress = 30 + Math.round(prog.percent * 0.6); // 30-90%
                        saveJobs();
                    }
                })
                .on('end', resolve)
                .on('error', reject)
                .save(tempOut);
        });

        // Step 3: Move to completed folder
        job.progress = 95;
        job.message = 'Finalizing...';
        saveJobs();

        fs.renameSync(tempOut, finalPath);
        const finalSize = fs.statSync(finalPath).size;

        // Step 4: Update job as completed
        job.status = 'completed';
        job.progress = 100;
        job.message = 'Complete';
        job.completedAt = Date.now();
        job.outputFile = outputFilename;
        job.outputPath = finalPath;
        job.outputSize = finalSize;
        job.outputSizeText = fmtSize(finalSize / (1024 * 1024));
        saveJobs();

        // Add to download history
        try {
            let history = [];
            if (fs.existsSync(HISTORY_FILE)) {
                history = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
            }
            history.push({
                id: jobId,
                movieId: movie.id,
                title: movie.title,
                quality,
                size: finalSize,
                sizeText: fmtSize(finalSize / (1024 * 1024)),
                downloadedAt: new Date().toISOString(),
                filename: outputFilename
            });
            if (history.length > 50) history = history.slice(-50);
            fs.writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 2));
        } catch (err) {
            console.error(`[JOB ${jobId}] Failed to update history:`, err.message);
        }

        console.log(`[JOB ${jobId}] Completed: ${outputFilename} (${fmtSize(finalSize / (1024 * 1024))})`);

        // Send webhook notification if provided
        if (webhookUrl) {
            try {
                await axios.post(webhookUrl, {
                    jobId,
                    success: true,
                    movieTitle: movie.title,
                    quality,
                    downloadUrl: `/api/download/file/${outputFilename}`,
                    size: finalSize
                });
            } catch (err) {
                console.error(`[JOB ${jobId}] Webhook failed:`, err.message);
            }
        }

    } catch (err) {
        console.error(`[JOB ${jobId}] Failed:`, err.message);
        job.status = 'failed';
        job.error = err.message;
        job.completedAt = Date.now();
        saveJobs();

        // Send error webhook
        if (webhookUrl) {
            try {
                await axios.post(webhookUrl, {
                    jobId,
                    success: false,
                    error: err.message
                });
            } catch { }
        }
    } finally {
        // Cleanup temp files
        cleanup(tempIn, tempOut);
        // Keep job in memory for 1 hour then remove
        setTimeout(() => {
            jobs.delete(jobId);
            saveJobs();
        }, 60 * 60 * 1000);
    }
}

// =============================================================================
// HEALTH CHECK ENDPOINTS (for Uptime Robot)
// =============================================================================
app.head('/health', (req, res) => {
    res.status(200).end();
});

app.get('/health', (req, res) => {
    res.status(200).json({
        status: 'ok',
        timestamp: Date.now(),
        uptime: process.uptime(),
        activeJobs: jobs.size,
        memory: process.memoryUsage(),
        tempDir: {
            free: os.freemem(),
            total: os.totalmem()
        }
    });
});

app.get('/api/health', (req, res) => {
    res.json({
        status: 'ok',
        message: 'PLAYKIT server is running',
        ts: Date.now(),
        jobs: jobs.size
    });
});

// =============================================================================
// API ENDPOINTS
// =============================================================================

/** GET /api/movie/:id — full TMDB details + trailerKey */
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
        console.error('[/api/movie/:id]', err.message);
        res.status(500).json({ error: err.message });
    }
});

/** GET /api/download/options/:id — quality options with size estimates */
app.get('/api/download/options/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const mRes = await axios.get(`https://api.themoviedb.org/3/movie/${id}?api_key=${TMDB_KEY}`);
        const movie = mRes.data;
        const duration = movie.runtime || 120;

        const options = Object.entries(QUALITY_PRESETS).map(([key, p]) => {
            const mb = clampMB(duration * p.sizeFactor);
            return {
                quality: key,
                label: p.label,
                size: mb,
                sizeText: fmtSize(mb),
                bitrate: p.bitrate,
                audioBitrate: p.audioBitrate,
                resolution: p.resolution
            };
        });

        res.json({
            movie: {
                id: movie.id,
                title: movie.title,
                runtime: duration,
                poster: movie.poster_path ? `https://image.tmdb.org/t/p/w500${movie.poster_path}` : null,
                year: movie.release_date?.substring(0, 4)
            },
            options
        });
    } catch (err) {
        console.error('[/api/download/options/:id]', err.message);
        res.status(500).json({ error: err.message });
    }
});

/** POST /api/download/request — start async download job */
app.post('/api/download/request', (req, res) => {
    try {
        const { movieId, quality, title, webhookUrl } = req.body;

        if (!movieId || !quality || !title) {
            return res.status(400).json({
                error: 'Missing required fields: movieId, quality, title'
            });
        }

        if (!QUALITY_PRESETS[quality]) {
            return res.status(400).json({
                error: `Invalid quality. Valid: ${Object.keys(QUALITY_PRESETS).join(', ')}`
            });
        }

        // Generate unique job ID
        const jobId = crypto.randomBytes(16).toString('hex');

        // Create job
        const job = {
            id: jobId,
            status: 'queued',
            progress: 0,
            message: 'Queued',
            movieId,
            quality,
            title,
            createdAt: Date.now(),
            webhookUrl: webhookUrl || null
        };

        jobs.set(jobId, job);
        saveJobs();

        // Start processing in background
        processDownloadJob(jobId, movieId, quality, title, webhookUrl).catch(console.error);

        // Return immediately
        res.json({
            success: true,
            jobId,
            status: 'queued',
            statusUrl: `/api/download/status/${jobId}`,
            progressUrl: `/api/download/progress/${jobId}`
        });

    } catch (err) {
        console.error('[/api/download/request]', err.message);
        res.status(500).json({ error: err.message });
    }
});

/** GET /api/download/status/:jobId — check job status */
app.get('/api/download/status/:jobId', (req, res) => {
    const job = jobs.get(req.params.jobId);

    if (!job) {
        return res.status(404).json({
            error: 'Job not found',
            message: 'Job may have expired (jobs are kept for 1 hour after completion)'
        });
    }

    const response = {
        jobId: job.id,
        status: job.status,
        progress: job.progress,
        message: job.message || null,
        createdAt: job.createdAt,
        startedAt: job.startedAt || null,
        completedAt: job.completedAt || null,
        movieTitle: job.movieTitle || null,
        moviePoster: job.moviePoster || null,
        estimatedSize: job.estimatedSize || null,
        estimatedSizeText: job.estimatedSize ? fmtSize(job.estimatedSize) : null
    };

    if (job.status === 'completed') {
        response.downloadUrl = `/api/download/file/${job.outputFile}`;
        response.filename = job.outputFile;
        response.size = job.outputSize;
        response.sizeText = job.outputSizeText;
    }

    if (job.status === 'failed') {
        response.error = job.error;
    }

    res.json(response);
});

/** GET /api/download/progress/:jobId — SSE progress stream */
app.get('/api/download/progress/:jobId', (req, res) => {
    const jobId = req.params.jobId;
    const job = jobs.get(jobId);

    if (!job) {
        return res.status(404).json({ error: 'Job not found' });
    }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    // Send initial status
    res.write(`data: ${JSON.stringify({
        jobId,
        status: job.status,
        progress: job.progress,
        message: job.message
    })}\n\n`);

    // Poll for updates
    const interval = setInterval(() => {
        const currentJob = jobs.get(jobId);
        if (!currentJob) {
            res.write(`data: ${JSON.stringify({ error: 'Job expired' })}\n\n`);
            clearInterval(interval);
            return res.end();
        }

        res.write(`data: ${JSON.stringify({
            jobId,
            status: currentJob.status,
            progress: currentJob.progress,
            message: currentJob.message,
            completedAt: currentJob.completedAt,
            downloadUrl: currentJob.status === 'completed' ? `/api/download/file/${currentJob.outputFile}` : null
        })}\n\n`);

        // Stop if job is finished
        if (currentJob.status === 'completed' || currentJob.status === 'failed') {
            clearInterval(interval);
            res.end();
        }
    }, 1000);

    req.on('close', () => {
        clearInterval(interval);
    });
});

/** GET /api/download/file/:filename — serve completed file */
app.get('/api/download/file/:filename', (req, res) => {
    try {
        const filename = req.params.filename;
        // Security: prevent path traversal
        if (filename.includes('..') || filename.includes('/')) {
            return res.status(400).json({ error: 'Invalid filename' });
        }

        const filePath = path.join(COMPLETED_DIR, filename);

        if (!fs.existsSync(filePath)) {
            return res.status(404).json({ error: 'File not found' });
        }

        const stat = fs.statSync(filePath);
        const fileSize = stat.size;

        res.setHeader('Content-Type', 'video/mp4');
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        res.setHeader('Content-Length', fileSize);
        res.setHeader('X-Exact-Size', Math.round(fileSize / (1024 * 1024)));

        const stream = fs.createReadStream(filePath);
        stream.pipe(res);

        stream.on('error', (err) => {
            console.error('[/api/download/file] Stream error:', err);
            if (!res.headersSent) {
                res.status(500).json({ error: 'Stream error' });
            }
        });

    } catch (err) {
        console.error('[/api/download/file]', err.message);
        res.status(500).json({ error: err.message });
    }
});

/** GET /api/downloads/history — get download history */
app.get('/api/downloads/history', (req, res) => {
    try {
        const history = fs.existsSync(HISTORY_FILE)
            ? JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'))
            : [];
        res.json(history);
    } catch (err) {
        console.error('[/api/downloads/history]', err.message);
        res.status(500).json({ error: err.message });
    }
});

/** DELETE /api/downloads/history — clear history */
app.delete('/api/downloads/history', (req, res) => {
    try {
        if (fs.existsSync(HISTORY_FILE)) {
            fs.unlinkSync(HISTORY_FILE);
        }
        res.json({ success: true, message: 'History cleared' });
    } catch (err) {
        console.error('[/api/downloads/history DELETE]', err.message);
        res.status(500).json({ error: err.message });
    }
});

/** GET /api/downloads/active — get active jobs */
app.get('/api/downloads/active', (req, res) => {
    const activeJobs = Array.from(jobs.values())
        .filter(job => job.status === 'queued' || job.status === 'processing')
        .map(job => ({
            id: job.id,
            status: job.status,
            progress: job.progress,
            message: job.message,
            movieTitle: job.movieTitle || job.title,
            quality: job.quality,
            createdAt: job.createdAt
        }));
    res.json(activeJobs);
});

// Legacy endpoint for backward compatibility (redirects to new flow)
app.get('/api/download', (req, res) => {
    res.status(400).json({
        error: 'Direct download endpoint removed',
        message: 'Please use POST /api/download/request for async downloads',
        docs: {
            request: 'POST /api/download/request',
            status: 'GET /api/download/status/:jobId',
            progress: 'GET /api/download/progress/:jobId (SSE)'
        }
    });
});

// =============================================================================
// CLEANUP OLD FILES (run every hour)
// =============================================================================
setInterval(() => {
    try {
        const now = Date.now();
        const oneHour = 60 * 60 * 1000;

        // Clean up completed files older than 1 hour
        if (fs.existsSync(COMPLETED_DIR)) {
            const files = fs.readdirSync(COMPLETED_DIR);
            files.forEach(file => {
                const filePath = path.join(COMPLETED_DIR, file);
                const stat = fs.statSync(filePath);
                if (now - stat.mtimeMs > oneHour) {
                    fs.unlinkSync(filePath);
                    console.log('[Cleanup] Removed old file:', file);
                }
            });
        }

        // Clean up job temp files
        if (fs.existsSync(JOBS_DIR)) {
            const files = fs.readdirSync(JOBS_DIR);
            files.forEach(file => {
                const filePath = path.join(JOBS_DIR, file);
                const stat = fs.statSync(filePath);
                if (now - stat.mtimeMs > oneHour) {
                    fs.unlinkSync(filePath);
                    console.log('[Cleanup] Removed temp file:', file);
                }
            });
        }
    } catch (err) {
        console.error('[Cleanup] Error:', err.message);
    }
}, 60 * 60 * 1000); // Run every hour

// =============================================================================
// START SERVER
// =============================================================================
app.listen(PORT, HOST, () => {
    console.log(`
╔════════════════════════════════════════════════════════════╗
║                 PLAYKIT Download Server                    ║
║                    Async Job Processing                     ║
║   http://${HOST}:${PORT}                                   ║
╠════════════════════════════════════════════════════════════╣
║  HEALTH CHECKS (for Uptime Robot):                          ║
║  HEAD /health                                               ║
║  GET  /health                                               ║
║  GET  /api/health                                           ║
╠════════════════════════════════════════════════════════════╣
║  ASYNC DOWNLOAD FLOW:                                       ║
║  1. POST /api/download/request  (start job)                 ║
║  2. GET  /api/download/status/:jobId (check status)         ║
║  3. GET  /api/download/progress/:jobId (SSE stream)         ║
║  4. GET  /api/download/file/:filename (download when done)  ║
╠════════════════════════════════════════════════════════════╣
║  OTHER ENDPOINTS:                                           ║
║  GET  /api/movie/:id                                        ║
║  GET  /api/download/options/:id                             ║
║  GET  /api/downloads/history                                ║
║  DELETE /api/downloads/history                              ║
║  GET  /api/downloads/active                                 ║
╚════════════════════════════════════════════════════════════╝
    `);
    console.log(`[Server] Active jobs: ${jobs.size}`);
});
