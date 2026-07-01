/* ══════════════════════════════════════════════════════
   SPACE.JS v3.1 — CRLX1Q Space Application
   Stages 1+2+3+6: Bugs • Cursors • Edges • Themes
   ══════════════════════════════════════════════════════ */

'use strict';

// ─── CONFIG ──────────────────────────────────────────
const API_BASE       = '/api/space';
// AI runs entirely server-side now (the Gemini key never reaches the browser).
// The client just POSTs the prompt and renders the realtime results over WS.

const CURSOR_COLORS  = ['#4ade80','#60a5fa','#c084fc','#fb923c','#f472b6','#34d399','#fbbf24','#f87171'];
// Is THIS device touch-based? Broadcast so others render our cursor as a dot (mobile) vs arrow (desktop)
const IS_TOUCH = (navigator.maxTouchPoints > 0) || ('ontouchstart' in window) || window.matchMedia('(pointer: coarse)').matches;
const CURSOR_THROTTLE_MS = 30;  // 30ms default, 100ms on slow network

// ─── STATE ───────────────────────────────────────────
let state = {
    token:           localStorage.getItem('space_token'),
    user:            null,
    spaceId:         null,
    spaceSlug:       null,
    spaceRole:       null,        // 'owner' | 'editor' | 'reader' on the current canvas
    readOnly:        false,       // true when spaceRole === 'reader'
    spaces:          [],          // [{ _id, name, slug, role, ... }] — canvases accessible to user
    theme:           localStorage.getItem('space_theme') || 'auto',
    currentTool:     'select',
    viewport:        { x: 0, y: 0, zoom: 1 },
    nodes:           new Map(),   // id → { el, data }
    edges:           new Map(),   // id → { el: g, path, hitPath, data }
    strokes:         new Map(),   // id → { el: path, data }  (freehand drawings)
    filed:           new Map(),   // id → data  (nodes filed inside a folder, not on canvas)
    selected:        new Set(),

    // drawing (pen / eraser)
    penColor:        '#9aa0a6',
    penWidth:        4,
    drawing:         null,        // { points: [{x,y}] } while a stroke is in progress
    erasing:         false,
    aiContextNodes:  new Set(),
    aiMessages:      [],
    aiThinkingEl:    null,        // shared "AI is working" indicator element

    // team group chat
    teamChatOpen:    false,
    chatMode:        'panel',     // 'panel' | 'floating' | 'canvas' (shared)
    chatPos:         { x: 80, y: 80 },
    undoStack:       [],
    redoStack:       [],

    // cursors
    remoteCursors:   new Map(),   // userId → { el, worldX, worldY }
    onlineUsers:     new Map(),   // userId → { username, color }

    // interaction
    connectingFrom:  null,        // { nodeId, side }
    isPanning:       false,
    panStart:        null,
    dragNode:        null,
    dragOffset:      null,
    dragMoved:       false,
    selectBoxStart:  null,
    isAIPanelOpen:   true,
    pendingDropPos:  { x: 400, y: 300 },

    // editing indicator
    remoteEditing:   new Map(),   // nodeId → { userId, color }

    // update debounce
    updatingTimer:   null,
    contentDebounce: new Map(),   // nodeId → timer
};

let physics = { edges: new Map(), animFrame: null };
let ws      = null;

// ─── DOM REFS ────────────────────────────────────────
const $  = id => document.getElementById(id);
const authScreen  = $('auth-screen');
const app         = $('app');
const canvasArea  = $('canvas-area');
const canvasWorld = $('canvas-world');
const nodesLayer  = $('nodes-layer');
const edgesGroup  = $('edges-group');
const edgePreview = $('edge-preview');
const drawGroup   = $('draw-group');
const drawPreview = $('draw-preview');
const selectBox   = $('select-box');
const contextMenu = $('context-menu');
const aiPanel     = $('ai-panel');
const aiMessages  = $('ai-messages');
const aiInput     = $('ai-input');
const canvasHint  = $('canvas-hint');
const zoomDisplay = $('zoom-display');
const wsStatus    = $('ws-status');
const wsDot       = $('ws-dot');
const cursorsLayer= $('cursors-layer');
const updatingEl  = $('updating-indicator');
const teamChat    = $('team-chat');
const teamChatMsgs= $('team-chat-messages');
const teamChatInputEl = $('team-chat-input');

// ══════════════════════════════════════════════════════
// THEME  (Stage 6)
// ══════════════════════════════════════════════════════

function applyTheme(theme) {
    state.theme = theme;
    localStorage.setItem('space_theme', theme);
    let resolved = theme;
    if (theme === 'auto') {
        resolved = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    }
    document.documentElement.setAttribute('data-theme', resolved);
    const btn = $('theme-toggle-btn');
    if (btn) btn.title = resolved === 'dark' ? 'Switch to Light' : 'Switch to Dark';
    // update toggle icon
    if (btn) btn.innerHTML = resolved === 'dark'
        ? `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="12" r="5"/><path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/></svg>`
        : `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M21 12.79A9 9 0 1111.21 3 7 7 0 0021 12.79z"/></svg>`;
}

function toggleTheme() {
    const cur = document.documentElement.getAttribute('data-theme');
    applyTheme(cur === 'dark' ? 'light' : 'dark');
}

// Watch system preference change
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (state.theme === 'auto') applyTheme('auto');
});

// ══════════════════════════════════════════════════════
// INIT
// ══════════════════════════════════════════════════════

async function init() {
    applyTheme(state.theme);
    initAuthMatrix();
    setupAuthInputs();
    if (state.token) {
        const ok = await verifyToken();
        if (ok) await bootApp();
    }
    setupKeyboard();
    setupDragAndDrop();
    setupMobileGestures();
    renderPalette();
    setPenColor(state.penColor);
    setPenWidth(state.penWidth);
}

// Swipe gestures for the AI panel on mobile:
//   • swipe left from the right edge → open    • swipe right on the panel → close
function setupMobileGestures() {
    let sx = 0, sy = 0, mode = null;
    const EDGE = 30, THRESH = 55;
    window.addEventListener('touchstart', (e) => {
        if (window.innerWidth > 768 || !app.classList.contains('show')) { mode = null; return; }
        const t = e.touches[0]; sx = t.clientX; sy = t.clientY; mode = null;
        if (!state.isAIPanelOpen && sx >= window.innerWidth - EDGE) mode = 'open';
        else if (state.isAIPanelOpen && aiPanel.contains(e.target)) mode = 'close';
    }, { passive: true });
    window.addEventListener('touchend', (e) => {
        if (window.innerWidth > 768 || !mode) { mode = null; return; }
        const t = e.changedTouches[0];
        const dx = t.clientX - sx, dy = t.clientY - sy;
        if (Math.abs(dx) > THRESH && Math.abs(dx) > Math.abs(dy)) {
            if (mode === 'open'  && dx < 0 && !state.isAIPanelOpen) toggleAIPanel();
            if (mode === 'close' && dx > 0 &&  state.isAIPanelOpen) toggleAIPanel();
        }
        mode = null;
    }, { passive: true });
}

async function verifyToken() {
    try {
        const res = await fetch(`${API_BASE}/auth/me`, {
            headers: { 'Authorization': 'Bearer ' + state.token }
        });
        if (!res.ok) { state.token = null; localStorage.removeItem('space_token'); return false; }
        state.user = await res.json();
        return true;
    } catch { return false; }
}

async function bootApp() {
    authScreen.classList.add('hidden');
    app.classList.add('show');
    // On mobile, start with the AI panel collapsed so it doesn't cover the canvas
    if (window.innerWidth <= 768 && state.isAIPanelOpen) toggleAIPanel();
    const av = $('user-avatar');
    av.textContent = (state.user.username || 'U')[0].toUpperCase();
    av.style.background = state.user.color || '#111';
    av.style.color = state.user.color ? '#000' : '#fff';
    if (state.user.role === 'owner') $('admin-link').style.display = 'flex';
    // Only global owners may create new canvases
    const newBtn = $('canvas-new-btn');
    if (newBtn) newBtn.style.display = state.user.role === 'owner' ? '' : 'none';
    const loaded = await loadSpaces();
    if (!loaded) return; // no accessible canvas — empty state shown
    initWebSocket();
    startPhysicsLoop();
    updateCursorThrottle();
}

// Read the slug from /canvas/:slug (if present)
function getSlugFromURL() {
    const m = location.pathname.match(/^\/canvas\/([A-Za-z0-9_-]+)$/);
    return m ? m[1] : null;
}

// Load the user's accessible canvases, resolve the target one (URL slug or first), apply role.
async function loadSpaces() {
    try {
        const res = await apiFetch(`${API_BASE}/spaces`);
        const spaces = await res.json();
        state.spaces = Array.isArray(spaces) ? spaces : [];

        if (state.spaces.length === 0) {
            showNoCanvasState();
            renderCanvasDropdown();
            return false;
        }

        const wantSlug = getSlugFromURL();
        let target = wantSlug ? state.spaces.find(s => s.slug === wantSlug) : null;
        if (!target) target = state.spaces[0];

        // Keep the URL in sync with the active canvas (without reloading)
        if (target.slug && location.pathname !== `/canvas/${target.slug}`) {
            history.replaceState({}, '', `/canvas/${target.slug}`);
        }

        applyActiveSpace(target);
        renderCanvasDropdown();
        return true;
    } catch (e) {
        console.error('Failed to load spaces:', e);
        showToast('Failed to load canvases', 'error');
        return false;
    }
}

// Set the active canvas + role and reflect read-only state across the UI
function applyActiveSpace(space) {
    state.spaceId   = space._id;
    state.spaceSlug = space.slug;
    state.spaceRole = space.role || 'reader';
    $('space-name-display').textContent = space.name || 'Canvas';
    applyReadOnly(state.spaceRole === 'reader');
    // Owner-only controls (access / delete)
    const accessBtn = $('canvas-access-btn');
    if (accessBtn) accessBtn.style.display = state.spaceRole === 'owner' ? '' : 'none';
    // Trash visible to owner + editors
    const trashBtn = $('canvas-trash-btn');
    if (trashBtn) trashBtn.style.display = (state.spaceRole === 'owner' || state.spaceRole === 'editor') ? '' : 'none';
}

// Toggle read-only mode: hides creation tools and locks node editing
function applyReadOnly(ro) {
    state.readOnly = ro;
    document.body.classList.toggle('read-only', ro);
    const badge = $('role-badge');
    if (badge) {
        badge.textContent = state.spaceRole || '';
        badge.style.display = state.spaceRole ? '' : 'none';
        badge.className = 'role-badge role-' + (state.spaceRole || '');
    }
    // Lock / unlock inline editing on already-rendered nodes
    state.nodes.forEach(({ el }) => setNodeEditable(el, !ro));
    // AI chat: readers can view but not write
    const aiIn = $('ai-input'), aiSend = $('ai-send-btn');
    if (aiIn)   { aiIn.disabled = ro; aiIn.placeholder = ro ? '// read-only — viewing AI chat' : '// ask AI agent...'; }
    if (aiSend) aiSend.disabled = ro;
    document.querySelectorAll('.ai-quick-btn').forEach(b => b.disabled = ro);
}

// Enable/disable contenteditable fields inside a node element
function setNodeEditable(el, editable) {
    el.querySelectorAll('[contenteditable]').forEach(c => {
        c.setAttribute('contenteditable', editable ? 'true' : 'false');
    });
}

function showNoCanvasState() {
    $('space-name-display').textContent = 'No canvas';
    canvasHint.classList.remove('hidden');
    const title = canvasHint.querySelector('.hint-title');
    const sub   = canvasHint.querySelector('.hint-sub');
    if (title) title.textContent = 'NO ACCESS';
    if (sub)   sub.textContent = '// you have no canvases yet — ask an owner to share one';
}

// ── Canvas switcher dropdown ──
function renderCanvasDropdown() {
    const list = $('canvas-dropdown-list');
    if (!list) return;
    list.innerHTML = '';
    state.spaces.forEach(s => {
        const item = document.createElement('div');
        item.className = 'canvas-dd-item' + (s._id === state.spaceId ? ' active' : '');
        item.innerHTML = `
            <span class="canvas-dd-name">${escHtml(s.name || 'Canvas')}</span>
            <span class="canvas-dd-role role-${s.role}">${s.role}</span>`;
        item.onclick = () => switchCanvas(s.slug);
        list.appendChild(item);
    });
}

function toggleCanvasDropdown() {
    const dd = $('canvas-dropdown');
    if (dd) dd.classList.toggle('show');
}

function switchCanvas(slug) {
    if (!slug || slug === state.spaceSlug) { toggleCanvasDropdown(); return; }
    // Full navigation keeps state clean (WS rejoin, snapshot reload)
    location.href = `/canvas/${slug}`;
}

async function createCanvas() {
    if (state.user?.role !== 'owner') { showToast('Only owners can create canvases', 'error'); return; }
    const name = prompt('New canvas name:', 'Untitled Canvas');
    if (!name || !name.trim()) return;
    try {
        const res = await apiFetch(`${API_BASE}/spaces`, 'POST', { name: name.trim() });
        if (!res.ok) { showToast('Failed to create canvas', 'error'); return; }
        const space = await res.json();
        location.href = `/canvas/${space.slug}`;
    } catch { showToast('Failed to create canvas', 'error'); }
}

// ══════════════════════════════════════════════════════
// AUTH  (Stage 1 — shake + Enter)
// ══════════════════════════════════════════════════════

function setupAuthInputs() {
    // Enter key handlers
    ['login-username','login-password'].forEach(id => {
        const el = $(id);
        if (el) el.addEventListener('keydown', e => { if (e.key === 'Enter') handleLogin(); });
    });
    ['reg-username','reg-email','reg-password'].forEach(id => {
        const el = $(id);
        if (el) el.addEventListener('keydown', e => { if (e.key === 'Enter') handleRegister(); });
    });
}

function switchAuthTab(tab) {
    $('tab-login').classList.toggle('active', tab === 'login');
    $('tab-register').classList.toggle('active', tab === 'register');
    $('panel-login').style.display = tab === 'login' ? '' : 'none';
    $('panel-register').style.display = tab === 'register' ? '' : 'none';
}

