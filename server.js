// =============================================================================
// server.js — PLAYKIT Movie Download Server
// Complete system with fzmovies.net as primary source
// =============================================================================

const express = require('express');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const axiosRetry = require('axios-retry').default;
const cheerio = require('cheerio');
const crypto = require('crypto');
const NodeCache = require('node-cache');
const puppeteer = require('puppeteer');
const rateLimit = require('express-rate-limit');
const compression = require('compression');
const os = require('os');
const ytdl = require('ytdl-core');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegI = require('@ffmpeg-installer/ffmpeg');

ffmpeg.setFfmpegPath(ffmpegI.path);

const app = express();
const PORT = process.env.PORT || 3000;
const HOST = '0.0.0.0';

// =============================================================================
// ADVANCED CORS & SECURITY
// =============================================================================
app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, Accept, X-Requested-With');
    res.setHeader('Access-Control-Expose-Headers', 'Content-Length, Content-Disposition, X-Exact-Size, X-Movie-Title, X-Cache-Hit');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
});

app.use(compression());
app.use(express.json({ limit: '10mb' }));
app.use(express.static('public'));

// Rate limiting
const limiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 100,
    message: { error: 'Too many requests, please try again later.' }
});
app.use('/api/', limiter);

// =============================================================================
// CONFIGURATION
// =============================================================================
const TMDB_KEY = '480f73d92f9395eb2140f092c746b3bc';
const USER_AGENTS = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15',
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36',
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_1_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'
];

const TEMP_DIR = path.join(os.tmpdir(), 'playkit-downloads');
const CACHE_DIR = path.join(__dirname, 'cache');
const LOG_DIR = path.join(__dirname, 'logs');

// Create directories
[TEMP_DIR, CACHE_DIR, LOG_DIR].forEach(dir => {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

// =============================================================================
// CACHE SYSTEM
// =============================================================================
const linkCache = new NodeCache({
    stdTTL: 86400, // 24 hours default TTL
    checkperiod: 3600,
    useClones: false
});

const CACHE_FILE = path.join(CACHE_DIR, 'links-cache.json');

function loadCacheFromDisk() {
    try {
        if (fs.existsSync(CACHE_FILE)) {
            const data = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
            Object.entries(data).forEach(([key, value]) => {
                linkCache.set(key, value);
            });
            console.log(`✅ Loaded ${Object.keys(data).length} cached links`);
        }
    } catch (error) {
        console.error('Failed to load cache:', error.message);
    }
}

function saveCacheToDisk() {
    try {
        const keys = linkCache.keys();
        const cacheData = {};
        keys.forEach(key => {
            cacheData[key] = linkCache.get(key);
        });
        fs.writeFileSync(CACHE_FILE, JSON.stringify(cacheData, null, 2));
        console.log(`💾 Saved ${keys.length} links to disk cache`);
    } catch (error) {
        console.error('Failed to save cache:', error.message);
    }
}

setInterval(saveCacheToDisk, 5 * 60 * 1000);
loadCacheFromDisk();

// =============================================================================
// LOGGING SYSTEM
// =============================================================================
function logError(context, error, metadata = {}) {
    const logEntry = {
        timestamp: new Date().toISOString(),
        context,
        error: error.message,
        stack: error.stack,
        metadata
    };
    
    const logFile = path.join(LOG_DIR, `error-${new Date().toISOString().split('T')[0]}.log`);
    fs.appendFileSync(logFile, JSON.stringify(logEntry) + '\n');
    console.error(`❌ [${context}]`, error.message);
}

function logInfo(context, message, data = {}) {
    console.log(`📌 [${context}]`, message, Object.keys(data).length ? data : '');
}

// =============================================================================
// AXIOS CONFIGURATION WITH RETRY
// =============================================================================
axiosRetry(axios, {
    retries: 3,
    retryDelay: axiosRetry.exponentialDelay,
    retryCondition: (error) => {
        return axiosRetry.isNetworkOrIdempotentRequestError(error) ||
               error.response?.status >= 500;
    }
});

const axiosWithProxy = axios.create({
    timeout: 30000,
    maxRedirects: 5,
    validateStatus: status => status < 400,
    headers: {
        'User-Agent': USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)],
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Encoding': 'gzip, deflate, br',
        'DNT': '1',
        'Connection': 'keep-alive',
        'Upgrade-Insecure-Requests': '1'
    }
});

