require('dotenv').config();

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ──────────────────────────────────────────────────────
// SPACE-specific dependencies
// ──────────────────────────────────────────────────────
const mongoose  = require('mongoose');
const jwt       = require('jsonwebtoken');
const bcrypt    = require('bcryptjs');
const { Server: SocketServer } = require('socket.io');
const { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');

const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

// ──────────────────────────────────────────────────────
// CONFIG
// ──────────────────────────────────────────────────────
const PORT       = 3000;
const VERSION    = '3.0.0';
const PUBLIC_DIR = path.join(__dirname, 'public');
const BOARD_FILE    = path.join(__dirname, 'board.json');
const NOTES_FILE    = path.join(__dirname, 'notes.json');
const UPTIME_DB_FILE = path.join(__dirname, 'uptime_db.json');
const UPTIME_CYCLE_DAYS = 30;
const PROJECTS_FILE = path.join(__dirname, 'projects.json');
const UPLOADS_DIR   = path.join(PUBLIC_DIR, 'uploads');
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

// ── Secrets — all loaded from environment (.env). No secrets in source. ──
const CRLPASS    = process.env.CRLPASS;
const JWT_SECRET = process.env.JWT_SECRET;
let adminToken   = crypto.randomBytes(32).toString('hex');

// ── MongoDB ──
const MONGO_URI = process.env.MONGO_URI;

// ── R2 / S3 ──
const R2_ACCESS_KEY = process.env.R2_ACCESS_KEY;
const R2_SECRET_KEY = process.env.R2_SECRET_KEY;
const R2_ENDPOINT   = process.env.R2_ENDPOINT;
const R2_BUCKET     = process.env.R2_BUCKET || 'space';
const R2_PUBLIC_URL = process.env.R2_PUBLIC_URL;

// ── Gemini (server-side proxy; key never reaches the browser) ──
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODELS  = (process.env.GEMINI_MODELS ||
    'gemini-3.1-flash-lite,gemini-2.5-flash-lite-preview-06-17,gemini-2.0-flash-lite,gemini-2.0-flash')
    .split(',').map(s => s.trim()).filter(Boolean);

// Warn loudly if any critical secret is missing so misconfig is obvious
(() => {
    const required = { JWT_SECRET, MONGO_URI, R2_ACCESS_KEY, R2_SECRET_KEY, R2_ENDPOINT, R2_PUBLIC_URL, CRLPASS };
    const missing = Object.entries(required).filter(([, v]) => !v).map(([k]) => k);
    if (missing.length) {
        console.warn('\x1b[33m[ENV] Missing required variables:\x1b[0m ' + missing.join(', ') +
            '  → copy .env.example to .env and fill them in.');
    }
    if (!GEMINI_API_KEY) console.warn('\x1b[33m[ENV] GEMINI_API_KEY not set — AI assistant will be disabled.\x1b[0m');
})();

const r2 = new S3Client({
    region: 'auto',
    endpoint: R2_ENDPOINT,
    credentials: { accessKeyId: R2_ACCESS_KEY, secretAccessKey: R2_SECRET_KEY },
    forcePathStyle: true
});

// ──────────────────────────────────────────────────────
// MONGODB SCHEMAS
// ──────────────────────────────────────────────────────

async function connectMongo() {
    try {
        await mongoose.connect(MONGO_URI);
        console.log('  \x1b[32m✓\x1b[0m MongoDB connected');
    } catch (e) {
        console.error('  \x1b[31m✗\x1b[0m MongoDB error:', e.message);
    }
}

const UserSchema = new mongoose.Schema({
    username:     { type: String, required: true, unique: true, trim: true, lowercase: true },
    email:        { type: String, required: true, unique: true, trim: true, lowercase: true },
    passwordHash: { type: String, required: true },
    role:         { type: String, enum: ['owner', 'member', 'viewer'], default: 'member' },
    color:        { type: String, default: '' },
    newReg:       { type: Boolean, default: false }, // false = pending, true = approved
    createdAt:    { type: Date, default: Date.now },
    lastSeen:     { type: Date, default: Date.now }
});

const SpaceSchema = new mongoose.Schema({
    name:       { type: String, default: 'My Space' },
    slug:       { type: String, unique: true, sparse: true, index: true }, // URL identifier: /canvas/:slug
    ownerId:    { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true }, // canvas owner (admin)
    // Permissions (multi-canvas): explicit role lists by userId
    editors:    [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }], // can do everything except manage rights / delete canvas
    readers:    [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }], // view + cursors only (read-only)
    members:    [{ userId: mongoose.Schema.Types.ObjectId, role: String }], // legacy — kept for backward compat
    isPublic:   { type: Boolean, default: false },
    shareToken: { type: String, default: () => crypto.randomBytes(12).toString('hex') },
    // Team-chat placement (shared by everyone): 'panel' | 'floating' | 'canvas'
    chatMode:   { type: String, enum: ['panel', 'floating', 'canvas'], default: 'panel' },
    chatPos:    { x: { type: Number, default: 80 }, y: { type: Number, default: 80 } },
    createdAt:  { type: Date, default: Date.now },
    updatedAt:  { type: Date, default: Date.now }
});

