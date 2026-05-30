const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = 3000;
const VERSION = '2.5.0';
const PUBLIC_DIR = path.join(__dirname, 'public');
const NOTES_FILE = path.join(__dirname, 'notes.json');
const NOTES_BACKUP_FILE = path.join(__dirname, 'notes.backup.json');
const NOTE_LIMIT = 50;
const NOTE_RATE_WINDOW = 30 * 60 * 1000;
const RATE_CLEANUP_INTERVAL = 10 * 60 * 1000;

// MIME-типы для корректной отдачи файлов
const MIME_TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
    '.json': 'application/json; charset=utf-8',
    '.txt': 'text/plain; charset=utf-8',
    '.webmanifest': 'application/manifest+json; charset=utf-8',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2'
};

const SECURITY_HEADERS = {
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=()',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Content-Security-Policy': [
        "default-src 'self'",
        "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://cdn.tailwindcss.com",
        "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
        "font-src 'self' https://fonts.gstatic.com data:",
        "img-src 'self' data:",
        "connect-src 'self'",
        "base-uri 'self'",
        "form-action 'self'",
        "frame-ancestors 'none'"
    ].join('; ')
};

function send(res, statusCode, headers, body) {
    res.writeHead(statusCode, { ...SECURITY_HEADERS, ...headers });
    res.end(body);
}

function sendJson(res, statusCode, data, extraHeaders = {}) {
    send(res, statusCode, { 'Content-Type': 'application/json; charset=utf-8', ...extraHeaders }, JSON.stringify(data));
}

function cacheHeaders(filePath) {
    const ext = path.extname(filePath).toLowerCase();
    if (ext === '.html') return { 'Cache-Control': 'no-cache' };
    if (['.png', '.jpg', '.jpeg', '.gif', '.svg', '.ico', '.css', '.js', '.woff', '.woff2', '.webmanifest'].includes(ext)) {
        return { 'Cache-Control': 'public, max-age=31536000, immutable' };
    }
    return { 'Cache-Control': 'no-cache' };
}

function makeNoteId() {
    return `note_${Date.now().toString(36)}_${crypto.randomBytes(4).toString('hex')}`;
}

function normalizeNote(note, index = 0) {
    const createdAt = typeof note.createdAt === 'string'
        ? note.createdAt
        : new Date(note.date || Date.now() - index).toISOString();
    return {
        id: typeof note.id === 'string' && note.id ? note.id : makeNoteId(),
        text: typeof note.text === 'string' ? note.text.slice(0, 120) : '',
        author: typeof note.author === 'string' && note.author ? note.author : 'guest',
        rot: Number.isFinite(Number(note.rot)) ? Number(note.rot) : 0,
        createdAt,
        date: Date.parse(createdAt) || Date.now()
    };
}

function saveNotesAtomic() {
    const payload = JSON.stringify(notes, null, 2);
    const tmpFile = `${NOTES_FILE}.${process.pid}.tmp`;
    fs.writeFile(tmpFile, payload, (err) => {
        if (err) return console.error('Ошибка записи notes tmp:', err.message);
        fs.copyFile(NOTES_FILE, NOTES_BACKUP_FILE, () => {
            fs.rename(tmpFile, NOTES_FILE, (renameErr) => {
                if (renameErr) console.error('Ошибка сохранения notes.json:', renameErr.message);
            });
        });
    });
}

function getClientIp(req) {
    const forwarded = req.headers['x-forwarded-for'];
    if (typeof forwarded === 'string' && forwarded.trim()) return forwarded.split(',')[0].trim();
    return req.socket.remoteAddress || 'unknown';
}