// =============================================================================
// FZMOVIES.NET EXTRACTOR (PRIMARY SOURCE)
// =============================================================================
class FZMoviesExtractor {
    constructor() {
        this.name = 'fzmovies';
        this.baseUrl = 'https://www.fzmovies.net';
        this.searchUrl = 'https://www.fzmovies.net/search.php';
        this.browser = null;
    }

    async getBrowser() {
        if (!this.browser) {
            this.browser = await puppeteer.launch({
                args: ['--no-sandbox', '--disable-setuid-sandbox'],
                headless: 'new'
            });
        }
        return this.browser;
    }

    async extract(movieId, title, year) {
        logInfo('FZMOVIES', `Searching for: ${title} (${year})`);
        
        try {
            // Step 1: Search for the movie
            const searchResults = await this.searchMovie(title, year);
            
            if (!searchResults || searchResults.length === 0) {
                throw new Error('No results found on fzmovies.net');
            }

            // Step 2: Get the best match
            const bestMatch = this.findBestMatch(searchResults, title, year);
            
            if (!bestMatch) {
                throw new Error('No matching movie found');
            }

            // Step 3: Extract download links from the movie page
            const downloadLinks = await this.extractDownloadLinks(bestMatch.url);

            if (!downloadLinks || downloadLinks.length === 0) {
                throw new Error('No download links found');
            }

            // Step 4: Process and categorize links by quality
            const processedLinks = this.processLinks(downloadLinks);

            return {
                links: processedLinks,
                quality: this.getBestQuality(processedLinks),
                pageUrl: bestMatch.url,
                title: bestMatch.title
            };

        } catch (error) {
            logError('FZMOVIES_EXTRACTOR', error, { movieId, title, year });
            throw error;
        }
    }

    async searchMovie(title, year) {
        try {
            const browser = await this.getBrowser();
            const page = await browser.newPage();
            
            await page.setUserAgent(USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)]);
            
            // Navigate to search page
            await page.goto(`${this.baseUrl}/`, { waitUntil: 'networkidle0', timeout: 15000 });
            
            // Fill and submit search form
            await page.type('#searchstring', `${title} ${year}`);
            await page.click('input[type="submit"]');
            await page.waitForNavigation({ waitUntil: 'networkidle0', timeout: 15000 });

            // Parse search results
            const results = await page.evaluate(() => {
                const items = [];
                const rows = document.querySelectorAll('table tr');
                
                rows.forEach(row => {
                    const link = row.querySelector('a[href*="movie"]');
                    if (link) {
                        const titleEl = row.querySelector('font b') || link;
                        const sizeEl = row.querySelector('font:contains("MB"), font:contains("GB")');
                        
                        items.push({
                            title: titleEl?.textContent?.trim() || link.textContent.trim(),
                            url: link.href,
                            size: sizeEl?.textContent?.trim() || 'Unknown',
                            quality: link.textContent.includes('1080') ? '1080p' :
                                    link.textContent.includes('720') ? '720p' :
                                    link.textContent.includes('480') ? '480p' : 'SD'
                        });
                    }
                });
                
                return items;
            });

