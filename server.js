const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = 3000;
const VERSION = '2.6.0';
const PUBLIC_DIR = path.join(__dirname, 'public');
const NOTES_FILE = path.join(__dirname, 'notes.json');
const UPTIME_DB_FILE = path.join(__dirname, 'uptime_db.json');
const UPTIME_CYCLE_DAYS = 30;

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
const PROJECTS = [
    {
        name: 'UMA',
        desc: '<span class="lang-en">Next-generation messenger. Secure, blazing fast, and intuitive communication focused on privacy and minimalistic design.</span><span class="lang-ru">Мессенджер нового поколения. Безопасное, невероятно быстрое и интуитивно понятное общение с фокусом на приватность и минималистичный дизайн.</span>',
        url:  'https://uma.reflexai.pro',
        flagship: true, wide: true, nameSize: 'text-4xl tracking-tighter', descSize: 'text-lg',
        tags: ['Node.js', 'WebSockets', 'React', 'E2E Encrypt'],
        rating: 9.8,
        totalChecks: 0, successfulChecks: 0, status: 'offline', uptime: '0.00'
    },
    {
        name: 'AiStudyMate',
        desc: '<span class="lang-en">Personal AI tutor. An intelligent assistant for knowledge structuring and exam preparation.</span><span class="lang-ru">Персональный ИИ-репетитор. Интеллектуальный помощник для структурирования знаний, подготовки к экзаменам.</span>',
        url:  'https://aistudymate.reflexai.pro',
        tags: ['Python', 'PyTorch', 'Next.js'],
        rating: 8.5,
        totalChecks: 0, successfulChecks: 0, status: 'offline', uptime: '0.00'
    },
    {
        name: 'Tasco',
        desc: '<span class="lang-en">Advanced task tracker for developers and teams. Agile project management and analytics.</span><span class="lang-ru">Продвинутый таск-трекер для разработчиков и команд. Гибкое управление проектами и аналитика.</span>',
        url:  'https://tasco.reflexai.pro',
        tags: ['TypeScript', 'PostgreSQL', 'Redis'],
        rating: 9.0,
        totalChecks: 0, successfulChecks: 0, status: 'wip', uptime: '0.00'
    },
    {
        name: 'AntiMat',
        desc: '<span class="lang-en">Intelligent AI moderator. A bot for automatic filtering of profanity in chats.</span><span class="lang-ru">Интеллектуальный AI-модератор. Бот для автоматической фильтрации ненормативной лексики в чатах.</span>',
        url:  'https://antimat.reflexai.pro',
        tags: ['Python', 'NLP', 'Telegram API'],
        rating: 8.8,
        totalChecks: 0, successfulChecks: 0, status: 'offline', uptime: '0.00'
    },
    {
        name: 'FoodLensAI',
        desc: '<span class="lang-en">Neural network for diet analysis. Food and ingredient recognition with instant calorie counting from a single photo.</span><span class="lang-ru">Нейросеть для анализа рациона. Распознавание блюд, ингредиентов и мгновенный подсчёт калорий по одной фотографии.</span>',
        url:  'https://foodlensai.reflexai.pro',
        tags: ['PyTorch', 'Computer Vision', 'FastAPI'],
        rating: 7.5,
        totalChecks: 0, successfulChecks: 0, status: 'offline', uptime: '0.00'
    }
];

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

    const checkable = PROJECTS.filter(p => p.url && p.status !== 'wip');
    let pending = checkable.length;

    function onAllDone() {
        PROJECTS.forEach(p => {
            if (p.status !== 'wip') p.uptime = getProjectUptime(p.name);
        });
        saveUptimeDB();
        const cycleDay = Math.floor((new Date(today) - new Date(uptimeDB.cycleStart)) / 86400000) + 1;
        console.log(`\x1b[90m  │\x1b[0m  \x1b[90m📊 Day ${cycleDay}/${UPTIME_CYCLE_DAYS} | cycle started ${uptimeDB.cycleStart}\x1b[0m`);
        console.log(`\x1b[90m  └──────────────────────────────────────────────────\x1b[0m`);
    }

    if (pending === 0) { onAllDone(); return; }

    PROJECTS.forEach(p => {
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


// Инициализация заметок (Board)
let notes = [];
if (fs.existsSync(NOTES_FILE)) {
    try {
        notes = JSON.parse(fs.readFileSync(NOTES_FILE, 'utf8'));
    } catch(e) {
        console.error("Ошибка чтения notes.json");
    }
} else {
    notes = [
        { text: "Awesome portfolio! Love the terminal vibe 🔥", author: "anon_dev", rot: -1 },
        { text: "Waiting for UMA beta release. Need a solid secure messenger.", author: "crypto_guy", rot: 1.5 },
        { text: "Nice ASCII art implementation. Smooth af.", author: "neo", rot: -2 },
        { text: "Frontend looks dope, what font is that? 🤔", author: "designer12", rot: 1 },
        { text: "Привет из КЗ! Успехов с проектами 🇰🇿", author: "almaty_coder", rot: -0.5 }
    ];
    fs.writeFileSync(NOTES_FILE, JSON.stringify(notes, null, 2));
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

const server = http.createServer((req, res) => {
    // Health check endpoint
    if (req.url === '/health' && req.method === 'GET') {
        res.writeHead(200, getSecurityHeaders('application/json'));
        return res.end(JSON.stringify({
            ok: true,
            version: VERSION,
            uptime: Math.floor(process.uptime()),
            timestamp: new Date().toISOString(),
            projects: PROJECTS.filter(p => p.status === 'live').length + '/' + PROJECTS.length + ' live'
        }));
    }

    // API endpoints
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
        return res.end(JSON.stringify(PROJECTS));
    }

    if (req.url === '/api/notes' && req.method === 'GET') {
        res.writeHead(200, getSecurityHeaders('application/json'));
        return res.end(JSON.stringify(notes));
    }

    if (req.url === '/api/notes' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => {
            body += chunk.toString();
            if (body.length > 5000) req.connection.destroy(); // Защита от больших payload
        });
        req.on('end', () => {
            const ip = getClientIP(req);
            const now = Date.now();
            const lastTime = ipRateLimit.get(ip) || 0;
            
            // Лимит: 1 заметка раз в 30 минут
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
                
                const text = data.text.trim().substring(0, 120); // Ограничение в 120 символов
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
                
                notes.unshift(newNote); // Добавляем в начало
                if (notes.length > 50) notes.pop(); // Храним только последние 50 заметок
                
                // Atomic write: tmp -> rename
                const tmpPath = NOTES_FILE + '.tmp';
                try {
                    fs.writeFileSync(tmpPath, JSON.stringify(notes, null, 2));
                    fs.renameSync(tmpPath, NOTES_FILE);
                } catch (writeErr) {
                    console.error('Error writing notes:', writeErr);
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

    // Логирование запросов в консоль
    console.log(`\x1b[90m[REQ]\x1b[0m ${req.method} ${req.url}`);
    
    // SPA-роуты — отдаем index.html для клиентских страниц
    const spaRoutes = ['/notes', '/board'];
    const urlPath = req.url.split('?')[0];
    
    if (spaRoutes.includes(urlPath)) {
        const indexPath = path.join(PUBLIC_DIR, 'index.html');
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
    console.log(`  \x1b[36m❖\x1b[0m \x1b[1mUptime\x1b[0m    : \x1b[90mMonitoring ${PROJECTS.filter(p => p.url && p.status !== 'wip').length} sites (interval: 5min)\x1b[0m`);
    console.log(`\x1b[90m  ---------------------------------------\x1b[0m\n`);
    console.log(`\x1b[90m  Waiting for connections...\x1b[0m\n`);
});