function cleanupRateLimit(now = Date.now()) {
    for (const [ip, lastTime] of ipRateLimit) {
        if (now - lastTime > NOTE_RATE_WINDOW + RATE_CLEANUP_INTERVAL) ipRateLimit.delete(ip);
    }
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
// Фоновый чек аптайма
function checkProjectsStatus() {
    const timestamp = new Date().toISOString().replace('T', ' ').slice(0, 19);
    console.log(`\n\x1b[90m  ┌──────────────────────────────────────────────────\x1b[0m`);
    console.log(`\x1b[90m  │\x1b[0m \x1b[36m⟳\x1b[0m  \x1b[1mUptime Service\x1b[0m \x1b[90m— v${VERSION} — ${timestamp}\x1b[0m`);
    console.log(`\x1b[90m  ├──────────────────────────────────────────────────\x1b[0m`);

    PROJECTS.forEach(p => {
        if (!p.url) return;
        if (p.status === 'wip') {
            console.log(`\x1b[90m  │\x1b[0m  \x1b[33m◐\x1b[0m \x1b[90m[WIP]\x1b[0m    ${p.name.padEnd(14)} \x1b[90m→ skipped (work in progress)\x1b[0m`);
            return;
        }
        console.log(`\x1b[90m  │\x1b[0m  \x1b[90m⋯\x1b[0m \x1b[90m[PARSE]\x1b[0m  ${p.name.padEnd(14)} \x1b[90m→ ${p.url}\x1b[0m`);
        const req = https.get(p.url, { timeout: 5000 }, (res) => {
            // Consume response data to free socket, then close
            res.resume();
            res.on('end', () => { try { req.destroy(); } catch(_){} });
            p.totalChecks++;
            if (res.statusCode >= 200 && res.statusCode < 400) {
                p.status = 'live';
                p.successfulChecks++;
                p.uptime = ((p.successfulChecks / p.totalChecks) * 100).toFixed(2);
                console.log(`\x1b[90m  │\x1b[0m  \x1b[32m✓\x1b[0m \x1b[32m[LIVE]\x1b[0m   ${p.name.padEnd(14)} \x1b[90m→ ${res.statusCode} — uptime ${p.uptime}%\x1b[0m`);
            } else {
                p.status = 'offline';
                p.uptime = ((p.successfulChecks / p.totalChecks) * 100).toFixed(2);
                console.log(`\x1b[90m  │\x1b[0m  \x1b[31m✗\x1b[0m \x1b[31m[DOWN]\x1b[0m   ${p.name.padEnd(14)} \x1b[90m→ ${res.statusCode}\x1b[0m`);
            }
        }).on('error', (e) => {
            // Ignore errors from intentional destroy after successful response
            if (e.code === 'ERR_SOCKET_CLOSED' || e.message === 'socket hang up') return;
            p.totalChecks++;
            p.status = 'offline';
            p.uptime = ((p.successfulChecks / p.totalChecks) * 100).toFixed(2);
            console.log(`\x1b[90m  │\x1b[0m  \x1b[31m✗\x1b[0m \x1b[31m[ERROR]\x1b[0m  ${p.name.padEnd(14)} \x1b[90m→ ${e.code || e.message}\x1b[0m`);
        });
        req.on('timeout', () => {
            req.destroy();
            console.log(`\x1b[90m  │\x1b[0m  \x1b[33m⏱\x1b[0m \x1b[33m[TIMEOUT]\x1b[0m ${p.name.padEnd(14)} \x1b[90m→ 5000ms exceeded\x1b[0m`);
        });
    });

    setTimeout(() => {
        console.log(`\x1b[90m  └──────────────────────────────────────────────────\x1b[0m`);
    }, 6000);
}

checkProjectsStatus();
setInterval(checkProjectsStatus, 5 * 60 * 1000); // каждые 5 минут


// Инициализация заметок (Board)
let notes = [];
if (fs.existsSync(NOTES_FILE)) {
    try {
        const rawNotes = JSON.parse(fs.readFileSync(NOTES_FILE, 'utf8'));
        notes = Array.isArray(rawNotes) ? rawNotes.map(normalizeNote).slice(0, NOTE_LIMIT) : [];
    } catch(e) {
        console.error('Ошибка чтения notes.json');
    }
} else {
    notes = [
        { text: 'Awesome portfolio! Love the terminal vibe 🔥', author: 'anon_dev', rot: -1 },
        { text: 'Waiting for UMA beta release. Need a solid secure messenger.', author: 'crypto_guy', rot: 1.5 },
        { text: 'Nice ASCII art implementation. Smooth af.', author: 'neo', rot: -2 },
        { text: 'Frontend looks dope, what font is that? 🤔', author: 'designer12', rot: 1 },
        { text: 'Привет из КЗ! Успехов с проектами 🇰🇿', author: 'almaty_coder', rot: -0.5 }
    ].map(normalizeNote);
    fs.writeFileSync(NOTES_FILE, JSON.stringify(notes, null, 2));
}

// Простая защита от спама (ограничение запросов)
const ipRateLimit = new Map();
setInterval(cleanupRateLimit, RATE_CLEANUP_INTERVAL).unref();

const server = http.createServer((req, res) => {
    const urlPath = req.url.split('?')[0];

    if (urlPath === '/health') {
        return sendJson(res, 200, {
            ok: true,
            version: VERSION,
            uptime: process.uptime(),
            notes: notes.length,
            projects: PROJECTS.length,
            timestamp: new Date().toISOString()
        }, { 'Cache-Control': 'no-cache' });
    }

    // API endpoints
    if (urlPath === '/api/init') {
        const acceptLang = req.headers['accept-language'] || '';
        const isRu = acceptLang.includes('ru') || acceptLang.includes('uk') || acceptLang.includes('be') || acceptLang.includes('kk');
        const lang = isRu ? 'ru' : 'en';

        return sendJson(res, 200, {
            uptime: process.uptime(),
            version: VERSION,
            lang: lang
        }, { 'Cache-Control': 'no-cache' });
    }

    if (urlPath === '/api/projects' && req.method === 'GET') {
        return sendJson(res, 200, PROJECTS, { 'Cache-Control': 'no-cache' });
    }

    if (urlPath === '/api/notes' && req.method === 'GET') {
        return sendJson(res, 200, notes, { 'Cache-Control': 'no-cache' });
    }

    if (urlPath === '/api/notes' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => {
            body += chunk.toString();
            if (body.length > 5000) req.connection.destroy(); // Защита от больших payload
        });
        req.on('end', () => {
            const ip = getClientIp(req);
            const now = Date.now();
            cleanupRateLimit(now);
            const lastTime = ipRateLimit.get(ip) || 0;

            // Лимит: 1 заметка раз в 30 минут
            if (now - lastTime < NOTE_RATE_WINDOW) {
                return sendJson(res, 429, { error: 'RATE LIMIT. 1 NOTE PER 30 MINS.' }, { 'Cache-Control': 'no-cache' });
            }

            try {
                const data = JSON.parse(body);
                if (!data.text || typeof data.text !== 'string') {
                    return sendJson(res, 400, { error: 'Некорректный текст' }, { 'Cache-Control': 'no-cache' });
                }

                const text = data.text.trim().substring(0, 120); // Ограничение в 120 символов
                if (!text || text.length < 2) {
                    return sendJson(res, 400, { error: 'Текст слишком короткий' }, { 'Cache-Control': 'no-cache' });
                }

                const createdAt = new Date().toISOString();
                const newNote = {
                    id: makeNoteId(),
                    text: text,
                    author: 'guest_' + Math.floor(Math.random()*9000 + 1000),
                    rot: (Math.random() * 4) - 2,
                    createdAt,
                    date: Date.parse(createdAt)
                };

                notes.unshift(newNote); // Добавляем в начало
                if (notes.length > NOTE_LIMIT) notes.pop(); // Храним только последние 50 заметок

                saveNotesAtomic();
                ipRateLimit.set(ip, now);

                return sendJson(res, 200, newNote, { 'Cache-Control': 'no-cache' });
            } catch (e) {
                return sendJson(res, 400, { error: 'Ошибка обработки данных' }, { 'Cache-Control': 'no-cache' });
            }
        });
        return;
    }

    // Логирование запросов в консоль
    console.log(`\x1b[90m[REQ]\x1b[0m ${req.method} ${req.url}`);

    // SPA-роуты — отдаем index.html для клиентских страниц
    const spaRoutes = ['/notes', '/board'];

    if (spaRoutes.includes(urlPath)) {
        const indexPath = path.join(PUBLIC_DIR, 'index.html');
        fs.readFile(indexPath, (err, data) => {
            if (err) {
                send(res, 500, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-cache' }, '500 Internal Server Error');
            } else {
                send(res, 200, { 'Content-Type': 'text/html; charset=utf-8', ...cacheHeaders(indexPath) }, data);
            }
        });
        return;
    }

    // Нормализация пути
    let filePath = req.url === '/' ? '/index.html' : req.url;
    filePath = filePath.split('?')[0]; // Убираем query-параметры

    // Защита от выхода за пределы папки (Directory Traversal)
    let decodedPath;
    try {
        decodedPath = decodeURIComponent(filePath);
    } catch (e) {
        return send(res, 400, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-cache' }, '400 Bad Request');
    }
    const safePath = path.normalize(decodedPath).replace(/^(\.\.[/\\])+/, '');
    const absPath = path.join(PUBLIC_DIR, safePath);
    if (!absPath.startsWith(PUBLIC_DIR)) {
        return send(res, 403, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-cache' }, '403 Forbidden');
    }

    const extname = String(path.extname(absPath)).toLowerCase();
    const contentType = MIME_TYPES[extname] || 'application/octet-stream';

    // Читаем и отдаем файл
    fs.readFile(absPath, (err, data) => {
        if (err) {
            if (err.code === 'ENOENT') {
                send(res, 404, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-cache' }, '404 Not Found');
            } else {
                send(res, 500, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-cache' }, '500 Internal Server Error');
            }
        } else {
            send(res, 200, { 'Content-Type': contentType, ...cacheHeaders(absPath) }, data);
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

