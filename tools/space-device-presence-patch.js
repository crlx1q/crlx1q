#!/usr/bin/env node
/*
 * One-shot, anchor-based patch script.
 *
 * Fixes:
 *  1) Presence counted per ACCOUNT instead of per DEVICE -> now every live
 *     session (device/tab) is reported, with a readable label (PC / Mobile / Tablet).
 *  2) Realtime updates were dropped between two devices of the SAME account
 *     (client did `if (userId === state.user._id) return;`) -> now the echo is
 *     filtered per SOCKET, so phone -> PC updates arrive live, no refresh.
 *  3) AI created notes with a title but an empty body -> prompt hardened,
 *     field aliases accepted, plus a one-shot fallback that generates the body.
 *
 * It NEVER touches the crlx1q.com -> space.crlx1q.com redirect block.
 * If any anchor is missing it exits non-zero WITHOUT writing anything.
 */

var fs = require('fs');
var path = require('path');

var ROOT = process.cwd();
var errs = [];
var log = [];

function rd(p) { return fs.readFileSync(path.join(ROOT, p), 'utf8'); }
function wr(p, s) { fs.writeFileSync(path.join(ROOT, p), s); }

function one(src, from, to, label) {
    var i = src.indexOf(from);
    if (i < 0) { errs.push('ANCHOR MISSING: ' + label); return src; }
    if (src.indexOf(from, i + from.length) >= 0) { errs.push('ANCHOR NOT UNIQUE: ' + label); return src; }
    log.push('ok   ' + label);
    return src.slice(0, i) + to + src.slice(i + from.length);
}

function many(src, from, to, label, min) {
    var parts = src.split(from);
    var hits = parts.length - 1;
    if (hits < (min || 1)) { errs.push('ANCHOR MISSING (' + hits + ' hits, need ' + (min || 1) + '): ' + label); return src; }
    log.push('ok   ' + label + ' (x' + hits + ')');
    return parts.join(to);
}

function L() { return Array.prototype.slice.call(arguments).join('\n'); }

// ── server.js ──────────────────────────────────────────────
var srv = rd('server.js');
var redirectGuard = srv.indexOf("host.includes('crlx1q.com')");
if (redirectGuard < 0) errs.push('SAFETY: redirect block not found in server.js');
var redirectSnapshot = redirectGuard < 0 ? '' : srv.slice(redirectGuard - 200, redirectGuard + 1200);

// 1. device helpers, inserted right before presenceFor()
srv = one(srv,
    'async function presenceFor(spaceId) {',
    L(
        '// Human readable device label from a User-Agent string.',
        'function deviceFromUA(ua) {',
        '    var s = String(ua || \'\');',
        '    var kind = \'PC\';',
        '    if (/iPhone|iPod|Windows Phone/i.test(s) || (/Android/i.test(s) && /Mobile/i.test(s))) kind = \'Mobile\';',
        '    else if (/iPad|Tablet|PlayBook|Silk/i.test(s) || (/Android/i.test(s) && !/Mobile/i.test(s))) kind = \'Tablet\';',
        '    var os = \'\';',
        '    if (/iPhone|iPod/i.test(s)) os = \'iPhone\';',
        '    else if (/iPad/i.test(s)) os = \'iPad\';',
        '    else if (/Android/i.test(s)) os = \'Android\';',
        '    else if (/Windows NT/i.test(s)) os = \'Windows\';',
        '    else if (/Mac OS X|Macintosh/i.test(s)) os = \'macOS\';',
        '    else if (/CrOS/i.test(s)) os = \'ChromeOS\';',
        '    else if (/Linux/i.test(s)) os = \'Linux\';',
        '    var browser = \'\';',
        '    if (/Edg\\//i.test(s)) browser = \'Edge\';',
        '    else if (/OPR\\/|Opera/i.test(s)) browser = \'Opera\';',
        '    else if (/YaBrowser/i.test(s)) browser = \'Yandex\';',
        '    else if (/SamsungBrowser/i.test(s)) browser = \'Samsung\';',
        '    else if (/Firefox\\//i.test(s)) browser = \'Firefox\';',
        '    else if (/Chrome\\//i.test(s)) browser = \'Chrome\';',
        '    else if (/Safari\\//i.test(s)) browser = \'Safari\';',
        '    return { kind: kind, os: os, browser: browser };',
        '}',
        '',
        '// Flat list of every live session: one entry per connected device/tab.',
        'function sessionsFrom(users) {',
        '    var out = [];',
        '    (users || []).forEach(function (u) {',
        '        (u.devices || []).forEach(function (d) {',
        '            out.push({',
        '                userId: u.userId, username: u.username, color: u.color,',
        '                socketId: d.socketId, kind: d.kind, os: d.os, browser: d.browser, label: d.label',
        '            });',
        '        });',
        '    });',
        '    return out;',
        '}',
        '',
        'async function presenceFor(spaceId) {'
    ),
    'server.js: device helpers');

