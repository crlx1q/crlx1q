const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = 3000;
const VERSION = '2.6.0';
const PUBLIC_DIR = path.join(__dirname, 'public');
const BOARD_FILE = path.join(__dirname, 'board.json');
const NOTES_FILE = path.join(__dirname, 'notes.json');
const UPTIME_DB_FILE = path.join(__dirname, 'uptime_db.json');
const UPTIME_CYCLE_DAYS = 30;

const PROJECTS_FILE = path.join(__dirname, 'projects.json');
const UPLOADS_DIR = path.join(PUBLIC_DIR, 'uploads');
if(!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, {recursive: true});

const CRLPASS = process.env.CRLPASS || '651956';
let adminToken = require('crypto').randomBytes(32).toString('hex');
let projects = [];
if (fs.existsSync(PROJECTS_FILE)) {
    try { projects = JSON.parse(fs.readFileSync(PROJECTS_FILE, 'utf8')); } catch(e){}
}


// MIME-типы для корректной отдачи файлов
const MIME_TYPES = {
    '.html': 'text/html',
    '.css': 'text/css',
    '.js': 'text/javascript',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
    '.json': 'application/json',
    '.txt': 'text/plain',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2'
};

// Security headers
function getSecurityHeaders(contentType) {
    const headers = {
        'Content-Type': contentType,
        'X-Content-Type-Options': 'nosniff',
        'X-Frame-Options': 'DENY',
        'Referrer-Policy': 'strict-origin-when-cross-origin',
        'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
        'Cross-Origin-Opener-Policy': 'same-origin',
    };
    if (contentType === 'text/html') {
        headers['Cache-Control'] = 'no-cache';
        headers['Content-Security-Policy'] = [
            "default-src 'self'",
            "script-src 'self' 'unsafe-inline' https://www.googletagmanager.com",
            "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
            "font-src 'self' https://fonts.gstatic.com",
            "img-src 'self' data: https://www.google-analytics.com https://www.googletagmanager.com",
            "connect-src 'self' https://www.google-analytics.com https://*.google-analytics.com https://*.analytics.google.com https://*.googletagmanager.com",
            "frame-ancestors 'none'",
        ].join('; ');
    } else if (contentType === 'application/json') {
        headers['Cache-Control'] = 'no-store, no-cache, must-revalidate, proxy-revalidate';
        headers['Pragma'] = 'no-cache';
        headers['Expires'] = '0';
    } else {
        // Static assets — aggressive caching
        headers['Cache-Control'] = 'public, max-age=31536000, immutable';
    }
    return headers;
}

// Заглушка проектов

// PROJECTS dynamically loaded


// ============================================================
// UPTIME DATABASE (JSON, 30-day cycle)
// ============================================================
let uptimeDB = { cycleStart: null, projects: {} };

function getToday() {
    return new Date().toISOString().slice(0, 10);
}

function loadUptimeDB() {
    try {
        if (fs.existsSync(UPTIME_DB_FILE)) {
            uptimeDB = JSON.parse(fs.readFileSync(UPTIME_DB_FILE, 'utf8'));
        }
    } catch (e) {
        console.error('  \x1b[31m✗\x1b[0m Error loading uptime DB:', e.message);
        uptimeDB = { cycleStart: null, projects: {} };
    }

    const today = getToday();

    if (uptimeDB.cycleStart) {
        const daysDiff = Math.floor((new Date(today) - new Date(uptimeDB.cycleStart)) / 86400000);
        if (daysDiff >= UPTIME_CYCLE_DAYS) {
            console.log(`\x1b[33m  ⟳ Uptime DB: 30-day cycle reset (${daysDiff}d elapsed)\x1b[0m`);
            uptimeDB = { cycleStart: today, projects: {} };
        }
    } else {
        uptimeDB.cycleStart = today;
    }

    for (const name in uptimeDB.projects) {
        rolloverDay(uptimeDB.projects[name], today);
    }

    saveUptimeDB();
}

