#!/usr/bin/env node
/**
 * One-shot patch #3
 *  - online tooltip becomes a Minecraft-style tab list: every participant AND
 *    every device, with myself ALWAYS listed.
 *  - footer email on crlx1q.com -> support@crlx1q.com
 *
 * Exact-string edits only. If any anchor is missing or ambiguous the script
 * exits non-zero and NOTHING is written. The crlx1q.com -> space.crlx1q.com
 * redirect is never touched (asserted below).
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = process.cwd();
const edits = [];
function edit(file, find, replace, opts) {
    edits.push(Object.assign({ file, find, replace }, opts || {}));
}

// 1. Tooltip delegates to the tab-list renderer (legacy markup stays as fallback)
edit('public/space.js',
[
"    const tooltipEl = $('online-tooltip');",
"    if (!tooltipEl) return;",
"    const list = [...state.onlineUsers.values()];"
].join('\n'),
[
"    const tooltipEl = $('online-tooltip');",
"    if (!tooltipEl) return;",
"    const list = [...state.onlineUsers.values()];",
"    // Tab list (like Minecraft): every participant AND every device of theirs,",
"    // and I am always in the list too. Falls back to the legacy list below.",
"    const dp = window.SpaceDevices;",
"    if (dp && dp.renderTooltip && dp.renderTooltip(tooltipEl, {",
"        selfUserId: state.user?._id,",
"        selfUsername: state.user?.username || 'you',",
"        selfClientId: DEVICE_ID,",
"        selfSocketId: ws && ws.id,",
"        others: list",
"    })) {",
"        if (state.teamChatOpen) renderTeamPresence();",
"        return;",
"    }"
].join('\n'));

// 2. Cache-bust the rewritten presence script
edit('public/space.html', 'device-presence.js?v=2', 'device-presence.js?v=3', { all: true });

// 3. Footer email
edit('public/index.html', 'mailto:contact@crlx1q.pro', 'mailto:support@crlx1q.com', { all: true });

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
        console.error('FAIL ' + label + ': anchor not found ->\n' + e.find.slice(0, 160));
        failed = true;
        return;
    }
    if (hits > 1 && !e.all) {
        console.error('FAIL ' + label + ': anchor found ' + hits + ' times (must be unique)');
        failed = true;
        return;
    }
    cache.set(e.file, e.all ? parts.join(e.replace) : src.replace(e.find, e.replace));
    console.log('ok   ' + label + ' (' + hits + ' replacement' + (hits > 1 ? 's' : '') + ')');
});

if (failed) {
    console.error('\nNo files were written.');
    process.exit(1);
}

// Safety: server.js is not modified by this patch and the redirect must stay
const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
if (!server.includes('space.crlx1q.com')) {
    console.error('FAIL: redirect marker missing from server.js');
    process.exit(1);
}
if (cache.has('server.js')) {
    console.error('FAIL: this patch must not touch server.js');
    process.exit(1);
}

for (const [file, content] of cache.entries()) {
    fs.writeFileSync(path.join(ROOT, file), content);
    console.log('wrote ' + file + ' (' + Buffer.byteLength(content) + ' bytes)');
}
console.log('patch3 applied');