// 2. presenceFor(): keep one entry per user (backwards compatible) but attach devices
srv = one(srv,
    L(
        '    const map = new Map();',
        '    for (const s of sockets) {',
        '        const uid = s.data?.userId;',
        '        if (uid && !map.has(uid)) {',
        '            map.set(uid, { userId: uid, username: s.data.username, color: s.data.color });',
        '        }',
        '    }',
        '    return [...map.values()];'
    ),
    L(
        '    const map = new Map();',
        '    for (const s of sockets) {',
        '        const uid = s.data?.userId;',
        '        if (!uid) continue;',
        '        if (!map.has(uid)) {',
        '            map.set(uid, { userId: uid, username: s.data.username, color: s.data.color, devices: [] });',
        '        }',
        '        const dev = s.data?.device || deviceFromUA(s.handshake?.headers?.[\'user-agent\']);',
        '        map.get(uid).devices.push({',
        '            socketId: s.id, kind: dev.kind, os: dev.os, browser: dev.browser,',
        '            label: (s.data.username || \'user\') + \' \' + dev.kind',
        '        });',
        '    }',
        '    // Same device kind twice on one account -> PC, PC 2, PC 3 …',
        '    for (const u of map.values()) {',
        '        const seen = new Map();',
        '        u.devices.forEach(function (d) {',
        '            const n = (seen.get(d.kind) || 0) + 1;',
        '            seen.set(d.kind, n);',
        '            if (n > 1) { d.kind = d.kind + \' \' + n; d.label = d.label + \' \' + n; }',
        '        });',
        '        u.deviceCount = u.devices.length;',
        '    }',
        '    return [...map.values()];'
    ),
    'server.js: presenceFor devices');

// 3. remember the device on the socket during auth
srv = one(srv,
    L(
        '        socket.data.userId = p.userId;',
        '        socket.data.username = p.username;'
    ),
    L(
        '        socket.data.userId = p.userId;',
        '        socket.data.username = p.username;',
        '        socket.data.device = deviceFromUA(socket.handshake?.headers?.[\'user-agent\']);'
    ),
    'server.js: socket device on auth');

// 4. broadcast per-device sessions with presence
srv = many(srv,
    "emit('space:online', { count: users.length, users });",
    "emit('space:online', { count: users.length, users, sessions: sessionsFrom(users) });",
    'server.js: space:online sessions', 1);

// 5. include sessions in the join snapshot
srv = one(srv,
    'onlineCount: users.length, users',
    'onlineCount: users.length, users, sessions: sessionsFrom(users)',
    'server.js: snapshot sessions');

// 6. tag every relayed realtime event with the ORIGIN SOCKET, so other devices
//    of the same account no longer discard the update
srv = many(srv,
    '{ ...data, userId: socket.userId }',
    '{ ...data, userId: socket.userId, socketId: socket.id }',
    'server.js: socketId on relayed events', 4);

// 7. AI: notes must always contain body text
srv = one(srv,
    '   • create_note  → fields: title, content, color(optional: white|blue|green|purple|yellow|red)',
    '   • create_note  → fields: title, content (REQUIRED, non-empty — the real body text of the note), color(optional: white|blue|green|purple|yellow|red)',
    'server.js: AI prompt create_note fields');

srv = one(srv,
    '- Keep notes concise and useful. Prefer a few well-structured notes over many tiny ones.',
    L(
        '- Keep notes concise and useful. Prefer a few well-structured notes over many tiny ones.',
        '- EVERY create_note MUST include a non-empty "content": the actual body of the note',
        '  (description, explanation or list). A note with a title only is a BUG — never do that.',
        '- "title" is a short name (2-6 words). All the details go into "content", not the title.',
        '- If the user asks for a note about something "with a description", write the description',
        '  into "content" in the same language the user used.',
        '- update_note follows the same rule when the user asks to fill in or extend a note.'
    ),
    'server.js: AI prompt note-body rules');

srv = one(srv,
    "                const content = String(a.content || '').slice(0, 5000);",
    L(
        "                let content = String(a.content || a.body || a.text || a.description || '').slice(0, 5000);",
        '                if (!content.trim()) {',
        '                    // Model returned a title with no body — ask once for the body text.',
        '                    try {',
        '                        const fb = await callGeminiServer({',
        "                            systemInstruction: { parts: [{ text: 'You write the BODY text of a sticky note. Plain text only, no JSON, no markdown headings, 1-6 short lines, same language as the request.' }] },",
        "                            contents: [{ role: 'user', parts: [{ text: 'Request: ' + userText + '\\nNote title: ' + title + '\\nWrite the note body:' }] }],",
        '                            generationConfig: { temperature: 0.6, maxOutputTokens: 512 }',
        '                        });',
        "                        content = String((fb && (fb.text || fb.reply)) || '').trim().slice(0, 5000);",
        '                    } catch (e) { /* keep going, note is still created */ }',
        '                }'
    ),
    'server.js: create_note content fallback');

