#!/usr/bin/env node
/**
 * One-shot patch #4
 *  1) FIX: <script src="device-presence.js"> was RELATIVE, so on
 *     /canvas/:slug the browser requested /canvas/device-presence.js -> 404
 *     and the page fell back to the old "Only you" list. Now absolute.
 *  2) Tooltip rows: colored dot (user color) + bright nickname, dim device info.
 *  3) Service worker cache bumped so old copies are dropped without Ctrl+Shift+R.
 *
 * Exact-string edits only. Any missing/ambiguous anchor -> exit 1, nothing written.
 * server.js is never touched (asserted).
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = process.cwd();
const edits = [];
function edit(file, find, replace, opts) {
    edits.push(Object.assign({ file, find, replace }, opts || {}));
}

// 1. absolute path + cache bust
edit('public/space.html', 'device-presence.js?v=3', '/device-presence.js?v=4', { all: true });

// 2. pass my own color to the renderer
edit('public/space.js',
[
"        selfClientId: DEVICE_ID,",
"        selfSocketId: ws && ws.id,"
].join('\n'),
[
"        selfClientId: DEVICE_ID,",
"        selfColor: state.user?.color,",
"        selfSocketId: ws && ws.id,"
].join('\n'));

// 3. service worker: new cache generation + keep the presence script fresh
edit('public/sw.js', "const CACHE = 'space-v1';", "const CACHE = 'space-v2';");
edit('public/sw.js', "    '/space.js',\n", "    '/space.js',\n    '/device-presence.js',\n");
edit('public/sw.js',
    "['/space', '/space.css', '/space.js', '/icon.svg', '/manifest.json'].includes(url.pathname)",
    "['/space', '/space.css', '/space.js', '/device-presence.js', '/icon.svg', '/manifest.json'].includes(url.pathname)");

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
    console.log('ok   ' + label + ' (' + hits + ')');
});

if (failed) {
    console.error('\nNo files were written.');
    process.exit(1);
}

const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
if (!server.includes('space.crlx1q.com')) {
    console.error('FAIL: redirect marker missing from server.js');
    process.exit(1);
}
if (cache.has('server.js')) {
    console.error('FAIL: this patch must not touch server.js');
    process.exit(1);
}
if (!cache.get('public/space.html').includes('src="/device-presence.js?v=4"')) {
    console.error('FAIL: script tag did not become absolute');
    process.exit(1);
}

for (const [file, content] of cache.entries()) {
    fs.writeFileSync(path.join(ROOT, file), content);
    console.log('wrote ' + file + ' (' + Buffer.byteLength(content) + ' bytes)');
}
console.log('patch4 applied');