async function handleLogin() {
    const username = $('login-username').value.trim();
    const password = $('login-password').value;
    const btn = $('login-btn');
    if (!username || !password) { shakeAuth('panel-login'); showAuthError('login', 'Fill all fields'); return; }
    btn.disabled = true;
    btn.innerHTML = '<div class="loading-spinner"></div>';
    try {
        const res = await fetch(`${API_BASE}/auth/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, password })
        });
        const data = await res.json();
        if (data.token) {
            state.token = data.token;
            state.user  = data.user;
            localStorage.setItem('space_token', data.token);
            await bootApp();
        } else {
            shakeAuth('panel-login');
            showAuthError('login', data.error || 'Access denied');
        }
    } catch { shakeAuth('panel-login'); showAuthError('login', 'Connection error'); }
    btn.disabled = false;
    btn.innerHTML = '<span>Initialize Session</span><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 12h14M12 5l7 7-7 7"/></svg>';
}

async function handleRegister() {
    const username = $('reg-username').value.trim();
    const email    = $('reg-email').value.trim();
    const password = $('reg-password').value;
    const btn = $('reg-btn');
    if (!username || !email || !password) { shakeAuth('panel-register'); showAuthError('reg', 'Fill all fields'); return; }
    if (password.length < 8) { shakeAuth('panel-register'); showAuthError('reg', 'Password min 8 chars'); return; }
    btn.disabled = true;
    btn.innerHTML = '<div class="loading-spinner"></div>';
    try {
        const res = await fetch(`${API_BASE}/auth/register`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, email, password })
        });
        const data = await res.json();
        if (data.ok) {
            btn.style.display = 'none';
            $('reg-pending').classList.add('show');
        } else { shakeAuth('panel-register'); showAuthError('reg', data.error || 'Registration failed'); }
    } catch { shakeAuth('panel-register'); showAuthError('reg', 'Connection error'); }
    btn.disabled = false;
    if (!$('reg-pending').classList.contains('show')) btn.innerHTML = '<span>Request Access</span>';
}

function shakeAuth(panelId) {
    const el = $(panelId);
    if (!el) return;
    el.classList.remove('shake');
    void el.offsetWidth; // reflow
    el.classList.add('shake');
    setTimeout(() => el.classList.remove('shake'), 600);
}

function showAuthError(prefix, msg) {
    const el = $(`${prefix}-err`);
    if (!el) return;
    el.textContent = '// ' + msg.toUpperCase();
    el.classList.add('show');
    setTimeout(() => el.classList.remove('show'), 4000);
}

// ══════════════════════════════════════════════════════
// VIEWPORT & PAN/ZOOM
// ══════════════════════════════════════════════════════

function applyViewport() {
    const { x, y, zoom } = state.viewport;
    canvasWorld.style.transform = `translate(${x}px,${y}px) scale(${zoom})`;
    canvasArea.style.setProperty('--grid-offset-x', (x % 32) + 'px');
    canvasArea.style.setProperty('--grid-offset-y', (y % 32) + 'px');
    const gs = Math.max(8, 32 * zoom);
    canvasArea.style.setProperty('--grid-size', gs + 'px');
    const dotOpacity = zoom < 0.5 ? 0.08 : zoom > 1.5 ? 0.25 : 0.18;
    canvasArea.style.setProperty('--grid-dot', `rgba(var(--grid-dot-rgb),${dotOpacity})`);
    zoomDisplay.textContent = Math.round(zoom * 100) + '%';
    updateAllCursorPositions();  // reproject cursors on viewport change
    reprojectChat();             // keep the on-canvas chat anchored to the board
    scheduleCull();              // hide off-screen nodes on big canvases (perf)
    updateMinimap();
}

// ── Node culling: on large canvases, hide nodes far outside the viewport ──
const CULL_THRESHOLD = 60;   // only cull when there are many nodes
let cullScheduled = false;
function scheduleCull() {
    if (cullScheduled) return;
    cullScheduled = true;
    requestAnimationFrame(() => { cullScheduled = false; cullNodes(); });
}
function cullNodes() {
    if (state.nodes.size <= CULL_THRESHOLD) {
        state.nodes.forEach(n => { if (n.el.style.display === 'none') n.el.style.display = ''; });
        return;
    }
    const rect = canvasArea.getBoundingClientRect();
    const tl = screenToWorld(0, 0);
    const br = screenToWorld(rect.width, rect.height);
    const m  = 400 / (state.viewport.zoom || 1);
    const minX = tl.x - m, minY = tl.y - m, maxX = br.x + m, maxY = br.y + m;
    state.nodes.forEach((node, id) => {
        if (state.selected.has(id) || state.dragNode === id) { node.el.style.display = ''; return; }
        const d = node.data, w = d.size?.w || 200, h = d.size?.h || 120;
        const visible = d.position.x < maxX && d.position.x + w > minX && d.position.y < maxY && d.position.y + h > minY;
        node.el.style.display = visible ? '' : 'none';
    });
}

function screenToWorld(sx, sy) {
    const { x, y, zoom } = state.viewport;
    return { x: (sx - x) / zoom, y: (sy - y) / zoom };
}

function worldToScreen(wx, wy) {
    const { x, y, zoom } = state.viewport;
    return { x: wx * zoom + x, y: wy * zoom + y };
}

function changeZoom(delta, cx, cy) {
    const rect = canvasArea.getBoundingClientRect();
    cx = cx ?? rect.width / 2;
    cy = cy ?? rect.height / 2;
    const oldZoom = state.viewport.zoom;
    const newZoom = Math.min(4, Math.max(0.08, oldZoom + delta * oldZoom));
    state.viewport.x = cx - (cx - state.viewport.x) * (newZoom / oldZoom);
    state.viewport.y = cy - (cy - state.viewport.y) * (newZoom / oldZoom);
    state.viewport.zoom = newZoom;
    applyViewport();
}

function fitView() {
    if (state.nodes.size === 0) { state.viewport = { x: 0, y: 0, zoom: 1 }; applyViewport(); return; }
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    state.nodes.forEach(({ data }) => {
        minX = Math.min(minX, data.position.x);
        minY = Math.min(minY, data.position.y);
        maxX = Math.max(maxX, data.position.x + (data.size?.w || 200));
        maxY = Math.max(maxY, data.position.y + (data.size?.h || 120));
    });
    const rect = canvasArea.getBoundingClientRect();
    const pad  = 80;
    const zoom = Math.min(4, Math.max(0.1,
        Math.min((rect.width - pad*2) / (maxX-minX||1), (rect.height - pad*2) / (maxY-minY||1))
    ));
    state.viewport.zoom = zoom;
    state.viewport.x = rect.width / 2 - ((minX+maxX)/2) * zoom;
    state.viewport.y = rect.height / 2 - ((minY+maxY)/2) * zoom;
    applyViewport();
}

// ══════════════════════════════════════════════════════
// CANVAS INPUT EVENTS
// ══════════════════════════════════════════════════════

canvasArea.addEventListener('wheel', (e) => {
    e.preventDefault();
    const rect = canvasArea.getBoundingClientRect();
    changeZoom(e.deltaY > 0 ? -0.08 : 0.08, e.clientX - rect.left, e.clientY - rect.top);
}, { passive: false });

canvasArea.addEventListener('mousedown', onCanvasMousedown);
canvasArea.addEventListener('mousemove', onCanvasMousemove);
window.addEventListener('mouseup', onCanvasMouseup);

// Touch
let lastTouchDist = null, lastTouchMid = null;
const touchDrags = new Map(); // touch.identifier → { nodeId, offX, offY, moved, start }
canvasArea.addEventListener('touchstart', onTouchStart, { passive: false });
canvasArea.addEventListener('touchmove',  onTouchMove,  { passive: false });
canvasArea.addEventListener('touchend',   onTouchEnd);

// Which node (if any) is under a touch point
function nodeIdAtPoint(clientX, clientY) {
    let el = document.elementFromPoint(clientX, clientY);
    el = el && el.closest ? el.closest('.space-node') : null;
    return el ? el.dataset.id : null;
}

function onTouchStart(e) {
    // Multi-touch node dragging (tablets): each finger on a note drags it (up to 3)
    if (state.currentTool === 'select' && !state.readOnly) {
        const rect = canvasArea.getBoundingClientRect();
        let started = false;
        for (const t of e.changedTouches) {
            if (touchDrags.size >= 3) break;
            // Don't start a drag on editable text / buttons / handles / media — let those tap normally
            const target = document.elementFromPoint(t.clientX, t.clientY);
            if (target && target.closest('[contenteditable="true"], .node-action-btn, a, .node-port, .node-resize, audio, video, .file-media-preview, .file-audio-preview')) continue;
            const id = nodeIdAtPoint(t.clientX, t.clientY);
            if (!id || [...touchDrags.values()].some(d => d.nodeId === id)) continue;
            const node = state.nodes.get(id);
            if (!node) continue;
            selectNode(id);
            const left = parseInt(node.el.style.left) || 0, top = parseInt(node.el.style.top) || 0;
            touchDrags.set(t.identifier, {
                nodeId: id,
                offX: (t.clientX - rect.left) - (left * state.viewport.zoom + state.viewport.x),
                offY: (t.clientY - rect.top)  - (top  * state.viewport.zoom + state.viewport.y),
                moved: false, start: { x: left, y: top }
            });
            started = true;
        }
        if (started || touchDrags.size) { e.preventDefault(); return; }
    }
    if (e.touches.length === 2) {
        lastTouchDist = getTouchDist(e.touches);
        lastTouchMid  = getTouchMid(e.touches, canvasArea.getBoundingClientRect());
    } else if (e.touches.length === 1) {
        const t = e.touches[0];
        onCanvasMousedown({ clientX: t.clientX, clientY: t.clientY, target: t.target, button: 0, preventDefault: () => e.preventDefault() });
    }
}
function onTouchMove(e) {
    e.preventDefault();
    // Drive any active per-finger node drags
    if (touchDrags.size) {
        const rect = canvasArea.getBoundingClientRect();
        for (const t of e.changedTouches) {
            const d = touchDrags.get(t.identifier);
            if (!d) continue;
            const w = screenToWorld((t.clientX - rect.left) - d.offX, (t.clientY - rect.top) - d.offY);
            moveNode(d.nodeId, Math.round(w.x / 8) * 8, Math.round(w.y / 8) * 8);
            d.moved = true;
        }
        return;
    }
    if (e.touches.length === 2) {
        const dist = getTouchDist(e.touches);
        const mid  = getTouchMid(e.touches, canvasArea.getBoundingClientRect());
        if (lastTouchDist && lastTouchMid) {
            changeZoom((dist - lastTouchDist) / lastTouchDist, mid.x, mid.y);
            state.viewport.x += mid.x - lastTouchMid.x;
            state.viewport.y += mid.y - lastTouchMid.y;
            applyViewport();
        }
        lastTouchDist = dist; lastTouchMid = mid;
    } else if (e.touches.length === 1) {
        const t = e.touches[0];
        onCanvasMousemove({ clientX: t.clientX, clientY: t.clientY });
    }
}
function onTouchEnd(e) {
    // Finish any per-finger node drags → persist their new positions
    if (touchDrags.size && e && e.changedTouches) {
        for (const t of e.changedTouches) {
            const d = touchDrags.get(t.identifier);
            if (!d) continue;
            if (d.moved) { const node = state.nodes.get(d.nodeId); if (node) saveNodePosition(d.nodeId, node.data.position, d.start); }
            touchDrags.delete(t.identifier);
        }
        if (touchDrags.size === 0) { lastTouchDist = null; lastTouchMid = null; }
        return;
    }
    lastTouchDist = null; lastTouchMid = null; onCanvasMouseup({});
}
function getTouchDist(t) { const dx=t[0].clientX-t[1].clientX, dy=t[0].clientY-t[1].clientY; return Math.sqrt(dx*dx+dy*dy); }
function getTouchMid(t, r) { return { x:(t[0].clientX+t[1].clientX)/2-r.left, y:(t[0].clientY+t[1].clientY)/2-r.top }; }

function onCanvasMousedown(e) {
    if (e.button !== 0 && e.button !== undefined) return;
    hideContextMenu();
    const rect  = canvasArea.getBoundingClientRect();
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;

    if (state.currentTool === 'pan' || e.button === 1 || e.altKey) {
        state.isPanning = true;
        state.panStart  = { x: sx, y: sy, vpx: state.viewport.x, vpy: state.viewport.y };
        canvasArea.style.cursor = 'grabbing';
        return;
    }
    if (state.currentTool === 'draw') {
        if (state.readOnly) return;
        const w = screenToWorld(sx, sy);
        state.drawing = { points: [{ x: w.x, y: w.y }] };
        drawPreview.setAttribute('stroke', state.penColor);
        drawPreview.setAttribute('stroke-width', state.penWidth);
        drawPreview.setAttribute('d', strokePathD(state.drawing.points));
        drawPreview.style.display = '';
        return;
    }
    if (state.currentTool === 'eraser') {
        if (state.readOnly) return;
        state.erasing = true;
        eraseAtScreen(sx, sy);
        return;
    }
    if (state.currentTool === 'note') {
        const w = screenToWorld(sx, sy);
        createNoteAtPos(w.x, w.y);
        setTool('select');
        return;
    }
    // connecting mode — cancel if clicking canvas background
    if (state.connectingFrom) {
        state.connectingFrom = null;
        if (edgePreview) edgePreview.style.display = 'none';
        document.querySelectorAll('.space-node.connecting-source').forEach(el => el.classList.remove('connecting-source'));
        return;
    }
    // selection box
    const isBackground = e.target === canvasArea || e.target === canvasWorld
        || e.target === nodesLayer || e.target.id === 'edges-svg'
        || e.target.closest('#edges-group') || e.target.tagName === 'svg';
    if (state.currentTool === 'select' && isBackground) {
        state.selected.forEach(id => deselectNode(id));
        state.selected.clear();
        state.selectBoxStart = { sx, sy };
        selectBox.style.cssText = `left:${sx}px;top:${sy}px;width:0;height:0;display:block`;
    }
}

function onCanvasMousemove(e) {
    const rect = canvasArea.getBoundingClientRect();
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;
    emitCursor(sx, sy);

    if (state.isPanning) {
        state.viewport.x = state.panStart.vpx + (sx - state.panStart.x);
        state.viewport.y = state.panStart.vpy + (sy - state.panStart.y);
        applyViewport();
        return;
    }
    if (state.drawing) {
        const w = screenToWorld(sx, sy);
        const pts = state.drawing.points;
        const last = pts[pts.length - 1];
        const minDist = 2 / (state.viewport.zoom || 1);
        if (Math.hypot(w.x - last.x, w.y - last.y) >= minDist) {
            pts.push({ x: w.x, y: w.y });
            drawPreview.setAttribute('d', strokePathD(pts));
        }
        return;
    }
    if (state.erasing) { eraseAtScreen(sx, sy); return; }
    if (state.dragNode) {
        const w = screenToWorld(sx - state.dragOffset.x, sy - state.dragOffset.y);
        const snapped = { x: Math.round(w.x / 8) * 8, y: Math.round(w.y / 8) * 8 };
        if (state.dragGroup) {
            // Move the whole selection by the same delta
            const dx = snapped.x - state.dragStartPos.x, dy = snapped.y - state.dragStartPos.y;
            state.dragGroup.forEach((start, gid) => moveNode(gid, start.x + dx, start.y + dy));
        } else {
            moveNode(state.dragNode, snapped.x, snapped.y);
        }
        state.dragMoved = true;
        // Highlight a folder we're hovering over (drop target)
        const draggedIds = state.dragGroup ? [...state.dragGroup.keys()] : [state.dragNode];
        const overFolder = findFolderUnder(state.dragNode, draggedIds);
        document.querySelectorAll('.space-node.folder-drop').forEach(el => { if (el.dataset.id !== overFolder) el.classList.remove('folder-drop'); });
        if (overFolder) { const f = state.nodes.get(overFolder); if (f) f.el.classList.add('folder-drop'); }
        return;
    }
    if (state.selectBoxStart) {
        const x = Math.min(sx, state.selectBoxStart.sx);
        const y = Math.min(sy, state.selectBoxStart.sy);
        const W = Math.abs(sx - state.selectBoxStart.sx);
        const H = Math.abs(sy - state.selectBoxStart.sy);
        selectBox.style.cssText = `left:${x}px;top:${y}px;width:${W}px;height:${H}px;display:block`;
        const wb = {
            x1: screenToWorld(x,y).x,   y1: screenToWorld(x,y).y,
            x2: screenToWorld(x+W,y+H).x, y2: screenToWorld(x+H,y+H).y
        };
        state.nodes.forEach((node, id) => {
            const d = node.data;
            const inside = d.position.x < wb.x2 && d.position.x+(d.size?.w||200) > wb.x1 &&
                           d.position.y < wb.y2 && d.position.y+(d.size?.h||120) > wb.y1;
            inside ? selectNode(id) : deselectNode(id);
        });
    }
    if (state.connectingFrom) {
        const world = screenToWorld(sx, sy);
        const src   = state.nodes.get(state.connectingFrom.nodeId);
        if (src) {
            const sp = getPortPosition(state.connectingFrom.nodeId, state.connectingFrom.side);
            const d  = makeEdgePath(sp, state.connectingFrom.side, world, null, 0);
            edgePreview.setAttribute('d', d);
            edgePreview.style.display = '';
        }
    }
}

function onCanvasMouseup(e) {
    if (state.drawing) { finishStroke(); }
    state.erasing = false;
    canvasArea.style.cursor = toolCursor(state.currentTool);
    state.isPanning = false;
    state.panStart  = null;
    if (state.dragNode && state.dragMoved) {
        const draggedIds = state.dragGroup ? [...state.dragGroup.keys()] : [state.dragNode];
        // Did we drop onto a folder? If so, file the dragged (non-folder) nodes.
        const folderId = findFolderUnder(state.dragNode, draggedIds);
        if (folderId) {
            draggedIds.forEach(nid => { const n = state.nodes.get(nid); if (n && n.data.type !== 'folder') fileNodeIntoFolder(nid, folderId); });
        } else if (state.dragGroup) {
            state.dragGroup.forEach((start, gid) => { const n = state.nodes.get(gid); if (n) saveNodePosition(gid, n.data.position, start); });
        } else {
            const node = state.nodes.get(state.dragNode);
            if (node) saveNodePosition(state.dragNode, node.data.position, state.dragStartPos);
        }
    }
    document.querySelectorAll('.space-node.folder-drop').forEach(el => el.classList.remove('folder-drop'));
    state.dragGroup  = null;
    state.dragNode   = null;
    state.dragOffset = null;
    state.dragMoved  = false;
    if (state.selectBoxStart) { selectBox.style.display = 'none'; state.selectBoxStart = null; }
    if (edgePreview && !state.connectingFrom) edgePreview.style.display = 'none';
}

canvasArea.addEventListener('dblclick', (e) => {
    if (state.readOnly) return;
    if (state.currentTool !== 'select') return;
    const isBack = e.target === canvasArea || e.target === canvasWorld || e.target === nodesLayer;
    if (!isBack) return;
    const rect  = canvasArea.getBoundingClientRect();
    const world = screenToWorld(e.clientX - rect.left, e.clientY - rect.top);
    createNoteAtPos(world.x - 90, world.y - 50);
});

canvasArea.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    showContextMenu(e.clientX, e.clientY, null);
});

// ══════════════════════════════════════════════════════
// NODES
// ══════════════════════════════════════════════════════

function createNoteAtPos(x, y, data = {}) {
    if (state.readOnly) { showToast('Read-only — viewing mode', 'error'); return; }
    return saveAndCreateNode({
        type:     'note',
        title:    data.title   || 'Note',
        content:  data.content || '',
        position: { x, y },
        size:     { w: data.w || 200, h: data.h || 120 },
        color:    data.color   || '',
        spaceId:  state.spaceId,
        metadata: { createdBy: state.user?._id, createdAt: new Date().toISOString() }
    });
}

async function saveAndCreateNode(nodeData) {
    if (state.readOnly) return null;
    showUpdating();
    try {
        const res  = await apiFetch(`${API_BASE}/spaces/${state.spaceId}/nodes`, 'POST', nodeData);
        const saved = await res.json();
        createNodeElement(saved, true);
        updateCanvasHint();
        pushUndo({ type: 'create-node', nodeId: saved._id, data: saved });
        emitNodeCreate(saved);
        return saved;
    } catch (e) {
        // Offline / server down — do NOT create a phantom node; leave canvas in its prior state
        showToast(isOffline ? 'No connection — change reverted' : 'Failed to create node', 'error');
        return null;
    } finally { hideUpdating(); }
}

function createNodeElement(data, animate = false) {
    const id = data._id;
    if (state.nodes.has(id)) return;

    // Filed inside a folder → keep the data only, don't render on the canvas
    if (data.parentId) {
        state.filed.set(id, { ...data });
        updateFolderCount(String(data.parentId));
        return;
    }

    const el = document.createElement('div');
    el.className = 'space-node'
        + (data.type === 'ai-generated' ? ' ai-node' : '')
        + (data.type === 'folder' ? ' folder-node' : '')
        + (data.color ? ` color-${data.color}` : '');
    el.dataset.id = id;
    el.style.cssText = `left:${data.position.x}px;top:${data.position.y}px;` +
                       `width:${data.size?.w||200}px;height:${data.size?.h||120}px;z-index:${data.zIndex||1}`;

    const createdAt = data.metadata?.createdAt
        ? new Date(data.metadata.createdAt).toLocaleDateString('ru-RU')
        : new Date().toLocaleDateString('ru-RU');

    el.innerHTML = data.type === 'folder'
        ? buildFolderNodeHTML(data, createdAt)
        : data.type === 'file'
        ? buildFileNodeHTML(data, createdAt)
        : buildNoteNodeHTML(data, createdAt);

    // Port handles — work in ANY tool mode (Stage 1 fix)
    ['top','right','bottom','left'].forEach(side => {
        const port = document.createElement('div');
        port.className = `node-port ${side}`;
        port.dataset.nodeId = id;
        port.dataset.side   = side;
        port.addEventListener('mousedown', onPortMousedown);
        el.appendChild(port);
    });

    // Resize handle (mouse + touch)
    const rh = document.createElement('div');
    rh.className = 'node-resize';
    rh.addEventListener('mousedown', onResizeMousedown);
    rh.addEventListener('touchstart', onResizeMousedown, { passive: false });
    el.appendChild(rh);

    el.addEventListener('mousedown', onNodeMousedown);
    el.addEventListener('contextmenu', (e) => {
        e.preventDefault(); e.stopPropagation();
        if (!state.selected.has(id)) {
            state.selected.forEach(s => deselectNode(s));
            state.selected.clear();
            selectNode(id);
        }
        showContextMenu(e.clientX, e.clientY, id);
    });

    if (animate) {
        el.style.opacity = '0';
        el.style.transform = 'scale(0.9)';
        el.style.transition = 'opacity 0.2s ease, transform 0.2s ease';
        requestAnimationFrame(() => { el.style.opacity=''; el.style.transform=''; });
        setTimeout(() => el.style.transition = '', 300);
    }

    nodesLayer.appendChild(el);
    state.nodes.set(id, { el, data: { ...data } });
    if (state.readOnly) setNodeEditable(el, false);
}

function buildNoteNodeHTML(data, createdAt) {
    const isAI  = data.type === 'ai-generated';
    const icon = isAI
        ? `<svg class="node-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M12 2a4 4 0 100 8 4 4 0 000-8zM4 20c0-4 3.6-7 8-7s8 3 8 7"/></svg>`
        : `<svg class="node-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="3" width="18" height="18"/><path d="M7 8h10M7 12h10M7 16h6"/></svg>`;
    return `<div class="node-card">
        <div class="node-header">
            ${icon}
            <div class="node-title" contenteditable="true" spellcheck="false"
                 data-node-id="${data._id}"
                 onblur="onNodeTitleBlur(this)"
                 onclick="event.stopPropagation()"
                 onkeydown="if(event.key==='Enter'){event.preventDefault();this.blur()}">${escHtml(data.title||'Note')}</div>
            <div class="node-type-badge">${isAI?'AI':'NOTE'}</div>
        </div>
        <div class="node-body ${data.content?'':'empty'}" contenteditable="true"
             data-node-id="${data._id}"
             onblur="onNodeContentBlur(this)"
             oninput="onNodeContentInput(this)"
             onclick="stopPropIfEditing(event)"
             onfocus="onNodeContentFocus(this)">${escHtml(data.content||'')}</div>
        <div class="node-footer">
            <div class="node-date">${createdAt}</div>
            <div class="node-actions">
                <button class="node-action-btn" onclick="openNodeEditModal('${data._id}')" title="Edit">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
                </button>
                <button class="node-action-btn" onclick="pinNodeToAI('${data._id}')" title="Pin to AI">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg>
                </button>
                <button class="node-action-btn danger" onclick="deleteNode('${data._id}')" title="Delete">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M10 11v6"/><path d="M14 11v6"/></svg>
                </button>
            </div>
        </div>
    </div>`;
}

function buildFileNodeHTML(data, createdAt) {
    const ext  = data.fileRef?.ext  || 'file';
    const name = data.fileRef?.name || 'file';
    const url  = data.fileRef?.url  || '#';
    const dlUrl = `/api/space/nodes/${data._id}/download?token=${encodeURIComponent(state.token || '')}`;
    return `<div class="node-card file-card">
        <div class="node-header">
            <svg class="node-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M13 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V9z"/><polyline points="13 2 13 9 20 9"/></svg>
            <div class="node-title" contenteditable="true" spellcheck="false"
                 data-node-id="${data._id}"
                 onblur="onNodeTitleBlur(this)"
                 onclick="event.stopPropagation()"
                 onkeydown="if(event.key==='Enter'){event.preventDefault();this.blur()}">${escHtml(data.title||name)}</div>
            <div class="node-type-badge">FILE</div>
        </div>
        <div class="node-file-preview">
            ${buildFilePreviewHTML(ext, name, url, data._id)}
        </div>
        <div class="node-footer">
            <div class="node-date">${createdAt}</div>
            <div class="node-actions">
                <a class="node-action-btn" href="${dlUrl}" title="Download" onclick="event.stopPropagation()">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
                </a>
                <button class="node-action-btn" onclick="pinNodeToAI('${data._id}')" title="Pin to AI">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg>
                </button>
                <button class="node-action-btn danger" onclick="deleteNode('${data._id}')" title="Delete">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M10 11v6"/><path d="M14 11v6"/></svg>
                </button>
            </div>
        </div>
    </div>`;
}

// ── Folders ──
const FOLDER_ICON = '<path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z"/>';

function buildFolderNodeHTML(data, createdAt) {
    const count = folderChildCount(data._id);
    return `<div class="node-card">
        <div class="node-header">
            <svg class="node-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">${FOLDER_ICON}</svg>
            <div class="node-title" contenteditable="true" spellcheck="false"
                 data-node-id="${data._id}"
                 onblur="onNodeTitleBlur(this)"
                 onclick="event.stopPropagation()"
                 onkeydown="if(event.key==='Enter'){event.preventDefault();this.blur()}">${escHtml(data.title||'Folder')}</div>
            <div class="node-type-badge">FOLDER</div>
        </div>
        <div class="folder-body" onclick="openFolder('${data._id}')" onmousedown="event.stopPropagation()">
            <div class="folder-icon-big"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">${FOLDER_ICON}</svg></div>
            <div class="folder-count" data-folder-count="${data._id}">${count} item${count===1?'':'s'}</div>
            <button class="folder-open-btn">Open</button>
        </div>
        <div class="node-footer">
            <div class="node-date">${createdAt}</div>
            <div class="node-actions">
                <button class="node-action-btn danger" onclick="deleteNode('${data._id}')" title="Delete">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M10 11v6"/><path d="M14 11v6"/></svg>
                </button>
            </div>
        </div>
    </div>`;
}

function createFolder() {
    if (state.readOnly) { showToast('Read-only — viewing mode', 'error'); return; }
    const c = getCenterViewport();
    saveAndCreateNode({
        type: 'folder', title: 'Folder', content: '',
        position: { x: c.x - 90, y: c.y - 70 }, size: { w: 190, h: 170 }, color: '',
        spaceId: state.spaceId,
        metadata: { createdBy: state.user?._id, createdAt: new Date().toISOString() }
    });
}

// How many nodes are filed inside a given folder
function folderChildCount(folderId) {
    let n = 0;
    state.filed.forEach(d => { if (String(d.parentId) === String(folderId)) n++; });
    return n;
}
function updateFolderCount(folderId) {
    const el = document.querySelector(`[data-folder-count="${folderId}"]`);
    if (el) { const c = folderChildCount(folderId); el.textContent = `${c} item${c === 1 ? '' : 's'}`; }
}

// Find a folder node whose rect contains the dropped node's centre (for filing)
function findFolderUnder(nodeId, excludeIds) {
    const dragged = state.nodes.get(nodeId);
    if (!dragged) return null;
    const cx = dragged.data.position.x + (dragged.data.size?.w || 200) / 2;
    const cy = dragged.data.position.y + (dragged.data.size?.h || 120) / 2;
    for (const [fid, f] of state.nodes) {
        if (f.data.type !== 'folder' || excludeIds.includes(fid)) continue;
        const x = f.data.position.x, y = f.data.position.y, w = f.data.size?.w || 190, h = f.data.size?.h || 170;
        if (cx >= x && cx <= x + w && cy >= y && cy <= y + h) return fid;
    }
    return null;
}

// File a node into a folder (removes it from the canvas, syncs to everyone)
async function fileNodeIntoFolder(nodeId, folderId) {
    const node = state.nodes.get(nodeId);
    if (!node || node.data.type === 'folder') return;
    node.data.parentId = folderId;
    // remove connected edges from view (they don't apply while filed)
    state.edges.forEach((e, eid) => {
        if (e.data.sourceNodeId === nodeId || e.data.targetNodeId === nodeId) { e.el.remove(); state.edges.delete(eid); physics.edges.delete(eid); }
    });
    node.el.remove();
    state.nodes.delete(nodeId);
    state.filed.set(nodeId, { ...node.data });
    updateFolderCount(folderId);
    showToast('Filed into folder', 'success');
    try {
        await apiFetch(`${API_BASE}/spaces/${state.spaceId}/nodes/${nodeId}`, 'PATCH', { parentId: folderId });
        if (ws) ws.emit('node:update', { spaceId: state.spaceId, nodeId, updates: { parentId: folderId }, userId: state.user?._id });
    } catch { queueNodeEdit(nodeId, { parentId: folderId }); }
}

// Take a node back out of its folder onto the canvas
async function ejectNode(nodeId) {
    const data = state.filed.get(nodeId);
    if (!data) return;
    const folderId = data.parentId;
    const folder = state.nodes.get(String(folderId));
    const pos = folder
        ? { x: folder.data.position.x + (folder.data.size?.w || 190) + 30, y: folder.data.position.y }
        : (data.position || { x: 100, y: 100 });
    data.parentId = null; data.position = pos;
    state.filed.delete(nodeId);
    createNodeElement({ ...data, parentId: null }, true);
    updateFolderCount(folderId);
    if (folder) updateFolderCount(folderId);
    renderFolderContents(folderId);
    try {
        await apiFetch(`${API_BASE}/spaces/${state.spaceId}/nodes/${nodeId}`, 'PATCH', { parentId: null, position: pos });
        if (ws) ws.emit('node:update', { spaceId: state.spaceId, nodeId, updates: { parentId: null, position: pos }, userId: state.user?._id });
    } catch { queueNodeEdit(nodeId, { parentId: null, position: pos }); }
}

let openFolderId = null;
function openFolder(folderId) {
    openFolderId = folderId;
    const folder = state.nodes.get(folderId);
    $('folder-modal-name').textContent = (folder?.data.title || 'Folder');
    $('folder-modal').classList.add('show');
    renderFolderContents(folderId);
}
function renderFolderContents(folderId) {
    if (openFolderId !== folderId) return;
    const listEl = $('folder-list');
    const items = [];
    state.filed.forEach((d, id) => { if (String(d.parentId) === String(folderId)) items.push({ id, d }); });
    if (!items.length) { listEl.innerHTML = '<div class="trash-empty">// empty — drag files onto the folder to fill it</div>'; return; }
    listEl.innerHTML = '';
    items.forEach(({ id, d }) => {
        const kind = d.type === 'file' ? (d.fileRef?.ext || 'file').toUpperCase() : (d.type === 'ai-generated' ? 'AI' : 'NOTE');
        const row = document.createElement('div');
        row.className = 'trash-row';
        const dl = d.type === 'file'
            ? `<a class="folder-eject-btn" href="/api/space/nodes/${id}/download?token=${encodeURIComponent(state.token || '')}" title="Download">↓</a>` : '';
        row.innerHTML = `
            <div class="trash-info">
                <span class="trash-kind">${escHtml(kind)}</span>
                <span class="trash-title">${escHtml(d.title || d.fileRef?.name || '(untitled)')}</span>
            </div>
            <div class="trash-actions">
                ${dl}
                ${state.readOnly ? '' : '<button class="folder-eject-btn">Eject</button>'}
            </div>`;
        const eject = row.querySelector('.folder-eject-btn:not(a)') || (state.readOnly ? null : row.querySelector('.trash-actions button'));
        if (eject && eject.textContent === 'Eject') eject.onclick = () => ejectNode(id);
        listEl.appendChild(row);
    });
}

// SVG path markup for each file-type category (clean Lucide-style, 24×24, stroke)
const FILE_ICON_PATHS = {
    doc:     '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="M16 13H8"/><path d="M16 17H8"/><path d="M10 9H8"/>',
    table:   '<rect x="3" y="3" width="18" height="18"/><path d="M3 9h18"/><path d="M3 15h18"/><path d="M9 3v18"/><path d="M15 3v18"/>',
    ppt:     '<path d="M2 3h20"/><path d="M21 3v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V3"/><path d="m7 21 5-4 5 4"/>',
    pdf:     '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="M16 13H8"/><path d="M16 17H8"/>',
    archive: '<rect x="2" y="4" width="20" height="5"/><path d="M4 9v9a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9"/><path d="M10 13h4"/>',
    code:    '<polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/>',
    audio:   '<path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>',
    video:   '<path d="m22 8-6 4 6 4V8Z"/><rect x="2" y="6" width="14" height="12" rx="2"/>',
    image:   '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.1-3.1a2 2 0 0 0-2.8 0L6 21"/>',
    file:    '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/>'
};

// Resolve a file extension → { cat, color }
function fileCategory(ext) {
    const LANG_COLORS = { py:'#3b82f6', js:'#facc15', ts:'#60a5fa', json:'#4ade80', html:'#f97316', css:'#c084fc', go:'#34d399', rs:'#fb923c', sh:'#94a3b8', java:'#f97316', cpp:'#60a5fa', c:'#60a5fa', php:'#a78bfa', rb:'#ef4444', xml:'#94a3b8', yaml:'#94a3b8' };
    const map = {
        docx:['doc','#2563eb'], doc:['doc','#2563eb'], rtf:['doc','#2563eb'], odt:['doc','#2563eb'],
        xls:['table','#16a34a'], xlsx:['table','#16a34a'], csv:['table','#16a34a'], ods:['table','#16a34a'],
        ppt:['ppt','#ea580c'], pptx:['ppt','#ea580c'], odp:['ppt','#ea580c'],
        pdf:['pdf','#ef4444'],
        zip:['archive','#d97706'], rar:['archive','#d97706'], '7z':['archive','#d97706'], tar:['archive','#d97706'], gz:['archive','#d97706'],
    };
    if (map[ext]) return { cat: map[ext][0], color: map[ext][1] };
    if (LANG_COLORS[ext]) return { cat: 'code', color: LANG_COLORS[ext] };
    return { cat: 'file', color: '' };
}

function fileBadgeHTML(ext, EXT, name) {
    const { cat, color } = fileCategory(ext);
    const path = FILE_ICON_PATHS[cat] || FILE_ICON_PATHS.file;
    const colorStyle = color ? ` style="color:${color}"` : '';
    return `<div class="file-code-icon">
        <div class="file-type-badge"${colorStyle}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4">${path}</svg>
        </div>
        <div class="file-ext-tag"${colorStyle}>.${EXT}</div>
    </div>`;
}

// Fallback when an image fails to load → show the type badge instead
function fileImgFallback(img) {
    const ext = img.dataset.ext || 'file';
    const name = img.dataset.fname || 'file';
    if (img.parentElement) img.parentElement.innerHTML = fileBadgeHTML(ext, ext.toUpperCase(), name);
}

function buildFilePreviewHTML(ext, name, url, nodeId) {
    const EXT = ext.toUpperCase();
    const imgs   = ['png','jpg','jpeg','gif','webp','svg','bmp','avif'];
    const videos = ['mp4','webm','m4v','ogv','mov'];
    const audios = ['mp3','wav','ogg','m4a','flac','aac','opus'];
    const texts  = ['txt','md','log','env','ini'];

    if (imgs.includes(ext)) {
        return `<img src="${url}" alt="${escHtml(name)}" class="file-img-preview" data-ext="${escHtml(ext)}" data-fname="${escHtml(name)}" onerror="fileImgFallback(this)">`;
    }
    if (videos.includes(ext)) {
        return `<video class="file-media-preview" src="${url}" controls preload="metadata" playsinline
                       onclick="event.stopPropagation()" onmousedown="event.stopPropagation()"></video>`;
    }
    if (audios.includes(ext)) {
        return `<div class="file-audio-wrap">
            <div class="file-type-badge" style="color:#c084fc"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4">${FILE_ICON_PATHS.audio}</svg></div>
            <audio class="file-audio-preview" src="${url}" controls preload="metadata"
                   onclick="event.stopPropagation()" onmousedown="event.stopPropagation()"></audio>
        </div>`;
    }
    if (texts.includes(ext)) {
        return `<div class="file-txt-preview file-txt-placeholder" data-nodeid="${nodeId}"><div class="file-ext-tag">.${EXT}</div><div class="file-txt-content">Loading...</div></div>`;
    }
    return fileBadgeHTML(ext, EXT, name);
}

// Load .txt previews — via authenticated server proxy (fixes Loading... stuck)
function loadTextPreviews() {
    document.querySelectorAll('.file-txt-placeholder').forEach(async el => {
        const nodeId = el.dataset.nodeid;
        if (!nodeId || el.dataset.loaded) return;
        el.dataset.loaded = 'true';
        const contentEl = el.querySelector('.file-txt-content');
        if (!contentEl) return;
        try {
            const res = await apiFetch(`${API_BASE}/nodes/${nodeId}/preview`);
            if (res.ok) {
                const text = await res.text();
                const lines = text.split('\n').slice(0, 10).join('\n');
                contentEl.textContent = lines || '(empty file)';
            } else {
                contentEl.textContent = '(preview unavailable)';
            }
        } catch { contentEl.textContent = '(preview unavailable)'; }
    });
}

function onNodeMousedown(e) {
    if (e.button !== 0) return;
    if (state.readOnly) return; // readers can't select/drag
    // In draw/eraser mode let the event bubble to the canvas so we can paint over nodes
    if (state.currentTool === 'draw' || state.currentTool === 'eraser') return;
    if (e.target.contentEditable === 'true' || e.target.closest('[contenteditable]')) return;
    if (e.target.closest('.node-action-btn') || e.target.closest('a')) return;
    if (e.target.classList.contains('node-port') || e.target.classList.contains('node-resize')) return;
    e.stopPropagation();
    const el = e.currentTarget;
    const id = el.dataset.id;
    if (!e.shiftKey && !state.selected.has(id)) {
        state.selected.forEach(s => deselectNode(s));
        state.selected.clear();
    }
    selectNode(id);
    const canvasRect = canvasArea.getBoundingClientRect();
    state.dragNode   = id;
    state.dragOffset = {
        x: (e.clientX - canvasRect.left) - (parseInt(el.style.left) * state.viewport.zoom + state.viewport.x),
        y: (e.clientY - canvasRect.top)  - (parseInt(el.style.top)  * state.viewport.zoom + state.viewport.y)
    };
    state.dragStartPos = { ...state.nodes.get(id).data.position };
    state.dragMoved = false;
    // If several nodes are selected, drag them together (record their start positions)
    state.dragGroup = null;
    if (state.selected.size > 1 && state.selected.has(id)) {
        state.dragGroup = new Map();
        state.selected.forEach(sid => { const sn = state.nodes.get(sid); if (sn) state.dragGroup.set(sid, { ...sn.data.position }); });
    }
    const maxZ = Math.max(1, ...Array.from(state.nodes.values()).map(n => parseInt(n.el.style.zIndex)||1));
    el.style.zIndex = maxZ + 1;
    state.nodes.get(id).data.zIndex = maxZ + 1;
}

function moveNode(id, x, y) {
    const node = state.nodes.get(id);
    if (!node) return;
    node.data.position = { x, y };
    node.el.style.left = x + 'px';
    node.el.style.top  = y + 'px';
    updateEdgesForNode(id);
    if (ws) ws.emit('node:move', { spaceId: state.spaceId, nodeId: id, x, y, userId: state.user?._id });
}

function selectNode(id)   { state.selected.add(id);    const n=state.nodes.get(id); if(n) n.el.classList.add('selected'); }
function deselectNode(id) { state.selected.delete(id); const n=state.nodes.get(id); if(n) n.el.classList.remove('selected'); }
function selectAll()      { state.nodes.forEach((_,id) => selectNode(id)); hideContextMenu(); }

async function deleteNode(id) {
    if (state.readOnly) { showToast('Read-only — viewing mode', 'error'); return; }
    const node = state.nodes.get(id);
    if (!node) return;
    // Deleting a folder → eject its contents back onto the canvas first
    if (node.data.type === 'folder') {
        [...state.filed.entries()].forEach(([cid, d]) => { if (String(d.parentId) === String(id)) ejectNode(cid); });
    }
    pushUndo({ type: 'delete-node', nodeId: id, data: { ...node.data } });
    node.el.style.transition = 'opacity 0.15s, transform 0.15s';
    node.el.style.opacity = '0';
    node.el.style.transform = 'scale(0.88)';
    setTimeout(() => node.el.remove(), 150);
    state.nodes.delete(id);
    state.selected.delete(id);
    state.edges.forEach((edge, eid) => {
        if (edge.data.sourceNodeId === id || edge.data.targetNodeId === id) deleteEdge(eid);
    });
    updateCanvasHint();
    const savedData = { ...node.data };
    showUpdating();
    try {
        await apiFetch(`${API_BASE}/spaces/${state.spaceId}/nodes/${id}`, 'DELETE');
        if (ws) ws.emit('node:delete', { spaceId: state.spaceId, nodeId: id, userId: state.user?._id });
    } catch {
        // Offline / failed — restore the node so the canvas reflects the real (server) state
        if (!state.nodes.has(id)) { createNodeElement(savedData, true); updateCanvasHint(); setTimeout(loadTextPreviews, 200); }
        state.undoStack = state.undoStack.filter(a => !(a.type === 'delete-node' && a.nodeId === id));
        showToast('No connection — delete reverted', 'error');
    } finally { hideUpdating(); }
}

// Offline edit queue — changes are kept locally and replayed on reconnect,
// so a failed/slow request never throws away what the user typed.
const pendingNodeEdits = new Map();  // nodeId → merged updates awaiting sync
function queueNodeEdit(id, updates) {
    pendingNodeEdits.set(id, Object.assign(pendingNodeEdits.get(id) || {}, updates));
}
async function flushPendingEdits() {
    if (!pendingNodeEdits.size || !state.spaceId) return;
    for (const [id, updates] of [...pendingNodeEdits.entries()]) {
        try {
            await apiFetch(`${API_BASE}/spaces/${state.spaceId}/nodes/${id}`, 'PATCH', updates);
            if (ws) ws.emit('node:update', { spaceId: state.spaceId, nodeId: id, updates, userId: state.user?._id });
            pendingNodeEdits.delete(id);
        } catch { break; } // still offline → keep the rest queued
    }
}

async function saveNodePosition(id, position, prevPosition) {
    if (state.readOnly) return;
    showUpdating();
    try {
        await apiFetch(`${API_BASE}/spaces/${state.spaceId}/nodes/${id}`, 'PATCH', { position });
    } catch {
        // Keep the local position and queue it — it will sync on reconnect
        queueNodeEdit(id, { position });
    } finally { hideUpdating(); }
}

async function saveNodeData(id, updates) {
    if (state.readOnly) return;
    const node = state.nodes.get(id);
    if (!node) return;
    Object.assign(node.data, updates);  // optimistic local update (kept even if offline)
    showUpdating();
    try {
        await apiFetch(`${API_BASE}/spaces/${state.spaceId}/nodes/${id}`, 'PATCH', updates);
        if (ws) ws.emit('node:update', { spaceId: state.spaceId, nodeId: id, updates, userId: state.user?._id });
    } catch {
        // Do NOT revert (that lost the user's text). Keep it locally and queue for retry.
        queueNodeEdit(id, updates);
    } finally { hideUpdating(); }
}

// Re-render a single node field from data (used for offline revert + edits)
function renderNodeField(node, key, value) {
    const el = node.el;
    const id = el.dataset.id;
    if (key === 'title') {
        const t = el.querySelector('.node-title');
        if (t && document.activeElement !== t) t.textContent = value || '';
    } else if (key === 'content') {
        const b = el.querySelector('.node-body');
        if (b && document.activeElement !== b) { b.textContent = value || ''; b.classList.toggle('empty', !value); }
    } else if (key === 'color') {
        el.className = el.className.replace(/\bcolor-\w+\b/g, '').trim();
        if (value) el.classList.add(`color-${value}`);
        updateEdgesForNode(id);
    } else if (key === 'size' && value) {
        el.style.width  = (value.w || 200) + 'px';
        el.style.height = (value.h || 120) + 'px';
        updateEdgesForNode(id);
    }
}

function onNodeContentFocus(el) {
    // notify others we're editing this node (Stage 2)
    const id = el.dataset.nodeId;
    if (ws && state.user) {
        ws.emit('node:editing', { spaceId: state.spaceId, nodeId: id, userId: state.user._id, color: state.user.color });
    }
}

// Inline title editing (note + file nodes)
function onNodeTitleBlur(el) {
    const id    = el.dataset.nodeId;
    const title = el.textContent.trim() || 'Untitled';
    el.textContent = title; // normalize
    const node = state.nodes.get(id);
    if (node) node.data.title = title;
    saveNodeData(id, { title });
}

function onNodeContentBlur(el) {
    const id      = el.dataset.nodeId;
    const content = el.textContent || '';
    el.classList.toggle('empty', !content);
    saveNodeData(id, { content });
    // clear editing state
    if (ws) ws.emit('node:editing-stop', { spaceId: state.spaceId, nodeId: id, userId: state.user?._id });
    const debTimer = state.contentDebounce.get(id);
    if (debTimer) { clearTimeout(debTimer); state.contentDebounce.delete(id); }
}

function onNodeContentInput(el) {
    const id      = el.dataset.nodeId;
    const content = el.textContent || '';
    el.classList.toggle('empty', !content);
    // Debounced save + WS emit for real-time (Stage 2)
    clearTimeout(state.contentDebounce.get(id));
    const t = setTimeout(() => {
        state.contentDebounce.delete(id);
        const node = state.nodes.get(id);
        if (node) {
            node.data.content = content;
            if (ws) ws.emit('node:update', {
                spaceId: state.spaceId, nodeId: id,
                updates: { content }, userId: state.user?._id
            });
        }
    }, 400);
    state.contentDebounce.set(id, t);
}

function stopPropIfEditing(e) { e.stopPropagation(); }

// Works for both mouse and touch (tablets can resize via the corner handle)
function onResizeMousedown(e) {
    if (state.readOnly) return;
    e.stopPropagation();
    if (e.cancelable) e.preventDefault();
    const pt = (ev) => (ev.touches && ev.touches[0]) ? ev.touches[0] : (ev.changedTouches && ev.changedTouches[0]) ? ev.changedTouches[0] : ev;
    const s = pt(e);
    const nodeEl = e.currentTarget.parentElement;
    const id     = nodeEl.dataset.id;
    const startX = s.clientX, startY = s.clientY;
    const startW = parseInt(nodeEl.style.width), startH = parseInt(nodeEl.style.height);
    let lastEmit = 0;
    function onMove(ev) {
        const p  = pt(ev);
        const z  = state.viewport.zoom;
        const w  = Math.max(160, startW + (p.clientX - startX) / z);
        const h  = Math.max(80,  startH + (p.clientY - startY) / z);
        nodeEl.style.width  = w + 'px';
        nodeEl.style.height = h + 'px';
        const node = state.nodes.get(id);
        if (node) node.data.size = { w, h };
        updateEdgesForNode(id);
        if (ev.cancelable) ev.preventDefault();
        const now = Date.now();
        if (ws && now - lastEmit > 60) {
            lastEmit = now;
            ws.emit('node:update', { spaceId: state.spaceId, nodeId: id, updates: { size: { w, h } }, userId: state.user?._id });
        }
    }
    function onUp() {
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup',  onUp);
        window.removeEventListener('touchmove', onMove);
        window.removeEventListener('touchend',  onUp);
        const node = state.nodes.get(id);
        if (node) saveNodeData(id, { size: node.data.size });
    }
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup',   onUp);
    window.addEventListener('touchmove', onMove, { passive: false });
    window.addEventListener('touchend',  onUp);
}

// ══════════════════════════════════════════════════════
// EDGES & CONNECTIONS  (Stage 1 port fix + Stage 3 routing)
// ══════════════════════════════════════════════════════

// Port mousedown — works in ANY tool mode (Stage 1 fix)
function onPortMousedown(e) {
    if (state.readOnly) return;
    e.stopPropagation();
    e.preventDefault();
    const nodeId = e.currentTarget.dataset.nodeId;
    const side   = e.currentTarget.dataset.side;

    if (!state.connectingFrom) {
        // Start connection
        state.connectingFrom = { nodeId, side };
        const node = state.nodes.get(nodeId);
        if (node) node.el.classList.add('connecting-source');
        if (edgePreview) { edgePreview.style.display = ''; }
    } else {
        // Complete connection
        const from = state.connectingFrom;
        state.connectingFrom = null;
        document.querySelectorAll('.space-node.connecting-source').forEach(el => el.classList.remove('connecting-source'));
        if (edgePreview) edgePreview.style.display = 'none';

        if (from.nodeId !== nodeId) {
            createConnection(from.nodeId, nodeId, from.side, side);
        }
    }
}

async function createConnection(sourceId, targetId, sourceSide, targetSide) {
    if (state.readOnly) return;
    // avoid duplicates
    let exists = false;
    state.edges.forEach(e => {
        if ((e.data.sourceNodeId===sourceId && e.data.targetNodeId===targetId) ||
            (e.data.sourceNodeId===targetId && e.data.targetNodeId===sourceId)) exists = true;
    });
    if (exists) { showToast('Connection already exists'); return; }
    const edgeData = {
        spaceId: state.spaceId,
        sourceNodeId: sourceId, targetNodeId: targetId,
        sourceSide, targetSide,
        style: 'animated', tension: 0.5
    };
    showUpdating();
    try {
        const res  = await apiFetch(`${API_BASE}/spaces/${state.spaceId}/edges`, 'POST', edgeData);
        const saved = await res.json();
        createEdgeElement(saved, true);
        if (ws) ws.emit('edge:create', { spaceId: state.spaceId, edge: saved, userId: state.user?._id });
        pushUndo({ type: 'create-edge', edgeId: saved._id, data: saved });
    } catch { showToast('Failed to create connection', 'error'); }
    finally { hideUpdating(); }
}

function createEdgeElement(data, animate = false) {
    const id = data._id;
    if (state.edges.has(id)) return;

    const g       = document.createElementNS('http://www.w3.org/2000/svg','g');
    g.dataset.edgeId = id;

    const hitPath = document.createElementNS('http://www.w3.org/2000/svg','path');
    hitPath.setAttribute('stroke','transparent');
    hitPath.setAttribute('stroke-width','14');
    hitPath.setAttribute('fill','none');
    hitPath.style.cursor = 'pointer';

    const path = document.createElementNS('http://www.w3.org/2000/svg','path');
    path.className.baseVal = 'edge-path' + (data.style==='animated' ? ' animated' : '');

    g.addEventListener('click', e => { e.stopPropagation(); deleteEdge(id); });

    g.appendChild(hitPath);
    g.appendChild(path);
    edgesGroup.appendChild(g);

    state.edges.set(id, { el: g, path, hitPath, data: { ...data } });
    physics.edges.set(id, { vel: 0, offset: 0 });
    updateEdgePath(id);
}

// ── Stage 3: port-based edge routing ──

function getPortPosition(nodeId, side) {
    const node = state.nodes.get(nodeId);
    if (!node) return { x: 0, y: 0 };
    const { x, y } = node.data.position;
    const w = node.data.size?.w || 200;
    const h = node.data.size?.h || 120;
    switch (side) {
        case 'top':    return { x: x + w/2, y };
        case 'right':  return { x: x + w,   y: y + h/2 };
        case 'bottom': return { x: x + w/2, y: y + h };
        case 'left':   return { x,           y: y + h/2 };
        default:       return { x: x + w/2, y: y + h/2 };
    }
}

function getAutoSides(srcId, tgtId) {
    const sn = state.nodes.get(srcId), tn = state.nodes.get(tgtId);
    if (!sn || !tn) return { srcSide: 'right', tgtSide: 'left' };
    const sc = { x: sn.data.position.x + (sn.data.size?.w||200)/2, y: sn.data.position.y + (sn.data.size?.h||120)/2 };
    const tc = { x: tn.data.position.x + (tn.data.size?.w||200)/2, y: tn.data.position.y + (tn.data.size?.h||120)/2 };
    const dx = tc.x - sc.x, dy = tc.y - sc.y;
    let srcSide, tgtSide;
    if (Math.abs(dx) >= Math.abs(dy)) {
        srcSide = dx >= 0 ? 'right' : 'left';
        tgtSide = dx >= 0 ? 'left'  : 'right';
    } else {
        srcSide = dy >= 0 ? 'bottom' : 'top';
        tgtSide = dy >= 0 ? 'top'    : 'bottom';
    }
    return { srcSide, tgtSide };
}

function getControlPoint(pos, side, dist) {
    switch (side) {
        case 'top':    return { x: pos.x,        y: pos.y - dist };
        case 'right':  return { x: pos.x + dist, y: pos.y };
        case 'bottom': return { x: pos.x,        y: pos.y + dist };
        case 'left':   return { x: pos.x - dist, y: pos.y };
        default:       return pos;
    }
}

function makeEdgePath(srcPos, srcSide, tgtPos, tgtSide, offset) {
    const dx   = tgtPos.x - srcPos.x, dy = tgtPos.y - srcPos.y;
    const dist = Math.sqrt(dx*dx + dy*dy);
    const ctrl = Math.max(60, Math.min(220, dist * 0.45)) + (offset || 0);
    const cp1  = srcSide ? getControlPoint(srcPos, srcSide, ctrl) : { x: srcPos.x, y: srcPos.y + ctrl };
    const cp2  = tgtSide ? getControlPoint(tgtPos, tgtSide, ctrl) : { x: tgtPos.x, y: tgtPos.y - ctrl };
    return `M${srcPos.x},${srcPos.y} C${cp1.x},${cp1.y} ${cp2.x},${cp2.y} ${tgtPos.x},${tgtPos.y}`;
}

const NODE_COLOR_MAP = {
    white:  'rgba(210,210,210,0.55)',
    blue:   'rgba(96,165,250,0.65)',
    green:  'rgba(74,222,128,0.65)',
    purple: 'rgba(192,132,252,0.65)',
    yellow: 'rgba(250,204,21,0.55)',
    red:    'rgba(239,68,68,0.65)',
};

function getNodeAccentColor(nodeId) {
    const n = state.nodes.get(nodeId);
    if (!n) return null;
    return NODE_COLOR_MAP[n.data.color] || null;
}

function updateEdgePath(id) {
    const edge  = state.edges.get(id);
    if (!edge) return;
    const { sourceNodeId, targetNodeId } = edge.data;
    let { sourceSide, targetSide } = edge.data;

    // Auto sides if not stored
    if (!sourceSide || !targetSide) {
        const auto = getAutoSides(sourceNodeId, targetNodeId);
        sourceSide = auto.srcSide;
        targetSide = auto.tgtSide;
    }
    const sp     = getPortPosition(sourceNodeId, sourceSide);
    const tp     = getPortPosition(targetNodeId, targetSide);
    const phys   = physics.edges.get(id);
    const offset = phys ? phys.offset : 0;
    const d = makeEdgePath(sp, sourceSide, tp, targetSide, offset);
    edge.path.setAttribute('d', d);
    edge.hitPath.setAttribute('d', d);

    // Stage 1 fix: color edge by node color
    const color = getNodeAccentColor(sourceNodeId) || getNodeAccentColor(targetNodeId);
    if (color) {
        edge.path.style.stroke = color;
    } else {
        edge.path.style.stroke = '';  // fallback to CSS default
    }
}


function updateEdgesForNode(nodeId) {
    state.edges.forEach((_, eid) => {
        const e = state.edges.get(eid);
        if (e.data.sourceNodeId === nodeId || e.data.targetNodeId === nodeId) updateEdgePath(eid);
    });
}

async function deleteEdge(id) {
    const edge = state.edges.get(id);
    if (!edge) return;
    edge.el.remove();
    state.edges.delete(id);
    physics.edges.delete(id);
    showUpdating();
    try {
        await apiFetch(`${API_BASE}/spaces/${state.spaceId}/edges/${id}`, 'DELETE');
        if (ws) ws.emit('edge:delete', { spaceId: state.spaceId, edgeId: id, userId: state.user?._id });
    } catch {} finally { hideUpdating(); }
}

// ══════════════════════════════════════════════════════
// SPRING PHYSICS
// ══════════════════════════════════════════════════════

function startPhysicsLoop() {
    const K = 0.02, DAMP = 0.86, MAX = 20;
    function loop() {
        physics.edges.forEach((phys, id) => {
            const edge = state.edges.get(id);
            if (edge && state.dragNode && state.dragMoved) {
                if (edge.data.sourceNodeId===state.dragNode || edge.data.targetNodeId===state.dragNode) {
                    phys.vel += K * (MAX - phys.offset) * 0.5;
                }
            }
            phys.vel   += -K * phys.offset;
            phys.vel   *= DAMP;
            phys.offset += phys.vel;
            if (Math.abs(phys.offset) > 0.05 || Math.abs(phys.vel) > 0.05) updateEdgePath(id);
        });
        physics.animFrame = requestAnimationFrame(loop);
    }
    physics.animFrame = requestAnimationFrame(loop);
}

// ══════════════════════════════════════════════════════
// TOOLS
// ══════════════════════════════════════════════════════

function setTool(tool) {
    state.currentTool = tool;
    document.querySelectorAll('.tool-btn[data-tool]').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.tool === tool);
    });
    canvasArea.style.cursor = toolCursor(tool);
    document.body.classList.toggle('drawing-mode', tool === 'draw' || tool === 'eraser');
    // cancel an in-progress stroke when switching away from drawing
    if (tool !== 'draw' && state.drawing) { state.drawing = null; if (drawPreview) drawPreview.style.display = 'none'; }
    if (tool !== 'eraser') state.erasing = false;
    // cancel connecting if changing tool
    if (tool !== 'connect' && state.connectingFrom) {
        state.connectingFrom = null;
        if (edgePreview) edgePreview.style.display = 'none';
        document.querySelectorAll('.space-node.connecting-source').forEach(el => el.classList.remove('connecting-source'));
    }
}