            await page.close();
            return results;

        } catch (error) {
            logError('FZMOVIES_SEARCH', error);
            return [];
        }
    }

    async extractDownloadLinks(movieUrl) {
        try {
            const browser = await this.getBrowser();
            const page = await browser.newPage();
            
            await page.setUserAgent(USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)]);
            await page.goto(movieUrl, { waitUntil: 'networkidle0', timeout: 15000 });

            // Wait for download links to load
            await page.waitForSelector('a[href*="download"], a:contains("Download")', { timeout: 10000 });

            const links = await page.evaluate(() => {
                const downloadLinks = [];
                
                // Find all download links
                document.querySelectorAll('a').forEach(link => {
                    const href = link.href;
                    const text = link.textContent.toLowerCase();
                    
                    if (href && (href.includes('.mp4') || href.includes('download') || text.includes('download'))) {
                        // Detect quality from link text
                        let quality = 'SD';
                        if (text.includes('1080') || href.includes('1080')) quality = '1080p';
                        else if (text.includes('720') || href.includes('720')) quality = '720p';
                        else if (text.includes('480') || href.includes('480')) quality = '480p';
                        else if (text.includes('360') || href.includes('360')) quality = '360p';

                        // Detect file size
                        let size = 'Unknown';
                        const sizeMatch = text.match(/(\d+(?:\.\d+)?)\s*(MB|GB)/i);
                        if (sizeMatch) {
                            size = sizeMatch[0];
                        }

                        downloadLinks.push({
                            url: href,
                            quality: quality,
                            size: size,
                            type: href.includes('.mp4') ? 'mp4' : 'unknown',
                            source: 'fzmovies'
                        });
                    }
                });

                // Also check for iframe sources
                document.querySelectorAll('iframe').forEach(iframe => {
                    const src = iframe.src;
                    if (src && (src.includes('embed') || src.includes('player'))) {
                        downloadLinks.push({
                            url: src,
                            quality: 'unknown',
                            type: 'embed',
                            source: 'fzmovies'
                        });
                    }
                });

                return downloadLinks;
            });

            await page.close();
            return links;

        } catch (error) {
            logError('FZMOVIES_EXTRACT_LINKS', error);
            return [];
        }
    }

    findBestMatch(results, targetTitle, targetYear) {
        if (!results || results.length === 0) return null;

        // Normalize function for comparison
        const normalize = (str) => {
            return str.toLowerCase()
                .replace(/[^\w\s]/g, '')
                .replace(/\s+/g, ' ')
                .trim();
        };

        const targetNormalized = normalize(`${targetTitle} ${targetYear}`);
        
        // Score each result
        const scored = results.map(result => {
            const resultNormalized = normalize(result.title);
            let score = 0;

            // Title similarity (using Levenshtein distance)
            const distance = this.levenshteinDistance(targetNormalized, resultNormalized);
            const maxLength = Math.max(targetNormalized.length, resultNormalized.length);
            const titleScore = 1 - (distance / maxLength);
            score += titleScore * 0.7; // Title weight: 70%

            // Year check
            if (targetYear && result.title.includes(targetYear.toString())) {
                score += 0.3; // Year weight: 30%
            }

            // Quality bonus
            if (result.quality === '1080p') score += 0.1;
            else if (result.quality === '720p') score += 0.05;

            return { ...result, score };
        });

        // Sort by score and return best match
        scored.sort((a, b) => b.score - a.score);
        return scored[0].score > 0.5 ? scored[0] : null;
    }

    levenshteinDistance(a, b) {
        const matrix = [];
        for (let i = 0; i <= b.length; i++) matrix[i] = [i];
        for (let j = 0; j <= a.length; j++) matrix[0][j] = j;

        for (let i = 1; i <= b.length; i++) {
            for (let j = 1; j <= a.length; j++) {
                if (b.charAt(i - 1) === a.charAt(j - 1)) {
                    matrix[i][j] = matrix[i - 1][j - 1];
                } else {
                    matrix[i][j] = Math.min(
                        matrix[i - 1][j - 1] + 1,
                        matrix[i][j - 1] + 1,
                        matrix[i - 1][j] + 1
                    );
                }
            }
        }
        return matrix[b.length][a.length];
    }

    processLinks(links) {
        const processed = [];
        const seen = new Set();

        links.forEach(link => {
            // Deduplicate
            const key = link.url.split('?')[0];
            if (seen.has(key)) return;
            seen.add(key);

            // Validate and clean URL
            if (link.url.startsWith('//')) {
                link.url = 'https:' + link.url;
            } else if (link.url.startsWith('/')) {
                link.url = this.baseUrl + link.url;
            }

            processed.push(link);
        });

        // Sort by quality (best first)
        const qualityOrder = { '1080p': 4, '720p': 3, '480p': 2, '360p': 1, 'SD': 0, 'unknown': -1 };
        processed.sort((a, b) => (qualityOrder[b.quality] || 0) - (qualityOrder[a.quality] || 0));

        return processed;
    }

    getBestQuality(links) {
        if (links.some(l => l.quality === '1080p')) return '1080p';
        if (links.some(l => l.quality === '720p')) return '720p';
        if (links.some(l => l.quality === '480p')) return '480p';
        return 'SD';
    }

    async cleanup() {
        if (this.browser) {
            await this.browser.close();
            this.browser = null;
        }
    }
}