function saveUptimeDB() {
    const tmpPath = UPTIME_DB_FILE + '.tmp';
    try {
        fs.writeFileSync(tmpPath, JSON.stringify(uptimeDB, null, 2));
        fs.renameSync(tmpPath, UPTIME_DB_FILE);
    } catch (e) {
        console.error('  \x1b[31m✗\x1b[0m Error saving uptime DB:', e.message);
    }
}

function rolloverDay(projData, today) {
    if (projData.todayDate && projData.todayDate !== today) {
        const pct = projData.todayChecks > 0
            ? parseFloat(((projData.todaySuccess / projData.todayChecks) * 100).toFixed(2))
            : 100;
        if (!projData.days) projData.days = [];
        projData.days.push({ d: projData.todayDate, up: pct });
        projData.todayDate = today;
        projData.todayChecks = 0;
        projData.todaySuccess = 0;
    }
}

function recordCheck(projectName, isSuccess) {
    const today = getToday();

    if (!uptimeDB.projects[projectName]) {
        uptimeDB.projects[projectName] = {
            todayDate: today, todayChecks: 0, todaySuccess: 0, days: []
        };
    }

    const proj = uptimeDB.projects[projectName];
    rolloverDay(proj, today);
    if (!proj.todayDate) proj.todayDate = today;

    proj.todayChecks++;
    if (isSuccess) proj.todaySuccess++;
}

function getProjectUptime(projectName) {
    const proj = uptimeDB.projects[projectName];
    if (!proj) return '100.00';

    const today = getToday();
    rolloverDay(proj, today);

    let totalPct = 0, count = 0;

    if (proj.days) {
        for (const day of proj.days) {
            totalPct += day.up;
            count++;
        }
    }

    if (proj.todayChecks > 0) {
        totalPct += (proj.todaySuccess / proj.todayChecks) * 100;
        count++;
    }

    if (count === 0) return '100.00';
    return (totalPct / count).toFixed(2);
}