function triggerFileUpload() { if (state.readOnly) { showToast('Read-only — viewing mode', 'error'); return; } $('file-input').click(); }

// ══════════════════════════════════════════════════════
// FILE UPLOAD (R2)
// ══════════════════════════════════════════════════════

async function handleFileSelect(event) {
    const files = Array.from(event.target.files);
    event.target.value = '';
    let offX = 0;
    for (const f of files) {
        await uploadFileToR2(f, state.pendingDropPos.x + offX, state.pendingDropPos.y);
        offX += 220;
    }
}

async function uploadFileToR2(file, x, y) {
    if (state.readOnly) { showToast('Read-only — viewing mode', 'error'); return; }
    showToast(`Uploading ${file.name}…`);
    showUpdating();
    try {
        const res = await apiFetch(`${API_BASE}/upload/presign`, 'POST', {
            fileName: file.name, fileType: file.type, fileSize: file.size, spaceId: state.spaceId
        });
        const { uploadUrl, publicUrl, r2Key } = await res.json();
        await fetch(uploadUrl, { method: 'PUT', headers: { 'Content-Type': file.type }, body: file });
        const ext = file.name.split('.').pop().toLowerCase();
        await saveAndCreateNode({
            type: 'file', title: file.name, content: '',
            position: { x, y }, size: { w: 190, h: 160 }, color: '',
            fileRef: { r2Key, url: publicUrl, name: file.name, ext, size: file.size, mimeType: file.type },
            spaceId: state.spaceId,
            metadata: { createdBy: state.user?._id, createdAt: new Date().toISOString() }
        });
        showToast(`${file.name} uploaded`, 'success');
        setTimeout(loadTextPreviews, 500);
    } catch (e) {
        showToast(`Upload failed: ${file.name}`, 'error');
    } finally { hideUpdating(); }
}