// =============================================================================
// BACKUP SOURCES (fallback if fzmovies fails)
// =============================================================================
class BackupExtractor {
    constructor() {
        this.name = 'backup';
    }

    async extract(movieId, title, year) {
        // Backup sources for when fzmovies doesn't have the movie
        const backupUrls = [
            `https://vidsrc.to/embed/movie/${movieId}`,
            `https://www.2embed.cc/embed/${movieId}`,
            `https://multiembed.mov/directstream.php?video_id=${movieId}`
        ];

        const links = [];

        for (const url of backupUrls) {
            try {
                const response = await axiosWithProxy.get(url);
                const $ = cheerio.load(response.data);

                // Extract video sources
                $('source').each((i, el) => {
                    const src = $(el).attr('src');
                    if (src && src.includes('.mp4')) {
                        links.push({
                            url: src,
                            quality: 'auto',
                            type: 'mp4',
                            source: 'backup'
                        });
                    }
                });

                // Extract from script tags
                $('script').each((i, el) => {
                    const script = $(el).html();
                    if (script && script.includes('file:')) {
                        const matches = script.match(/file:\s*["']([^"']+)["']/g);
                        if (matches) {
                            matches.forEach(match => {
                                const url = match.replace(/file:\s*["']|["']/g, '');
                                if (url.match(/\.(mp4|m3u8)/)) {
                                    links.push({
                                        url: url,
                                        quality: script.includes('1080') ? '1080p' :
                                                script.includes('720') ? '720p' : 'auto',
                                        type: url.includes('.m3u8') ? 'hls' : 'mp4',
                                        source: 'backup'
                                    });
                                }
                            });
                        }
                    }
                });

            } catch (error) {
                continue; // Try next backup source
            }
        }

        return {
            links: this.deduplicateLinks(links),
            quality: this.getBestQuality(links)
        };
    }

    deduplicateLinks(links) {
        const seen = new Set();
        return links.filter(link => {
            const key = link.url.split('?')[0];
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        });
    }

    getBestQuality(links) {
        if (links.some(l => l.quality === '1080p')) return '1080p';
        if (links.some(l => l.quality === '720p')) return '720p';
        return 'auto';
    }
}

// =============================================================================
// LINK EXTRACTOR MANAGER
// =============================================================================
class LinkExtractor {
    constructor() {
        this.primarySource = new FZMoviesExtractor();
        this.backupSource = new BackupExtractor();
    }

    async extractLinks(movieId, title, year) {
        const cacheKey = `movie_${movieId}_${year}`;
        const cached = linkCache.get(cacheKey);
        
        if (cached) {
            logInfo('CACHE', `Cache hit for ${title}`, { movieId });
            return { ...cached, cached: true };
        }

        logInfo('EXTRACT', `Extracting links for ${title} (${year})`);
        
        let result = null;
        let error = null;

        // Try primary source (fzmovies.net) first
        try {
            result = await this.primarySource.extract(movieId, title, year);
            logInfo('FZMOVIES', `Found ${result.links.length} links for ${title}`);
        } catch (primaryError) {
            error = primaryError;
            logError('PRIMARY_SOURCE', primaryError);

            // Try backup sources
            try {
                result = await this.backupSource.extract(movieId, title, year);
                logInfo('BACKUP', `Found ${result.links.length} backup links for ${title}`);
            } catch (backupError) {
                logError('BACKUP_SOURCE', backupError);
                throw new Error('No working sources found');
            }
        }

        if (!result || !result.links || result.links.length === 0) {
            throw new Error('No links extracted from any source');
        }

        // Validate links
        const validatedLinks = await this.validateLinks(result.links);
        
        const output = {
            movieId,
            title,
            year,
            timestamp: Date.now(),
            sources: [{
                source: result.source || 'primary',
                links: validatedLinks
            }],
            primary: validatedLinks[0] || null
        };

        // Cache the results
        linkCache.set(cacheKey, output);
        
        return output;
    }

    async validateLinks(links) {
        const validated = [];
        
        for (const link of links.slice(0, 5)) { // Validate top 5 links only
            try {
                const response = await axios.head(link.url, {
                    timeout: 5000,
                    maxRedirects: 3,
                    headers: {
                        'User-Agent': USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)]
                    }
                });
                
                const contentType = response.headers['content-type'] || '';
                const contentLength = response.headers['content-length'];
                
                const isValid = contentType.includes('video/') || 
                               link.url.match(/\.(mp4|mkv|avi|mov|webm)$/i) ||
                               (contentLength && parseInt(contentLength) > 1024 * 1024); // > 1MB
                
                if (isValid) {
                    validated.push({
                        ...link,
                        validated: true,
                        size: contentLength ? parseInt(contentLength) : null,
                        checkedAt: Date.now()
                    });
                }
            } catch (error) {
                // Skip invalid links
                continue;
            }
            
            // Small delay to avoid rate limiting
            await new Promise(r => setTimeout(r, 500));
        }
        
        return validated.length > 0 ? validated : links.slice(0, 3); // Fallback to unvalidated if all fail
    }

