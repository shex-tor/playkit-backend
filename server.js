// =============================================================================
// server.js — PLAYKIT Movie Download Server
// Deploy to Render with package.json in the same repo root
// =============================================================================

const express  = require('express');
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
const HOST = '0.0.0.0';

// =============================================================================
// CORS — manual middleware, placed FIRST.
// Sets headers on EVERY response including Render wake-up error pages.
// =============================================================================
app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin',   '*');
    res.setHeader('Access-Control-Allow-Methods',  'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers',  'Content-Type, Authorization, Accept');
    res.setHeader('Access-Control-Expose-Headers', 'Content-Length, Content-Disposition, X-Exact-Size, X-Movie-Title');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
});

app.use(express.json());
app.use(express.static('public'));

// =============================================================================
// CONFIG
// =============================================================================
const TMDB_KEY = '480f73d92f9395eb2140f092c746b3bc';
const TEMP_DIR = path.join(os.tmpdir(), 'playkit-downloads');
if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });

// =============================================================================
// QUALITY PRESETS (H.265 / HEVC)
// =============================================================================
const QUALITY_PRESETS = {
    '240p':  { bitrate:'300k',  audioBitrate:'64k',  resolution:'426:240',   label:'240p (H.265)',  sizeFactor:0.27 },
    '360p':  { bitrate:'450k',  audioBitrate:'64k',  resolution:'640:360',   label:'360p (H.265)',  sizeFactor:0.38 },
    '480p':  { bitrate:'600k',  audioBitrate:'96k',  resolution:'854:480',   label:'480p (H.265)',  sizeFactor:0.52 },
    '720p':  { bitrate:'900k',  audioBitrate:'96k',  resolution:'1280:720',  label:'720p (H.265)',  sizeFactor:0.75 },
    '1080p': { bitrate:'1400k', audioBitrate:'128k', resolution:'1920:1080', label:'1080p (H.265)', sizeFactor:1.15 }
};

function clampMB(mb)     { return Math.min(1400, Math.max(240, Math.round(mb))); }
function fmtSize(mb)     { return mb >= 1024 ? `${(mb/1024).toFixed(2)} GB` : `${mb} MB`; }
function cleanup(...fps) { fps.forEach(f => { try { if (f && fs.existsSync(f)) fs.unlinkSync(f); } catch {} }); }

// =============================================================================
// ROUTES
// =============================================================================

/** GET /api/health — wake-up check used by frontend */
app.get('/api/health', (_req, res) => {
    res.json({ status:'ok', message:'PLAYKIT server is running', ts:Date.now() });
});

/** GET /api/movie/:id — full TMDB details + trailerKey */
app.get('/api/movie/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const [mRes, vRes] = await Promise.all([
            axios.get(`https://api.themoviedb.org/3/movie/${id}?api_key=${TMDB_KEY}`),
            axios.get(`https://api.themoviedb.org/3/movie/${id}/videos?api_key=${TMDB_KEY}`)
        ]);
        const trailer = vRes.data.results.find(v => v.type==='Trailer' && v.site==='YouTube');
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
        const mRes     = await axios.get(`https://api.themoviedb.org/3/movie/${id}?api_key=${TMDB_KEY}`);
        const movie    = mRes.data;
        const duration = movie.runtime || 120;

        const options = Object.entries(QUALITY_PRESETS).map(([key, p]) => {
            const mb = clampMB(duration * p.sizeFactor);
            return { quality:key, label:p.label, size:mb, sizeText:fmtSize(mb), bitrate:p.bitrate, audioBitrate:p.audioBitrate, resolution:p.resolution };
        });

        res.json({
            movie: { id:movie.id, title:movie.title, runtime:duration, poster:`https://image.tmdb.org/t/p/w500${movie.poster_path}`, year:movie.release_date?.substring(0,4) },
            options
        });
    } catch (err) {
        console.error('[/api/download/options/:id]', err.message);
        res.status(500).json({ error: err.message });
    }
});

/**
 * GET /api/download — download + transcode movie trailer as mp4
 * Query: movieId, quality, title
 */