function setupDragAndDrop() {
    canvasArea.addEventListener('dragover', (e) => {
        e.preventDefault();
        $('drop-overlay').classList.add('show');
        const rect  = canvasArea.getBoundingClientRect();
        state.pendingDropPos = screenToWorld(e.clientX - rect.left, e.clientY - rect.top);
    });
    canvasArea.addEventListener('dragleave', () => $('drop-overlay').classList.remove('show'));
    canvasArea.addEventListener('drop', (e) => {
        e.preventDefault();
        $('drop-overlay').classList.remove('show');
        const rect  = canvasArea.getBoundingClientRect();
        const world = screenToWorld(e.clientX - rect.left, e.clientY - rect.top);
        let offX = 0;
        Array.from(e.dataTransfer.files).forEach(async f => {
            await uploadFileToR2(f, world.x + offX, world.y);
            offX += 220;
        });
    });
}

// ══════════════════════════════════════════════════════
// CONTEXT MENU
// ══════════════════════════════════════════════════════

let ctxTargetNode = null, ctxTargetPos = null;

function showContextMenu(x, y, nodeId) {
    ctxTargetNode = nodeId;
    const rect = canvasArea.getBoundingClientRect();
    ctxTargetPos  = screenToWorld(x - rect.left, y - rect.top);
    const hasSelected = state.selected.size > 0;
    const ro = state.readOnly;
    $('ctx-node-section').style.display  = (nodeId && !ro) ? '' : 'none';
    $('ctx-color-section').style.display = (hasSelected && !ro) ? '' : 'none';
    $('ctx-delete-section').style.display = (hasSelected && !ro) ? '' : 'none';
    const addSection = $('ctx-add-section');
    if (addSection) addSection.style.display = ro ? 'none' : '';
    contextMenu.style.left = Math.min(x, window.innerWidth  - 200) + 'px';
    contextMenu.style.top  = Math.min(y, window.innerHeight - 200) + 'px';
    contextMenu.classList.add('show');
}
function hideContextMenu() { contextMenu.classList.remove('show'); }

