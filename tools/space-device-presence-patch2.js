#!/usr/bin/env node
/**
 * One-shot patch #2: per-DEVICE presence, correct device counting,
 * cross-device cursors for the same account, SVG icons instead of emoji.
 *
 * Every edit is an exact-string replacement. If an anchor is missing or
 * ambiguous the script exits non-zero and NOTHING is written.
 * The crlx1q.com -> space.crlx1q.com redirect is never touched (verified below).
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = process.cwd();
const edits = [];

function edit(file, find, replace, opts) {
    edits.push(Object.assign({ file, find, replace }, opts || {}));
}

// ══════════════ server.js ══════════════

// 1. Stable per-device id from the handshake + on-demand presence refresh
edit('server.js',
"        socket.data.device = deviceFromUA(socket.handshake?.headers?.['user-agent']);",
[
"        socket.data.device = deviceFromUA(socket.handshake?.headers?.['user-agent']);",
"        // Stable device identity (survives reloads / reconnects / extra tabs)",
"        socket.data.clientId = String(socket.handshake?.auth?.clientId || socket.handshake?.query?.clientId || socket.id).slice(0, 64);",
"        // On-demand presence refresh: kills stale device lists after sleep/reconnect",
"        socket.on('space:presence', async (payload) => {",
"            try {",
"                const sid = (payload && payload.spaceId) || socket.currentSpace || socket.spaceId;",
"                if (!sid) return;",
"                const rooms = socket.rooms ? [...socket.rooms] : [];",
"                if (!rooms.some(r => String(r).includes(String(sid)))) return;",
"                const users = await presenceFor(sid);",
"                socket.emit('space:online', { count: users.length, users, sessions: sessionsFrom(users) });",
"            } catch (e) {}",
"        });"
].join('\n'));

// 2. presenceFor(): one row per PHYSICAL device (dedupe by clientId)
edit('server.js',
[
"        const dev = s.data?.device || deviceFromUA(s.handshake?.headers?.['user-agent']);",
"        map.get(uid).devices.push({",
"            socketId: s.id, kind: dev.kind, os: dev.os, browser: dev.browser,",
"            label: (s.data.username || 'user') + ' ' + dev.kind",
"        });"
].join('\n'),
[
"        const dev = s.data?.device || deviceFromUA(s.handshake?.headers?.['user-agent']);",
"        const cid = String(s.data?.clientId || s.id);",
"        const bucket = map.get(uid);",
"        // Extra tabs / reconnects from the same device share a clientId,",
"        // so they collapse into ONE device row (no more duplicate 'Chrome').",
"        const dup = bucket.devices.find(d => d.clientId === cid);",
"        if (dup) { dup.tabs = (dup.tabs || 1) + 1; dup.socketId = s.id; continue; }",
"        bucket.devices.push({",
"            clientId: cid, socketId: s.id, kind: dev.kind, os: dev.os, browser: dev.browser, tabs: 1,",
"            label: (s.data.username || 'user') + ' ' + dev.kind",
"        });"
].join('\n'));

// 3. sessionsFrom(): expose clientId + tab count to the client
edit('server.js',
"                socketId: d.socketId, kind: d.kind, os: d.os, browser: d.browser, label: d.label",
[
"                clientId: d.clientId, socketId: d.socketId, kind: d.kind, os: d.os,",
"                browser: d.browser, tabs: d.tabs, label: d.label"
].join('\n'));

// 4. Relay clientId with realtime events (per-device identity)
edit('server.js',
"{ ...data, userId: socket.userId, socketId: socket.id }",
"{ ...data, userId: socket.userId, socketId: socket.id, clientId: socket.data?.clientId }",
{ all: true });

// ══════════════ public/space.js ══════════════

// 5. Persistent device id on the client
edit('public/space.js',
[
"let physics = { edges: new Map(), animFrame: null };",
"let ws      = null;"
].join('\n'),
[
"let physics = { edges: new Map(), animFrame: null };",
"let ws      = null;",
"// Stable id for THIS device (persists across reloads, unique per browser/device).",
"// Presence counts devices with it, and it lets your own phone and PC see each",
"// other's cursor even though it is the same account.",
"const DEVICE_ID = (function () {",
"    const gen = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 10);",
"    try {",
"        let v = localStorage.getItem('space_device_id');",
"        if (!v) { v = gen(); localStorage.setItem('space_device_id', v); }",
"        return v;",
"    } catch (e) { return gen(); }",
"})();"
].join('\n'));

// 6. Send the device id in the socket handshake
edit('public/space.js',
"    ws = io({ auth: { token: state.token }, transports: ['websocket'] });",
"    ws = io({ auth: { token: state.token, clientId: DEVICE_ID }, transports: ['websocket'] });");

// 7. Cursors are PER DEVICE, not per account
edit('public/space.js',
[
"    ws.on('cursor:move', ({ userId, username, color, x, y, touch }) => {",
"        if ((typeof __ev !== 'undefined' && __ev && __ev.socketId) ? __ev.socketId === ws.id : (userId === state.user?._id)) return;",
"        updateRemoteCursor(userId, username, color, x, y, touch);",
"    });"
].join('\n'),
[
"    ws.on('cursor:move', (__ev) => {",
"        const { userId, username, color, x, y, touch } = __ev;",
"        // Key cursors by DEVICE: same account on phone + PC = two cursors,",
"        // and each device only ignores its own events.",
"        const key = __ev.clientId || __ev.socketId || userId;",
"        const isSelfDevice = __ev.clientId",
"            ? __ev.clientId === DEVICE_ID",
"            : (__ev.socketId ? __ev.socketId === ws.id : userId === state.user?._id);",
"        if (isSelfDevice) return;",
"        updateRemoteCursor(key, userId, username, color, x, y, touch);",
"    });"
].join('\n'));

// 8. user:leave removes every cursor belonging to that account
edit('public/space.js',
[
"    ws.on('user:leave', ({ userId }) => {",
"        // Remove cursor",
"        const c = state.remoteCursors.get(userId);",
"        if (c) { c.el.remove(); state.remoteCursors.delete(userId); }",
"        state.onlineUsers.delete(userId);",
"        updateOnlineTooltip();",
"    });"
].join('\n'),
[
"    ws.on('user:leave', ({ userId }) => {",
"        // Remove every device cursor of that account",
"        state.remoteCursors.forEach((c, key) => {",
"            if (c && c.userId === userId) { c.el.remove(); state.remoteCursors.delete(key); }",
"        });",
"        state.onlineUsers.delete(userId);",
"        updateOnlineTooltip();",
"    });"
].join('\n'));

// 9. updateRemoteCursor keyed by device
edit('public/space.js',
[
"function updateRemoteCursor(userId, username, color, wx, wy, touch) {",
"    let entry = state.remoteCursors.get(userId);"
].join('\n'),
[
"function updateRemoteCursor(key, userId, username, color, wx, wy, touch) {",
"    let entry = state.remoteCursors.get(key);"
].join('\n'));

edit('public/space.js',
[
"        entry = { el, worldX: wx, worldY: wy };",
"        state.remoteCursors.set(userId, entry);",
"        state.onlineUsers.set(userId, { userId, username, color });"
].join('\n'),
[
"        entry = { el, worldX: wx, worldY: wy, userId: userId, clientId: key };",
"        state.remoteCursors.set(key, entry);",
"        // Never list yourself as another participant",
"        if (userId !== state.user?._id) state.onlineUsers.set(userId, { userId, username, color });"
].join('\n'));

// 10. The online badge counts DEVICES (every device is +1)
edit('public/space.js',
"    if (count) count.textContent = state.onlineUsers.size + 1; // +self",
[
"    // Count DEVICES, not people: 2 people where one is on phone + PC => 3",
"    const deviceTotal = (window.SpaceDevices && window.SpaceDevices.total) || 0;",
"    if (count) count.textContent = deviceTotal || (state.onlineUsers.size + 1);"
].join('\n'));

// 11. Device presence listener: fresh data + stale cursor cleanup + refresh hooks
edit('public/space.js',
[
"    ws.on('space:online', (p) => {",
"        try {",
"            if (window.SpaceDevices) window.SpaceDevices.update(p, { selfId: ws.id, selfUserId: state.user?._id });",
"        } catch (e) {}",
"    });"
].join('\n'),
[
"    ws.on('space:online', (p) => {",
"        try {",
"            if (window.SpaceDevices) {",
"                window.SpaceDevices.update(p, { selfId: ws.id, selfClientId: DEVICE_ID, selfUserId: state.user?._id });",
"                updateOnlineTooltip();",
"            }",
"            // Drop cursors of devices that are no longer connected",
"            if (p && Array.isArray(p.sessions) && p.sessions.length) {",
"                const live = new Set(p.sessions.map(s => s.clientId || s.socketId));",
"                state.remoteCursors.forEach((c, key) => {",
"                    if (!live.has(key)) { c.el.remove(); state.remoteCursors.delete(key); }",
"                });",
"            }",
"        } catch (e) {}",
"    });",
"",
"    // Ask for a fresh device list when it matters (fixes stale 'Only you')",
"    const askPresence = () => {",
"        try { if (ws && ws.connected && state.spaceId) ws.emit('space:presence', { spaceId: state.spaceId }); } catch (e) {}",
"    };",
"    ws.on('connect', () => setTimeout(askPresence, 900));",
"    const onlineBadge = document.getElementById('online-count');",
"    if (onlineBadge && !onlineBadge.dataset.presenceHook) {",
"        onlineBadge.dataset.presenceHook = '1';",
"        onlineBadge.addEventListener('mouseenter', askPresence);",
"        onlineBadge.addEventListener('touchstart', askPresence, { passive: true });",
"    }",
"    window.addEventListener('focus', askPresence);",
"    document.addEventListener('visibilitychange', () => { if (!document.hidden) askPresence(); });",
"    setInterval(askPresence, 20000);"
].join('\n'));

// ══════════════ public/space.html ══════════════

// 12. Cache-bust the rewritten presence script
edit('public/space.html', 'device-presence.js?v=1', 'device-presence.js?v=2', { all: true });

// ══════════════ apply ══════════════

const REDIRECT_MARK = 'space.crlx1q.com';
const cache = new Map();

function read(file) {
    if (!cache.has(file)) cache.set(file, fs.readFileSync(path.join(ROOT, file), 'utf8'));
    return cache.get(file);
}

let failed = false;
edits.forEach((e, i) => {
    const label = '#' + (i + 1) + ' ' + e.file;
    let src = read(e.file);
    const parts = src.split(e.find);
    const hits = parts.length - 1;
    if (hits === 0) {
        console.error('FAIL ' + label + ': anchor not found ->\n' + e.find.slice(0, 160));
        failed = true;
        return;
    }
    if (hits > 1 && !e.all) {
        console.error('FAIL ' + label + ': anchor found ' + hits + ' times (needs to be unique)');
        failed = true;
        return;
    }
    src = e.all ? parts.join(e.replace) : src.replace(e.find, e.replace);
    cache.set(e.file, src);
    console.log('ok   ' + label + ' (' + hits + ' replacement' + (hits > 1 ? 's' : '') + ')');
});

if (failed) {
    console.error('\nNo files were written.');
    process.exit(1);
}

// Safety: the redirect must still be present in server.js
const before = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
const after = cache.get('server.js');
if (!after.includes(REDIRECT_MARK)) {
    console.error('FAIL: redirect marker missing from server.js');
    process.exit(1);
}
const redirectRe = /if \(host\.includes\('crlx1q\.com'\)[\s\S]{0,600}?\n\s*\}/;
const mBefore = before.match(redirectRe);
const mAfter = after.match(redirectRe);
if (mBefore && mAfter && mBefore[0] !== mAfter[0]) {
    console.error('FAIL: redirect block changed');
    process.exit(1);
}

for (const [file, content] of cache.entries()) {
    fs.writeFileSync(path.join(ROOT, file), content);
    console.log('wrote ' + file + ' (' + Buffer.byteLength(content) + ' bytes)');
}
console.log('patch2 applied');