srv = one(srv,
    '                if (a.content != null) upd.content = String(a.content).slice(0, 5000);',
    L(
        '                const newContent = a.content != null ? a.content',
        '                    : (a.body != null ? a.body : (a.text != null ? a.text : a.description));',
        '                if (newContent != null) upd.content = String(newContent).slice(0, 5000);'
    ),
    'server.js: update_note content aliases');

srv = one(srv,
    '                                content: { type: \'string\' },',
    L(
        '                                content: { type: \'string\' },',
        '                                body:    { type: \'string\' },',
        '                                text:    { type: \'string\' },',
        '                                description: { type: \'string\' },'
    ),
    'server.js: AI schema content aliases');

// safety: the redirect block must be byte-identical
if (redirectGuard >= 0) {
    var after = srv.indexOf("host.includes('crlx1q.com')");
    if (after < 0 || srv.slice(after - 200, after + 1200) !== redirectSnapshot) {
        errs.push('SAFETY: redirect block changed — aborting');
    } else {
        log.push('ok   redirect block untouched');
    }
}

// ── public/space.js ────────────────────────────────────────
var js = rd('public/space.js');

// A. realtime handlers get access to the raw event so we can filter per socket
var RT = ['node:create', 'node:move', 'node:update', 'node:delete',
          'edge:create', 'edge:delete', 'draw:create', 'draw:delete',
          'node:editing', 'node:editing-stop'];
var rewritten = 0;
js = js.replace(/ws\.on\('([a-z:-]+)',\s*\(\{([^{}]*)\}\)\s*=>\s*\{/g, function (m, ev, destr) {
    if (RT.indexOf(ev) < 0) return m;
    rewritten++;
    return "ws.on('" + ev + "', (__ev) => { const {" + destr + "} = __ev; " +
        'if (__ev && __ev.socketId && __ev.socketId === ws.id) return;';
});
if (rewritten < 4) errs.push('space.js: only ' + rewritten + ' realtime handlers rewritten');
else log.push('ok   space.js: realtime handlers rewritten (x' + rewritten + ')');

// B. the actual bug: own-account echo was dropped by userId, killing multi-device sync
js = many(js,
    'if (userId === state.user?._id) return;',
    "if ((typeof __ev !== 'undefined' && __ev && __ev.socketId) ? __ev.socketId === ws.id : (userId === state.user?._id)) return;",
    'space.js: per-socket echo filter', 1);

// C. feed the device list UI
js = one(js,
    L(
        "    ws.on('space:online', ({ count, users }) => {",
        '        if (users) { state.onlineUsers.clear(); users.filter(u => u.userId !== state.user?._id).forEach(u => state.onlineUsers.set(u.userId, u)); }',
        '        updateOnlineTooltip();',
        '    });'
    ),
    L(
        "    ws.on('space:online', ({ count, users }) => {",
        '        if (users) { state.onlineUsers.clear(); users.filter(u => u.userId !== state.user?._id).forEach(u => state.onlineUsers.set(u.userId, u)); }',
        '        updateOnlineTooltip();',
        '    });',
        '',
        '    // Per-device presence (admin PC / admin Mobile …), rendered by device-presence.js',
        "    ws.on('space:online', (p) => {",
        '        try {',
        '            if (window.SpaceDevices) window.SpaceDevices.update(p, { selfId: ws.id, selfUserId: state.user?._id });',
        '        } catch (e) {}',
        '    });'
    ),
    'space.js: device presence listener');

// ── public/space.html ──────────────────────────────────────
var html = rd('public/space.html');
if (html.indexOf('device-presence.js') >= 0) {
    log.push('skip public/space.html: script tag already present');
} else {
    var injected = false;
    html = html.replace(/(<script[^>]*src="[^"]*space\.js[^"]*"[^>]*>\s*<\/script>)/, function (m) {
        injected = true;
        return m + '\n    <script src="device-presence.js?v=1"></script>';
    });
    if (!injected) errs.push('ANCHOR MISSING: space.html script tag for space.js');
    else log.push('ok   space.html: device-presence.js script tag');
}

// ──────────────────────────────────────────────────────────
console.log(log.join('\n'));
if (errs.length) {
    console.error('\nPATCH ABORTED — nothing was written:\n' + errs.join('\n'));
    process.exit(1);
}

wr('server.js', srv);
wr('public/space.js', js);
wr('public/space.html', html);
console.log('\nAll patches applied.');