function ctxEditNode()       { hideContextMenu(); if (ctxTargetNode) openNodeEditModal(ctxTargetNode); }
function ctxPinToAI()        { hideContextMenu(); if (ctxTargetNode) pinNodeToAI(ctxTargetNode); }
function ctxDuplicateNode()  {
    hideContextMenu();
    if (!ctxTargetNode) return;
    const n = state.nodes.get(ctxTargetNode);
    if (n) createNoteAtPos(n.data.position.x+24, n.data.position.y+24, n.data);
}
function ctxSetColor(color) {
    hideContextMenu();
    state.selected.forEach(id => {
        const n = state.nodes.get(id);
        if (!n) return;
        n.el.className = n.el.className.replace(/\bcolor-\w+\b/g,'').trim();
        if (color) n.el.classList.add(`color-${color}`);
        n.data.color = color;
        saveNodeData(id, { color });
        // Re-render edges so they pick up the new accent color
        updateEdgesForNode(id);
    });
}

function ctxAddNote()          { hideContextMenu(); if (ctxTargetPos) createNoteAtPos(ctxTargetPos.x, ctxTargetPos.y); }
function ctxDeleteSelected()   { hideContextMenu(); [...state.selected].forEach(id => deleteNode(id)); }

document.addEventListener('click', e => { if (!contextMenu.contains(e.target)) hideContextMenu(); });

// Close the canvas switcher dropdown when clicking outside it
document.addEventListener('click', e => {
    const sw = document.querySelector('.canvas-switcher');
    const dd = $('canvas-dropdown');
    if (dd && dd.classList.contains('show') && sw && !sw.contains(e.target)) dd.classList.remove('show');
});

// ══════════════════════════════════════════════════════
// DRAWING (pen / eraser) + COLOR PALETTE
// ══════════════════════════════════════════════════════

// Palette: each entry maps a node colour name to a concrete pen hex.
const PEN_PALETTE = [
    { name: 'white',  hex: '#e5e5e5' },
    { name: 'blue',   hex: '#60a5fa' },
    { name: 'green',  hex: '#4ade80' },
    { name: 'purple', hex: '#c084fc' },
    { name: 'yellow', hex: '#facc15' },
    { name: 'red',    hex: '#f87171' },
    { name: 'gray',   hex: '#9aa0a6' }
];

function toolCursor(tool) {
    if (tool === 'pan')     return 'grab';
    if (tool === 'connect') return 'crosshair';
    if (tool === 'draw')    return 'crosshair';
    if (tool === 'eraser')  return 'cell';
    return 'default';
}

// Build a smooth SVG path (quadratic midpoints) from a list of world points
function strokePathD(points) {
    if (!points.length) return '';
    if (points.length === 1) return `M ${points[0].x} ${points[0].y} l 0.01 0.01`;
    let d = `M ${points[0].x} ${points[0].y}`;
    for (let i = 1; i < points.length - 1; i++) {
        const mx = (points[i].x + points[i + 1].x) / 2;
        const my = (points[i].y + points[i + 1].y) / 2;
        d += ` Q ${points[i].x} ${points[i].y} ${mx} ${my}`;
    }
    const last = points[points.length - 1];
    d += ` L ${last.x} ${last.y}`;
    return d;
}

function createStrokeElement(data) {
    const id = data._id;
    if (!id || state.strokes.has(id)) return;
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('class', 'draw-stroke');
    path.setAttribute('d', strokePathD(data.points || []));
    path.setAttribute('stroke', data.color || '#9aa0a6');
    path.setAttribute('stroke-width', data.width || 4);
    path.setAttribute('fill', 'none');
    path.setAttribute('stroke-linecap', 'round');
    path.setAttribute('stroke-linejoin', 'round');
    path.dataset.strokeId = id;
    // Read the current id from the dataset so re-keyed (temp→real) strokes still erase
    path.addEventListener('mousedown', (e) => {
        if (state.currentTool === 'eraser' && !state.readOnly) {
            e.stopPropagation();
            deleteStroke(e.currentTarget.dataset.strokeId);
        }
    });
    drawGroup.appendChild(path);
    state.strokes.set(id, { el: path, data: { ...data } });
}

async function finishStroke() {
    const draw = state.drawing;
    state.drawing = null;
    if (!draw || draw.points.length < 2) { drawPreview.style.display = 'none'; return; }
    const points = draw.points, color = state.penColor, width = state.penWidth;

    // Optimistic render: show MY stroke instantly (no disappear/flicker). We give it a
    // temporary id and, once the server replies, re-key the SAME element to the real id.
    const tempId = 'tmp_' + Math.random().toString(36).slice(2);
    createStrokeElement({ _id: tempId, points, color, width });
    drawPreview.style.display = 'none';

    showUpdating();
    try {
        const res = await apiFetch(`${API_BASE}/spaces/${state.spaceId}/strokes`, 'POST', { points, color, width });
        const saved = await res.json();
        const entry = state.strokes.get(tempId);
        if (entry) {
            state.strokes.delete(tempId);
            entry.el.dataset.strokeId = saved._id;
            entry.data = { ...saved };
            state.strokes.set(saved._id, entry);
        } else {
            createStrokeElement(saved);
        }
        if (ws) ws.emit('draw:create', { spaceId: state.spaceId, stroke: saved });
        pushUndo({ type: 'create-stroke', strokeId: saved._id });
    } catch {
        deleteStroke(tempId, false); // roll back the optimistic stroke
        showToast(isOffline ? 'No connection — drawing not saved' : 'Failed to save drawing', 'error');
    } finally { hideUpdating(); }
}

async function deleteStroke(id, broadcast = true) {
    const s = state.strokes.get(id);
    if (!s) return;
    s.el.remove();
    state.strokes.delete(id);
    if (!broadcast) return;
    try {
        await apiFetch(`${API_BASE}/spaces/${state.spaceId}/strokes/${id}`, 'DELETE');
        if (ws) ws.emit('draw:delete', { spaceId: state.spaceId, strokeId: id });
    } catch {}
}

// Distance from point to a segment (world units)
function distToSegment(px, py, ax, ay, bx, by) {
    const dx = bx - ax, dy = by - ay;
    const len2 = dx * dx + dy * dy;
    let t = len2 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
    t = Math.max(0, Math.min(1, t));
    const cx = ax + t * dx, cy = ay + t * dy;
    return Math.hypot(px - cx, py - cy);
}
function pointNearPolyline(px, py, points, r) {
    for (let i = 0; i < points.length - 1; i++) {
        if (distToSegment(px, py, points[i].x, points[i].y, points[i + 1].x, points[i + 1].y) <= r) return true;
    }
    return points.length === 1 ? Math.hypot(px - points[0].x, py - points[0].y) <= r : false;
}
function eraseAtScreen(sx, sy) {
    const w = screenToWorld(sx, sy);
    const tol = 8 / (state.viewport.zoom || 1);
    for (const [id, s] of state.strokes) {
        if (pointNearPolyline(w.x, w.y, s.data.points || [], (s.data.width / 2) + tol)) { deleteStroke(id); break; }
    }
}

// ── Palette popover ──
function renderPalette() {
    const grid = $('palette-grid');
    if (!grid) return;
    grid.innerHTML = '';
    PEN_PALETTE.forEach(({ name, hex }) => {
        const sw = document.createElement('button');
        sw.className = 'palette-swatch' + (hex === state.penColor ? ' active' : '');
        sw.style.background = hex;
        sw.dataset.name = name;
        sw.title = name;
        sw.onclick = () => pickColor(name, hex);
        grid.appendChild(sw);
    });
    // "no fill" for nodes (doesn't change pen colour)
    const none = document.createElement('button');
    none.className = 'palette-swatch none';
    none.title = 'No node colour';
    none.onclick = () => { if (state.selected.size) ctxSetColor(''); };
    grid.appendChild(none);
}

function pickColor(name, hex) {
    setPenColor(hex);
    if (state.selected.size) ctxSetColor(name);   // also recolour selected nodes
}
function setPenColor(hex) {
    state.penColor = hex;
    const dot = $('pen-color-dot');
    if (dot) dot.style.background = hex;
    document.querySelectorAll('#palette-grid .palette-swatch').forEach(sw => {
        sw.classList.toggle('active', sw.style.background && rgbToHex(sw.style.background) === hex.toLowerCase());
    });
}
function setPenWidth(w) {
    state.penWidth = w;
    document.querySelectorAll('#palette-widths .pen-width-btn').forEach(b => {
        b.classList.toggle('active', Number(b.dataset.width) === w);
    });
}
function togglePalette(e) {
    if (e) e.stopPropagation();
    const pop = $('palette-pop');
    if (pop) pop.classList.toggle('show');
}
// Helper: normalise "rgb(a)" → hex for active-swatch matching
function rgbToHex(rgb) {
    const m = rgb.match(/\d+/g);
    if (!m || m.length < 3) return rgb.toLowerCase();
    return '#' + m.slice(0, 3).map(n => (+n).toString(16).padStart(2, '0')).join('');
}

// Close palette when clicking elsewhere
document.addEventListener('click', (e) => {
    const pop = $('palette-pop');
    const btn = $('tool-palette');
    if (pop && pop.classList.contains('show') && !pop.contains(e.target) && btn && !btn.contains(e.target)) {
        pop.classList.remove('show');
    }
});

// ══════════════════════════════════════════════════════
// NODE EDIT MODAL
// ══════════════════════════════════════════════════════

let editingNodeId = null;

function openNodeEditModal(id) {
    editingNodeId = id;
    const n = state.nodes.get(id);
    if (!n) return;
    $('edit-node-title').value   = n.data.title   || '';
    $('edit-node-content').value = n.data.content || '';
    document.querySelectorAll('#edit-color-row .color-swatch').forEach(sw => {
        sw.classList.toggle('active', sw.dataset.color === (n.data.color||''));
    });
    $('node-edit-modal').classList.add('show');
    setTimeout(() => $('edit-node-title').focus(), 50);
}
function selectEditColor(el) {
    document.querySelectorAll('#edit-color-row .color-swatch').forEach(sw => sw.classList.remove('active'));
    el.classList.add('active');
}
async function saveNodeEdit() {
    if (!editingNodeId) return;
    const title   = $('edit-node-title').value.trim();
    const content = $('edit-node-content').value;
    const colorEl = document.querySelector('#edit-color-row .color-swatch.active');
    const color   = colorEl?.dataset.color || '';
    const n = state.nodes.get(editingNodeId);
    if (n) {
        const titleEl = n.el.querySelector('.node-title');
        if (titleEl) titleEl.textContent = title;
        const bodyEl = n.el.querySelector('.node-body');
        if (bodyEl) { bodyEl.textContent = content; bodyEl.classList.toggle('empty', !content); }
        n.el.className = n.el.className.replace(/\bcolor-\w+\b/g,'').trim();
        if (color) n.el.classList.add(`color-${color}`);
        await saveNodeData(editingNodeId, { title, content, color });
    }
    closeModal('node-edit-modal');
}
function closeModal(id) { $(id).classList.remove('show'); }

// ══════════════════════════════════════════════════════
// AI PANEL
// ══════════════════════════════════════════════════════

function toggleAIPanel() {
    state.isAIPanelOpen = !state.isAIPanelOpen;
    aiPanel.classList.toggle('collapsed', !state.isAIPanelOpen);
    const btn = $('ai-panel-toggle-btn');
    btn.querySelector('svg path').setAttribute('d',
        state.isAIPanelOpen ? 'M9 18l6-6-6-6' : 'M15 18l-6-6 6-6');
    $('ai-toggle-btn').classList.toggle('active', state.isAIPanelOpen);
}

function pinNodeToAI(id) {
    state.aiContextNodes.add(id);
    updateAIContextBar();
    showToast('Pinned to AI context', 'success');
}

function updateAIContextBar() {
    const bar   = $('ai-context-bar');
    const chips = $('ai-context-chips');
    if (state.aiContextNodes.size === 0) { bar.style.display = 'none'; return; }
    bar.style.display = 'flex';
    chips.innerHTML   = '';
    state.aiContextNodes.forEach(id => {
        const n = state.nodes.get(id);
        if (!n) { state.aiContextNodes.delete(id); return; }
        const chip = document.createElement('div');
        chip.className = 'ai-context-chip';
        chip.innerHTML = `${escHtml(n.data.title||'Node')}<button onclick="unpinFromAI('${id}')">×</button>`;
        chips.appendChild(chip);
    });
}
function unpinFromAI(id) { state.aiContextNodes.delete(id); updateAIContextBar(); }