// Фоновый чек аптайма (с записью в uptime_db.json)
function checkProjectsStatus() {
    const timestamp = new Date().toISOString().replace('T', ' ').slice(0, 19);
    console.log(`\n\x1b[90m  ┌──────────────────────────────────────────────────\x1b[0m`);
    console.log(`\x1b[90m  │\x1b[0m \x1b[36m⟳\x1b[0m  \x1b[1mUptime Service\x1b[0m \x1b[90m— v${VERSION} — ${timestamp}\x1b[0m`);
    console.log(`\x1b[90m  ├──────────────────────────────────────────────────\x1b[0m`);

    const today = getToday();
    if (uptimeDB.cycleStart) {
        const daysDiff = Math.floor((new Date(today) - new Date(uptimeDB.cycleStart)) / 86400000);
        if (daysDiff >= UPTIME_CYCLE_DAYS) {
            console.log(`\x1b[90m  │\x1b[0m  \x1b[33m⟳\x1b[0m \x1b[33m[RESET]\x1b[0m  30-day cycle complete — resetting`);
            uptimeDB = { cycleStart: today, projects: {} };
        }
    }

    const checkable = projects.filter(p => p.url && p.status !== 'wip');
    let pending = checkable.length;

    function onAllDone() {
        projects.forEach(p => {
            if (p.status !== 'wip') p.uptime = getProjectUptime(p.name);
        });
        saveUptimeDB();
        const cycleDay = Math.floor((new Date(today) - new Date(uptimeDB.cycleStart)) / 86400000) + 1;
        console.log(`\x1b[90m  │\x1b[0m  \x1b[90m📊 Day ${cycleDay}/${UPTIME_CYCLE_DAYS} | cycle started ${uptimeDB.cycleStart}\x1b[0m`);
        console.log(`\x1b[90m  └──────────────────────────────────────────────────\x1b[0m`);
    }

    if (pending === 0) { onAllDone(); return; }

    projects.forEach(p => {
        if (!p.url) return;
        if (p.status === 'wip') {
            console.log(`\x1b[90m  │\x1b[0m  \x1b[33m◐\x1b[0m \x1b[90m[WIP]\x1b[0m    ${p.name.padEnd(14)} \x1b[90m→ skipped\x1b[0m`);
            return;
        }
        console.log(`\x1b[90m  │\x1b[0m  \x1b[90m⋯\x1b[0m \x1b[90m[CHECK]\x1b[0m  ${p.name.padEnd(14)} \x1b[90m→ ${p.url}\x1b[0m`);

        let handled = false;
        function finishCheck(success, logCallback) {
            if (handled) return;
            handled = true;
            recordCheck(p.name, success);
            p.uptime = getProjectUptime(p.name);
            if (logCallback) logCallback();
            if (--pending <= 0) onAllDone();
        }

        const req = https.get(p.url, { timeout: 5000 }, (res) => {
            res.resume();
            res.on('end', () => { try { req.destroy(); } catch (_) {} });
            if (res.statusCode >= 200 && res.statusCode < 400) {
                p.status = 'live';
                finishCheck(true, () => {
                    console.log(`\x1b[90m  │\x1b[0m  \x1b[32m✓\x1b[0m \x1b[32m[LIVE]\x1b[0m   ${p.name.padEnd(14)} \x1b[90m→ ${res.statusCode} — uptime ${p.uptime}%\x1b[0m`);
                });
            } else {
                p.status = 'offline';
                finishCheck(false, () => {
                    console.log(`\x1b[90m  │\x1b[0m  \x1b[31m✗\x1b[0m \x1b[31m[DOWN]\x1b[0m   ${p.name.padEnd(14)} \x1b[90m→ ${res.statusCode}\x1b[0m`);
                });
            }
        }).on('error', (e) => {
            if (e.code === 'ERR_SOCKET_CLOSED' || e.message === 'socket hang up') return;
            p.status = 'offline';
            finishCheck(false, () => {
                console.log(`\x1b[90m  │\x1b[0m  \x1b[31m✗\x1b[0m \x1b[31m[ERROR]\x1b[0m  ${p.name.padEnd(14)} \x1b[90m→ ${e.code || e.message}\x1b[0m`);
            });
        });
        req.on('timeout', () => {
            req.destroy();
            p.status = 'offline';
            finishCheck(false, () => {
                console.log(`\x1b[90m  │\x1b[0m  \x1b[33m⏱\x1b[0m \x1b[33m[TMOUT]\x1b[0m  ${p.name.padEnd(14)} \x1b[90m→ 5s exceeded\x1b[0m`);
            });
        });
    });
}

loadUptimeDB();
checkProjectsStatus();
setInterval(checkProjectsStatus, 5 * 60 * 1000); // каждые 5 минут


// Инициализация гостевой книги (Board)
let boardNotes = [];
if (fs.existsSync(BOARD_FILE)) {
    try {
        boardNotes = JSON.parse(fs.readFileSync(BOARD_FILE, 'utf8'));
    } catch(e) {
        console.error("Ошибка чтения board.json");
    }
} else {
    boardNotes = [
        { text: "Awesome portfolio! Love the terminal vibe 🔥", author: "anon_dev", rot: -1 },
        { text: "Waiting for UMA beta release. Need a solid secure messenger.", author: "crypto_guy", rot: 1.5 },
        { text: "Nice ASCII art implementation. Smooth af.", author: "neo", rot: -2 },
        { text: "Frontend looks dope, what font is that? 🤔", author: "designer12", rot: 1 },
        { text: "Привет из КЗ! Успехов с проектами 🇰🇿", author: "almaty_coder", rot: -0.5 }
    ];
    fs.writeFileSync(BOARD_FILE, JSON.stringify(boardNotes, null, 2));
}

// Инициализация статей (Notes/Blog)
let articles = [];
if (fs.existsSync(NOTES_FILE)) {
    try {
        articles = JSON.parse(fs.readFileSync(NOTES_FILE, 'utf8'));
    } catch(e) {
        console.error("Ошибка чтения notes.json");
    }
} else {
    fs.writeFileSync(NOTES_FILE, JSON.stringify([], null, 2));
}

// Простая защита от спама (ограничение запросов)
const ipRateLimit = new Map();