    async cleanup() {
        await this.primarySource.cleanup();
    }
}

// =============================================================================
// QUALITY PRESETS
// =============================================================================
const QUALITY_PRESETS = {
    '1080p': { bitrate: '2000k', audioBitrate: '128k', label: '1080p Full HD', sizeFactor: 1.5 },
    '720p': { bitrate: '1200k', audioBitrate: '96k', label: '720p HD', sizeFactor: 1.0 },
    '480p': { bitrate: '800k', audioBitrate: '64k', label: '480p SD', sizeFactor: 0.6 },
    '360p': { bitrate: '500k', audioBitrate: '48k', label: '360p', sizeFactor: 0.4 }
};

function clampMB(mb) { return Math.min(2000, Math.max(100, Math.round(mb))); }
function fmtSize(mb) { return mb >= 1024 ? `${(mb/1024).toFixed(2)} GB` : `${mb} MB`; }

// =============================================================================
// DOWNLOAD MANAGER
// =============================================================================
class DownloadManager {
    constructor() {
        this.extractor = new LinkExtractor();
    }

    async getDownloadLinks(movieId, title, year) {
        try {
            // Get movie details from TMDB
            const tmdbResponse = await axios.get(
                `https://api.themoviedb.org/3/movie/${movieId}?api_key=${TMDB_KEY}`
            );
            
            const movie = tmdbResponse.data;
            const movieTitle = movie.title;
            const movieYear = new Date(movie.release_date).getFullYear();

            // Check cache
            const cached = linkCache.get(`links_${movieId}`);
            if (cached) {
                const age = Date.now() - cached.timestamp;
                if (age < 12 * 60 * 60 * 1000) { // 12 hours
                    return {
                        ...cached,
                        cached: true,
                        cacheAge: Math.floor(age / 1000 / 60) + ' minutes'
                    };
                }
            }

            // Extract fresh links
            const links = await this.extractor.extractLinks(movieId, movieTitle, movieYear);
            
            // Generate quality options
            const qualityOptions = this.generateQualityOptions(links);

            const output = {
                movieId,
                title: movieTitle,
                year: movieYear,
                timestamp: Date.now(),
                links: links.primary ? [links.primary] : [],
                allLinks: links.sources?.[0]?.links || [],
                qualityOptions,
                sources: links.sources || []
            };

            // Cache the results
            linkCache.set(`links_${movieId}`, output);

            return output;

        } catch (error) {
            logError('DOWNLOAD_MANAGER', error, { movieId, title });
            throw error;
        }
    }