function buildCanvasContext() {
    const nodes = [], pinned = [];
    state.nodes.forEach(n => nodes.push({ title: n.data.title||'', content: n.data.content||'', type: n.data.type }));
    state.aiContextNodes.forEach(id => {
        const n = state.nodes.get(id);
        if (n) pinned.push({ title: n.data.title, content: n.data.content });
    });
    return `Canvas: ${nodes.length} nodes\n${nodes.map((n,i) => `  [${i+1}] ${n.type}: "${n.title}" — ${n.content.substring(0,100)}`).join('\n')}\n\nPinned:\n${pinned.length ? pinned.map(n=>`  - "${n.title}": ${n.content.substring(0,200)}`).join('\n') : '  (none)'}`;
}

function aiInputKeydown(e) { if (e.key==='Enter' && !e.shiftKey) { e.preventDefault(); sendAIMessage(); } }
function autoResizeAI(el)  { el.style.height='auto'; el.style.height=Math.min(120,el.scrollHeight)+'px'; aiTypingPing(); }

async function sendAIMessage() {
    if (state.readOnly) { showToast('Readers can only view the AI chat', 'error'); return; }
    const text = aiInput.value.trim();
    if (!text) return;
    aiInput.value = ''; aiInput.style.height = 'auto';
    aiTypingStop();

    // The server validates, calls Gemini, performs canvas actions and broadcasts
    // the user message + AI reply + "thinking" state to everyone (incl. us).
    const center = getCenterViewport();
    try {
        const res = await apiFetch(`${API_BASE}/spaces/${state.spaceId}/ai`, 'POST', {
            message: text,
            viewport: { x: center.x, y: center.y },
            pinnedIds: [...state.aiContextNodes]
        });
        if (res && !res.ok) {
            const err = await res.json().catch(() => ({}));
            appendAIMessage('ai', `⚠ ${err.error || 'AI request failed'}`);
        }
    } catch {
        appendAIMessage('ai', '⚠ No connection to the AI service');
    }
}

// Persistent "AI is working" indicator (shared — shown to everyone in the room)
function showAIThinking(username) {
    if (state.aiThinkingEl) return;
    const el = document.createElement('div');
    el.className = 'ai-msg ai';
    const who = username ? ` · ${escHtml(username)}` : '';
    el.innerHTML = `<div class="ai-msg-role">space_ai${who}</div><div class="ai-typing"><span></span><span></span><span></span></div>`;
    aiMessages.appendChild(el);
    aiMessages.scrollTop = aiMessages.scrollHeight;
    state.aiThinkingEl = el;
}
function hideAIThinking() {
    if (state.aiThinkingEl) { state.aiThinkingEl.remove(); state.aiThinkingEl = null; }
}

function appendAIMessage(role, text, username) {
    const el = document.createElement('div');
    el.className = `ai-msg ${role}`;
    const roleLabel = role === 'user' ? (username || state.user?.username || 'you') : 'space_ai';
    el.innerHTML = `<div class="ai-msg-role">${escHtml(roleLabel)}</div><div class="ai-msg-body">${escHtml(text)}</div>`;
    aiMessages.appendChild(el);
    aiMessages.scrollTop = aiMessages.scrollHeight;
}

// Render the persisted shared conversation (called on each snapshot/reconnect)
function renderAIHistory(history) {
    if (!Array.isArray(history)) return;
    state.aiMessages = [];
    hideAIThinking();
    if (!history.length) {
        aiMessages.innerHTML = `<div class="ai-msg ai"><div class="ai-msg-role">space_ai</div><div class="ai-msg-body">How can I help? Ask me to create notes, connect or edit them.</div></div>`;
        return;
    }
    aiMessages.innerHTML = '';
    history.forEach(m => {
        const role = m.role === 'user' ? 'user' : 'ai';
        appendAIMessage(role, m.text, m.username);
        state.aiMessages.push({ role: m.role === 'user' ? 'user' : 'model', text: m.text });
    });
}

function clearAIChat(broadcast = true) {
    state.aiMessages = [];
    hideAIThinking();
    aiMessages.innerHTML = `<div class="ai-msg ai"><div class="ai-msg-role">space_ai</div><div class="ai-msg-body">Chat cleared. How can I help?</div></div>`;
    // broadcast=true → user initiated; clear shared history on the server (writers only)
    if (broadcast && !state.readOnly && state.spaceId) {
        apiFetch(`${API_BASE}/spaces/${state.spaceId}/ai`, 'DELETE').catch(() => {});
    }
}

async function aiQuickAction(type) {
    const p = { summarize:'Summarize my canvas.', organize:'Suggest how to organize these nodes better.', idea:'Generate 3 new ideas based on canvas content.' };
    aiInput.value = p[type] || '';
    sendAIMessage();
}

function getCenterViewport() {
    const rect = canvasArea.getBoundingClientRect();
    return screenToWorld(rect.width/2, rect.height/2);
}

// ══════════════════════════════════════════════════════
// UNDO / REDO
// ══════════════════════════════════════════════════════

function pushUndo(action) {
    state.undoStack.push(action);
    if (state.undoStack.length > 50) state.undoStack.shift();
    state.redoStack = [];
}

async function undoAction() {
    const a = state.undoStack.pop();
    if (!a) return;
    state.redoStack.push(a);
    if (a.type==='create-node')  await deleteNode(a.nodeId);
    else if (a.type==='delete-node')  await saveAndCreateNode(a.data);
    else if (a.type==='create-edge')  await deleteEdge(a.edgeId);
    else if (a.type==='create-stroke') await deleteStroke(a.strokeId);
    else if (a.type==='move-node')    { moveNode(a.nodeId, a.from.x, a.from.y); await saveNodePosition(a.nodeId, a.from); }
    showToast('Undone');
}

async function redoAction() {
    const a = state.redoStack.pop();
    if (!a) return;
    state.undoStack.push(a);
    if (a.type==='create-node')  await saveAndCreateNode(a.data);
    else if (a.type==='delete-node')  await deleteNode(a.nodeId);
    else if (a.type==='create-edge')  await createConnection(a.data.sourceNodeId, a.data.targetNodeId, a.data.sourceSide, a.data.targetSide);
    showToast('Redone');
}

// ══════════════════════════════════════════════════════
// WEBSOCKET  (Stage 2 — snapshot, cursors, presence)
// ══════════════════════════════════════════════════════

let cursorThrottleTimer = null;
let cursorThrottleMs    = CURSOR_THROTTLE_MS;

function updateCursorThrottle() {
    const conn = navigator.connection;
    if (conn) {
        if (conn.saveData || conn.effectiveType === 'slow-2g' || conn.effectiveType === '2g') cursorThrottleMs = 200;
        else if (conn.effectiveType === '3g') cursorThrottleMs = 100;
        else cursorThrottleMs = CURSOR_THROTTLE_MS;
    }
}

function initWebSocket() {
    ws = io({ auth: { token: state.token }, transports: ['websocket'] });

    ws.on('connect', () => {
        wsStatus.textContent = 'live';
        wsDot.style.background = 'var(--green)';
        if (state.spaceId) ws.emit('space:join', { spaceId: state.spaceId, userId: state.user?._id, username: state.user?.username, color: state.user?.color });
        flushPendingEdits();  // replay edits queued while disconnected
    });
    ws.on('disconnect', () => { wsStatus.textContent = 'reconnecting…'; wsDot.style.background = 'var(--yellow)'; });
    ws.on('connect_error', () => { wsStatus.textContent = 'offline'; wsDot.style.background = 'var(--red)'; });

    // Stage 2: Initial snapshot — server sends current canvas state on join
    ws.on('space:snapshot', ({ nodes, edges, strokes, aiHistory, chat, chatMode, chatPos, onlineCount, users }) => {
        // Load snapshot into canvas
        nodes.forEach(n => { if (!state.nodes.has(n._id)) createNodeElement(n, false); });
        edges.forEach(e => { if (!state.edges.has(e._id)) createEdgeElement(e, false); });
        if (strokes) strokes.forEach(s => { if (!state.strokes.has(s._id)) createStrokeElement(s); });
        renderChatHistory(chat);
        applyChatMode(chatMode || 'panel', chatPos);
        scheduleCull();
        updateCanvasHint();
        updateMinimap();
        if (users) { state.onlineUsers.clear(); users.filter(u => u.userId !== state.user?._id).forEach(u => state.onlineUsers.set(u.userId, u)); }
        updateOnlineTooltip();
        renderAIHistory(aiHistory);
        setTimeout(loadTextPreviews, 400);
    });

    ws.on('space:online', ({ count, users }) => {
        if (users) { state.onlineUsers.clear(); users.filter(u => u.userId !== state.user?._id).forEach(u => state.onlineUsers.set(u.userId, u)); }
        updateOnlineTooltip();
    });

    // Node events
    ws.on('node:create', ({ node, userId }) => {
        if (userId === state.user?._id) return;
        createNodeElement(node, true);
        updateCanvasHint();
    });
    ws.on('node:move', ({ nodeId, x, y, userId }) => {
        if (userId === state.user?._id) return;
        const n = state.nodes.get(nodeId);
        if (n) { n.data.position={x,y}; n.el.style.left=x+'px'; n.el.style.top=y+'px'; updateEdgesForNode(nodeId); }
    });
    ws.on('node:update', ({ nodeId, updates, userId }) => {
        if (userId === state.user?._id) return;
        if (!updates) return;
        // Folder filing / ejecting (node moves between canvas and a folder)
        if (updates.parentId !== undefined) {
            if (updates.parentId) {
                const n = state.nodes.get(nodeId);
                if (n) {
                    state.edges.forEach((e, eid) => { if (e.data.sourceNodeId === nodeId || e.data.targetNodeId === nodeId) { e.el.remove(); state.edges.delete(eid); physics.edges.delete(eid); } });
                    const data = { ...n.data, parentId: updates.parentId };
                    n.el.remove(); state.nodes.delete(nodeId);
                    state.filed.set(nodeId, data);
                } else if (state.filed.has(nodeId)) {
                    state.filed.get(nodeId).parentId = updates.parentId;
                }
                updateFolderCount(String(updates.parentId));
            } else {
                const data = state.filed.get(nodeId);
                if (data) {
                    const oldFolder = data.parentId;
                    state.filed.delete(nodeId);
                    data.parentId = null;
                    if (updates.position) data.position = updates.position;
                    createNodeElement({ ...data, parentId: null }, true);
                    updateFolderCount(String(oldFolder));
                }
            }
            if (openFolderId) renderFolderContents(openFolderId);
            return;
        }
        const n = state.nodes.get(nodeId);
        if (!n) return;
        Object.assign(n.data, updates);
        if (updates.content !== undefined) {
            const b = n.el.querySelector('.node-body');
            if (b && document.activeElement !== b) { b.textContent = updates.content; b.classList.toggle('empty', !updates.content); }
        }
        if (updates.title !== undefined) {
            const t = n.el.querySelector('.node-title');
            if (t) t.textContent = updates.title;
        }
        // Sync size (resize), position and colour live
        if (updates.size && (updates.size.w || updates.size.h)) {
            n.el.style.width  = (updates.size.w || n.data.size?.w || 200) + 'px';
            n.el.style.height = (updates.size.h || n.data.size?.h || 120) + 'px';
            updateEdgesForNode(nodeId);
        }
        if (updates.position && updates.position.x !== undefined) {
            n.el.style.left = updates.position.x + 'px';
            n.el.style.top  = updates.position.y + 'px';
            updateEdgesForNode(nodeId);
        }
        if (updates.color !== undefined) {
            n.el.className = n.el.className.replace(/\bcolor-\w+\b/g,'').trim();
            if (updates.color) n.el.classList.add(`color-${updates.color}`);
            updateEdgesForNode(nodeId);
        }
    });
    ws.on('node:delete', ({ nodeId, userId }) => {
        if (userId === state.user?._id) return;
        const n = state.nodes.get(nodeId);
        if (n) { n.el.remove(); state.nodes.delete(nodeId); }
        updateCanvasHint();
    });

    // Edge events
    ws.on('edge:create', ({ edge, userId }) => {
        if (userId === state.user?._id) return;
        createEdgeElement(edge, true);
    });
    ws.on('edge:delete', ({ edgeId, userId }) => {
        if (userId === state.user?._id) return;
        const e = state.edges.get(edgeId);
        if (e) { e.el.remove(); state.edges.delete(edgeId); physics.edges.delete(edgeId); }
    });

    // Drawing events
    ws.on('draw:create', ({ stroke, userId }) => {
        if (userId === state.user?._id) return;
        if (stroke) createStrokeElement(stroke);
    });
    ws.on('draw:delete', ({ strokeId, userId }) => {
        if (userId === state.user?._id) return;
        deleteStroke(strokeId, false);
    });

    // Cursor events (Stage 2)
    ws.on('cursor:move', ({ userId, username, color, x, y, touch }) => {
        if (userId === state.user?._id) return;
        updateRemoteCursor(userId, username, color, x, y, touch);
    });

    // Remote editing indicator (Stage 2)
    ws.on('node:editing', ({ nodeId, userId, color }) => {
        if (userId === state.user?._id) return;
        setRemoteEditing(nodeId, userId, color);
    });
    ws.on('node:editing-stop', ({ nodeId, userId }) => {
        if (userId === state.user?._id) return;
        clearRemoteEditing(nodeId);
    });

    ws.on('user:leave', ({ userId }) => {
        // Remove cursor
        const c = state.remoteCursors.get(userId);
        if (c) { c.el.remove(); state.remoteCursors.delete(userId); }
        state.onlineUsers.delete(userId);
        updateOnlineTooltip();
    });

    // Access denied to this canvas room (e.g. permissions revoked)
    ws.on('space:denied', () => {
        showToast('Access to this canvas was denied', 'error');
        setTimeout(() => { location.href = '/space'; }, 1500);
    });

    // Permissions changed live — recompute our role and toggle read-only on the fly
    ws.on('space:permissions', ({ editors, readers, ownerId }) => {
        const uid = state.user?._id?.toString();
        let role = null;
        if (ownerId && ownerId.toString() === uid) role = 'owner';
        else if ((editors || []).some(id => id.toString() === uid)) role = 'editor';
        else if ((readers || []).some(id => id.toString() === uid)) role = 'reader';
        if (!role) { // no longer has any role on this canvas
            showToast('Your access to this canvas was removed', 'error');
            setTimeout(() => { location.href = '/space'; }, 1500);
            return;
        }
        state.spaceRole = role;
        const cur = state.spaces.find(s => s._id === state.spaceId);
        if (cur) cur.role = role;
        applyReadOnly(role === 'reader');
        const accessBtn = $('canvas-access-btn');
        if (accessBtn) accessBtn.style.display = role === 'owner' ? '' : 'none';
        const trashBtn = $('canvas-trash-btn');
        if (trashBtn) trashBtn.style.display = (role === 'owner' || role === 'editor') ? '' : 'none';
        showToast(`Your role is now: ${role}`);
    });

    // The whole canvas was deleted by its owner
    ws.on('space:deleted', () => {
        showToast('This canvas was deleted', 'error');
        setTimeout(() => { location.href = '/space'; }, 1500);
    });

    // Shared AI chat — the server broadcasts every message to the whole room
    ws.on('ai:message', ({ role, text, username }) => {
        hideAIThinking();
        appendAIMessage(role === 'user' ? 'user' : 'ai', text, username);
        state.aiMessages.push({ role: role === 'user' ? 'user' : 'model', text });
    });
    // Shared "AI is working" state — visible to everyone, including its node-building process
    ws.on('ai:thinking', ({ username }) => showAIThinking(username));
    ws.on('ai:thinking-stop', () => hideAIThinking());
    ws.on('ai:clear', () => clearAIChat(false));

    // "X is typing to the AI…" presence above the input
    ws.on('ai:typing', ({ username }) => setAITyping(username, true));
    ws.on('ai:typing-stop', ({ username }) => setAITyping(username, false));

    // ── Team group chat ──
    ws.on('chat:message', (m) => { appendChatMsg(m); if (m && m.username) setChatTyping(m.username, false); });
    ws.on('chat:react', ({ msgId, reactions }) => renderReactions(msgId, reactions));
    ws.on('chat:clear', () => renderChatHistory([]));
    ws.on('chat:typing', ({ username }) => setChatTyping(username, true));
    ws.on('chat:typing-stop', ({ username }) => setChatTyping(username, false));
    ws.on('chat:mode', ({ mode, pos }) => applyChatMode(mode, pos));
}

// ── AI "typing" presence (over the input) ──
const aiTypingUsers = new Map(); // username → timeout id
function setAITyping(username, on) {
    if (!username) return;
    const existing = aiTypingUsers.get(username);
    if (existing) clearTimeout(existing);
    if (on) {
        aiTypingUsers.set(username, setTimeout(() => { aiTypingUsers.delete(username); renderAITyping(); }, 3500));
    } else {
        aiTypingUsers.delete(username);
    }
    renderAITyping();
}
function renderAITyping() {
    const el = $('ai-typing-indicator');
    if (!el) return;
    const names = [...aiTypingUsers.keys()];
    if (!names.length) { el.style.display = 'none'; el.textContent = ''; return; }
    const who = names.length === 1 ? `${names[0]} is typing` : `${names.slice(0, 2).join(', ')} are typing`;
    el.style.display = 'flex';
    el.innerHTML = `<span class="ai-typing-dots"><span></span><span></span><span></span></span><span>${escHtml(who)}…</span>`;
}