const NodeSchema = new mongoose.Schema({
    spaceId:  { type: mongoose.Schema.Types.ObjectId, ref: 'Space', required: true },
    type:     { type: String, enum: ['note', 'file', 'image', 'ai-generated', 'folder'], default: 'note' },
    parentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Node', default: null }, // set → filed inside a folder
    title:    { type: String, default: 'Note' },
    content:  { type: String, default: '' },
    position: { x: { type: Number, default: 100 }, y: { type: Number, default: 100 } },
    size:     { w: { type: Number, default: 200 }, h: { type: Number, default: 120 } },
    color:    { type: String, default: '' },
    zIndex:   { type: Number, default: 1 },
    locked:   { type: Boolean, default: false },
    fileRef: {
        r2Key: String, url: String, name: String,
        ext: String, size: Number, mimeType: String
    },
    // Soft-delete (Trash Bin): items stay in DB with deleted flag until purged after 30 min
    deleted:   { type: Boolean, default: false },
    deletedAt: { type: Date, default: null },
    deletedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    metadata: {
        createdBy:  { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
        createdAt:  { type: Date, default: Date.now },
        updatedAt:  { type: Date, default: Date.now },
        updatedBy:  mongoose.Schema.Types.ObjectId
    }
});

const EdgeSchema = new mongoose.Schema({
    spaceId:      { type: mongoose.Schema.Types.ObjectId, ref: 'Space', required: true },
    sourceNodeId: { type: mongoose.Schema.Types.ObjectId, ref: 'Node', required: true },
    targetNodeId: { type: mongoose.Schema.Types.ObjectId, ref: 'Node', required: true },
    sourceSide:   { type: String, enum: ['top','right','bottom','left'], default: 'right' },
    targetSide:   { type: String, enum: ['top','right','bottom','left'], default: 'left' },
    style:        { type: String, enum: ['solid', 'dashed', 'animated'], default: 'animated' },
    color:        { type: String, default: '' },
    tension:      { type: Number, default: 0.5 },
    createdBy:    { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    // Soft-delete (Trash Bin)
    deleted:      { type: Boolean, default: false },
    deletedAt:    { type: Date, default: null },
    deletedBy:    { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    createdAt:    { type: Date, default: Date.now }
});

const ChangelogSchema = new mongoose.Schema({
    spaceId:    { type: mongoose.Schema.Types.ObjectId, ref: 'Space' },
    userId:     { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    action:     { type: String },
    targetType: { type: String },
    targetId:   { type: mongoose.Schema.Types.ObjectId },
    before:     mongoose.Schema.Types.Mixed,
    after:      mongoose.Schema.Types.Mixed,
    timestamp:  { type: Date, default: Date.now }
});

// Persistent AI chat history (per canvas). Shared by everyone in the space.
const AiMessageSchema = new mongoose.Schema({
    spaceId:   { type: mongoose.Schema.Types.ObjectId, ref: 'Space', required: true, index: true },
    role:      { type: String, enum: ['user', 'assistant'], required: true },
    text:      { type: String, default: '' },
    username:  { type: String, default: '' },
    actions:   { type: Number, default: 0 },     // how many canvas actions this message performed
    createdAt: { type: Date, default: Date.now }
});

// Freehand drawing strokes (pen/marker) — stored in world coordinates.
const StrokeSchema = new mongoose.Schema({
    spaceId:   { type: mongoose.Schema.Types.ObjectId, ref: 'Space', required: true, index: true },
    points:    [{ x: Number, y: Number, _id: false }],
    color:     { type: String, default: '#9aa0a6' },
    width:     { type: Number, default: 4 },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    createdAt: { type: Date, default: Date.now }
});

// Team group-chat messages (per canvas). @agent mentions invoke the AI agent.
const ChatMessageSchema = new mongoose.Schema({
    spaceId:   { type: mongoose.Schema.Types.ObjectId, ref: 'Space', required: true, index: true },
    userId:    { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    username:  { type: String, default: '' },
    color:     { type: String, default: '' },
    text:      { type: String, default: '' },
    agent:     { type: Boolean, default: false },   // true for messages authored by the AI agent
    reactions: { type: Object, default: {} },        // { "👍": [userId, ...], ... }
    createdAt: { type: Date, default: Date.now }
});

const User      = mongoose.model('User', UserSchema);
const Space     = mongoose.model('Space', SpaceSchema);
const Node      = mongoose.model('Node', NodeSchema);
const Edge      = mongoose.model('Edge', EdgeSchema);
const Changelog = mongoose.model('Changelog', ChangelogSchema);
const AiMessage = mongoose.model('AiMessage', AiMessageSchema);
const Stroke    = mongoose.model('Stroke', StrokeSchema);
const ChatMessage = mongoose.model('ChatMessage', ChatMessageSchema);

// Serialise a chat message for the client
function serializeChatMsg(m) {
    return {
        _id: m._id, userId: m.userId, username: m.username, color: m.color,
        text: m.text, agent: !!m.agent, reactions: m.reactions || {}, createdAt: m.createdAt
    };
}

// ──────────────────────────────────────────────────────
// SPACE PERMISSIONS HELPERS (multi-canvas)
// ──────────────────────────────────────────────────────

const TRASH_TTL_MS   = 30 * 60 * 1000;            // purge soft-deleted items after 30 min
const TRASH_SWEEP_MS  = 5 * 60 * 1000;            // run cleanup every 5 min

// Build a URL-safe unique slug from a name (e.g. "My Space" → "my-space-a1b2c3")
async function generateSlug(name) {
    const base = String(name || 'canvas')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 32) || 'canvas';
    // try a few random suffixes to guarantee uniqueness
    for (let i = 0; i < 6; i++) {
        const slug = `${base}-${crypto.randomBytes(3).toString('hex')}`;
        const exists = await Space.exists({ slug });
        if (!exists) return slug;
    }
    return `${base}-${Date.now().toString(36)}`;
}

// Resolve a user's role on a given space document → 'owner' | 'editor' | 'reader' | null
function getSpaceRole(space, userId) {
    if (!space || !userId) return null;
    const uid = userId.toString();
    if (space.ownerId && space.ownerId.toString() === uid) return 'owner';
    if ((space.editors || []).some(id => id && id.toString() === uid)) return 'editor';
    if ((space.readers || []).some(id => id && id.toString() === uid)) return 'reader';
    return null;
}

// Gate a space-scoped request. `level` = 'read' | 'write' | 'owner'.
// Returns { user, space, role } on success, or null after sending an error response.
async function requireSpaceAccess(req, res, spaceId, level = 'read') {
    const user = await requireAuth(req, res);
    if (!user) return null; // requireAuth already responded
    let space;
    try { space = await Space.findById(spaceId); } catch { space = null; }
    if (!space) {
        res.writeHead(404, getSecurityHeaders('application/json'));
        res.end(JSON.stringify({ error: 'Space not found' }));
        return null;
    }
    const role = getSpaceRole(space, user._id);
    const ok =
        level === 'owner' ? role === 'owner' :
        level === 'write' ? (role === 'owner' || role === 'editor') :
        /* read */          (role === 'owner' || role === 'editor' || role === 'reader');
    if (!ok) {
        res.writeHead(403, getSecurityHeaders('application/json'));
        res.end(JSON.stringify({ error: 'Forbidden — insufficient permissions for this canvas' }));
        return null;
    }
    return { user, space, role };
}

// Best-effort deletion of a list of R2 object keys (ignores individual failures)
async function deleteR2Keys(keys) {
    const list = (keys || []).filter(Boolean);
    for (const Key of list) {
        try {
            await r2.send(new DeleteObjectCommand({ Bucket: R2_BUCKET, Key }));
        } catch (e) {
            console.error('  [R2] delete failed for', Key, '—', e.message);
        }
    }
}

// Serialize a space for the client (includes caller's role)
function serializeSpace(space, userId) {
    return {
        _id:      space._id,
        name:     space.name,
        slug:     space.slug,
        ownerId:  space.ownerId,
        editors:  space.editors || [],
        readers:  space.readers || [],
        role:     getSpaceRole(space, userId),
        createdAt: space.createdAt,
        updatedAt: space.updatedAt
    };
}

// ──────────────────────────────────────────────────────
// AI AGENT (server-side Gemini proxy — key never reaches the client)
// ──────────────────────────────────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const AI_NODE_COLORS = new Set(['white', 'blue', 'green', 'purple', 'yellow', 'red']);
const aiRateLimit = new Map(); // userId → last request ts (basic anti-spam)

// One Gemini call to a specific model. Resolves { status, json } (never throws).
function geminiFetch(model, body) {
    return new Promise((resolve) => {
        const payload = JSON.stringify(body);
        const r = https.request({
            hostname: 'generativelanguage.googleapis.com',
            path: `/v1beta/models/${model}:generateContent?key=${encodeURIComponent(GEMINI_API_KEY)}`,
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
        }, (resp) => {
            let buf = '';
            resp.on('data', (c) => { buf += c; });
            resp.on('end', () => {
                let json = {};
                try { json = JSON.parse(buf); } catch {}
                resolve({ status: resp.statusCode, json });
            });
        });
        r.on('error', (e) => resolve({ status: 0, json: { error: { message: e.message } } }));
        r.write(payload); r.end();
    });
}

// Core agent: builds canvas context, calls Gemini, performs canvas actions
// (broadcasting each to the room) and returns { reply } or { error }.
// `contents` is the prior conversation already mapped to Gemini's format.
async function agentRun(spaceId, user, userText, viewport, pinnedIds, contents) {
    const nodes = await Node.find({ spaceId, deleted: { $ne: true } }).lean();
    const pinnedSet = new Set(pinnedIds);
    const ctxLines = nodes.length ? nodes.map((n) => {
        const isPinned = pinnedSet.has(n._id.toString());
        const content = String(n.content || '').replace(/\s+/g, ' ').slice(0, isPinned ? 800 : 120);
        return `- id:${n._id} type:${n.type} title:"${String(n.title || '').slice(0, 80)}"`
            + (content ? ` content:"${content}"` : '') + (isPinned ? ' [PINNED]' : '');
    }).join('\n') : '(canvas is empty)';

    const systemPrompt =
`You are Space AI — an agent embedded in an infinite-canvas workspace ("Space" by CRLX1Q).
You help the user capture projects, ideas and notes, and you can ACT on the canvas.
Always answer in the same language the user wrote in.

Current canvas nodes (use these EXACT ids for connect/update):
${ctxLines}

Return JSON only, matching the schema:
- "reply": a short human-readable summary of what you did or your answer (user's language). Always required.
- "actions": optional array (max 12). Each item has a "type":
   • create_note  → fields: title, content, color(optional: white|blue|green|purple|yellow|red)
   • update_note  → fields: id (existing node id from the list above), and any of title/content/color
   • connect      → fields: from, to (both existing node ids from the list above)
Guidelines:
- Only include actions when the user asks you to build/modify the canvas. Otherwise return an empty actions array and just answer in "reply".
- Never invent ids; only use ids present in the list above for update_note/connect.
- Keep notes concise and useful. Prefer a few well-structured notes over many tiny ones.`;

    const genBody = {
        systemInstruction: { parts: [{ text: systemPrompt }] },
        contents,
        generationConfig: {
            temperature: 0.7,
            maxOutputTokens: 2048,
            responseMimeType: 'application/json',
            responseSchema: {
                type: 'object',
                properties: {
                    reply: { type: 'string' },
                    actions: {
                        type: 'array',
                        items: {
                            type: 'object',
                            properties: {
                                type:    { type: 'string' },
                                title:   { type: 'string' },
                                content: { type: 'string' },
                                color:   { type: 'string' },
                                id:      { type: 'string' },
                                from:    { type: 'string' },
                                to:      { type: 'string' }
                            },
                            required: ['type']
                        }
                    }
                },
                required: ['reply']
            }
        }
    };

    const { text: aiText, error } = await callGeminiServer(genBody);
    if (error) return { error };

    let parsed = {};
    try { parsed = JSON.parse(aiText); } catch { parsed = { reply: aiText, actions: [] }; }
    let reply = String(parsed.reply || '').trim();
    const actions = Array.isArray(parsed.actions) ? parsed.actions.slice(0, 12) : [];

    const created = [];
    let updated = 0, connected = 0, idx = 0;
    for (const a of actions) {
        const type = String(a.type || '');
        try {
            if (type === 'create_note') {
                const title = String(a.title || 'Note').slice(0, 120);
                const content = String(a.content || '').slice(0, 5000);
                const color = AI_NODE_COLORS.has(a.color) ? a.color : 'purple';
                const pos = {
                    x: Math.round(viewport.x + (idx % 4) * 240 - 120),
                    y: Math.round(viewport.y + Math.floor(idx / 4) * 180 - 80)
                };
                const node = await Node.create({
                    spaceId, type: 'ai-generated', title, content, color,
                    position: pos, size: { w: 220, h: 150 },
                    'metadata.createdBy': user._id, 'metadata.createdAt': new Date()
                });
                io.to(spaceId).emit('node:create', { node: node.toObject(), userId: 'ai' });
                Changelog.create({ spaceId, userId: user._id, action: 'ai-create', targetType: 'node', targetId: node._id, after: node }).catch(() => {});
                created.push(title); idx++;
                await sleep(240);
            } else if (type === 'update_note') {
                if (!/^[a-f0-9]{24}$/.test(String(a.id || ''))) continue;
                const upd = {};
                if (a.title != null)   upd.title   = String(a.title).slice(0, 120);
                if (a.content != null) upd.content = String(a.content).slice(0, 5000);
                if (AI_NODE_COLORS.has(a.color)) upd.color = a.color;
                if (!Object.keys(upd).length) continue;
                const node = await Node.findOneAndUpdate(
                    { _id: a.id, spaceId, deleted: { $ne: true } },
                    { ...upd, 'metadata.updatedAt': new Date(), 'metadata.updatedBy': user._id },
                    { new: true }
                );
                if (node) {
                    io.to(spaceId).emit('node:update', { nodeId: node._id.toString(), updates: upd, userId: 'ai' });
                    updated++; await sleep(200);
                }
            } else if (type === 'connect') {
                if (!/^[a-f0-9]{24}$/.test(String(a.from || '')) || !/^[a-f0-9]{24}$/.test(String(a.to || ''))) continue;
                if (a.from === a.to) continue;
                const cnt = await Node.countDocuments({ _id: { $in: [a.from, a.to] }, spaceId, deleted: { $ne: true } });
                if (cnt < 2) continue;
                const edge = await Edge.create({
                    spaceId, sourceNodeId: a.from, targetNodeId: a.to,
                    sourceSide: 'right', targetSide: 'left', style: 'animated', createdBy: user._id
                });
                io.to(spaceId).emit('edge:create', { edge: edge.toObject(), userId: 'ai' });
                connected++; await sleep(200);
            }
        } catch (e) {
            console.error('[AI] action failed:', type, e.message);
        }
    }

    if (!reply) {
        const bits = [];
        if (created.length) bits.push(`создал ${created.length} заметк(и): ${created.join(', ')}`);
        if (updated) bits.push(`обновил ${updated} нод`);
        if (connected) bits.push(`добавил ${connected} связ(и)`);
        reply = bits.length ? `Готово — ${bits.join('; ')}.` : 'Готово.';
    }
    return { reply, actions: created.length + updated + connected };
}

// Walk the model fallback list. Returns { text } on success or { error }.
async function callGeminiServer(body) {
    let lastError = 'No response';
    for (const model of GEMINI_MODELS) {
        const { status, json } = await geminiFetch(model, body);
        if (status >= 200 && status < 300 && !json.error) {
            const cand = json.candidates?.[0];
            const text = cand?.content?.parts?.map((p) => p.text).filter(Boolean).join('') || '';
            if (text) return { text };
            lastError = cand?.finishReason
                ? `No output (${cand.finishReason})`
                : (json.promptFeedback?.blockReason ? `Blocked: ${json.promptFeedback.blockReason}` : 'Empty response');
            continue; // empty → try next model
        }
        lastError = json.error?.message || `HTTP ${status}`;
        if (status === 404 || status === 400) continue; // model missing / bad request → next
        return { error: lastError }; // auth / quota / network → stop
    }
    return { error: lastError };
}

// ──────────────────────────────────────────────────────
// MIME TYPES
// ──────────────────────────────────────────────────────
const MIME_TYPES = {
    '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript',
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
    '.gif': 'image/gif', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
    '.json': 'application/json', '.txt': 'text/plain',
    '.woff': 'font/woff', '.woff2': 'font/woff2'
};

// ──────────────────────────────────────────────────────
// SECURITY HEADERS
// ──────────────────────────────────────────────────────
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
            "img-src 'self' data: https: blob:",
            "connect-src 'self' wss: ws: https://generativelanguage.googleapis.com https://www.google-analytics.com https://*.google-analytics.com https://*.analytics.google.com https://*.googletagmanager.com https://*.r2.cloudflarestorage.com",
            "frame-ancestors 'none'",
            "media-src 'self' blob: https://*.r2.dev https://pub-fe6f29a1871540698dda93f6f50946b9.r2.dev",
        ].join('; ');
    } else if (contentType === 'application/json') {
        headers['Cache-Control'] = 'no-store, no-cache, must-revalidate, proxy-revalidate';
        headers['Pragma'] = 'no-cache';
        headers['Expires'] = '0';
    } else {
        headers['Cache-Control'] = 'public, max-age=31536000, immutable';
    }
    return headers;
}

// ──────────────────────────────────────────────────────
// AUTH MIDDLEWARE
// ──────────────────────────────────────────────────────
function parseBody(req) {
    return new Promise((resolve) => {
        let body = '';
        req.on('data', chunk => body += chunk.toString());
        req.on('end', () => {
            try { resolve(body ? JSON.parse(body) : {}); } catch (e) { resolve({}); }
        });
    });
}

function isAdmin(req) {
    return req.headers['authorization'] === 'Bearer ' + adminToken;
}

function verifyJWT(req) {
    const auth = req.headers['authorization'];
    if (!auth || !auth.startsWith('Bearer ')) return null;
    try {
        return jwt.verify(auth.slice(7), JWT_SECRET);
    } catch { return null; }
}

async function requireAuth(req, res) {
    const payload = verifyJWT(req);
    if (!payload) {
        res.writeHead(401, getSecurityHeaders('application/json'));
        res.end(JSON.stringify({ error: 'Unauthorized' }));
        return null;
    }
    const user = await User.findById(payload.userId).lean();
    if (!user || !user.newReg) {
        res.writeHead(403, getSecurityHeaders('application/json'));
        res.end(JSON.stringify({ error: user ? 'Account pending approval' : 'User not found' }));
        return null;
    }
    return user;
}

// ──────────────────────────────────────────────────────
// EXISTING: Projects, Board, Articles (JSON files)
// ──────────────────────────────────────────────────────
let projects = [];
if (fs.existsSync(PROJECTS_FILE)) {
    try { projects = JSON.parse(fs.readFileSync(PROJECTS_FILE, 'utf8')); } catch (e) {}
}

let uptimeDB = { cycleStart: null, projects: {} };
function getToday() { return new Date().toISOString().slice(0, 10); }
function loadUptimeDB() {
    try {
        if (fs.existsSync(UPTIME_DB_FILE)) uptimeDB = JSON.parse(fs.readFileSync(UPTIME_DB_FILE, 'utf8'));
    } catch (e) { uptimeDB = { cycleStart: null, projects: {} }; }
    const today = getToday();
    if (uptimeDB.cycleStart) {
        const d = Math.floor((new Date(today) - new Date(uptimeDB.cycleStart)) / 86400000);
        if (d >= UPTIME_CYCLE_DAYS) uptimeDB = { cycleStart: today, projects: {} };
    } else { uptimeDB.cycleStart = today; }
    for (const n in uptimeDB.projects) rolloverDay(uptimeDB.projects[n], today);
    saveUptimeDB();
}
function saveUptimeDB() {
    const tmp = UPTIME_DB_FILE + '.tmp';
    try { fs.writeFileSync(tmp, JSON.stringify(uptimeDB, null, 2)); fs.renameSync(tmp, UPTIME_DB_FILE); } catch {}
}
function rolloverDay(p, today) {
    if (p.todayDate && p.todayDate !== today) {
        const pct = p.todayChecks > 0 ? parseFloat(((p.todaySuccess / p.todayChecks) * 100).toFixed(2)) : 100;
        if (!p.days) p.days = [];
        p.days.push({ d: p.todayDate, up: pct });
        p.todayDate = today; p.todayChecks = 0; p.todaySuccess = 0;
    }
}
function recordCheck(name, ok) {
    const today = getToday();
    if (!uptimeDB.projects[name]) uptimeDB.projects[name] = { todayDate: today, todayChecks: 0, todaySuccess: 0, days: [] };
    const p = uptimeDB.projects[name];
    rolloverDay(p, today);
    if (!p.todayDate) p.todayDate = today;
    p.todayChecks++; if (ok) p.todaySuccess++;
}
function getProjectUptime(name) {
    const p = uptimeDB.projects[name];
    if (!p) return '100.00';
    const today = getToday(); rolloverDay(p, today);
    let tot = 0, cnt = 0;
    if (p.days) { for (const d of p.days) { tot += d.up; cnt++; } }
    if (p.todayChecks > 0) { tot += (p.todaySuccess / p.todayChecks) * 100; cnt++; }
    if (cnt === 0) return '100.00';
    return (tot / cnt).toFixed(2);
}

function checkProjectsStatus() {
    const timestamp = new Date().toISOString().replace('T', ' ').slice(0, 19);
    console.log(`\n\x1b[90m  ┌──────────────────────────────────────────────────\x1b[0m`);
    console.log(`\x1b[90m  │\x1b[0m \x1b[36m⟳\x1b[0m  \x1b[1mUptime Service\x1b[0m \x1b[90m— v${VERSION} — ${timestamp}\x1b[0m`);
    console.log(`\x1b[90m  ├──────────────────────────────────────────────────\x1b[0m`);
    const today = getToday();
    if (uptimeDB.cycleStart) {
        const d = Math.floor((new Date(today) - new Date(uptimeDB.cycleStart)) / 86400000);
        if (d >= UPTIME_CYCLE_DAYS) { uptimeDB = { cycleStart: today, projects: {} }; }
    }
    const checkable = projects.filter(p => p.url && p.status !== 'wip');
    let pending = checkable.length;
    function onAllDone() {
        projects.forEach(p => { if (p.status !== 'wip') p.uptime = getProjectUptime(p.name); });
        saveUptimeDB();
        const cd = Math.floor((new Date(today) - new Date(uptimeDB.cycleStart)) / 86400000) + 1;
        console.log(`\x1b[90m  │\x1b[0m  \x1b[90m📊 Day ${cd}/${UPTIME_CYCLE_DAYS}\x1b[0m`);
        console.log(`\x1b[90m  └──────────────────────────────────────────────────\x1b[0m`);
    }
    if (pending === 0) { onAllDone(); return; }
    projects.forEach(p => {
        if (!p.url || p.status === 'wip') { if (p.status === 'wip') { console.log(`\x1b[90m  │\x1b[0m  \x1b[33m◐\x1b[0m [WIP]    ${p.name}`); } return; }
        let handled = false;
        function finish(ok, log) {
            if (handled) return; handled = true;
            recordCheck(p.name, ok); p.uptime = getProjectUptime(p.name);
            if (log) log(); if (--pending <= 0) onAllDone();
        }
        const req = https.get(p.url, { timeout: 5000 }, (res) => {
            res.resume();
            res.on('end', () => { try { req.destroy(); } catch {} });
            if (res.statusCode >= 200 && res.statusCode < 400) { p.status = 'live'; finish(true, () => console.log(`\x1b[90m  │\x1b[0m  \x1b[32m✓\x1b[0m [LIVE]   ${p.name}`)); }
            else { p.status = 'offline'; finish(false, () => console.log(`\x1b[90m  │\x1b[0m  \x1b[31m✗\x1b[0m [DOWN]   ${p.name}`)); }
        }).on('error', (e) => {
            if (e.code === 'ERR_SOCKET_CLOSED' || e.message === 'socket hang up') return;
            p.status = 'offline'; finish(false, () => console.log(`\x1b[90m  │\x1b[0m  \x1b[31m✗\x1b[0m [ERROR]  ${p.name}`));
        });
        req.on('timeout', () => { req.destroy(); p.status = 'offline'; finish(false, () => console.log(`\x1b[90m  │\x1b[0m  \x1b[33m⏱\x1b[0m [TMOUT]  ${p.name}`)); });
    });
}

loadUptimeDB(); checkProjectsStatus();
setInterval(checkProjectsStatus, 5 * 60 * 1000);

let boardNotes = [];
if (fs.existsSync(BOARD_FILE)) { try { boardNotes = JSON.parse(fs.readFileSync(BOARD_FILE, 'utf8')); } catch {} }
else {
    boardNotes = [
        { text: "Awesome portfolio! Love the terminal vibe 🔥", author: "anon_dev", rot: -1 },
        { text: "Waiting for UMA beta release.", author: "crypto_guy", rot: 1.5 }
    ];
    fs.writeFileSync(BOARD_FILE, JSON.stringify(boardNotes, null, 2));
}

let articles = [];
if (fs.existsSync(NOTES_FILE)) { try { articles = JSON.parse(fs.readFileSync(NOTES_FILE, 'utf8')); } catch {} }
else fs.writeFileSync(NOTES_FILE, JSON.stringify([], null, 2));

const ipRateLimit = new Map();
setInterval(() => {
    const now = Date.now(), TTL = 30 * 60 * 1000;
    for (const [ip, t] of ipRateLimit) if (now - t > TTL) ipRateLimit.delete(ip);
}, 10 * 60 * 1000);

function getClientIP(req) {
    const f = req.headers['x-forwarded-for'];
    return f ? f.split(',')[0].trim() : req.socket.remoteAddress;
}

// ──────────────────────────────────────────────────────
// HTTP SERVER + SOCKET.IO
// ──────────────────────────────────────────────────────
const httpServer = http.createServer(handleRequest);

const io = new SocketServer(httpServer, {
    cors: {
        origin: ['http://localhost:3000', 'https://space.crlx1q.com', 'https://crlx1q.com'],
        credentials: true
    }
});

// ──────────────────────────────────────────────────────
// SOCKET.IO — REAL-TIME COLLABORATION
// ──────────────────────────────────────────────────────
// Live presence is derived from the actual sockets in a room (deduped by
// userId) so multiple tabs count once and stale "ghosts" can't accumulate.
async function presenceFor(spaceId) {
    let sockets = [];
    try { sockets = await io.in(spaceId).fetchSockets(); } catch { sockets = []; }
    const map = new Map();
    for (const s of sockets) {
        const uid = s.data?.userId;
        if (uid && !map.has(uid)) {
            map.set(uid, { userId: uid, username: s.data.username, color: s.data.color });
        }
    }
    return [...map.values()];
}

io.use((socket, next) => {
    const token = socket.handshake.auth?.token;
    if (!token) { next(new Error('No token')); return; }
    try {
        const p = jwt.verify(token, JWT_SECRET);
        socket.userId = p.userId;
        socket.username = p.username;
        // Mirror into socket.data so presenceFor() (RemoteSocket) can read them
        socket.data.userId = p.userId;
        socket.data.username = p.username;
        next();
    } catch { next(new Error('Invalid token')); }
});

io.on('connection', (socket) => {
    console.log(`\x1b[90m  [WS]\x1b[0m connected: ${socket.username}`);

    socket.on('space:join', async ({ spaceId, userId, username, color }) => {
        // Permission check — only users with a role on this canvas may join its room
        let role = null, space = null;
        try {
            space = await Space.findById(spaceId).lean();
            role = getSpaceRole(space, socket.userId);
        } catch { role = null; }
        if (!role || !space) {
            socket.emit('space:denied', { spaceId });
            return;
        }
        socket.spaceRole = role;
        socket.data.color = color;
        socket.join(spaceId);
        socket.currentSpace = spaceId;

        // Stage 2: Send full snapshot to joining user (incl. AI history, drawings, chat)
        let snapNodes = [], snapEdges = [], aiHistory = [], snapStrokes = [], chatHistory = [];
        try {
            [snapNodes, snapEdges, aiHistory, snapStrokes, chatHistory] = await Promise.all([
                Node.find({ spaceId, deleted: { $ne: true } }).lean(),
                Edge.find({ spaceId, deleted: { $ne: true } }).lean(),
                AiMessage.find({ spaceId }).sort({ createdAt: -1 }).limit(80).lean(),
                Stroke.find({ spaceId }).sort({ createdAt: 1 }).lean(),
                ChatMessage.find({ spaceId }).sort({ createdAt: -1 }).limit(120).lean()
            ]);
            aiHistory.reverse();
            chatHistory.reverse();
        } catch (err) {
            console.error('[WS] snapshot error:', err.message);
        }
        const users = await presenceFor(spaceId);
        socket.emit('space:snapshot', {
            nodes: snapNodes, edges: snapEdges, strokes: snapStrokes, aiHistory,
            chat: chatHistory.map(serializeChatMsg),
            chatMode: space.chatMode || 'panel',
            chatPos: space.chatPos || { x: 80, y: 80 },
            onlineCount: users.length, users
        });

        // Broadcast updated presence to the whole room
        io.to(spaceId).emit('space:online', { count: users.length, users });
    });

    // Readers may observe (cursors) but cannot mutate — drop their write broadcasts
    const canWrite = () => socket.spaceRole === 'owner' || socket.spaceRole === 'editor';

    socket.on('node:create', (data) => {
        if (!canWrite()) return;
        socket.to(data.spaceId).emit('node:create', { ...data, userId: socket.userId });
    });
    socket.on('node:move', (data) => {
        if (!canWrite()) return;
        socket.to(data.spaceId).emit('node:move', { ...data, userId: socket.userId });
    });
    socket.on('node:update', (data) => {
        if (!canWrite()) return;
        socket.to(data.spaceId).emit('node:update', { ...data, userId: socket.userId });
    });
    socket.on('node:delete', (data) => {
        if (!canWrite()) return;
        socket.to(data.spaceId).emit('node:delete', { ...data, userId: socket.userId });
    });
    socket.on('edge:create', (data) => {
        if (!canWrite()) return;
        socket.to(data.spaceId).emit('edge:create', { ...data, userId: socket.userId });
    });
    socket.on('edge:delete', (data) => {
        if (!canWrite()) return;
        socket.to(data.spaceId).emit('edge:delete', { ...data, userId: socket.userId });
    });
    // Freehand drawing — broadcast finished strokes / erasures to the room
    socket.on('draw:create', (data) => {
        if (!canWrite()) return;
        socket.to(data.spaceId).emit('draw:create', { ...data, userId: socket.userId });
    });
    socket.on('draw:delete', (data) => {
        if (!canWrite()) return;
        socket.to(data.spaceId).emit('draw:delete', { ...data, userId: socket.userId });
    });
    socket.on('cursor:move', (data) => {
        // cursors allowed for everyone (incl. readers)
        socket.to(data.spaceId).emit('cursor:move', {
            ...data, userId: socket.userId, username: socket.username
        });
    });

    // Shared AI chat is now fully server-orchestrated via REST (/api/space/spaces/:id/ai):
    // the server validates permissions, calls Gemini, performs canvas actions and
    // broadcasts ai:message / ai:thinking / ai:clear to the whole room. Clients no
    // longer emit AI events directly (prevents spoofed messages).

    // "Someone is typing to the AI" presence (just a hint; no content sent)
    socket.on('ai:typing', (data) => {
        if (!canWrite()) return;
        socket.to(data.spaceId).emit('ai:typing', { username: socket.username });
    });
    socket.on('ai:typing-stop', (data) => {
        if (!canWrite()) return;
        socket.to(data.spaceId).emit('ai:typing-stop', { username: socket.username });
    });

    // Team chat — typing presence (anyone in the room may chat)
    socket.on('chat:typing', (data) => {
        socket.to(data.spaceId).emit('chat:typing', { username: socket.username });
    });
    socket.on('chat:typing-stop', (data) => {
        socket.to(data.spaceId).emit('chat:typing-stop', { username: socket.username });
    });
    // Team chat — shared placement mode (panel | floating | canvas). Persisted on the space.
    socket.on('chat:mode', async (data) => {
        const mode = ['panel', 'floating', 'canvas'].includes(data.mode) ? data.mode : 'panel';
        const pos = (data.pos && typeof data.pos.x === 'number') ? { x: data.pos.x, y: data.pos.y } : undefined;
        try {
            const upd = { chatMode: mode };
            if (pos) upd.chatPos = pos;
            await Space.findByIdAndUpdate(socket.currentSpace, upd);
        } catch {}
        io.to(socket.currentSpace).emit('chat:mode', { mode, pos });
    });

    // Stage 2: Remote editing indicators
    socket.on('node:editing', (data) => {
        if (!canWrite()) return;
        socket.to(data.spaceId).emit('node:editing', { ...data, userId: socket.userId });
    });
    socket.on('node:editing-stop', (data) => {
        if (!canWrite()) return;
        socket.to(data.spaceId).emit('node:editing-stop', { ...data, userId: socket.userId });
    });

    socket.on('disconnect', async () => {
        const spaceId = socket.currentSpace;
        if (spaceId) {
            // Socket has already left its rooms here, so presence excludes it.
            const users = await presenceFor(spaceId);
            io.to(spaceId).emit('space:online', { count: users.length, users });
            // Only signal "leave" if this user has no other live sockets here
            if (!users.some(u => u.userId === socket.userId)) {
                io.to(spaceId).emit('user:leave', { userId: socket.userId });
            }
        }
        console.log(`\x1b[90m  [WS]\x1b[0m disconnected: ${socket.username}`);
    });
});

// ──────────────────────────────────────────────────────
// MAIN REQUEST HANDLER
// ──────────────────────────────────────────────────────
async function handleRequest(req, res) {
    const url = req.url.split('?')[0];
    const method = req.method;
    const host = req.headers.host || '';

    // ── Domain Redirects ──
    if (host.includes('crlx1q.com') && !host.startsWith('space.')) {
        if (url === '/space' || url === '/space/') {
            res.writeHead(302, { Location: `https://space.crlx1q.com/` });
            return res.end();
        }
        if (url.startsWith('/space/canvas')) {
            res.writeHead(302, { Location: `https://space.crlx1q.com${url.replace('/space', '')}` });
            return res.end();
        }
        if (url.startsWith('/canvas')) {
            res.writeHead(302, { Location: `https://space.crlx1q.com${url}` });
            return res.end();
        }
    }

    // ── Health ──
    if (url === '/health' && method === 'GET') {
        res.writeHead(200, getSecurityHeaders('application/json'));
        return res.end(JSON.stringify({ ok: true, version: VERSION, uptime: Math.floor(process.uptime()) }));
    }

    // ══════════════════════════════════════════════════
    // SPACE AUTH API
    // ══════════════════════════════════════════════════

    if (url === '/api/space/auth/register' && method === 'POST') {
        const body = await parseBody(req);
        const { username, email, password } = body;
        if (!username || !email || !password) {
            res.writeHead(400, getSecurityHeaders('application/json'));
            return res.end(JSON.stringify({ error: 'Missing fields' }));
        }
        if (password.length < 8) {
            res.writeHead(400, getSecurityHeaders('application/json'));
            return res.end(JSON.stringify({ error: 'Password min 8 characters' }));
        }
        try {
            const exists = await User.findOne({ $or: [{ username: username.toLowerCase() }, { email: email.toLowerCase() }] });
            if (exists) {
                res.writeHead(409, getSecurityHeaders('application/json'));
                return res.end(JSON.stringify({ error: 'Username or email already taken' }));
            }
            const passwordHash = await bcrypt.hash(password, 12);
            const colors = ['#4ade80','#60a5fa','#c084fc','#fb923c','#f472b6','#34d399'];
            const color = colors[Math.floor(Math.random() * colors.length)];
            // Check if first user — make them owner
            const userCount = await User.countDocuments();
            const isFirst = userCount === 0;
            const user = await User.create({
                username: username.toLowerCase(), email: email.toLowerCase(),
                passwordHash, color,
                role: isFirst ? 'owner' : 'member',
                newReg: isFirst ? true : false // first user auto-approved
            });
            res.writeHead(200, getSecurityHeaders('application/json'));
            return res.end(JSON.stringify({ ok: true, pending: !user.newReg }));
        } catch (e) {
            console.error('Register error:', e);
            res.writeHead(500, getSecurityHeaders('application/json'));
            return res.end(JSON.stringify({ error: 'Server error' }));
        }
    }

    if (url === '/api/space/auth/login' && method === 'POST') {
        const body = await parseBody(req);
        const { username, password } = body;
        if (!username || !password) {
            res.writeHead(400, getSecurityHeaders('application/json'));
            return res.end(JSON.stringify({ error: 'Missing fields' }));
        }
        try {
            const user = await User.findOne({ username: username.toLowerCase() });
            if (!user) {
                res.writeHead(401, getSecurityHeaders('application/json'));
                return res.end(JSON.stringify({ error: 'Invalid credentials' }));
            }
            if (!user.newReg) {
                res.writeHead(403, getSecurityHeaders('application/json'));
                return res.end(JSON.stringify({ error: 'Account pending admin approval' }));
            }
            const ok = await bcrypt.compare(password, user.passwordHash);
            if (!ok) {
                res.writeHead(401, getSecurityHeaders('application/json'));
                return res.end(JSON.stringify({ error: 'Invalid credentials' }));
            }
            await User.findByIdAndUpdate(user._id, { lastSeen: new Date() });
            const token = jwt.sign({ userId: user._id.toString(), username: user.username, role: user.role }, JWT_SECRET, { expiresIn: '30d' });
            res.writeHead(200, getSecurityHeaders('application/json'));
            return res.end(JSON.stringify({
                token,
                user: { _id: user._id, username: user.username, email: user.email, role: user.role, color: user.color }
            }));
        } catch (e) {
            console.error('Login error:', e);
            res.writeHead(500, getSecurityHeaders('application/json'));
            return res.end(JSON.stringify({ error: 'Server error' }));
        }
    }

    if (url === '/api/space/auth/me' && method === 'GET') {
        const user = await requireAuth(req, res);
        if (!user) return;
        res.writeHead(200, getSecurityHeaders('application/json'));
        return res.end(JSON.stringify({ _id: user._id, username: user.username, email: user.email, role: user.role, color: user.color }));
    }

    // ══════════════════════════════════════════════════
    // SPACE — SPACES CRUD (multi-canvas + permissions)
    // ══════════════════════════════════════════════════

    // List all canvases the user can access (owned + editor + reader).
    // Owners (global role) with no canvas get a default one auto-created.
    if (url === '/api/space/spaces' && method === 'GET') {
        const user = await requireAuth(req, res);
        if (!user) return;
        try {
            let spaces = await Space.find({
                $or: [{ ownerId: user._id }, { editors: user._id }, { readers: user._id }]
            }).sort({ createdAt: 1 });
            // Every approved user gets their own personal canvas (they are its owner)
            if (spaces.length === 0) {
                const slug = await generateSlug(`${user.username || 'my'} space`);
                const created = await Space.create({ name: 'My Space', slug, ownerId: user._id });
                spaces = [created];
            }
            // Backfill slugs for any legacy canvases created before slugs existed
            for (const s of spaces) {
                if (!s.slug) { s.slug = await generateSlug(s.name || 'canvas'); await s.save(); }
            }
            res.writeHead(200, getSecurityHeaders('application/json'));
            return res.end(JSON.stringify(spaces.map(s => serializeSpace(s, user._id))));
        } catch (e) {
            console.error('Spaces list error:', e);
            res.writeHead(500, getSecurityHeaders('application/json'));
            return res.end(JSON.stringify({ error: 'Server error' }));
        }
    }

    // Create a new canvas — only global "owner" role users may create
    if (url === '/api/space/spaces' && method === 'POST') {
        const user = await requireAuth(req, res);
        if (!user) return;
        if (user.role !== 'owner') {
            res.writeHead(403, getSecurityHeaders('application/json'));
            return res.end(JSON.stringify({ error: 'Only owners can create canvases' }));
        }
        const body = await parseBody(req);
        try {
            const name = (body.name || 'Untitled Canvas').toString().trim().slice(0, 60) || 'Untitled Canvas';
            const slug = await generateSlug(name);
            const space = await Space.create({ name, slug, ownerId: user._id });
            res.writeHead(200, getSecurityHeaders('application/json'));
            return res.end(JSON.stringify(serializeSpace(space, user._id)));
        } catch (e) {
            console.error('Space create error:', e);
            res.writeHead(500, getSecurityHeaders('application/json'));
            return res.end(JSON.stringify({ error: 'Server error' }));
        }
    }

    // Resolve a slug → space (must have access). Used by the frontend router.
    const slugMatch = url.match(/^\/api\/space\/spaces\/by-slug\/([A-Za-z0-9_-]+)$/);
    if (slugMatch && method === 'GET') {
        const user = await requireAuth(req, res);
        if (!user) return;
        try {
            const space = await Space.findOne({ slug: slugMatch[1] });
            if (!space) {
                res.writeHead(404, getSecurityHeaders('application/json'));
                return res.end(JSON.stringify({ error: 'Canvas not found' }));
            }
            if (!getSpaceRole(space, user._id)) {
                res.writeHead(403, getSecurityHeaders('application/json'));
                return res.end(JSON.stringify({ error: 'Forbidden' }));
            }
            res.writeHead(200, getSecurityHeaders('application/json'));
            return res.end(JSON.stringify(serializeSpace(space, user._id)));
        } catch {
            res.writeHead(500, getSecurityHeaders('application/json'));
            return res.end(JSON.stringify({ error: 'Server error' }));
        }
    }

    // Directory of users (for the owner's permission picker) — minimal public info
    if (url === '/api/space/users/directory' && method === 'GET') {
        const user = await requireAuth(req, res);
        if (!user) return;
        try {
            const users = await User.find({ newReg: true })
                .select('_id username color role').sort({ username: 1 }).lean();
            res.writeHead(200, getSecurityHeaders('application/json'));
            return res.end(JSON.stringify(users));
        } catch {
            res.writeHead(500, getSecurityHeaders('application/json'));
            return res.end(JSON.stringify({ error: 'Server error' }));
        }
    }

    // Update canvas permissions — owner only
    const permMatch = url.match(/^\/api\/space\/spaces\/([a-f0-9]{24})\/permissions$/);
    if (permMatch && method === 'PATCH') {
        const ctx = await requireSpaceAccess(req, res, permMatch[1], 'owner');
        if (!ctx) return;
        const body = await parseBody(req);
        try {
            const ownerId = ctx.space.ownerId.toString();
            const clean = (arr) => [...new Set((Array.isArray(arr) ? arr : [])
                .map(id => String(id)).filter(id => /^[a-f0-9]{24}$/.test(id) && id !== ownerId))];
            const editors = clean(body.editors);
            const readers = clean(body.readers).filter(id => !editors.includes(id)); // editor wins over reader
            ctx.space.editors = editors;
            ctx.space.readers = readers;
            ctx.space.updatedAt = new Date();
            await ctx.space.save();
            // Notify connected clients so read-only/editor state updates live
            io.to(permMatch[1]).emit('space:permissions', { spaceId: permMatch[1], editors, readers, ownerId });
            res.writeHead(200, getSecurityHeaders('application/json'));
            return res.end(JSON.stringify(serializeSpace(ctx.space, ctx.user._id)));
        } catch (e) {
            console.error('Permissions update error:', e);
            res.writeHead(500, getSecurityHeaders('application/json'));
            return res.end(JSON.stringify({ error: 'Server error' }));
        }
    }

    const spaceMatch = url.match(/^\/api\/space\/spaces\/([a-f0-9]{24})$/);
    if (spaceMatch && method === 'PATCH') {
        // Rename / safe settings — editors & owner; permission fields are ignored here
        const ctx = await requireSpaceAccess(req, res, spaceMatch[1], 'write');
        if (!ctx) return;
        const body = await parseBody(req);
        try {
            const update = { updatedAt: new Date() };
            if (typeof body.name === 'string') update.name = body.name.trim().slice(0, 60) || 'Untitled';
            const space = await Space.findByIdAndUpdate(spaceMatch[1], update, { new: true });
            res.writeHead(200, getSecurityHeaders('application/json'));
            return res.end(JSON.stringify(serializeSpace(space, ctx.user._id)));
        } catch {
            res.writeHead(500, getSecurityHeaders('application/json'));
            return res.end(JSON.stringify({ error: 'Server error' }));
        }
    }

    // Delete an entire canvas — owner only (purges nodes, edges and their R2 files)
    if (spaceMatch && method === 'DELETE') {
        const ctx = await requireSpaceAccess(req, res, spaceMatch[1], 'owner');
        if (!ctx) return;
        const spaceId = spaceMatch[1];
        try {
            const fileNodes = await Node.find({ spaceId, 'fileRef.r2Key': { $exists: true, $ne: null } })
                .select('fileRef.r2Key').lean();
            await deleteR2Keys(fileNodes.map(n => n.fileRef?.r2Key));
            await Promise.all([
                Node.deleteMany({ spaceId }),
                Edge.deleteMany({ spaceId }),
                Space.deleteOne({ _id: spaceId })
            ]);
            io.to(spaceId).emit('space:deleted', { spaceId });
            res.writeHead(200, getSecurityHeaders('application/json'));
            return res.end(JSON.stringify({ ok: true }));
        } catch (e) {
            console.error('Space delete error:', e);
            res.writeHead(500, getSecurityHeaders('application/json'));
            return res.end(JSON.stringify({ error: 'Server error' }));
        }
    }

    // ══════════════════════════════════════════════════
    // SPACE — NODES CRUD
    // ══════════════════════════════════════════════════

    const nodesListMatch = url.match(/^\/api\/space\/spaces\/([a-f0-9]{24})\/nodes$/);
    if (nodesListMatch) {
        const spaceId = nodesListMatch[1];
        // GET → read access; POST → write access
        const ctx = await requireSpaceAccess(req, res, spaceId, method === 'POST' ? 'write' : 'read');
        if (!ctx) return;
        const user = ctx.user;

        if (method === 'GET') {
            try {
                const nodes = await Node.find({ spaceId, deleted: { $ne: true } }).sort({ 'metadata.createdAt': 1 }).lean();
                res.writeHead(200, getSecurityHeaders('application/json'));
                return res.end(JSON.stringify(nodes));
            } catch {
                res.writeHead(500, getSecurityHeaders('application/json'));
                return res.end(JSON.stringify({ error: 'Server error' }));
            }
        }

        if (method === 'POST') {
            const body = await parseBody(req);
            try {
                const node = await Node.create({ ...body, spaceId, deleted: false, deletedAt: null, 'metadata.createdBy': user._id, 'metadata.createdAt': new Date() });
                // Log
                Changelog.create({ spaceId, userId: user._id, action: 'create', targetType: 'node', targetId: node._id, after: node }).catch(() => {});
                res.writeHead(200, getSecurityHeaders('application/json'));
                return res.end(JSON.stringify(node));
            } catch (e) {
                console.error('Node create error:', e);
                res.writeHead(500, getSecurityHeaders('application/json'));
                return res.end(JSON.stringify({ error: 'Server error' }));
            }
        }
    }

    const nodeMatch = url.match(/^\/api\/space\/spaces\/([a-f0-9]{24})\/nodes\/([a-f0-9]{24})$/);
    if (nodeMatch) {
        const [, spaceId, nodeId] = nodeMatch;
        const ctx = await requireSpaceAccess(req, res, spaceId, 'write');
        if (!ctx) return;
        const user = ctx.user;

        if (method === 'PATCH') {
            const body = await parseBody(req);
            // Never allow toggling soft-delete state via the generic PATCH (use trash endpoints)
            delete body.deleted; delete body.deletedAt; delete body.deletedBy;
            try {
                const node = await Node.findOneAndUpdate(
                    { _id: nodeId, spaceId },
                    { ...body, 'metadata.updatedAt': new Date(), 'metadata.updatedBy': user._id },
                    { new: true }
                );
                Changelog.create({ spaceId, userId: user._id, action: 'update', targetType: 'node', targetId: nodeId, after: body }).catch(() => {});
                res.writeHead(200, getSecurityHeaders('application/json'));
                return res.end(JSON.stringify(node));
            } catch {
                res.writeHead(500, getSecurityHeaders('application/json'));
                return res.end(JSON.stringify({ error: 'Server error' }));
            }
        }

        if (method === 'DELETE') {
            // Soft-delete: flag node + cascade soft-delete its edges (kept in Trash for 30 min)
            try {
                const now = new Date();
                const node = await Node.findOneAndUpdate(
                    { _id: nodeId, spaceId },
                    { deleted: true, deletedAt: now, deletedBy: user._id },
                    { new: true }
                );
                await Edge.updateMany(
                    { spaceId, deleted: { $ne: true }, $or: [{ sourceNodeId: nodeId }, { targetNodeId: nodeId }] },
                    { deleted: true, deletedAt: now, deletedBy: user._id }
                );
                Changelog.create({ spaceId, userId: user._id, action: 'soft-delete', targetType: 'node', targetId: nodeId, before: node }).catch(() => {});
                res.writeHead(200, getSecurityHeaders('application/json'));
                return res.end(JSON.stringify({ ok: true }));
            } catch {
                res.writeHead(500, getSecurityHeaders('application/json'));
                return res.end(JSON.stringify({ error: 'Server error' }));
            }
        }
    }

    // ══════════════════════════════════════════════════
    // SPACE — EDGES CRUD
    // ══════════════════════════════════════════════════

    const edgesListMatch = url.match(/^\/api\/space\/spaces\/([a-f0-9]{24})\/edges$/);
    if (edgesListMatch) {
        const spaceId = edgesListMatch[1];
        const ctx = await requireSpaceAccess(req, res, spaceId, method === 'POST' ? 'write' : 'read');
        if (!ctx) return;
        const user = ctx.user;

        if (method === 'GET') {
            try {
                const edges = await Edge.find({ spaceId, deleted: { $ne: true } }).lean();
                res.writeHead(200, getSecurityHeaders('application/json'));
                return res.end(JSON.stringify(edges));
            } catch {
                res.writeHead(500, getSecurityHeaders('application/json'));
                return res.end(JSON.stringify({ error: 'Server error' }));
            }
        }

        if (method === 'POST') {
            const body = await parseBody(req);
            try {
                const edge = await Edge.create({ ...body, spaceId, deleted: false, deletedAt: null, createdBy: user._id });
                res.writeHead(200, getSecurityHeaders('application/json'));
                return res.end(JSON.stringify(edge));
            } catch (e) {
                res.writeHead(500, getSecurityHeaders('application/json'));
                return res.end(JSON.stringify({ error: 'Server error' }));
            }
        }
    }

    const edgeMatch = url.match(/^\/api\/space\/spaces\/([a-f0-9]{24})\/edges\/([a-f0-9]{24})$/);
    if (edgeMatch && method === 'DELETE') {
        const [, spaceId, edgeId] = edgeMatch;
        const ctx = await requireSpaceAccess(req, res, spaceId, 'write');
        if (!ctx) return;
        try {
            // Soft-delete edge
            await Edge.findOneAndUpdate(
                { _id: edgeId, spaceId },
                { deleted: true, deletedAt: new Date(), deletedBy: ctx.user._id }
            );
            res.writeHead(200, getSecurityHeaders('application/json'));
            return res.end(JSON.stringify({ ok: true }));
        } catch {
            res.writeHead(500, getSecurityHeaders('application/json'));
            return res.end(JSON.stringify({ error: 'Server error' }));
        }
    }

    // ══════════════════════════════════════════════════
    // SPACE — DRAWING STROKES (pen / eraser)
    // ══════════════════════════════════════════════════

    const strokesListMatch = url.match(/^\/api\/space\/spaces\/([a-f0-9]{24})\/strokes$/);
    if (strokesListMatch) {
        const spaceId = strokesListMatch[1];
        const ctx = await requireSpaceAccess(req, res, spaceId, method === 'POST' ? 'write' : 'read');
        if (!ctx) return;

        if (method === 'GET') {
            try {
                const strokes = await Stroke.find({ spaceId }).sort({ createdAt: 1 }).lean();
                res.writeHead(200, getSecurityHeaders('application/json'));
                return res.end(JSON.stringify(strokes));
            } catch {
                res.writeHead(500, getSecurityHeaders('application/json'));
                return res.end(JSON.stringify({ error: 'Server error' }));
            }
        }

        if (method === 'POST') {
            const body = await parseBody(req);
            try {
                // Sanitise: cap point count, coerce numbers, clamp width
                const pts = Array.isArray(body.points) ? body.points.slice(0, 2000)
                    .map(p => ({ x: Number(p.x) || 0, y: Number(p.y) || 0 })) : [];
                if (pts.length < 2) {
                    res.writeHead(400, getSecurityHeaders('application/json'));
                    return res.end(JSON.stringify({ error: 'Stroke too short' }));
                }
                const color = (typeof body.color === 'string' ? body.color : '#9aa0a6').slice(0, 24);
                const width = Math.max(1, Math.min(40, Number(body.width) || 4));
                const stroke = await Stroke.create({ spaceId, points: pts, color, width, createdBy: ctx.user._id });
                res.writeHead(200, getSecurityHeaders('application/json'));
                return res.end(JSON.stringify(stroke));
            } catch (e) {
                console.error('Stroke create error:', e.message);
                res.writeHead(500, getSecurityHeaders('application/json'));
                return res.end(JSON.stringify({ error: 'Server error' }));
            }
        }
    }

    const strokeMatch = url.match(/^\/api\/space\/spaces\/([a-f0-9]{24})\/strokes\/([a-f0-9]{24})$/);
    if (strokeMatch && method === 'DELETE') {
        const [, spaceId, strokeId] = strokeMatch;
        const ctx = await requireSpaceAccess(req, res, spaceId, 'write');
        if (!ctx) return;
        try {
            await Stroke.deleteOne({ _id: strokeId, spaceId });
            res.writeHead(200, getSecurityHeaders('application/json'));
            return res.end(JSON.stringify({ ok: true }));
        } catch {
            res.writeHead(500, getSecurityHeaders('application/json'));
            return res.end(JSON.stringify({ error: 'Server error' }));
        }
    }

    // ══════════════════════════════════════════════════
    // SPACE — AI AGENT (shared, server-orchestrated)
    // ══════════════════════════════════════════════════

    // History — anyone with access can read the shared conversation
    const aiHistMatch = url.match(/^\/api\/space\/spaces\/([a-f0-9]{24})\/ai\/history$/);
    if (aiHistMatch && method === 'GET') {
        const spaceId = aiHistMatch[1];
        const ctx = await requireSpaceAccess(req, res, spaceId, 'read');
        if (!ctx) return;
        try {
            const msgs = await AiMessage.find({ spaceId }).sort({ createdAt: -1 }).limit(80).lean();
            msgs.reverse();
            res.writeHead(200, getSecurityHeaders('application/json'));
            return res.end(JSON.stringify(msgs));
        } catch {
            res.writeHead(500, getSecurityHeaders('application/json'));
            return res.end(JSON.stringify({ error: 'Server error' }));
        }
    }

    const aiMatch = url.match(/^\/api\/space\/spaces\/([a-f0-9]{24})\/ai$/);
    if (aiMatch && method === 'DELETE') {
        // Clear shared chat history — writers only
        const spaceId = aiMatch[1];
        const ctx = await requireSpaceAccess(req, res, spaceId, 'write');
        if (!ctx) return;
        try {
            await AiMessage.deleteMany({ spaceId });
            io.to(spaceId).emit('ai:clear', {});
            res.writeHead(200, getSecurityHeaders('application/json'));
            return res.end(JSON.stringify({ ok: true }));
        } catch {
            res.writeHead(500, getSecurityHeaders('application/json'));
            return res.end(JSON.stringify({ error: 'Server error' }));
        }
    }

    if (aiMatch && method === 'POST') {
        const spaceId = aiMatch[1];
        const ctx = await requireSpaceAccess(req, res, spaceId, 'write');
        if (!ctx) return;
        const { user } = ctx;

        if (!GEMINI_API_KEY) {
            res.writeHead(503, getSecurityHeaders('application/json'));
            return res.end(JSON.stringify({ error: 'AI is not configured on this server' }));
        }

        // Basic anti-spam: 1 request / 2.5s per user
        const rlKey = user._id.toString();
        const nowTs = Date.now();
        if (nowTs - (aiRateLimit.get(rlKey) || 0) < 2500) {
            res.writeHead(429, getSecurityHeaders('application/json'));
            return res.end(JSON.stringify({ error: 'Slow down a moment…' }));
        }
        aiRateLimit.set(rlKey, nowTs);

        const body = await parseBody(req);
        const userText = String(body.message || '').trim().slice(0, 4000);
        if (!userText) {
            res.writeHead(400, getSecurityHeaders('application/json'));
            return res.end(JSON.stringify({ error: 'Empty message' }));
        }
        const viewport = (body.viewport && typeof body.viewport.x === 'number' && typeof body.viewport.y === 'number')
            ? { x: body.viewport.x, y: body.viewport.y } : { x: 0, y: 0 };
        const pinnedIds = Array.isArray(body.pinnedIds)
            ? body.pinnedIds.filter((id) => /^[a-f0-9]{24}$/.test(id)).slice(0, 10) : [];

        // Respond to the HTTP request immediately; all results stream over WS.
        res.writeHead(200, getSecurityHeaders('application/json'));
        res.end(JSON.stringify({ ok: true }));

        // Orchestrate the agent asynchronously, broadcasting to the whole room.
        (async () => {
            const uname = user.username || 'user';
            try {
                await AiMessage.create({ spaceId, role: 'user', text: userText, username: uname });
                io.to(spaceId).emit('ai:message', { role: 'user', text: userText, username: uname });
                io.to(spaceId).emit('ai:thinking', { username: uname });

                const past = await AiMessage.find({ spaceId }).sort({ createdAt: -1 }).limit(12).lean();
                past.reverse();
                const contents = past.map((m) => ({
                    role: m.role === 'user' ? 'user' : 'model', parts: [{ text: m.text }]
                }));

                const { reply, error, actions } = await agentRun(spaceId, user, userText, viewport, pinnedIds, contents);
                io.to(spaceId).emit('ai:thinking-stop', {});

                const msg = error ? `⚠ ${error}` : reply;
                await AiMessage.create({ spaceId, role: 'assistant', text: msg, username: 'space_ai', actions: actions || 0 });
                io.to(spaceId).emit('ai:message', { role: 'assistant', text: msg, username: 'space_ai' });
            } catch (e) {
                console.error('[AI] orchestration error:', e.message);
                io.to(spaceId).emit('ai:thinking-stop', {});
                io.to(spaceId).emit('ai:message', { role: 'assistant', text: '⚠ AI error', username: 'space_ai' });
            }
        })();
        return;
    }

    // ══════════════════════════════════════════════════
    // SPACE — TEAM GROUP CHAT (with @agent + reactions)
    // ══════════════════════════════════════════════════

    const chatListMatch = url.match(/^\/api\/space\/spaces\/([a-f0-9]{24})\/chat$/);
    if (chatListMatch && method === 'GET') {
        const spaceId = chatListMatch[1];
        const ctx = await requireSpaceAccess(req, res, spaceId, 'read');
        if (!ctx) return;
        try {
            const msgs = await ChatMessage.find({ spaceId }).sort({ createdAt: -1 }).limit(120).lean();
            msgs.reverse();
            res.writeHead(200, getSecurityHeaders('application/json'));
            return res.end(JSON.stringify(msgs.map(serializeChatMsg)));
        } catch {
            res.writeHead(500, getSecurityHeaders('application/json'));
            return res.end(JSON.stringify({ error: 'Server error' }));
        }
    }

    if (chatListMatch && method === 'DELETE') {
        const spaceId = chatListMatch[1];
        const ctx = await requireSpaceAccess(req, res, spaceId, 'write');
        if (!ctx) return;
        try {
            await ChatMessage.deleteMany({ spaceId });
            io.to(spaceId).emit('chat:clear', {});
            res.writeHead(200, getSecurityHeaders('application/json'));
            return res.end(JSON.stringify({ ok: true }));
        } catch {
            res.writeHead(500, getSecurityHeaders('application/json'));
            return res.end(JSON.stringify({ error: 'Server error' }));
        }
    }

    if (chatListMatch && method === 'POST') {
        const spaceId = chatListMatch[1];
        // Any member (incl. readers) may chat — it isn't a canvas mutation
        const ctx = await requireSpaceAccess(req, res, spaceId, 'read');
        if (!ctx) return;
        const { user, role } = ctx;

        const rlKey = 'chat_' + user._id.toString();
        const nowTs = Date.now();
        if (nowTs - (aiRateLimit.get(rlKey) || 0) < 600) {
            res.writeHead(429, getSecurityHeaders('application/json'));
            return res.end(JSON.stringify({ error: 'Slow down' }));
        }
        aiRateLimit.set(rlKey, nowTs);

        const body = await parseBody(req);
        const text = String(body.message || '').trim().slice(0, 2000);
        if (!text) {
            res.writeHead(400, getSecurityHeaders('application/json'));
            return res.end(JSON.stringify({ error: 'Empty message' }));
        }
        const viewport = (body.viewport && typeof body.viewport.x === 'number')
            ? { x: body.viewport.x, y: body.viewport.y } : { x: 0, y: 0 };

        try {
            const msg = await ChatMessage.create({
                spaceId, userId: user._id, username: user.username, color: user.color || '', text
            });
            io.to(spaceId).emit('chat:message', serializeChatMsg(msg));
            res.writeHead(200, getSecurityHeaders('application/json'));
            res.end(JSON.stringify({ ok: true }));
        } catch {
            res.writeHead(500, getSecurityHeaders('application/json'));
            return res.end(JSON.stringify({ error: 'Server error' }));
        }

        // @agent / @ai mention → invoke the AI agent (writers only) into the chat
        const mentioned = /@(agent|ai)\b/i.test(text);
        const canAct = role === 'owner' || role === 'editor';
        if (mentioned && GEMINI_API_KEY && canAct) {
            (async () => {
                try {
                    io.to(spaceId).emit('chat:typing', { username: 'agent', agent: true });
                    const past = await ChatMessage.find({ spaceId }).sort({ createdAt: -1 }).limit(12).lean();
                    past.reverse();
                    const contents = past.map((m) => ({
                        role: m.agent ? 'model' : 'user',
                        parts: [{ text: m.agent ? m.text : `${m.username}: ${m.text}` }]
                    }));
                    const clean = text.replace(/@(agent|ai)\b/ig, '').trim() || text;
                    const { reply, error } = await agentRun(spaceId, user, clean, viewport, [], contents);
                    io.to(spaceId).emit('chat:typing-stop', { username: 'agent' });
                    const out = error ? `⚠ ${error}` : reply;
                    const am = await ChatMessage.create({
                        spaceId, userId: null, username: 'agent', color: '#c084fc', text: out, agent: true
                    });
                    io.to(spaceId).emit('chat:message', serializeChatMsg(am));
                } catch (e) {
                    console.error('[CHAT] agent error:', e.message);
                    io.to(spaceId).emit('chat:typing-stop', { username: 'agent' });
                }
            })();
        }
        return;
    }

    const chatReactMatch = url.match(/^\/api\/space\/spaces\/([a-f0-9]{24})\/chat\/([a-f0-9]{24})\/react$/);
    if (chatReactMatch && method === 'POST') {
        const [, spaceId, msgId] = chatReactMatch;
        const ctx = await requireSpaceAccess(req, res, spaceId, 'read');
        if (!ctx) return;
        const body = await parseBody(req);
        const emoji = String(body.emoji || '').slice(0, 8);
        if (!emoji) {
            res.writeHead(400, getSecurityHeaders('application/json'));
            return res.end(JSON.stringify({ error: 'No emoji' }));
        }
        try {
            const m = await ChatMessage.findOne({ _id: msgId, spaceId });
            if (!m) { res.writeHead(404, getSecurityHeaders('application/json')); return res.end(JSON.stringify({ error: 'Not found' })); }
            const uid = ctx.user._id.toString();
            const reactions = m.reactions || {};
            const list = Array.isArray(reactions[emoji]) ? reactions[emoji].map(String) : [];
            const i = list.indexOf(uid);
            if (i >= 0) list.splice(i, 1); else list.push(uid);
            if (list.length) reactions[emoji] = list; else delete reactions[emoji];
            m.reactions = reactions;
            m.markModified('reactions');
            await m.save();
            io.to(spaceId).emit('chat:react', { msgId, reactions });
            res.writeHead(200, getSecurityHeaders('application/json'));
            return res.end(JSON.stringify({ ok: true }));
        } catch (e) {
            res.writeHead(500, getSecurityHeaders('application/json'));
            return res.end(JSON.stringify({ error: 'Server error' }));
        }
    }

    // ══════════════════════════════════════════════════
    // SPACE — TRASH BIN (soft-deleted nodes & edges)
    // ══════════════════════════════════════════════════

    // List trashed items — owner & editors only
    const trashListMatch = url.match(/^\/api\/space\/spaces\/([a-f0-9]{24})\/trash$/);
    if (trashListMatch && method === 'GET') {
        const spaceId = trashListMatch[1];
        const ctx = await requireSpaceAccess(req, res, spaceId, 'write');
        if (!ctx) return;
        try {
            const [nodes, edges] = await Promise.all([
                Node.find({ spaceId, deleted: true }).sort({ deletedAt: -1 }).lean(),
                Edge.find({ spaceId, deleted: true }).sort({ deletedAt: -1 }).lean()
            ]);
            res.writeHead(200, getSecurityHeaders('application/json'));
            return res.end(JSON.stringify({ nodes, edges, ttlMs: TRASH_TTL_MS }));
        } catch {
            res.writeHead(500, getSecurityHeaders('application/json'));
            return res.end(JSON.stringify({ error: 'Server error' }));
        }
    }

    // Empty the whole trash now — owner only (also removes R2 files)
    if (trashListMatch && method === 'DELETE') {
        const spaceId = trashListMatch[1];
        const ctx = await requireSpaceAccess(req, res, spaceId, 'owner');
        if (!ctx) return;
        try {
            const nodes = await Node.find({ spaceId, deleted: true }).lean();
            const keys = nodes.map(n => n.fileRef?.r2Key).filter(Boolean);
            if (keys.length) await deleteR2Keys(keys);
            await Node.deleteMany({ spaceId, deleted: true });
            await Edge.deleteMany({ spaceId, deleted: true });
            res.writeHead(200, getSecurityHeaders('application/json'));
            return res.end(JSON.stringify({ ok: true, removed: nodes.length }));
        } catch {
            res.writeHead(500, getSecurityHeaders('application/json'));
            return res.end(JSON.stringify({ error: 'Server error' }));
        }
    }

    // Restore a trashed node (and any edges that were cascaded with it and whose other end still lives)
    const restoreNodeMatch = url.match(/^\/api\/space\/spaces\/([a-f0-9]{24})\/trash\/nodes\/([a-f0-9]{24})\/restore$/);
    if (restoreNodeMatch && method === 'POST') {
        const [, spaceId, nodeId] = restoreNodeMatch;
        const ctx = await requireSpaceAccess(req, res, spaceId, 'write');
        if (!ctx) return;
        try {
            const node = await Node.findOneAndUpdate(
                { _id: nodeId, spaceId, deleted: true },
                { deleted: false, deletedAt: null, deletedBy: null },
                { new: true }
            );
            if (!node) {
                res.writeHead(404, getSecurityHeaders('application/json'));
                return res.end(JSON.stringify({ error: 'Not found in trash' }));
            }
            // Restore edges that touch this node only if BOTH endpoints are now alive
            const candidateEdges = await Edge.find({
                spaceId, deleted: true,
                $or: [{ sourceNodeId: nodeId }, { targetNodeId: nodeId }]
            }).lean();
            const restoredEdges = [];
            for (const e of candidateEdges) {
                const [src, tgt] = await Promise.all([
                    Node.exists({ _id: e.sourceNodeId, deleted: { $ne: true } }),
                    Node.exists({ _id: e.targetNodeId, deleted: { $ne: true } })
                ]);
                if (src && tgt) {
                    const re = await Edge.findByIdAndUpdate(e._id, { deleted: false, deletedAt: null, deletedBy: null }, { new: true }).lean();
                    restoredEdges.push(re);
                }
            }
            // Broadcast restoration so other clients re-render it live
            io.to(spaceId).emit('node:create', { spaceId, node, userId: null });
            restoredEdges.forEach(re => io.to(spaceId).emit('edge:create', { spaceId, edge: re, userId: null }));
            res.writeHead(200, getSecurityHeaders('application/json'));
            return res.end(JSON.stringify({ ok: true, node, edges: restoredEdges }));
        } catch (e) {
            console.error('Restore node error:', e);
            res.writeHead(500, getSecurityHeaders('application/json'));
            return res.end(JSON.stringify({ error: 'Server error' }));
        }
    }

    // Restore a trashed edge (only if both endpoint nodes are alive)
    const restoreEdgeMatch = url.match(/^\/api\/space\/spaces\/([a-f0-9]{24})\/trash\/edges\/([a-f0-9]{24})\/restore$/);
    if (restoreEdgeMatch && method === 'POST') {
        const [, spaceId, edgeId] = restoreEdgeMatch;
        const ctx = await requireSpaceAccess(req, res, spaceId, 'write');
        if (!ctx) return;
        try {
            const e = await Edge.findOne({ _id: edgeId, spaceId, deleted: true }).lean();
            if (!e) {
                res.writeHead(404, getSecurityHeaders('application/json'));
                return res.end(JSON.stringify({ error: 'Not found in trash' }));
            }
            const [src, tgt] = await Promise.all([
                Node.exists({ _id: e.sourceNodeId, deleted: { $ne: true } }),
                Node.exists({ _id: e.targetNodeId, deleted: { $ne: true } })
            ]);
            if (!src || !tgt) {
                res.writeHead(409, getSecurityHeaders('application/json'));
                return res.end(JSON.stringify({ error: 'Restore the connected notes first' }));
            }
            const edge = await Edge.findByIdAndUpdate(edgeId, { deleted: false, deletedAt: null, deletedBy: null }, { new: true }).lean();
            io.to(spaceId).emit('edge:create', { spaceId, edge, userId: null });
            res.writeHead(200, getSecurityHeaders('application/json'));
            return res.end(JSON.stringify({ ok: true, edge }));
        } catch {
            res.writeHead(500, getSecurityHeaders('application/json'));
            return res.end(JSON.stringify({ error: 'Server error' }));
        }
    }

    // Permanently purge a single trashed node now — owner only (also removes its R2 file)
    const purgeNodeMatch = url.match(/^\/api\/space\/spaces\/([a-f0-9]{24})\/trash\/nodes\/([a-f0-9]{24})$/);
    if (purgeNodeMatch && method === 'DELETE') {
        const [, spaceId, nodeId] = purgeNodeMatch;
        const ctx = await requireSpaceAccess(req, res, spaceId, 'owner');
        if (!ctx) return;
        try {
            const node = await Node.findOne({ _id: nodeId, spaceId, deleted: true }).lean();
            if (node) {
                if (node.fileRef?.r2Key) await deleteR2Keys([node.fileRef.r2Key]);
                await Edge.deleteMany({ spaceId, deleted: true, $or: [{ sourceNodeId: nodeId }, { targetNodeId: nodeId }] });
                await Node.deleteOne({ _id: nodeId });
            }
            res.writeHead(200, getSecurityHeaders('application/json'));
            return res.end(JSON.stringify({ ok: true }));
        } catch {
            res.writeHead(500, getSecurityHeaders('application/json'));
            return res.end(JSON.stringify({ error: 'Server error' }));
        }
    }

    // Permanently purge a single trashed edge — owner only
    const purgeEdgeMatch = url.match(/^\/api\/space\/spaces\/([a-f0-9]{24})\/trash\/edges\/([a-f0-9]{24})$/);
    if (purgeEdgeMatch && method === 'DELETE') {
        const [, spaceId, edgeId] = purgeEdgeMatch;
        const ctx = await requireSpaceAccess(req, res, spaceId, 'owner');
        if (!ctx) return;
        try {
            await Edge.deleteOne({ _id: edgeId, spaceId, deleted: true });
            res.writeHead(200, getSecurityHeaders('application/json'));
            return res.end(JSON.stringify({ ok: true }));
        } catch {
            res.writeHead(500, getSecurityHeaders('application/json'));
            return res.end(JSON.stringify({ error: 'Server error' }));
        }
    }

    // ══════════════════════════════════════════════════
    // R2 PRESIGNED URL
    // ══════════════════════════════════════════════════

    if (url === '/api/space/upload/presign' && method === 'POST') {
        const user = await requireAuth(req, res);
        if (!user) return;
        const body = await parseBody(req);
        const { fileName, fileType, fileSize, spaceId } = body;
        if (!fileName || !fileType) {
            res.writeHead(400, getSecurityHeaders('application/json'));
            return res.end(JSON.stringify({ error: 'fileName and fileType required' }));
        }
        // R2 is private: only users with write access to the target canvas may upload to it
        if (!spaceId || !/^[a-f0-9]{24}$/.test(spaceId)) {
            res.writeHead(400, getSecurityHeaders('application/json'));
            return res.end(JSON.stringify({ error: 'spaceId required' }));
        }
        const space = await Space.findById(spaceId).catch(() => null);
        const role = getSpaceRole(space, user._id);
        if (!space || !(role === 'owner' || role === 'editor')) {
            res.writeHead(403, getSecurityHeaders('application/json'));
            return res.end(JSON.stringify({ error: 'Forbidden' }));
        }
        if (fileSize && fileSize > 100 * 1024 * 1024) { // 100MB limit
            res.writeHead(400, getSecurityHeaders('application/json'));
            return res.end(JSON.stringify({ error: 'File too large (max 100MB)' }));
        }
        try {
            const ext = fileName.split('.').pop().toLowerCase();
            // Key files under their canvas so access can be reasoned about by prefix
            const r2Key = `${spaceId}/${user._id}/${Date.now()}_${crypto.randomBytes(4).toString('hex')}.${ext}`;
            const command = new PutObjectCommand({
                Bucket: R2_BUCKET,
                Key: r2Key,
                ContentType: fileType,
            });
            const uploadUrl = await getSignedUrl(r2, command, { expiresIn: 300 }); // 5 min
            const publicUrl = `${R2_PUBLIC_URL}/${r2Key}`;
            res.writeHead(200, getSecurityHeaders('application/json'));
            return res.end(JSON.stringify({ uploadUrl, publicUrl, r2Key }));
        } catch (e) {
            console.error('R2 presign error:', e);
            res.writeHead(500, getSecurityHeaders('application/json'));
            return res.end(JSON.stringify({ error: 'Failed to generate upload URL' }));
        }
    }

    // ══════════════════════════════════════════════════
    // FILE TEXT PREVIEW (reads first 2KB from R2)
    // ══════════════════════════════════════════════════

    const previewMatch = url.match(/^\/api\/space\/nodes\/([a-f0-9]+)\/preview$/);
    if (previewMatch && method === 'GET') {
        const user = await requireAuth(req, res);
        if (!user) return;
        const nodeId = previewMatch[1];
        try {
            const node = await Node.findById(nodeId).lean();
            if (!node || !node.fileRef?.r2Key) {
                res.writeHead(404, getSecurityHeaders('application/json'));
                return res.end(JSON.stringify({ error: 'Not found' }));
            }
            // Access check: caller must have at least read access to the node's canvas
            const space = await Space.findById(node.spaceId).catch(() => null);
            if (!getSpaceRole(space, user._id)) {
                res.writeHead(403, getSecurityHeaders('application/json'));
                return res.end(JSON.stringify({ error: 'Forbidden' }));
            }
            const cmd = new GetObjectCommand({ Bucket: R2_BUCKET, Key: node.fileRef.r2Key });
            const r2res = await r2.send(cmd);
            // Read first 2KB
            const chunks = [];
            let total = 0;
            for await (const chunk of r2res.Body) {
                chunks.push(chunk);
                total += chunk.length;
                if (total >= 2048) break;
            }
            const text = Buffer.concat(chunks).slice(0, 2048).toString('utf8');
            res.writeHead(200, getSecurityHeaders('text/plain; charset=utf-8'));
            return res.end(text);
        } catch (e) {
            res.writeHead(500, getSecurityHeaders('application/json'));
            return res.end(JSON.stringify({ error: 'Preview failed' }));
        }
    }

    // ══════════════════════════════════════════════════
    // FILE DOWNLOAD — proper filename via redirect
    // ══════════════════════════════════════════════════

    const downloadMatch = url.match(/^\/api\/space\/nodes\/([a-f0-9]+)\/download$/);
    if (downloadMatch && method === 'GET') {
        // Download links are opened via direct navigation (no Authorization header),
        // so accept the JWT via a ?token= query param as a fallback.
        if (!req.headers['authorization']) {
            const qToken = new URL(req.url, 'http://localhost').searchParams.get('token');
            if (qToken) req.headers['authorization'] = 'Bearer ' + qToken;
        }
        const user = await requireAuth(req, res);
        if (!user) return;
        const nodeId = downloadMatch[1];
        try {
            const node = await Node.findById(nodeId).lean();
            if (!node || !node.fileRef?.r2Key) {
                res.writeHead(404, getSecurityHeaders('application/json'));
                return res.end(JSON.stringify({ error: 'Not found' }));
            }
            // Access check: caller must have at least read access to the node's canvas
            const space = await Space.findById(node.spaceId).catch(() => null);
            if (!getSpaceRole(space, user._id)) {
                res.writeHead(403, getSecurityHeaders('application/json'));
                return res.end(JSON.stringify({ error: 'Forbidden' }));
            }
            const originalName = node.fileRef.name || node.title || 'file';
            const safeName = originalName.replace(/[^\w.-]/g, '_');
            const cmd = new GetObjectCommand({
                Bucket: R2_BUCKET,
                Key: node.fileRef.r2Key,
                ResponseContentDisposition: `attachment; filename="${safeName}"`,
            });
            const signedUrl = await getSignedUrl(r2, cmd, { expiresIn: 300 });
            res.writeHead(302, { ...getSecurityHeaders('application/json'), Location: signedUrl });
            return res.end();
        } catch (e) {
            res.writeHead(500, getSecurityHeaders('application/json'));
            return res.end(JSON.stringify({ error: 'Download failed' }));
        }
    }


    if (url === '/api/admin/space/users' && method === 'GET') {
        if (!isAdmin(req)) { res.writeHead(401, getSecurityHeaders('application/json')); return res.end(JSON.stringify({ error: 'Unauthorized' })); }
        try {
            const users = await User.find({}).select('-passwordHash').sort({ createdAt: -1 }).lean();
            res.writeHead(200, getSecurityHeaders('application/json'));
            return res.end(JSON.stringify(users));
        } catch {
            res.writeHead(500, getSecurityHeaders('application/json'));
            return res.end(JSON.stringify({ error: 'Server error' }));
        }
    }

    if (url.startsWith('/api/admin/space/users/') && method === 'PATCH') {
        if (!isAdmin(req)) { res.writeHead(401, getSecurityHeaders('application/json')); return res.end(JSON.stringify({ error: 'Unauthorized' })); }
        const userId = url.split('/').pop();
        const body = await parseBody(req);
        try {
            const user = await User.findByIdAndUpdate(userId, body, { new: true }).select('-passwordHash').lean();
            res.writeHead(200, getSecurityHeaders('application/json'));
            return res.end(JSON.stringify(user));
        } catch {
            res.writeHead(500, getSecurityHeaders('application/json'));
            return res.end(JSON.stringify({ error: 'Server error' }));
        }
    }

    if (url.startsWith('/api/admin/space/users/') && method === 'DELETE') {
        if (!isAdmin(req)) { res.writeHead(401, getSecurityHeaders('application/json')); return res.end(JSON.stringify({ error: 'Unauthorized' })); }
        const userId = url.split('/').pop();
        try {
            await User.findByIdAndDelete(userId);
            res.writeHead(200, getSecurityHeaders('application/json'));
            return res.end(JSON.stringify({ ok: true }));
        } catch {
            res.writeHead(500, getSecurityHeaders('application/json'));
            return res.end(JSON.stringify({ error: 'Server error' }));
        }
    }

    // ══════════════════════════════════════════════════
    // EXISTING API (unchanged)
    // ══════════════════════════════════════════════════

    if (url === '/api/admin/auth' && method === 'POST') {
        const body = await parseBody(req);
        if (body.password === CRLPASS) {
            res.writeHead(200, getSecurityHeaders('application/json'));
            return res.end(JSON.stringify({ token: adminToken }));
        }
        res.writeHead(401, getSecurityHeaders('application/json'));
        return res.end(JSON.stringify({ error: 'Unauthorized' }));
    }

    if (url.startsWith('/api/admin/') && url !== '/api/admin/auth') {
        if (!isAdmin(req)) {
            res.writeHead(401, getSecurityHeaders('application/json'));
            return res.end(JSON.stringify({ error: 'Unauthorized' }));
        }
        if (url === '/api/admin/upload' && method === 'POST') {
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
        if (url === '/api/admin/stats' && method === 'GET') {
            res.writeHead(200, getSecurityHeaders('application/json'));
            const spaceUserCount = await User.countDocuments().catch(() => 0);
            const pendingCount = await User.countDocuments({ newReg: false }).catch(() => 0);
            return res.end(JSON.stringify({
                uptime: process.uptime(), memory: process.memoryUsage(),
                projectsCount: projects.length, articlesCount: articles.length,
                boardCount: boardNotes.length,
                spaceUserCount, pendingCount
            }));
        }
        if (url === '/api/admin/projects' && method === 'POST') {
            const body = await parseBody(req); body.id = Date.now().toString();
            projects.push(body); fs.writeFileSync(PROJECTS_FILE, JSON.stringify(projects, null, 2));
            res.writeHead(200, getSecurityHeaders('application/json')); return res.end(JSON.stringify(body));
        }
        if (url.startsWith('/api/admin/projects/') && method === 'PUT') {
            const id = url.split('/').pop(); const body = await parseBody(req);
            const idx = projects.findIndex(p => p.id === id || p.name === id);
            if (idx !== -1) { projects[idx] = { ...projects[idx], ...body }; fs.writeFileSync(PROJECTS_FILE, JSON.stringify(projects, null, 2)); res.writeHead(200, getSecurityHeaders('application/json')); return res.end(JSON.stringify(projects[idx])); }
        }
        if (url.startsWith('/api/admin/projects/') && method === 'DELETE') {
            const id = url.split('/').pop();
            projects = projects.filter(p => p.id !== id && p.name !== id);
            fs.writeFileSync(PROJECTS_FILE, JSON.stringify(projects, null, 2));
            res.writeHead(200, getSecurityHeaders('application/json')); return res.end(JSON.stringify({ success: true }));
        }
        if (url === '/api/admin/articles' && method === 'POST') {
            const body = await parseBody(req); body.id = Date.now().toString();
            articles.unshift(body); fs.writeFileSync(NOTES_FILE, JSON.stringify(articles, null, 2));
            res.writeHead(200, getSecurityHeaders('application/json')); return res.end(JSON.stringify(body));
        }
        if (url.startsWith('/api/admin/articles/') && method === 'PUT') {
            const id = url.split('/').pop(); const body = await parseBody(req);
            const idx = articles.findIndex(a => a.id === id);
            if (idx !== -1) { articles[idx] = { ...articles[idx], ...body }; fs.writeFileSync(NOTES_FILE, JSON.stringify(articles, null, 2)); res.writeHead(200, getSecurityHeaders('application/json')); return res.end(JSON.stringify(articles[idx])); }
        }
        if (url.startsWith('/api/admin/articles/') && method === 'DELETE') {
            const id = url.split('/').pop();
            articles = articles.filter(a => a.id !== id); fs.writeFileSync(NOTES_FILE, JSON.stringify(articles, null, 2));
            res.writeHead(200, getSecurityHeaders('application/json')); return res.end(JSON.stringify({ success: true }));
        }
        if (url.startsWith('/api/admin/board/') && method === 'DELETE') {
            const id = url.split('/').pop();
            boardNotes = boardNotes.filter(b => b.id !== id); fs.writeFileSync(BOARD_FILE, JSON.stringify(boardNotes, null, 2));
            res.writeHead(200, getSecurityHeaders('application/json')); return res.end(JSON.stringify({ success: true }));
        }
        res.writeHead(404); return res.end();
    }

    // ── Serve Admin ──
    if (url === '/admin' || url === '/admin/') {
        if (fs.existsSync(path.join(PUBLIC_DIR, 'admin.html'))) {
            res.writeHead(200, getSecurityHeaders('text/html'));
            return res.end(fs.readFileSync(path.join(PUBLIC_DIR, 'admin.html')));
        }
        res.writeHead(404); return res.end('Admin not found');
    }

    // ── Serve Space (also handles /canvas/:slug — slug resolved client-side) ──
    const isSpaceRoot = host.startsWith('space.') && url === '/';
    if (isSpaceRoot || url === '/space' || url === '/space/' || url === '/canvas' || url === '/canvas/' || /^\/canvas\/[A-Za-z0-9_-]+$/.test(url)) {
        if (fs.existsSync(path.join(PUBLIC_DIR, 'space.html'))) {
            res.writeHead(200, getSecurityHeaders('text/html'));
            return res.end(fs.readFileSync(path.join(PUBLIC_DIR, 'space.html')));
        }
        res.writeHead(404); return res.end('Space not found');
    }

    if (url === '/api/init') {
        const acceptLang = req.headers['accept-language'] || '';
        const isRu = acceptLang.includes('ru') || acceptLang.includes('uk') || acceptLang.includes('kk');
        res.writeHead(200, getSecurityHeaders('application/json'));
        return res.end(JSON.stringify({ uptime: process.uptime(), version: VERSION, lang: isRu ? 'ru' : 'en' }));
    }

    if (url === '/api/projects' && method === 'GET') {
        res.writeHead(200, getSecurityHeaders('application/json'));
        return res.end(JSON.stringify(projects));
    }

    if (url === '/api/board' && method === 'GET') {
        res.writeHead(200, getSecurityHeaders('application/json'));
        return res.end(JSON.stringify(boardNotes));
    }

    if (url === '/api/board' && method === 'POST') {
        let body = '';
        req.on('data', chunk => { body += chunk.toString(); if (body.length > 5000) req.connection.destroy(); });
        req.on('end', () => {
            const ip = getClientIP(req); const now = Date.now(); const last = ipRateLimit.get(ip) || 0;
            if (now - last < 30 * 60 * 1000) { res.writeHead(429, getSecurityHeaders('application/json')); return res.end(JSON.stringify({ error: 'RATE LIMIT' })); }
            try {
                const data = JSON.parse(body);
                if (!data.text || typeof data.text !== 'string') { res.writeHead(400, getSecurityHeaders('application/json')); return res.end(JSON.stringify({ error: 'Bad text' })); }
                const text = data.text.trim().substring(0, 120);
                if (!text || text.length < 2) { res.writeHead(400, getSecurityHeaders('application/json')); return res.end(JSON.stringify({ error: 'Too short' })); }
                const note = { id: crypto.randomUUID(), text, author: "guest_" + Math.floor(Math.random()*9000+1000), rot: (Math.random()*4)-2, createdAt: new Date().toISOString(), date: Date.now() };
                boardNotes.unshift(note); if (boardNotes.length > 50) boardNotes.pop();
                const tmp = BOARD_FILE + '.tmp';
                try { fs.writeFileSync(tmp, JSON.stringify(boardNotes, null, 2)); fs.renameSync(tmp, BOARD_FILE); } catch {}
                ipRateLimit.set(ip, now);
                res.writeHead(200, getSecurityHeaders('application/json')); res.end(JSON.stringify(note));
            } catch { res.writeHead(400, getSecurityHeaders('application/json')); res.end(JSON.stringify({ error: 'Bad data' })); }
        });
        return;
    }

    if (url === '/api/articles' && method === 'GET') {
        res.writeHead(200, getSecurityHeaders('application/json'));
        return res.end(JSON.stringify(articles.map(a => ({ ...a, content: undefined }))));
    }
    if (url.startsWith('/api/articles/') && url.endsWith('/like') && method === 'POST') {
        const id = url.split('/')[3];
        const article = articles.find(a => a.id === id);
        if (article) {
            const ip = getClientIP(req); const likeKey = `like_${ip}_${id}`; const now = Date.now(); const last = ipRateLimit.get(likeKey) || 0;
            if (now - last < 24*60*60*1000) { res.writeHead(429, getSecurityHeaders('application/json')); return res.end(JSON.stringify({ error: 'Already liked' })); }
            article.likes = (article.likes || 0) + 1; ipRateLimit.set(likeKey, now);
            try { fs.writeFileSync(NOTES_FILE, JSON.stringify(articles, null, 2)); } catch {}
            res.writeHead(200, getSecurityHeaders('application/json')); return res.end(JSON.stringify({ likes: article.likes }));
        }
        res.writeHead(404, getSecurityHeaders('application/json')); return res.end(JSON.stringify({ error: 'Not found' }));
    }
    if (url.startsWith('/api/articles/') && method === 'GET') {
        const id = url.split('/')[3];
        const article = articles.find(a => a.id === id);
        if (article) { res.writeHead(200, getSecurityHeaders('application/json')); return res.end(JSON.stringify(article)); }
        res.writeHead(404, getSecurityHeaders('application/json')); return res.end(JSON.stringify({ error: 'Not found' }));
    }

    // ── Static files ──
    console.log(`\x1b[90m[REQ]\x1b[0m ${method} ${url}`);
    const pageMap = { '/notes': 'notes.html', '/board': 'board.html', '/article': 'article.html' };
    if (pageMap[url]) {
        const p = path.join(PUBLIC_DIR, pageMap[url]);
        fs.readFile(p, (err, data) => {
            if (err) { res.writeHead(500); res.end('500'); } else { res.writeHead(200, getSecurityHeaders('text/html')); res.end(data); }
        }); return;
    }
    let filePath = url === '/' ? '/index.html' : url;
    const safePath = path.normalize(filePath).replace(/^(\.\.[\\/])+/, '');
    const absPath = path.join(PUBLIC_DIR, safePath);
    const ext = String(path.extname(absPath)).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';
    fs.readFile(absPath, (err, data) => {
        if (err) { if (err.code === 'ENOENT') { res.writeHead(404); res.end('404 Not Found'); } else { res.writeHead(500); res.end('500'); } }
        else {
            const headers = getSecurityHeaders(contentType);
            // App code, the service worker and the manifest must always revalidate
            // so online users get updates without a hard refresh (Ctrl+Shift+R).
            if (/\.(js|css)$/.test(safePath) || /(?:^|[\\/])(?:sw\.js|manifest\.json)$/.test(safePath)) {
                headers['Cache-Control'] = 'no-cache';
            }
            // Let the service worker control the whole origin
            if (/(?:^|[\\/])sw\.js$/.test(safePath)) headers['Service-Worker-Allowed'] = '/';
            res.writeHead(200, headers);
            res.end(data);
        }
    });
}

// ──────────────────────────────────────────────────────
// TRASH CLEANUP — permanently purge soft-deleted items older than TRASH_TTL_MS
// Removes their R2 files too. Runs on startup + every TRASH_SWEEP_MS.
// ──────────────────────────────────────────────────────
async function purgeExpiredTrash() {
    if (mongoose.connection.readyState !== 1) return; // skip until DB connected
    const cutoff = new Date(Date.now() - TRASH_TTL_MS);
    try {
        // Nodes: collect R2 keys before deleting
        const expiredNodes = await Node.find({ deleted: true, deletedAt: { $lte: cutoff } })
            .select('_id fileRef.r2Key').lean();
        if (expiredNodes.length) {
            await deleteR2Keys(expiredNodes.map(n => n.fileRef?.r2Key));
            const ids = expiredNodes.map(n => n._id);
            await Node.deleteMany({ _id: { $in: ids } });
            console.log(`\x1b[90m  [TRASH]\x1b[0m purged ${ids.length} node(s)`);
        }
        // Edges
        const edgeRes = await Edge.deleteMany({ deleted: true, deletedAt: { $lte: cutoff } });
        if (edgeRes.deletedCount) console.log(`\x1b[90m  [TRASH]\x1b[0m purged ${edgeRes.deletedCount} edge(s)`);
    } catch (e) {
        console.error('  [TRASH] cleanup error:', e.message);
    }
}
// Kick off shortly after start (give Mongo time to connect), then on a fixed interval
setTimeout(purgeExpiredTrash, 15 * 1000);
setInterval(purgeExpiredTrash, TRASH_SWEEP_MS);

// ──────────────────────────────────────────────────────
// START
// ──────────────────────────────────────────────────────

connectMongo();

httpServer.listen(PORT, () => {
    console.clear();
    const ascii = `
\x1b[97m   ██████╗ ██████╗ ██╗     ██╗  ██╗██╗ ██████╗ 
  ██╔════╝ ██╔══██╗██║     ╚██╗██╔╝██║██╔═══██╗
  ██║      ██████╔╝██║      ╚███╔╝ ██║██║   ██║
  ██║      ██╔══██╗██║      ██╔██╗ ██║██║▄▄ ██║
  ╚██████╗ ██║  ██║███████╗██╔╝ ██╗██║╚██████╔╝
   ╚═════╝ ╚═╝  ╚═╝╚══════╝╚═╝  ╚═╝╚═╝ ╚══▀▀═╝ \x1b[0m
`;
    console.log(ascii);
    console.log(`\x1b[1m\x1b[32m  >>> CRLX1Q SERVER IS ONLINE <<<\x1b[0m`);
    console.log(`\x1b[90m  ----------------------------------------\x1b[0m`);
    console.log(`  \x1b[36m❖\x1b[0m \x1b[1mVersion\x1b[0m   : \x1b[33mv${VERSION}\x1b[0m`);
    console.log(`  \x1b[36m❖\x1b[0m \x1b[1mLocal\x1b[0m     : \x1b[4mhttp://localhost:${PORT}\x1b[0m`);
    console.log(`  \x1b[36m❖\x1b[0m \x1b[1mSpace\x1b[0m     : \x1b[4mhttp://localhost:${PORT}/space\x1b[0m`);
    console.log(`  \x1b[36m❖\x1b[0m \x1b[1mSocket.io\x1b[0m : \x1b[32mEnabled\x1b[0m`);
    console.log(`  \x1b[36m❖\x1b[0m \x1b[1mMongoDB\x1b[0m   : \x1b[33mConnecting...\x1b[0m`);
    console.log(`  \x1b[36m❖\x1b[0m \x1b[1mR2 Bucket\x1b[0m : \x1b[33m${R2_BUCKET}\x1b[0m`);
    console.log(`\x1b[90m  ----------------------------------------\x1b[0m\n`);
});