// Получить реальный IP (поддержка proxy/CDN)
function getClientIP(req) {
    const forwarded = req.headers['x-forwarded-for'];
    if (forwarded) return forwarded.split(',')[0].trim();
    return req.socket.remoteAddress;
}

// TTL cleanup каждые 10 минут
setInterval(() => {
    const now = Date.now();
    const TTL = 30 * 60 * 1000;
    for (const [ip, time] of ipRateLimit) {
        if (now - time > TTL) ipRateLimit.delete(ip);
    }
}, 10 * 60 * 1000);


function parseBody(req) {
    return new Promise((resolve) => {
        let body = '';
        req.on('data', chunk => body += chunk.toString());
        req.on('end', () => {
            try { resolve(body ? JSON.parse(body) : {}); }
            catch(e) { resolve({}); }
        });
    });
}
function isAdmin(req) {
    return req.headers['authorization'] === 'Bearer ' + adminToken;
}

const server = http.createServer(async (req, res) => {
    // Health check endpoint
    if (req.url === '/health' && req.method === 'GET') {
        res.writeHead(200, getSecurityHeaders('application/json'));
        return res.end(JSON.stringify({
            ok: true,
            version: VERSION,
            uptime: Math.floor(process.uptime()),
            timestamp: new Date().toISOString(),
            projects: projects.filter(p => p.status === 'live').length + '/' + projects.length + ' live'
        }));
    }

    // API endpoints
    
    // Admin Auth
    if (req.url === '/api/admin/auth' && req.method === 'POST') {
        const body = await parseBody(req);
        if (body.password === CRLPASS) {
            res.writeHead(200, getSecurityHeaders('application/json'));
            return res.end(JSON.stringify({ token: adminToken }));
        }
        res.writeHead(401, getSecurityHeaders('application/json'));
        return res.end(JSON.stringify({ error: 'Unauthorized' }));
    }

    // Admin API guard
    if (req.url.startsWith('/api/admin/') && req.url !== '/api/admin/auth') {
        if (!isAdmin(req)) {
            res.writeHead(401, getSecurityHeaders('application/json'));
            return res.end(JSON.stringify({ error: 'Unauthorized' }));
        }

        // Upload
        if (req.url === '/api/admin/upload' && req.method === 'POST') {
            const body = await parseBody(req);
            if (body.image) {
                const matches = body.image.match(/^data:([A-Za-z-+\/]+);base64,(.+)$/);
                if (matches && matches.length === 3) {
                    const buffer = Buffer.from(matches[2], 'base64');
                    const ext = matches[1].split('/')[1] || 'png';
                    const filename = 'upload_' + Date.now() + '.' + ext;
                    fs.writeFileSync(path.join(UPLOADS_DIR, filename), buffer);
                    res.writeHead(200, getSecurityHeaders('application/json'));
                    return res.end(JSON.stringify({ url: '/uploads/' + filename }));
                }
            }
            res.writeHead(400); return res.end();
        }

        // Stats
        if (req.url === '/api/admin/stats' && req.method === 'GET') {
            res.writeHead(200, getSecurityHeaders('application/json'));
            return res.end(JSON.stringify({
                uptime: process.uptime(),
                memory: process.memoryUsage(),
                projectsCount: projects.length,
                articlesCount: articles.length,
                boardCount: boardNotes.length
            }));
        }

        // Projects CRUD
        if (req.url === '/api/admin/projects' && req.method === 'POST') {
            const body = await parseBody(req);
            body.id = Date.now().toString();
            projects.push(body);
            fs.writeFileSync(PROJECTS_FILE, JSON.stringify(projects, null, 2));
            res.writeHead(200, getSecurityHeaders('application/json'));
            return res.end(JSON.stringify(body));
        }
        if (req.url.startsWith('/api/admin/projects/') && req.method === 'PUT') {
            const id = req.url.split('/').pop();
            const body = await parseBody(req);
            const idx = projects.findIndex(p => p.id === id || p.name === id); // fallback to name for old ones
            if(idx !== -1) {
                projects[idx] = { ...projects[idx], ...body };
                fs.writeFileSync(PROJECTS_FILE, JSON.stringify(projects, null, 2));
                res.writeHead(200, getSecurityHeaders('application/json'));
                return res.end(JSON.stringify(projects[idx]));
            }
        }
        if (req.url.startsWith('/api/admin/projects/') && req.method === 'DELETE') {
            const id = req.url.split('/').pop();
            projects = projects.filter(p => p.id !== id && p.name !== id);
            fs.writeFileSync(PROJECTS_FILE, JSON.stringify(projects, null, 2));
            res.writeHead(200, getSecurityHeaders('application/json'));
            return res.end(JSON.stringify({ success: true }));
        }

        // Articles CRUD
        if (req.url === '/api/admin/articles' && req.method === 'POST') {
            const body = await parseBody(req);
            body.id = Date.now().toString();
            articles.unshift(body);
            fs.writeFileSync(NOTES_FILE, JSON.stringify(articles, null, 2));
            res.writeHead(200, getSecurityHeaders('application/json'));
            return res.end(JSON.stringify(body));
        }
        if (req.url.startsWith('/api/admin/articles/') && req.method === 'PUT') {
            const id = req.url.split('/').pop();
            const body = await parseBody(req);
            const idx = articles.findIndex(a => a.id === id);
            if(idx !== -1) {
                articles[idx] = { ...articles[idx], ...body };
                fs.writeFileSync(NOTES_FILE, JSON.stringify(articles, null, 2));
                res.writeHead(200, getSecurityHeaders('application/json'));
                return res.end(JSON.stringify(articles[idx]));
            }
        }
        if (req.url.startsWith('/api/admin/articles/') && req.method === 'DELETE') {
            const id = req.url.split('/').pop();
            articles = articles.filter(a => a.id !== id);
            fs.writeFileSync(NOTES_FILE, JSON.stringify(articles, null, 2));
            res.writeHead(200, getSecurityHeaders('application/json'));
            return res.end(JSON.stringify({ success: true }));
        }

        // Board Delete
        if (req.url.startsWith('/api/admin/board/') && req.method === 'DELETE') {
            const id = req.url.split('/').pop();
            boardNotes = boardNotes.filter(b => b.id !== id);
            fs.writeFileSync(BOARD_FILE, JSON.stringify(boardNotes, null, 2));
            res.writeHead(200, getSecurityHeaders('application/json'));
            return res.end(JSON.stringify({ success: true }));
        }
        
        // Catchall admin 404
        res.writeHead(404);
        return res.end();
    }

    // Serve Admin Panel
    if (req.url === '/admin' || req.url === '/admin/') {
        if (fs.existsSync(path.join(PUBLIC_DIR, 'admin.html'))) {
            const html = fs.readFileSync(path.join(PUBLIC_DIR, 'admin.html'));
            res.writeHead(200, getSecurityHeaders('text/html'));
            return res.end(html);
        } else {
            res.writeHead(404);
            return res.end('Admin panel not found. Please wait for deployment.');
        }
    }

    if (req.url === '/api/init') {
        const acceptLang = req.headers['accept-language'] || '';
        const isRu = acceptLang.includes('ru') || acceptLang.includes('uk') || acceptLang.includes('be') || acceptLang.includes('kk');
        const lang = isRu ? 'ru' : 'en';

        res.writeHead(200, getSecurityHeaders('application/json'));
        return res.end(JSON.stringify({ 
            uptime: process.uptime(),
            version: VERSION,
            lang: lang
        }));
    }

    if (req.url === '/api/projects' && req.method === 'GET') {
        res.writeHead(200, getSecurityHeaders('application/json'));
        return res.end(JSON.stringify(projects));
    }

    if (req.url === '/api/board' && req.method === 'GET') {
        res.writeHead(200, getSecurityHeaders('application/json'));
        return res.end(JSON.stringify(boardNotes));
    }

    if (req.url === '/api/board' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => {
            body += chunk.toString();
            if (body.length > 5000) req.connection.destroy();
        });
        req.on('end', () => {
            const ip = getClientIP(req);
            const now = Date.now();
            const lastTime = ipRateLimit.get(ip) || 0;
            
            if (now - lastTime < 30 * 60 * 1000) {
                res.writeHead(429, getSecurityHeaders('application/json'));
                return res.end(JSON.stringify({ error: 'RATE LIMIT. 1 NOTE PER 30 MINS.' }));
            }

            try {
                const data = JSON.parse(body);
                if (!data.text || typeof data.text !== 'string') {
                    res.writeHead(400, getSecurityHeaders('application/json'));
                    return res.end(JSON.stringify({ error: 'Некорректный текст' }));
                }
                
                const text = data.text.trim().substring(0, 120);
                if (!text || text.length < 2) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    return res.end(JSON.stringify({ error: 'Текст слишком короткий' }));
                }
                
                const newNote = {
                    id: crypto.randomUUID(),
                    text: text,
                    author: "guest_" + Math.floor(Math.random()*9000 + 1000), 
                    rot: (Math.random() * 4) - 2,
                    createdAt: new Date().toISOString(),
                    date: Date.now()
                };
                
                boardNotes.unshift(newNote);
                if (boardNotes.length > 50) boardNotes.pop();
                
                const tmpPath = BOARD_FILE + '.tmp';
                try {
                    fs.writeFileSync(tmpPath, JSON.stringify(boardNotes, null, 2));
                    fs.renameSync(tmpPath, BOARD_FILE);
                } catch (writeErr) {
                    console.error('Error writing board notes:', writeErr);
                }
                ipRateLimit.set(ip, now);
                
                res.writeHead(200, getSecurityHeaders('application/json'));
                res.end(JSON.stringify(newNote));
            } catch (e) {
                res.writeHead(400, getSecurityHeaders('application/json'));
                res.end(JSON.stringify({ error: 'Ошибка обработки данных' }));
            }
        });
        return;
    }

    if (req.url === '/api/articles' && req.method === 'GET') {
        res.writeHead(200, getSecurityHeaders('application/json'));
        // Возвращаем список статей без полных текстов для превью
        const previews = articles.map(a => ({ ...a, content: undefined }));
        return res.end(JSON.stringify(previews));
    }

    if (req.url.startsWith('/api/articles/') && req.method === 'GET') {
        const id = req.url.split('/')[3];
        const article = articles.find(a => a.id === id);
        if (article) {
            res.writeHead(200, getSecurityHeaders('application/json'));
            return res.end(JSON.stringify(article));
        } else {
            res.writeHead(404, getSecurityHeaders('application/json'));
            return res.end(JSON.stringify({ error: 'Not found' }));
        }
    }

    if (req.url.startsWith('/api/articles/') && req.url.endsWith('/like') && req.method === 'POST') {
        const id = req.url.split('/')[3];
        const article = articles.find(a => a.id === id);
        if (article) {
            const ip = getClientIP(req);
            const likeKey = `like_${ip}_${id}`;
            const now = Date.now();
            const lastLike = ipRateLimit.get(likeKey) || 0;

            if (now - lastLike < 24 * 60 * 60 * 1000) { // 1 лайк в сутки с одного IP
                res.writeHead(429, getSecurityHeaders('application/json'));
                return res.end(JSON.stringify({ error: 'Уже лайкнули' }));
            }

            article.likes = (article.likes || 0) + 1;
            ipRateLimit.set(likeKey, now);

            try {
                fs.writeFileSync(NOTES_FILE, JSON.stringify(articles, null, 2));
            } catch(e) {
                console.error("Ошибка сохранения лайка:", e);
            }

            res.writeHead(200, getSecurityHeaders('application/json'));
            return res.end(JSON.stringify({ likes: article.likes }));
        } else {
            res.writeHead(404, getSecurityHeaders('application/json'));
            return res.end(JSON.stringify({ error: 'Not found' }));
        }
    }

    // Логирование запросов в консоль
    console.log(`\x1b[90m[REQ]\x1b[0m ${req.method} ${req.url}`);
    
    // Роутинг для клиентских страниц
    const pageMap = {
        '/notes': 'notes.html',
        '/board': 'board.html',
        '/article': 'article.html'
    };
    const urlPath = req.url.split('?')[0];
    
    if (pageMap[urlPath]) {
        const indexPath = path.join(PUBLIC_DIR, pageMap[urlPath]);
        fs.readFile(indexPath, (err, data) => {
            if (err) {
                res.writeHead(500, { 'Content-Type': 'text/plain' });
                res.end('500 Internal Server Error');
            } else {
                res.writeHead(200, getSecurityHeaders('text/html'));
                res.end(data);
            }
        });
        return;
    }
    
    // Нормализация пути
    let filePath = req.url === '/' ? '/index.html' : req.url;
    filePath = filePath.split('?')[0]; // Убираем query-параметры
    
    // Защита от выхода за пределы папки (Directory Traversal)
    const safePath = path.normalize(filePath).replace(/^(\.\.[\/\\])+/, '');
    const absPath = path.join(PUBLIC_DIR, safePath);
    
    const extname = String(path.extname(absPath)).toLowerCase();
    const contentType = MIME_TYPES[extname] || 'application/octet-stream';

    // Читаем и отдаем файл
    fs.readFile(absPath, (err, data) => {
        if (err) {
            if (err.code === 'ENOENT') {
                res.writeHead(404, { 'Content-Type': 'text/plain' });
                res.end('404 Not Found');
            } else {
                res.writeHead(500, { 'Content-Type': 'text/plain' });
                res.end('500 Internal Server Error');
            }
        } else {
            res.writeHead(200, getSecurityHeaders(contentType));
            res.end(data);
        }
    });
});