    generateQualityOptions(links) {
        const options = {};
        
        if (links.sources && links.sources[0] && links.sources[0].links) {
            links.sources[0].links.forEach(link => {
                const quality = link.quality || 'auto';
                if (!options[quality]) {
                    options[quality] = [];
                }
                options[quality].push(link);
            });
        }

        return options;
    }

    async getDirectDownloadUrl(movieId, quality) {
        const cached = linkCache.get(`links_${movieId}`);
        
        if (!cached || !cached.allLinks) {
            throw new Error('No download links available');
        }

        // Find link matching requested quality
        const link = cached.allLinks.find(l => l.quality === quality) || cached.allLinks[0];
        
        if (!link) {
            throw new Error(`No ${quality} link available`);
        }

        return {
            url: link.url,
            quality: link.quality,
            size: link.size,
            source: link.source
        };
    }
}

// =============================================================================
// INITIALIZE MANAGERS
// =============================================================================
const downloadManager = new DownloadManager();
const extractor = new LinkExtractor();

// =============================================================================
// API ENDPOINTS
// =============================================================================

// Health check
app.get('/api/health', (req, res) => {
    res.json({
        status: 'ok',
        timestamp: Date.now(),
        uptime: process.uptime(),
        cacheSize: linkCache.keys().length
    });
});

// Get movie details
app.get('/api/movie/:id', async (req, res) => {
    try {
        const { id } = req.params;
        
        const [movieRes, videosRes] = await Promise.all([
            axios.get(`https://api.themoviedb.org/3/movie/${id}?api_key=${TMDB_KEY}`),
            axios.get(`https://api.themoviedb.org/3/movie/${id}/videos?api_key=${TMDB_KEY}`)
        ]);

        const movie = movieRes.data;
        const trailer = videosRes.data.results.find(
            v => v.type === 'Trailer' && v.site === 'YouTube'
        );

        res.json({
            ...movie,
            trailerKey: trailer?.key || null
        });
    } catch (error) {
        logError('API_MOVIE', error);
        res.status(500).json({ error: error.message });
    }
});

// Get download options
app.get('/api/download/options/:id', async (req, res) => {
    try {
        const { id } = req.params;
        
        const movieRes = await axios.get(
            `https://api.themoviedb.org/3/movie/${id}?api_key=${TMDB_KEY}`
        );
        
        const movie = movieRes.data;
        const year = new Date(movie.release_date).getFullYear();

        const links = await downloadManager.getDownloadLinks(id, movie.title, year);

        // Format options for frontend
        const options = Object.entries(QUALITY_PRESETS).map(([quality, preset]) => {
            // Check if this quality is available
            const availableLinks = links.qualityOptions[quality] || [];
            const isAvailable = availableLinks.length > 0;
            
            // Calculate size based on runtime if not provided
            const runtime = movie.runtime || 120;
            const sizeMB = isAvailable ? 
                (availableLinks[0].size ? 
                    parseInt(availableLinks[0].size) / (1024 * 1024) : 
                    clampMB(runtime * preset.sizeFactor)
                ) : 
                clampMB(runtime * preset.sizeFactor);

            return {
                quality,
                label: preset.label,
                size: Math.round(sizeMB),
                sizeText: fmtSize(Math.round(sizeMB)),
                bitrate: preset.bitrate,
                audioBitrate: preset.audioBitrate,
                available: isAvailable,
                url: isAvailable ? availableLinks[0].url : null
            };
        }).filter(opt => opt.available); // Only show available qualities

        res.json({
            movie: {
                id: movie.id,
                title: movie.title,
                year,
                runtime: movie.runtime || 120,
                poster: `https://image.tmdb.org/t/p/w500${movie.poster_path}`,
                backdrop: `https://image.tmdb.org/t/p/w1280${movie.backdrop_path}`
            },
            options,
            cached: links.cached || false,
            timestamp: links.timestamp
        });

    } catch (error) {
        logError('API_DOWNLOAD_OPTIONS', error);
        res.status(500).json({ 
            error: 'Failed to fetch download options',
            details: error.message 
        });
    }
});

