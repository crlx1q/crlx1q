#!/usr/bin/env node
/**
 * One-shot patch #6 — per-device cursors
 *
 *  Problem: the server relayed cursor:move WITHOUT socketId/clientId, so the
 *  client keyed every cursor by userId and treated your own second device as
 *  "self" (filtered out). Result: phone + PC on one account shared a single
 *  cursor and fought over it.
 *
 *  Fix:
 *   1) server.js  — cursor:move relay now carries socketId, clientId, device.
 *   2) space.js   — emitCursor sends this device's stable clientId.
 *   3) space.js   — each device gets its own cursor with a distinct shade of
 *      the user's color and a device icon (PC / Mobile / Tablet) by the nick.
 *
 * Exact-string edits only. Missing/ambiguous anchor -> exit 1, nothing written.
 * The crlx1q.com -> space.crlx1q.com redirect is asserted intact.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = process.cwd();
const edits = [];
function edit(file, find, replace, opts) {
    edits.push(Object.assign({ file, find, replace }, opts || {}));
}
const L = (arr) => arr.join('\n');

// ── 1. server: relay device identity with cursors ──
edit('server.js', L([
"    socket.on('cursor:move', (data) => {",
"        // cursors allowed for everyone (incl. readers)",
"        socket.to(data.spaceId).emit('cursor:move', {",
"            ...data, userId: socket.userId, username: socket.username",
"        });",
"    });"
]), L([
"    socket.on('cursor:move', (data) => {",
"        // Cursors are allowed for everyone (incl. readers).",
"        // socketId/clientId/device let each DEVICE render as its own cursor,",
"        // so one account on phone + PC shows two cursors instead of sharing one.",
"        socket.to(data.spaceId).emit('cursor:move', {",
"            ...data, userId: socket.userId, username: socket.username,",
"            socketId: socket.id,",
"            clientId: socket.data?.clientId,",
"            device: socket.data?.device",
"        });",
"    });"
]));

// ── 2. client: send this device's stable id ──
edit('public/space.js', L([
"        color: state.user.color || CURSOR_COLORS[0],",
"        touch: IS_TOUCH",
"    });"
]), L([
"        color: state.user.color || CURSOR_COLORS[0],",
"        clientId: DEVICE_ID,",
"        touch: IS_TOUCH",
"    });"
]));

// ── 3. client: pass the raw event through so we know the sender's device ──
edit('public/space.js',
"        updateRemoteCursor(key, userId, username, color, x, y, touch);",
"        updateRemoteCursor(key, userId, username, color, x, y, touch, __ev);");

// ── 4. client: per-device color + device icon on the cursor label ──
edit('public/space.js', L([
"function updateRemoteCursor(key, userId, username, color, wx, wy, touch) {",
"    let entry = state.remoteCursors.get(key);",
"    if (!entry) {",
"        const el = document.createElement('div');",
"        const c = color || '#4ade80';"
]), L([
"// Device icons for cursor labels (same stroke family as the rest of the UI)",
"const CURSOR_DEVICE_ICONS = {",
"    PC:     '<rect x=\"2\" y=\"3\" width=\"20\" height=\"14\" rx=\"2\"/><path d=\"M8 21h8\"/><path d=\"M12 17v4\"/>',",
"    Mobile: '<rect x=\"5\" y=\"2\" width=\"14\" height=\"20\" rx=\"2\"/><path d=\"M12 18h.01\"/>',",
"    Tablet: '<rect x=\"4\" y=\"2\" width=\"16\" height=\"20\" rx=\"2\"/><path d=\"M12 18h.01\"/>'",
"};",
"",
"// Which device is this cursor coming from? (server device info, else touch hint)",
"function cursorDeviceKind(ev, touch) {",
"    const raw = String((ev && (ev.kind || (ev.device && ev.device.kind))) || '').trim();",
"    if (/^mobile/i.test(raw)) return 'Mobile';",
"    if (/^tablet/i.test(raw)) return 'Tablet';",
"    if (raw) return 'PC';",
"    return touch ? 'Mobile' : 'PC';",
"}",
"",
"function cursorDeviceIcon(kind) {",
"    const p = CURSOR_DEVICE_ICONS[kind] || CURSOR_DEVICE_ICONS.PC;",
"    return '<svg viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.8\" '",
"        + 'stroke-linecap=\"round\" stroke-linejoin=\"round\" '",
"        + 'style=\"width:9px;height:9px;margin-right:4px;vertical-align:-1px;opacity:.85\">' + p + '</svg>';",
"}",
"",
"// Same account on several devices -> same base color, visibly different shade,",
"// so two cursors of one user never look like a single one.",
"function deviceCursorColor(hex, key) {",
"    const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || ''));",
"    if (!m) return hex || '#4ade80';",
"    const n = parseInt(m[1], 16);",
"    let r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;",
"    const s = String(key || '');",
"    let h = 0;",
"    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 99991;",
"    const variant = h % 3;                       // 0 = as-is, 1 = lighter, 2 = deeper",
"    const mix = (v, t, f) => Math.round(v + (t - v) * f);",
"    if (variant === 1) { r = mix(r, 255, 0.42); g = mix(g, 255, 0.42); b = mix(b, 255, 0.42); }",
"    if (variant === 2) { r = mix(r, 0, 0.34);   g = mix(g, 0, 0.34);   b = mix(b, 0, 0.34); }",
"    return '#' + [r, g, b].map(v => Math.max(0, Math.min(255, v)).toString(16).padStart(2, '0')).join('');",
"}",
"",
"function updateRemoteCursor(key, userId, username, color, wx, wy, touch, ev) {",
"    let entry = state.remoteCursors.get(key);",
"    if (!entry) {",
"        const el = document.createElement('div');",
"        const kind = cursorDeviceKind(ev, touch);",
"        const c = deviceCursorColor(color || '#4ade80', key);"
]));

// label: nickname + device icon
edit('public/space.js',
"            + `<div class=\"remote-cursor-label\" style=\"background:${c}\">${escHtml(username||'user')}</div>`;",
"            + `<div class=\"remote-cursor-label\" style=\"background:${c}\">${cursorDeviceIcon(kind)}${escHtml(username||'user')}</div>`;");

// remember the device on the entry (handy for debugging / future use)
edit('public/space.js',
"        entry = { el, worldX: wx, worldY: wy, userId: userId, clientId: key };",
"        entry = { el, worldX: wx, worldY: wy, userId: userId, clientId: key, kind: kind };");

// ══════════════ apply ══════════════

const cache = new Map();
function read(file) {
    if (!cache.has(file)) cache.set(file, fs.readFileSync(path.join(ROOT, file), 'utf8'));
    return cache.get(file);
}

let failed = false;
edits.forEach((e, i) => {
    const label = '#' + (i + 1) + ' ' + e.file;
    const src = read(e.file);
    const parts = src.split(e.find);
    const hits = parts.length - 1;
    if (hits === 0) {
        console.error('FAIL ' + label + ': anchor not found ->\n' + e.find.slice(0, 200));
        failed = true;
        return;
    }
    if (hits > 1 && !e.all) {
        console.error('FAIL ' + label + ': anchor found ' + hits + ' times (must be unique)');
        failed = true;
        return;
    }
    cache.set(e.file, e.all ? parts.join(e.replace) : src.replace(e.find, e.replace));
    console.log('ok   ' + label + ' (' + hits + ')');
});

if (failed) {
    console.error('\nNo files were written.');
    process.exit(1);
}

const server = cache.get('server.js');
if (!server.includes('space.crlx1q.com')) {
    console.error('FAIL: redirect marker missing from server.js');
    process.exit(1);
}
if (!/host\.includes\('crlx1q\.com'\) && !host\.startsWith\('space\.'\)/.test(server)) {
    console.error('FAIL: redirect block missing from server.js');
    process.exit(1);
}

for (const [file, content] of cache.entries()) {
    fs.writeFileSync(path.join(ROOT, file), content);
    console.log('wrote ' + file + ' (' + Buffer.byteLength(content) + ' bytes)');
}
console.log('patch6 applied');