server.listen(PORT, () => {
    // Красивый ASCII арт
    const asciiArt = `
\x1b[97m   ██████╗ ██████╗ ██╗     ██╗  ██╗██╗ ██████╗ 
  ██╔════╝ ██╔══██╗██║     ╚██╗██╔╝██║██╔═══██╗
  ██║      ██████╔╝██║      ╚███╔╝ ██║██║   ██║
  ██║      ██╔══██╗██║      ██╔██╗ ██║██║▄▄ ██║
  ╚██████╗ ██║  ██║███████╗██╔╝ ██╗██║╚██████╔╝
   ╚═════╝ ╚═╝  ╚═╝╚══════╝╚═╝  ╚═╝╚═╝ ╚══▀▀═╝ \x1b[0m

\x1b[90m  > \x1b[32m[system.boot]\x1b[90m kernel loaded...
  > \x1b[32m[network]\x1b[90m     stack ready.
  > \x1b[33m[warn]\x1b[90m        decrypting ascii art... \x1b[32m[ok]\x1b[0m
`;
    
    console.clear();
    console.log(asciiArt);
    console.log(`\x1b[1m\x1b[32m  >>> CRLX1Q SERVER IS ONLINE <<<\x1b[0m`);
    console.log(`\x1b[90m  ---------------------------------------\x1b[0m`);
    console.log(`  \x1b[36m❖\x1b[0m \x1b[1mVersion\x1b[0m   : \x1b[33mv${VERSION}\x1b[0m`);
    console.log(`  \x1b[36m❖\x1b[0m \x1b[1mStatus\x1b[0m    : \x1b[32mActive & Listening\x1b[0m`);
    console.log(`  \x1b[36m❖\x1b[0m \x1b[1mLocal\x1b[0m     : \x1b[4mhttp://localhost:${PORT}\x1b[0m`);
    console.log(`  \x1b[36m❖\x1b[0m \x1b[1mDirectory\x1b[0m : /public`);
    console.log(`  \x1b[36m❖\x1b[0m \x1b[1mUptime\x1b[0m    : \x1b[90mMonitoring ${projects.filter(p => p.url && p.status !== 'wip').length} sites (interval: 5min)\x1b[0m`);
    console.log(`\x1b[90m  ---------------------------------------\x1b[0m\n`);
    console.log(`\x1b[90m  Waiting for connections...\x1b[0m\n`);
});