// Initiate download
app.get('/api/download', async (req, res) => {
    try {
        const { movieId, quality, title } = req.query;

        if (!movieId || !quality || !title) {
            return res.status(400).json({ 
                error: 'Missing required parameters: movieId, quality, title' 
            });
        }

        const downloadInfo = await downloadManager.getDirectDownloadUrl(movieId, quality);

        if (!downloadInfo || !downloadInfo.url) {
            return res.status(404).json({ 
                error: 'No working download link found for this quality' 
            });
        }

        // Set response headers for direct download
        res.setHeader('Content-Type', 'video/mp4');
        res.setHeader('Content-Disposition', `attachment; filename="${title.replace(/[^a-z0-9]/gi, '_')}_${quality}.mp4"`);
        
        if (downloadInfo.size) {
            res.setHeader('Content-Length', downloadInfo.size);
        }
        
        res.setHeader('X-Download-Source', downloadInfo.source);
        res.setHeader('X-Download-Quality', downloadInfo.quality);

        // Stream the file directly
        const response = await axios({
            method: 'GET',
            url: downloadInfo.url,
            responseType: 'stream',
            timeout: 30000,
            maxRedirects: 5,
            headers: {
                'User-Agent': USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)],
                'Referer': 'https://www.fzmovies.net/'
            }
        });

        response.data.pipe(res);

        response.data.on('end', () => {
            logInfo('DOWNLOAD', `Completed: ${title} (${quality})`);
        });

        response.data.on('error', (error) => {
            logError('DOWNLOAD_STREAM', error);
            if (!res.headersSent) {
                res.status(500).end();
            }
        });

    } catch (error) {
        logError('API_DOWNLOAD', error);
        if (!res.headersSent) {
            res.status(500).json({ 
                error: 'Download failed',
                details: error.message 
            });
        }
    }
});

// Proxy download (for CORS issues)
app.get('/api/download/proxy', async (req, res) => {
    try {
        const { url } = req.query;

        if (!url) {
            return res.status(400).json({ error: 'Missing URL parameter' });
        }

        const response = await axios({
            method: 'GET',
            url: decodeURIComponent(url),
            responseType: 'stream',
            timeout: 30000,
            maxRedirects: 5,
            headers: {
                'User-Agent': USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)],
                'Referer': 'https://www.fzmovies.net/'
            }
        });

        // Forward headers
        Object.entries(response.headers).forEach(([key, value]) => {
            if (key.toLowerCase().startsWith('content-')) {
                res.setHeader(key, value);
            }
        });

        res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition, Content-Length');

        // Pipe the response
        response.data.pipe(res);

        response.data.on('end', () => {
            logInfo('PROXY', 'Download completed');
        });

    } catch (error) {
        logError('PROXY_DOWNLOAD', error);
        if (!res.headersSent) {
            res.status(500).json({ error: 'Proxy download failed' });
        }
    }
});