// Emit our own typing presence (throttled), with auto-stop after idle
let aiTypingThrottle = null, aiTypingStopTimer = null;
function aiTypingPing() {
    if (state.readOnly || !ws || !state.spaceId) return;
    if (!aiTypingThrottle) {
        ws.emit('ai:typing', { spaceId: state.spaceId });
        aiTypingThrottle = setTimeout(() => { aiTypingThrottle = null; }, 1500);
    }
    clearTimeout(aiTypingStopTimer);
    aiTypingStopTimer = setTimeout(aiTypingStop, 2500);
}
function aiTypingStop() {
    clearTimeout(aiTypingStopTimer);
    if (ws && state.spaceId) ws.emit('ai:typing-stop', { spaceId: state.spaceId });
}

// ══════════════════════════════════════════════════════
// TEAM GROUP CHAT  (messages • reactions • @agent • placement modes)
// ══════════════════════════════════════════════════════

const CHAT_EMOJIS = ['👍', '❤️', '😂', '🎉', '✅'];

function toggleTeamChat() {
    state.teamChatOpen = !state.teamChatOpen;
    teamChat.style.display = state.teamChatOpen ? 'flex' : 'none';
    $('team-chat-btn')?.classList.toggle('active', state.teamChatOpen);
    if (state.teamChatOpen) {
        applyChatMode(state.chatMode, state.chatPos);
        renderTeamPresence();
        teamChatMsgs.scrollTop = teamChatMsgs.scrollHeight;
    }
}

// Apply the (shared) placement mode + position. Called locally + on chat:mode.
// In 'canvas' mode chatPos is WORLD coords (chat is anchored to the board and
// pans/zooms with it). In 'floating' mode chatPos is screen coords.
function applyChatMode(mode, pos) {
    state.chatMode = mode || 'panel';
    if (pos && typeof pos.x === 'number') state.chatPos = { x: pos.x, y: pos.y };
    teamChat.classList.remove('mode-panel', 'mode-floating', 'mode-canvas');
    teamChat.classList.add(`mode-${state.chatMode}`);
    document.querySelectorAll('.tc-mode-btn').forEach(b => b.classList.toggle('active', b.dataset.mode === state.chatMode));
    if (state.chatMode === 'panel') {
        // drop any inline size/pos from a previous floating/canvas resize so CSS wins
        teamChat.style.left = ''; teamChat.style.top = '';
        teamChat.style.width = ''; teamChat.style.height = '';
    } else if (state.chatMode === 'floating') {
        teamChat.style.left = state.chatPos.x + 'px';
        teamChat.style.top  = state.chatPos.y + 'px';
    } else { // canvas — position from world coords
        reprojectChat();
    }
}

// Re-place the on-canvas chat from its world position (called on pan/zoom)
function reprojectChat() {
    if (state.chatMode !== 'canvas' || !state.teamChatOpen) return;
    const rect = canvasArea.getBoundingClientRect();
    const s = worldToScreen(state.chatPos.x, state.chatPos.y);
    teamChat.style.left = (rect.left + s.x) + 'px';
    teamChat.style.top  = (rect.top + s.y) + 'px';
}

// User picked a mode → broadcast to everyone (server persists it)
function setChatMode(mode) {
    const rect = canvasArea.getBoundingClientRect();
    let pos = state.chatPos;
    if (mode === 'canvas') {
        const w = screenToWorld(rect.width / 2 - 165, rect.height / 2 - 200);
        pos = { x: Math.round(w.x), y: Math.round(w.y) };
    } else if (mode === 'floating') {
        pos = { x: Math.round(rect.left + rect.width / 2 - 180), y: 110 };
    }
    if (ws && state.spaceId) ws.emit('chat:mode', { spaceId: state.spaceId, mode, pos });
    applyChatMode(mode, pos); // optimistic
}

function renderTeamPresence() {
    const box = $('team-chat-presence');
    if (!box) return;
    const me = { username: state.user?.username, color: state.user?.color };
    const users = [me, ...[...state.onlineUsers.values()]].slice(0, 6);
    box.innerHTML = users.map(u =>
        `<div class="tc-presence-dot" style="background:${u.color || '#4ade80'}" title="${escHtml(u.username || '')}">${escHtml((u.username || '?')[0] || '?')}</div>`
    ).join('');
}

function teamChatKeydown(e) { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendTeamChat(); } }
function teamChatInput(el) {
    el.style.height = 'auto'; el.style.height = Math.min(110, el.scrollHeight) + 'px';
    chatTypingPing();
}

async function sendTeamChat() {
    const text = teamChatInputEl.value.trim();
    if (!text) return;
    teamChatInputEl.value = ''; teamChatInputEl.style.height = 'auto';
    chatTypingStop();
    const center = getCenterViewport();
    try {
        const res = await apiFetch(`${API_BASE}/spaces/${state.spaceId}/chat`, 'POST', {
            message: text, viewport: { x: center.x, y: center.y }
        });
        if (res && !res.ok) { const err = await res.json().catch(() => ({})); showToast(err.error || 'Chat failed', 'error'); }
    } catch { showToast('No connection', 'error'); }
}