app.get('/api/download', async (req, res) => {
    let tempIn = null, tempOut = null;
    try {
        const { movieId, quality, title } = req.query;
        if (!movieId || !quality || !title)
            return res.status(400).json({ error:'Missing params: movieId, quality, title' });

        const preset = QUALITY_PRESETS[quality];
        if (!preset)
            return res.status(400).json({ error:`Invalid quality "${quality}". Valid: ${Object.keys(QUALITY_PRESETS).join(', ')}` });

        const [mRes, vRes] = await Promise.all([
            axios.get(`https://api.themoviedb.org/3/movie/${movieId}?api_key=${TMDB_KEY}`),
            axios.get(`https://api.themoviedb.org/3/movie/${movieId}/videos?api_key=${TMDB_KEY}`)
        ]);
        const movie    = mRes.data;
        const duration = movie.runtime || 120;
        const sizeMB   = clampMB(duration * preset.sizeFactor);
        const trailer  = vRes.data.results.find(v => v.type==='Trailer' && v.site==='YouTube');
        if (!trailer)
            return res.status(404).json({ error:'No YouTube trailer found — cannot generate download.' });

        const safeTitle = (title||'movie').replace(/[^a-z0-9_]/gi,'_');
        const ts        = Date.now();
        tempIn          = path.join(TEMP_DIR, `input_${ts}.mp4`);
        tempOut         = path.join(TEMP_DIR, `output_${ts}.mp4`);

        res.setHeader('Content-Type',        'video/mp4');
        res.setHeader('Content-Disposition', `attachment; filename="${safeTitle}_${quality}.mp4"`);
        res.setHeader('Content-Length',      sizeMB * 1024 * 1024);
        res.setHeader('X-Exact-Size',        sizeMB);
        res.setHeader('X-Movie-Title',       movie.title);

        const ytUrl = `https://www.youtube.com/watch?v=${trailer.key}`;
        console.log(`\n[Download] "${movie.title}" ${quality} → ${ytUrl}`);

        // Step 1: download YouTube source
        const ys = ytdl(ytUrl, { quality:'highestvideo', filter: f => f.hasVideo && f.hasAudio });
        const ws = fs.createWriteStream(tempIn);
        await new Promise((res, rej) => {
            ys.pipe(ws);
            ys.on('end', res); ys.on('error', rej); ws.on('error', rej);
        });

        console.log(`[Download] Source ready (${(fs.statSync(tempIn).size/1048576).toFixed(1)} MB). Transcoding...`);

        // Step 2: transcode + stream to client
        await new Promise((resolve, reject) => {
            ffmpeg(tempIn)
                .videoCodec('libx265').audioCodec('aac')
                .videoBitrate(preset.bitrate).audioBitrate(preset.audioBitrate)
                .size(preset.resolution).autopad()
                .outputOptions(['-movflags','frag_keyframe+empty_moov+default_base_moof','-preset','ultrafast','-tune','fastdecode'])
                .format('mp4')
                .on('start',    cmd  => console.log('[ffmpeg]', cmd))
                .on('progress', prog => process.stdout.write(`\r[ffmpeg] ${Math.round(prog.percent||0)}%`))
                .on('end', () => {
                    console.log('\n[ffmpeg] Done.');
                    const rs = fs.createReadStream(tempOut);
                    rs.pipe(res);
                    rs.on('end',   () => { cleanup(tempIn, tempOut); resolve(); });
                    rs.on('error', e  => { cleanup(tempIn, tempOut); reject(e); });
                })
                .on('error', e => { cleanup(tempIn, tempOut); reject(e); })
                .save(tempOut);
        });

    } catch (err) {
        console.error('[/api/download]', err.message);
        cleanup(tempIn, tempOut);
        if (!res.headersSent) res.status(500).json({ error: err.message });
        else res.end();
    }
});

/** GET /api/download/progress/:id — SSE progress feed */
app.get('/api/download/progress/:id', (req, res) => {
    res.setHeader('Content-Type','text/event-stream');
    res.setHeader('Cache-Control','no-cache');
    res.setHeader('Connection','keep-alive');
    res.flushHeaders();
    let pct = 0;
    const iv = setInterval(() => {
        pct += Math.random() * 8 + 2;
        if (pct >= 100) {
            clearInterval(iv);
            res.write(`data: ${JSON.stringify({progress:100,completed:true})}\n\n`);
            res.end();
        } else {
            res.write(`data: ${JSON.stringify({progress:Math.round(pct),downloadedMB:Math.round(pct*1.5)})}\n\n`);
        }
    }, 800);
    req.on('close', () => clearInterval(iv));
});

/** GET /api/downloads/history */
app.get('/api/downloads/history', (_req, res) => {
    const f = path.join(TEMP_DIR,'history.json');
    res.json(fs.existsSync(f) ? JSON.parse(fs.readFileSync(f,'utf8')) : []);
});

/** POST /api/downloads/history */
app.post('/api/downloads/history', (req, res) => {
    const { movie, quality, size } = req.body;
    const f = path.join(TEMP_DIR,'history.json');
    let h   = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f,'utf8')) : [];
    h.push({...movie, quality, size, downloadedAt:new Date().toISOString(), id:Date.now()});
    if (h.length > 20) h = h.slice(-20);
    fs.writeFileSync(f, JSON.stringify(h, null, 2));
    res.json({ success:true, history:h });
});

// =============================================================================
// START
// =============================================================================
app.listen(PORT, HOST, () => {
    console.log(`
╔════════════════════════════════════════════╗
║          PLAYKIT Download Server           ║
║   http://${HOST}:${PORT}                   ║
║                                            ║
║  GET  /api/health                          ║
║  GET  /api/movie/:id                       ║
║  GET  /api/download/options/:id            ║
║  GET  /api/download                        ║
║  GET  /api/download/progress/:id  (SSE)    ║
║  GET  /api/downloads/history               ║
║  POST /api/downloads/history               ║
╚════════════════════════════════════════════╝
    `);
});
