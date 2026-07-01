/* Space — Service Worker
 * Strategy: network-first for the app shell so an online user ALWAYS gets the
 * latest code/markup (no more Ctrl+Shift+R), with a cached fallback for offline.
 * API requests and cross-origin assets (fonts, R2, Gemini, socket.io) are never
 * intercepted — they go straight to the network.
 */
const CACHE = 'space-v1';
const SHELL = [
    '/space',
    '/space.css',
    '/space.js',
    '/icon.svg',
    '/manifest.json',
];

self.addEventListener('install', (event) => {
    self.skipWaiting();
    event.waitUntil(
        caches.open(CACHE).then((c) => c.addAll(SHELL).catch(() => {}))
    );
});

self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys()
            .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
            .then(() => self.clients.claim())
    );
});

// Allow the page to tell a waiting SW to take over immediately
self.addEventListener('message', (e) => {
    if (e.data === 'skip-waiting') self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
    const req = event.request;
    if (req.method !== 'GET') return;

    const url = new URL(req.url);
    // Only handle our own origin; never touch APIs, websockets or 3rd-party assets
    if (url.origin !== self.location.origin) return;
    if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/socket.io/')) return;

    const isShell =
        req.mode === 'navigate' ||
        ['/space', '/space.css', '/space.js', '/icon.svg', '/manifest.json'].includes(url.pathname);

    if (!isShell) return; // let everything else go to the network untouched

    // Network-first → fresh when online, cached copy when offline
    event.respondWith(
        fetch(req)
            .then((res) => {
                if (res && res.ok) {
                    const clone = res.clone();
                    caches.open(CACHE).then((c) => c.put(req, clone));
                }
                return res;
            })
            .catch(() =>
                caches.match(req).then((hit) => hit || caches.match('/space'))
            )
    );
});