function escAttr(s) { return String(s).replace(/"/g, '&quot;'); }

// Render @mentions
function renderChatText(text) {
    return escHtml(text).replace(/@(agent|ai|[a-z0-9_]+)/gi, '<span class="tc-mention">@$1</span>');
}

function appendChatMsg(m) {
    if (!m || !m._id) return;
    if (teamChatMsgs.querySelector(`[data-msg-id="${m._id}"]`)) return;
    const mine = m.userId && state.user && String(m.userId) === String(state.user._id);
    const el = document.createElement('div');
    el.className = 'tc-msg' + (mine ? ' mine' : '') + (m.agent ? ' agent' : '');
    el.dataset.msgId = m._id;
    const time = new Date(m.createdAt || Date.now()).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
    const reactBar = CHAT_EMOJIS.map(em => `<button onclick="toggleReaction('${m._id}','${em}')">${em}</button>`).join('');
    el.innerHTML =
        `<div class="tc-msg-meta"><span class="tc-msg-author">${escHtml(m.agent ? 'agent' : (m.username || 'user'))}</span><span>${time}</span></div>`
        + `<div class="tc-msg-bubble">${renderChatText(m.text || '')}</div>`
        + `<div class="tc-reactions"></div>`
        + `<div class="tc-react-add">${reactBar}</div>`;
    teamChatMsgs.appendChild(el);
    renderReactions(m._id, m.reactions || {});
    teamChatMsgs.scrollTop = teamChatMsgs.scrollHeight;
}

function renderReactions(msgId, reactions) {
    const el = teamChatMsgs.querySelector(`[data-msg-id="${msgId}"] .tc-reactions`);
    if (!el) return;
    const uid = String(state.user?._id || '');
    const entries = Object.entries(reactions || {}).filter(([, list]) => Array.isArray(list) && list.length);
    el.innerHTML = entries.map(([em, list]) => {
        const mine = list.map(String).includes(uid);
        return `<button class="tc-reaction${mine ? ' mine' : ''}" onclick="toggleReaction('${msgId}','${em}')">${em} ${list.length}</button>`;
    }).join('');
}

async function toggleReaction(msgId, emoji) {
    try { await apiFetch(`${API_BASE}/spaces/${state.spaceId}/chat/${msgId}/react`, 'POST', { emoji }); } catch {}
}

function renderChatHistory(history) {
    teamChatMsgs.innerHTML = '';
    if (Array.isArray(history)) history.forEach(appendChatMsg);
    if (!history || !history.length) {
        teamChatMsgs.innerHTML = `<div class="tc-msg agent"><div class="tc-msg-bubble">Team chat. Say hi 👋 — mention <span class="tc-mention">@agent</span> to bring in the AI.</div></div>`;
    }
}

async function clearTeamChat() {
    if (state.readOnly) return;
    try { await apiFetch(`${API_BASE}/spaces/${state.spaceId}/chat`, 'DELETE'); } catch {}
}

// ── Chat typing presence ──
const chatTypingUsers = new Map();
let chatTypingThrottle = null, chatTypingStopTimer = null;
function chatTypingPing() {
    if (!ws || !state.spaceId) return;
    if (!chatTypingThrottle) {
        ws.emit('chat:typing', { spaceId: state.spaceId });
        chatTypingThrottle = setTimeout(() => { chatTypingThrottle = null; }, 1500);
    }
    clearTimeout(chatTypingStopTimer);
    chatTypingStopTimer = setTimeout(chatTypingStop, 2500);
}
function chatTypingStop() {
    clearTimeout(chatTypingStopTimer);
    if (ws && state.spaceId) ws.emit('chat:typing-stop', { spaceId: state.spaceId });
}
function setChatTyping(username, on) {
    if (!username) return;
    const existing = chatTypingUsers.get(username);
    if (existing) clearTimeout(existing);
    if (on) chatTypingUsers.set(username, setTimeout(() => { chatTypingUsers.delete(username); renderChatTyping(); }, 3500));
    else chatTypingUsers.delete(username);
    renderChatTyping();
}
function renderChatTyping() {
    const el = $('team-chat-typing');
    if (!el) return;
    const names = [...chatTypingUsers.keys()];
    if (!names.length) { el.style.display = 'none'; el.textContent = ''; return; }
    el.style.display = 'flex';
    el.innerHTML = `<span class="ai-typing-dots"><span></span><span></span><span></span></span><span>${escHtml(names.slice(0, 2).join(', '))} typing…</span>`;
}

// ── Dragging the chat in floating / canvas modes ──
(function setupChatDrag() {
    const header = $('team-chat-header');
    if (!header) return;
    let dragging = false, ox = 0, oy = 0;
    header.addEventListener('mousedown', (e) => {
        if (state.chatMode === 'panel') return;
        if (e.target.closest('button')) return;
        dragging = true;
        const r = teamChat.getBoundingClientRect();
        ox = e.clientX - r.left; oy = e.clientY - r.top;
        e.preventDefault();
    });
    window.addEventListener('mousemove', (e) => {
        if (!dragging) return;
        const x = Math.max(0, Math.min(window.innerWidth - 80, e.clientX - ox));
        const y = Math.max(44, Math.min(window.innerHeight - 60, e.clientY - oy));
        teamChat.style.left = x + 'px'; teamChat.style.top = y + 'px';
        if (state.chatMode === 'canvas') {
            // store as world coords so it stays anchored to the board
            const rect = canvasArea.getBoundingClientRect();
            const w = screenToWorld(x - rect.left, y - rect.top);
            state.chatPos = { x: Math.round(w.x), y: Math.round(w.y) };
        } else {
            state.chatPos = { x, y };
        }
    });
    window.addEventListener('mouseup', () => {
        if (!dragging) return;
        dragging = false;
        if (ws && state.spaceId) ws.emit('chat:mode', { spaceId: state.spaceId, mode: state.chatMode, pos: state.chatPos });
    });

    // Resize (floating / canvas) with sensible bounds
    const handle = $('tc-resize');
    if (handle) {
        let rz = false, sw = 0, sh = 0, sx = 0, sy = 0;
        handle.addEventListener('mousedown', (e) => {
            if (state.chatMode === 'panel') return;
            rz = true; const r = teamChat.getBoundingClientRect();
            sw = r.width; sh = r.height; sx = e.clientX; sy = e.clientY;
            e.preventDefault(); e.stopPropagation();
        });
        window.addEventListener('mousemove', (e) => {
            if (!rz) return;
            const w = Math.max(280, Math.min(560, sw + (e.clientX - sx)));
            const h = Math.max(320, Math.min(720, sh + (e.clientY - sy)));
            teamChat.style.width = w + 'px'; teamChat.style.height = h + 'px';
        });
        window.addEventListener('mouseup', () => { rz = false; });
    }
})();

// ── Paste (Ctrl+V) onto the canvas: image → upload, text → new note ──
document.addEventListener('paste', (e) => {
    if (!app.classList.contains('show') || state.readOnly) return;
    const ae = document.activeElement;
    // let normal paste happen inside editable fields (notes, chat, inputs)
    if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' || ae.isContentEditable)) return;
    const cd = e.clipboardData;
    if (!cd) return;
    // Image?
    for (const it of cd.items || []) {
        if (it.type && it.type.startsWith('image/')) {
            const blob = it.getAsFile();
            if (blob) {
                e.preventDefault();
                const ext = (blob.type.split('/')[1] || 'png').replace('jpeg', 'jpg');
                const file = new File([blob], `pasted-${Date.now()}.${ext}`, { type: blob.type });
                const c = getCenterViewport();
                uploadFileToR2(file, c.x - 95, c.y - 80);
                return;
            }
        }
    }
    // Text?
    const text = cd.getData('text/plain');
    if (text && text.trim()) {
        e.preventDefault();
        const c = getCenterViewport();
        createNoteAtPos(c.x - 100, c.y - 60, { title: 'Pasted', content: text.trim().slice(0, 5000), w: 220, h: 150 });
    }
});

// ── Cursor rendering (Stage 2) — in canvas-area screen space ──
function emitCursor(sx, sy) {
    if (!ws || !state.user || !state.spaceId) return;
    if (cursorThrottleTimer) return;
    cursorThrottleTimer = setTimeout(() => { cursorThrottleTimer = null; }, cursorThrottleMs);
    const world = screenToWorld(sx, sy);
    ws.emit('cursor:move', {
        spaceId: state.spaceId,
        x: world.x, y: world.y,
        userId: state.user._id,
        username: state.user.username,
        color: state.user.color || CURSOR_COLORS[0],
        touch: IS_TOUCH
    });
}

function updateRemoteCursor(userId, username, color, wx, wy, touch) {
    let entry = state.remoteCursors.get(userId);
    if (!entry) {
        const el = document.createElement('div');
        const c = color || '#4ade80';
        // Shape reflects the SENDER's device: touch → presence dot, desktop → arrow
        el.className = 'remote-cursor' + (touch ? ' mobile' : '');
        el.style.setProperty('--cursor-color', c);
        el.innerHTML = (touch
            ? `<div class="remote-cursor-dot" style="background:${c}"></div>`
            : `<svg class="remote-cursor-arrow" viewBox="0 0 12 18" width="12" height="18">
                <path d="M0,0 L0,15 L4,11 L7,17 L9,16 L6,10 L11,10 Z" fill="${c}"/>
            </svg>`)
            + `<div class="remote-cursor-label" style="background:${c}">${escHtml(username||'user')}</div>`;
        cursorsLayer.appendChild(el);
        entry = { el, worldX: wx, worldY: wy };
        state.remoteCursors.set(userId, entry);
        state.onlineUsers.set(userId, { userId, username, color });
    }
    entry.worldX = wx;
    entry.worldY = wy;
    projectCursor(entry);
    // Auto-fade after 8s
    clearTimeout(entry.hideTimer);
    entry.el.style.opacity = '1';
    entry.hideTimer = setTimeout(() => { entry.el.style.opacity = '0'; }, 8000);
}

function projectCursor(entry) {
    const screen = worldToScreen(entry.worldX, entry.worldY);
    entry.el.style.left = screen.x + 'px';
    entry.el.style.top  = screen.y + 'px';
}

function updateAllCursorPositions() {
    state.remoteCursors.forEach(entry => projectCursor(entry));
}

// ── Online presence tooltip (Stage 2) ──
function updateOnlineTooltip() {
    const count = $('online-num');
    if (count) count.textContent = state.onlineUsers.size + 1; // +self
    const tooltipEl = $('online-tooltip');
    if (!tooltipEl) return;
    const list = [...state.onlineUsers.values()];
    tooltipEl.innerHTML = list.map(u =>
        `<div class="online-user-item"><div class="online-user-dot" style="background:${u.color||'#4ade80'}"></div>${escHtml(u.username)}</div>`
    ).join('') || '<div class="online-user-item" style="color:var(--dim)">Only you</div>';
    if (state.teamChatOpen) renderTeamPresence();
}

// ── Remote editing indicator (Stage 2) ──
function setRemoteEditing(nodeId, userId, color) {
    state.remoteEditing.set(nodeId, { userId, color });
    const n = state.nodes.get(nodeId);
    if (n) {
        n.el.style.setProperty('--remote-edit-color', color);
        n.el.classList.add('remote-editing');
    }
}
function clearRemoteEditing(nodeId) {
    state.remoteEditing.delete(nodeId);
    const n = state.nodes.get(nodeId);
    if (n) n.el.classList.remove('remote-editing');
}

function emitNodeCreate(node) {
    if (ws) ws.emit('node:create', { spaceId: state.spaceId, node, userId: state.user?._id });
}

// ══════════════════════════════════════════════════════
// UPDATING INDICATOR  (Stage 1)
// ══════════════════════════════════════════════════════

let updatingCount = 0, updatingHideTimer = null;

function showUpdating() {
    updatingCount++;
    clearTimeout(updatingHideTimer);
    if (updatingEl) updatingEl.classList.add('show');
}
function hideUpdating() {
    updatingCount = Math.max(0, updatingCount - 1);
    if (updatingCount === 0) {
        clearTimeout(updatingHideTimer);
        updatingHideTimer = setTimeout(() => {
            if (updatingEl) updatingEl.classList.remove('show');
        }, 800);
    }
}

// ══════════════════════════════════════════════════════
// KEYBOARD SHORTCUTS
// ══════════════════════════════════════════════════════

function setupKeyboard() {
    document.addEventListener('keydown', e => {
        const tag     = document.activeElement.tagName;
        const editing = tag==='INPUT' || tag==='TEXTAREA' || document.activeElement.contentEditable==='true';
        // Use e.code (physical key) so shortcuts work on any layout (e.g. Russian ЯЦУКЕН)
        const code = e.code;
        if (e.ctrlKey || e.metaKey) {
            if (code==='KeyZ') { e.preventDefault(); e.shiftKey ? redoAction() : undoAction(); return; }
            if (code==='KeyY') { e.preventDefault(); redoAction(); return; }
            if (code==='KeyA' && !editing) { e.preventDefault(); selectAll(); return; }
            if (code==='KeyD' && !editing) {
                e.preventDefault();
                state.selected.forEach(id => { const n=state.nodes.get(id); if(n) createNoteAtPos(n.data.position.x+24,n.data.position.y+24,n.data); });
                return;
            }
        }
        if (editing) return;
        const map = { KeyV:'select', KeyH:'pan', KeyN:'note', KeyC:'connect', KeyP:'draw', KeyE:'eraser' };
        const t = map[code];
        if (t) { if ((t === 'draw' || t === 'eraser') && state.readOnly) { /* readers can't draw */ } else setTool(t); }
        if (code==='KeyF') triggerFileUpload();
        if (code==='Digit0' || code==='Numpad0') fitView();
        if (e.key==='Escape') {
            setTool('select');
            state.selected.forEach(id => deselectNode(id)); state.selected.clear();
            hideContextMenu(); closeModal('node-edit-modal');
            state.connectingFrom = null;
            if (edgePreview) edgePreview.style.display = 'none';
            document.querySelectorAll('.connecting-source').forEach(el => el.classList.remove('connecting-source'));
        }
        if (e.key==='Delete' || e.key==='Backspace') { [...state.selected].forEach(id => deleteNode(id)); }
        if (code==='Equal' || code==='NumpadAdd') changeZoom(0.1);
        if (code==='Minus' || code==='NumpadSubtract') changeZoom(-0.1);
    });
}

// ══════════════════════════════════════════════════════
// MINIMAP
// ══════════════════════════════════════════════════════

let minimapTimer = null;
function updateMinimap() { clearTimeout(minimapTimer); minimapTimer = setTimeout(drawMinimap, 100); }

function drawMinimap() {
    const canvas = $('minimap-canvas');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const W = 160, H = 90;
    canvas.width = W; canvas.height = H;
    const isDark = document.documentElement.getAttribute('data-theme') !== 'light';
    ctx.fillStyle = isDark ? 'rgba(3,3,3,0.9)' : 'rgba(240,240,240,0.9)';
    ctx.fillRect(0, 0, W, H);
    if (state.nodes.size === 0) return;
    let minX=Infinity,minY=Infinity,maxX=-Infinity,maxY=-Infinity;
    state.nodes.forEach(({data}) => {
        minX=Math.min(minX,data.position.x); minY=Math.min(minY,data.position.y);
        maxX=Math.max(maxX,data.position.x+(data.size?.w||200));
        maxY=Math.max(maxY,data.position.y+(data.size?.h||120));
    });
    const rX=Math.max(400,maxX-minX), rY=Math.max(300,maxY-minY);
    const scale = Math.min(W/rX, H/rY) * 0.85;
    const offX  = (W - rX*scale)/2 - minX*scale;
    const offY  = (H - rY*scale)/2 - minY*scale;
    state.nodes.forEach(({data}) => {
        ctx.fillStyle = isDark ? 'rgba(255,255,255,0.14)' : 'rgba(0,0,0,0.12)';
        ctx.fillRect(data.position.x*scale+offX, data.position.y*scale+offY, (data.size?.w||200)*scale, (data.size?.h||120)*scale);
    });
    const rect = canvasArea.getBoundingClientRect();
    const vx = (-state.viewport.x/state.viewport.zoom)*scale+offX;
    const vy = (-state.viewport.y/state.viewport.zoom)*scale+offY;
    const vw = (rect.width/state.viewport.zoom)*scale;
    const vh = (rect.height/state.viewport.zoom)*scale;
    ctx.strokeStyle = isDark ? 'rgba(255,255,255,0.35)' : 'rgba(0,0,0,0.3)';
    ctx.lineWidth = 1;
    ctx.strokeRect(vx, vy, vw, vh);
}

// ══════════════════════════════════════════════════════
// UTILS
// ══════════════════════════════════════════════════════

function updateCanvasHint() {
    if (state.nodes.size > 0) canvasHint.classList.add('hidden');
    else canvasHint.classList.remove('hidden');
}

function showToast(msg, type='') {
    const t = document.createElement('div');
    t.className = 'toast' + (type ? ' '+type : '');
    t.textContent = msg;
    $('toast-container').appendChild(t);
    setTimeout(() => t.remove(), 3000);
}

function escHtml(s) {
    if (!s) return '';
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

async function apiFetch(url, method='GET', body=null) {
    // 10s timeout so a dead server / lost connection doesn't hang the "updating…" spinner forever
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 10000);
    const opts = { method, headers: { 'Content-Type':'application/json', 'Authorization':'Bearer '+state.token }, signal: ctrl.signal };
    if (body) opts.body = JSON.stringify(body);
    try {
        const res = await fetch(url, opts);
        clearTimeout(timer);
        if (res.status === 401) {
            state.token = null; localStorage.removeItem('space_token');
            authScreen.classList.remove('hidden'); app.classList.remove('show');
        }
        markOnline();
        return res;
    } catch (e) {
        clearTimeout(timer);
        markOffline();
        throw e;
    }
}

// ── Connection status (offline detection) ──
let isOffline = false;
function markOffline() {
    isOffline = true;
    if (updatingEl) {
        updatingEl.classList.add('show', 'offline');
        updatingEl.innerHTML = '<div class="updating-dot"></div> no connection — changes will sync';
    }
    if (wsStatus) { wsStatus.textContent = 'offline'; wsDot.style.background = 'var(--red)'; }
}
function markOnline() {
    if (!isOffline) return;
    isOffline = false;
    if (updatingEl) {
        updatingEl.classList.remove('offline');
        updatingEl.innerHTML = '<div class="updating-dot"></div> updating...';
    }
    if (ws && ws.connected) { wsStatus.textContent = 'live'; wsDot.style.background = 'var(--green)'; }
    flushPendingEdits();  // replay any edits made while offline
}

function renameSpace() {
    if (state.readOnly) return;
    const n = prompt('Space name:', $('space-name-display').textContent);
    if (n?.trim()) {
        $('space-name-display').textContent = n.trim();
        const cur = state.spaces.find(s => s._id === state.spaceId);
        if (cur) cur.name = n.trim();
        renderCanvasDropdown();
        apiFetch(`${API_BASE}/spaces/${state.spaceId}`, 'PATCH', { name: n.trim() }).catch(()=>{});
    }
}

function showUserMenu() {
    if (confirm(`Logged in as "${state.user?.username}"\n\nLogout?`)) { localStorage.removeItem('space_token'); location.reload(); }
}

function clearCanvas() {
    if (state.readOnly) { showToast('Read-only — viewing mode', 'error'); return; }
    if (!confirm('Move ALL nodes to Trash and erase drawings?')) return;
    state.nodes.forEach((_,id) => deleteNode(id));
    // also erase freehand strokes
    [...state.strokes.keys()].forEach(id => deleteStroke(id));
}

// ══════════════════════════════════════════════════════
// ACCESS / PERMISSIONS MODAL  (owner only)
// ══════════════════════════════════════════════════════

let accessDirectory = []; // cached user directory
// pending role choices: userId → 'editor' | 'reader' | 'none'

async function openAccessModal() {
    if (state.spaceRole !== 'owner') { showToast('Owner only', 'error'); return; }
    $('access-modal').classList.add('show');
    const listEl = $('access-list');
    listEl.innerHTML = '<div class="access-loading">// loading users…</div>';
    try {
        const [dirRes, spaceRes] = await Promise.all([
            apiFetch(`${API_BASE}/users/directory`),
            apiFetch(`${API_BASE}/spaces/by-slug/${state.spaceSlug}`)
        ]);
        accessDirectory = await dirRes.json();
        const space = await spaceRes.json();
        const ownerId  = space.ownerId?.toString();
        const editorSet = new Set((space.editors || []).map(String));
        const readerSet = new Set((space.readers || []).map(String));
        renderAccessList(ownerId, editorSet, readerSet);
    } catch {
        listEl.innerHTML = '<div class="access-loading">// failed to load</div>';
    }
}

function renderAccessList(ownerId, editorSet, readerSet) {
    const listEl = $('access-list');
    listEl.innerHTML = '';
    accessDirectory.forEach(u => {
        const uid = u._id.toString();
        const isOwner = uid === ownerId;
        let role = isOwner ? 'owner' : (editorSet.has(uid) ? 'editor' : (readerSet.has(uid) ? 'reader' : 'none'));
        const row = document.createElement('div');
        row.className = 'access-row';
        row.dataset.userId = uid;
        row.dataset.role = role;
        row.innerHTML = `
            <div class="access-user">
                <div class="access-avatar" style="background:${u.color || '#222'}">${escHtml((u.username||'?')[0].toUpperCase())}</div>
                <span class="access-username">${escHtml(u.username)}</span>
            </div>
            ${isOwner
                ? '<span class="access-owner-tag">OWNER</span>'
                : `<div class="access-roles">
                    <button class="access-role-btn ${role==='none'?'active':''}"   data-set="none">None</button>
                    <button class="access-role-btn ${role==='reader'?'active':''}" data-set="reader">Reader</button>
                    <button class="access-role-btn ${role==='editor'?'active':''}" data-set="editor">Editor</button>
                   </div>`}
        `;
        if (!isOwner) {
            row.querySelectorAll('.access-role-btn').forEach(btn => {
                btn.onclick = () => {
                    row.dataset.role = btn.dataset.set;
                    row.querySelectorAll('.access-role-btn').forEach(b => b.classList.toggle('active', b === btn));
                };
            });
        }
        listEl.appendChild(row);
    });
}

async function saveAccess() {
    const editors = [], readers = [];
    document.querySelectorAll('#access-list .access-row').forEach(row => {
        if (row.dataset.role === 'editor') editors.push(row.dataset.userId);
        else if (row.dataset.role === 'reader') readers.push(row.dataset.userId);
    });
    try {
        const res = await apiFetch(`${API_BASE}/spaces/${state.spaceId}/permissions`, 'PATCH', { editors, readers });
        if (!res.ok) { showToast('Failed to save permissions', 'error'); return; }
        showToast('Permissions updated', 'success');
        closeModal('access-modal');
    } catch { showToast('Failed to save permissions', 'error'); }
}

// ══════════════════════════════════════════════════════
// TRASH BIN MODAL  (owner + editors)
// ══════════════════════════════════════════════════════

function fmtAgo(ts) {
    if (!ts) return '';
    const diff = Date.now() - new Date(ts).getTime();
    const m = Math.floor(diff / 60000), s = Math.floor(diff / 1000) % 60;
    return m > 0 ? `${m}m ${s}s ago` : `${s}s ago`;
}

async function openTrashModal() {
    if (!(state.spaceRole === 'owner' || state.spaceRole === 'editor')) { showToast('No access to Trash', 'error'); return; }
    $('trash-modal').classList.add('show');
    await loadTrash();
}

async function loadTrash() {
    const listEl = $('trash-list');
    listEl.innerHTML = '<div class="access-loading">// loading trash…</div>';
    try {
        const res = await apiFetch(`${API_BASE}/spaces/${state.spaceId}/trash`);
        const { nodes, edges } = await res.json();
        renderTrash(nodes || [], edges || []);
    } catch {
        listEl.innerHTML = '<div class="access-loading">// failed to load</div>';
    }
}

function renderTrash(nodes, edges) {
    const listEl = $('trash-list');
    listEl.innerHTML = '';
    const isOwner = state.spaceRole === 'owner';
    // Show "Delete All" only for the owner when there's something to purge
    const delAll = $('trash-delete-all');
    if (delAll) delAll.style.display = (isOwner && (nodes.length || edges.length)) ? '' : 'none';
    if (nodes.length === 0 && edges.length === 0) {
        listEl.innerHTML = '<div class="trash-empty">// trash is empty</div>';
        return;
    }
    nodes.forEach(n => {
        const row = document.createElement('div');
        row.className = 'trash-row';
        const kind = n.type === 'file' ? 'FILE' : (n.type === 'ai-generated' ? 'AI' : 'NOTE');
        row.innerHTML = `
            <div class="trash-info">
                <span class="trash-kind">${kind}</span>
                <span class="trash-title">${escHtml(n.title || '(untitled)')}</span>
                <span class="trash-age">${fmtAgo(n.deletedAt)}</span>
            </div>
            <div class="trash-actions">
                <button class="trash-restore-btn">Restore</button>
                ${isOwner ? '<button class="trash-purge-btn" title="Delete forever">✕</button>' : ''}
            </div>`;
        row.querySelector('.trash-restore-btn').onclick = () => restoreTrashNode(n._id);
        const purge = row.querySelector('.trash-purge-btn');
        if (purge) purge.onclick = () => purgeTrashNode(n._id, n.title);
        listEl.appendChild(row);
    });
    edges.forEach(e => {
        const row = document.createElement('div');
        row.className = 'trash-row';
        row.innerHTML = `
            <div class="trash-info">
                <span class="trash-kind">LINK</span>
                <span class="trash-title">connection</span>
                <span class="trash-age">${fmtAgo(e.deletedAt)}</span>
            </div>
            <div class="trash-actions">
                <button class="trash-restore-btn">Restore</button>
                ${isOwner ? '<button class="trash-purge-btn" title="Delete forever">✕</button>' : ''}
            </div>`;
        row.querySelector('.trash-restore-btn').onclick = () => restoreTrashEdge(e._id);
        const purge = row.querySelector('.trash-purge-btn');
        if (purge) purge.onclick = () => purgeTrashEdge(e._id);
        listEl.appendChild(row);
    });
}

async function purgeTrashEdge(edgeId) {
    if (!confirm('Delete this connection forever?')) return;
    try {
        const res = await apiFetch(`${API_BASE}/spaces/${state.spaceId}/trash/edges/${edgeId}`, 'DELETE');
        if (res.ok) loadTrash();
    } catch { showToast('Purge failed', 'error'); }
}

async function restoreTrashNode(nodeId) {
    try {
        const res = await apiFetch(`${API_BASE}/spaces/${state.spaceId}/trash/nodes/${nodeId}/restore`, 'POST');
        if (!res.ok) { showToast('Restore failed', 'error'); return; }
        const { node, edges } = await res.json();
        if (node && !state.nodes.has(node._id)) createNodeElement(node, true);
        (edges || []).forEach(e => { if (!state.edges.has(e._id)) createEdgeElement(e, true); });
        updateCanvasHint();
        setTimeout(loadTextPreviews, 300);
        showToast('Restored', 'success');
        await loadTrash();
    } catch { showToast('Restore failed', 'error'); }
}

async function restoreTrashEdge(edgeId) {
    try {
        const res = await apiFetch(`${API_BASE}/spaces/${state.spaceId}/trash/edges/${edgeId}/restore`, 'POST');
        if (!res.ok) { const d = await res.json().catch(()=>({})); showToast(d.error || 'Restore failed', 'error'); return; }
        const { edge } = await res.json();
        if (edge && !state.edges.has(edge._id)) createEdgeElement(edge, true);
        showToast('Connection restored', 'success');
        await loadTrash();
    } catch { showToast('Restore failed', 'error'); }
}

async function emptyTrash() {
    if (state.spaceRole !== 'owner') { showToast('Owner only', 'error'); return; }
    if (!confirm('Permanently delete EVERYTHING in the trash? This cannot be undone.')) return;
    try {
        const res = await apiFetch(`${API_BASE}/spaces/${state.spaceId}/trash`, 'DELETE');
        if (res.ok) { showToast('Trash emptied', 'success'); await loadTrash(); }
        else showToast('Failed to empty trash', 'error');
    } catch { showToast('Failed to empty trash', 'error'); }
}

async function purgeTrashNode(nodeId, title) {
    if (!confirm(`Permanently delete "${title || 'item'}"? This cannot be undone.`)) return;
    try {
        const res = await apiFetch(`${API_BASE}/spaces/${state.spaceId}/trash/nodes/${nodeId}`, 'DELETE');
        if (!res.ok) { showToast('Delete failed', 'error'); return; }
        showToast('Deleted permanently');
        await loadTrash();
    } catch { showToast('Delete failed', 'error'); }
}

// ══════════════════════════════════════════════════════
// AUTH MATRIX ANIMATION
// ══════════════════════════════════════════════════════

function initAuthMatrix() {
    const canvas = $('auth-matrix');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    canvas.width = window.innerWidth; canvas.height = window.innerHeight;
    const chars = '01アイウエオカキクケコサシスセソタ∂∑∫π';
    const cols  = Math.floor(canvas.width / 14);
    const drops = Array(cols).fill(1);
    let interval;
    function draw() {
        const isDark = document.documentElement.getAttribute('data-theme') !== 'light';
        ctx.fillStyle = isDark ? 'rgba(3,3,3,0.05)' : 'rgba(240,240,240,0.08)';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.fillStyle = isDark ? 'rgba(255,255,255,0.5)' : 'rgba(0,0,0,0.3)';
        ctx.font = '11px JetBrains Mono,monospace';
        drops.forEach((y, i) => {
            ctx.fillText(chars[Math.floor(Math.random()*chars.length)], i*14, y*14);
            if (y*14 > canvas.height && Math.random()>0.975) drops[i] = 0;
            drops[i]++;
        });
    }
    interval = setInterval(draw, 60);
    new MutationObserver(() => {
        if (authScreen.classList.contains('hidden')) { clearInterval(interval); }
    }).observe(authScreen, { attributes: true });
}

// ══════════════════════════════════════════════════════
// PWA — service worker registration + auto-update
// ══════════════════════════════════════════════════════
function registerServiceWorker() {
    if (!('serviceWorker' in navigator)) return;
    window.addEventListener('load', async () => {
        try {
            const reg = await navigator.serviceWorker.register('/sw.js');
            // When a new SW is found, tell it to activate right away
            reg.addEventListener('updatefound', () => {
                const sw = reg.installing;
                if (!sw) return;
                sw.addEventListener('statechange', () => {
                    if (sw.state === 'installed' && navigator.serviceWorker.controller) {
                        sw.postMessage('skip-waiting');
                    }
                });
            });
            // Periodically check for a newer version while the app is open
            setInterval(() => reg.update().catch(() => {}), 60 * 1000);
        } catch {}
    });
    // The new SW took control → reload once to pick up fresh code
    let reloaded = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
        if (reloaded) return;
        reloaded = true;
        location.reload();
    });
}

// ══════════════════════════════════════════════════════
// START
// ══════════════════════════════════════════════════════

registerServiceWorker();
document.addEventListener('DOMContentLoaded', init);