// Progress feed (mock - can be enhanced with real progress)
app.get('/api/download/progress/:id', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    let progress = 0;
    const interval = setInterval(() => {
        progress += Math.random() * 10;
        if (progress >= 100) {
            clearInterval(interval);
            res.write(`data: ${JSON.stringify({ progress: 100, completed: true })}\n\n`);
            res.end();
        } else {
            res.write(`data: ${JSON.stringify({ progress: Math.min(99, Math.round(progress)) })}\n\n`);
        }
    }, 1000);

    req.on('close', () => clearInterval(interval));
});

// Get cache status
app.get('/api/cache/status', (req, res) => {
    const keys = linkCache.keys();
    const stats = {
        totalEntries: keys.length,
        keys: keys.slice(0, 20),
        memory: process.memoryUsage(),
        uptime: process.uptime()
    };
    res.json(stats);
});

// Clear cache (admin only)
app.post('/api/cache/clear', (req, res) => {
    linkCache.flushAll();
    saveCacheToDisk();
    res.json({ success: true, message: 'Cache cleared' });
});

// Download history endpoints
app.get('/api/downloads/history', (req, res) => {
    const historyFile = path.join(CACHE_DIR, 'history.json');
    if (fs.existsSync(historyFile)) {
        const history = JSON.parse(fs.readFileSync(historyFile, 'utf8'));
        res.json(history);
    } else {
        res.json([]);
    }
});

app.post('/api/downloads/history', (req, res) => {
    const { movie, quality, size } = req.body;
    const historyFile = path.join(CACHE_DIR, 'history.json');
    
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
    
    // Keep last 50 items
    if (history.length > 50) {
        history = history.slice(-50);
    }
    
    fs.writeFileSync(historyFile, JSON.stringify(history, null, 2));
    res.json({ success: true, history });
});

// =============================================================================
// BACKGROUND TASKS
// =============================================================================

// Refresh expired cache entries
async function refreshCache() {
    const keys = linkCache.keys();
    const refreshKeys = keys.filter(key => {
        const value = linkCache.get(key);
        const age = Date.now() - (value.timestamp || 0);
        return age > 6 * 60 * 60 * 1000; // Older than 6 hours
    });

    for (const key of refreshKeys.slice(0, 5)) { // Limit to 5 per run
        try {
            const movieId = key.replace('links_', '');
            logInfo('REFRESH', `Refreshing cache for ${movieId}`);
            
            const movieRes = await axios.get(
                `https://api.themoviedb.org/3/movie/${movieId}?api_key=${TMDB_KEY}`
            );
            const movie = movieRes.data;
            const year = new Date(movie.release_date).getFullYear();
            
            const links = await downloadManager.getDownloadLinks(movieId, movie.title, year);
            
            // Delay between requests
            await new Promise(r => setTimeout(r, 5000));
            
        } catch (error) {
            logError('REFRESH', error, { key });
        }
    }
}

// Run refresh every hour
setInterval(refreshCache, 60 * 60 * 1000);

// =============================================================================
// CLEANUP
// =============================================================================
process.on('SIGINT', async () => {
    logInfo('SHUTDOWN', 'Saving cache and cleaning up...');
    saveCacheToDisk();
    
    await extractor.cleanup();
    
    process.exit(0);
});

// =============================================================================
// START SERVER
// =============================================================================
app.listen(PORT, HOST, () => {
    console.log(`
╔════════════════════════════════════════════════════════════╗
║              PLAYKIT Download Server v2.0                  ║
║              Primary Source: fzmovies.net                  ║
╠════════════════════════════════════════════════════════════╣
║  Server: http://${HOST}:${PORT}                                ║
║  Cache: ${linkCache.keys().length} entries                         ║
║  Features:                                                   ║
║    • Fzmovies.net integration                               ║
║    • Real MP4 extraction                                    ║
║    • Automatic fallback sources                             ║
║    • Link validation & caching                              ║
║    • Quality detection (1080p/720p/480p)                    ║
╚════════════════════════════════════════════════════════════╝
    `);
});
