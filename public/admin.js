/* ═══════════════════════════════════════════
   CRLX1Q ADMIN — CLIENT LOGIC v2
   ═══════════════════════════════════════════ */

let adminToken = localStorage.getItem('crlx_admin_token');

const loginScreen = document.getElementById('login-screen');
const appScreen   = document.getElementById('app-screen');
const loginForm   = document.getElementById('login-form');
const loginErr    = document.getElementById('login-err');

if (adminToken) showApp();

loginForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const pwd = document.getElementById('login-pwd').value;
    try {
        const res = await fetch('/api/admin/auth', {
            method: 'POST',
            body: JSON.stringify({ password: pwd })
        });
        const data = await res.json();
        if (data.token) {
            adminToken = data.token;
            localStorage.setItem('crlx_admin_token', adminToken);
            showApp();
        } else {
            showLoginError();
        }
    } catch {
        showLoginError();
    }
});

let shakeTimeout;
function showLoginError() {
    const row = document.getElementById('login-row');
    row.classList.remove('animate-error-shake');
    void row.offsetWidth; // trigger reflow
    row.classList.add('animate-error-shake');
    
    loginErr.classList.add('show');
    
    clearTimeout(shakeTimeout);
    shakeTimeout = setTimeout(() => {
        row.classList.remove('animate-error-shake');
    }, 3000);
}

document.getElementById('logout-btn').addEventListener('click', () => {
    localStorage.removeItem('crlx_admin_token');
    location.reload();
});

function showApp() {
    loginScreen.classList.add('gone');
    appScreen.classList.add('show');
    loadDashboard();
}

async function api(path, method = 'GET', body = null) {
    const opts = { method, headers: { 'Authorization': 'Bearer ' + adminToken } };
    if (body) opts.body = JSON.stringify(body);
    const res = await fetch(path, opts);
    if (res.status === 401) { localStorage.removeItem('crlx_admin_token'); location.reload(); return; }
    return res.json();
}

// Navigation
document.querySelectorAll('.sb-link[data-target]').forEach(btn => {
    btn.addEventListener('click', () => {
        document.querySelectorAll('.sb-link').forEach(n => n.classList.remove('on'));
        btn.classList.add('on');
        document.querySelectorAll('.view').forEach(v => v.classList.remove('on'));
        const t = btn.getAttribute('data-target');
        document.getElementById('view-' + t).classList.add('on');
        if (t === 'dashboard') loadDashboard();
        if (t === 'articles')  loadArticles();
        if (t === 'projects')  loadProjects();
        if (t === 'board')     loadBoard();
        if (t === 'space-users') loadSpaceUsers();
    });
});

/* ── DASHBOARD ─────────────────────────────── */
async function loadDashboard() {
    const s = await api('/api/admin/stats');
    if (!s) return;
    const grid = document.getElementById('stats-grid');
    const d = Math.floor(s.uptime / 86400);
    const h = Math.floor((s.uptime % 86400) / 3600);
    const m = Math.round(s.memory.rss / 1024 / 1024);

    grid.innerHTML = `
        <div class="stat">
            <div class="stat-label">uptime</div>
            <div class="stat-val g">${d}d ${h}h</div>
            <div class="stat-sub">${Math.floor(s.uptime)}s total</div>
        </div>
        <div class="stat">
            <div class="stat-label">memory (rss)</div>
            <div class="stat-val">${m}<span style="font-size:14px;color:var(--dim)"> MB</span></div>
            <div class="stat-sub">heap: ${Math.round(s.memory.heapUsed / 1024 / 1024)} MB</div>
        </div>
        <div class="stat">
            <div class="stat-label">projects</div>
            <div class="stat-val">${s.projectsCount}</div>
            <div class="stat-sub">registered</div>
        </div>
        <div class="stat">
            <div class="stat-label">articles</div>
            <div class="stat-val">${s.articlesCount}</div>
            <div class="stat-sub">published</div>
        </div>
    `;
}

/* ── ARTICLES ──────────────────────────────── */
let currentArticles = [];
async function loadArticles() {
    const data = await fetch('/api/articles').then(r => r.json());
    currentArticles = data;
    const tbody = document.getElementById('articles-table-body');
    tbody.innerHTML = data.map(a => {
        const title = a.title?.ru || a.title?.en || '—';
        return `<tr>
            <td style="font-family:'JetBrains Mono',monospace;font-size:11px;color:var(--dim)">${a.date || ''}</td>
            <td class="td-b">${title}</td>
            <td><span class="likes"><svg width="12" height="12" fill="currentColor" viewBox="0 0 24 24"><path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/></svg>${a.likes||0}</span></td>
            <td class="td-r">
                <button class="act act-e" onclick="editArticle('${a.id}')">edit</button>
                <button class="act act-d" onclick="deleteArticle('${a.id}')">del</button>
            </td>
        </tr>`;
    }).join('');
}

function openArticleModal() {
    document.getElementById('article-modal').classList.add('show');
    document.getElementById('article-modal-title').textContent = 'new article';
    document.getElementById('article-id').value = '';
    document.getElementById('article-title-en').value = '';
    document.getElementById('article-title-ru').value = '';
    document.getElementById('article-desc-en').value = '';
    document.getElementById('article-desc-ru').value = '';
    document.getElementById('article-date').value = new Date().toISOString().split('T')[0].replace(/-/g, '.');
    document.getElementById('article-readTime').value = '';
    document.getElementById('article-tags').value = '';
    document.getElementById('article-cover').value = '';
    document.getElementById('article-cover-preview').classList.remove('show');
    document.getElementById('article-content-en').value = '';
    document.getElementById('article-content-ru').value = '';
}

function editArticle(id) {
    const a = currentArticles.find(x => x.id === id);
    if (!a) return;
    openArticleModal();
    document.getElementById('article-modal-title').textContent = 'edit article';
    document.getElementById('article-id').value = a.id;
    document.getElementById('article-title-en').value = a.title?.en || '';
    document.getElementById('article-title-ru').value = a.title?.ru || '';
    document.getElementById('article-desc-en').value = a.desc?.en || '';
    document.getElementById('article-desc-ru').value = a.desc?.ru || '';
    document.getElementById('article-date').value = a.date || '';
    document.getElementById('article-readTime').value = a.readTime || '';
    document.getElementById('article-tags').value = (a.tags || []).join(', ');
    document.getElementById('article-cover').value = a.coverImage || '';
    const pv = document.getElementById('article-cover-preview');
    if (a.coverImage) { pv.style.backgroundImage = `url(${a.coverImage})`; pv.classList.add('show'); }
    else { pv.classList.remove('show'); }
    document.getElementById('article-content-en').value = a.content?.en || '';
    document.getElementById('article-content-ru').value = a.content?.ru || '';
}

async function saveArticle() {
    const id = document.getElementById('article-id').value;
    const cEn = document.getElementById('article-content-en').value;
    const cRu = document.getElementById('article-content-ru').value;
    let rt = document.getElementById('article-readTime').value;
    if (!rt) {
        const w = (cEn.length + cRu.length) / 5;
        rt = Math.max(1, Math.ceil(w / 200)) + ' min read';
    }
    const payload = {
        title: { en: document.getElementById('article-title-en').value, ru: document.getElementById('article-title-ru').value },
        desc: { en: document.getElementById('article-desc-en').value, ru: document.getElementById('article-desc-ru').value },
        date: document.getElementById('article-date').value, readTime: rt,
        tags: document.getElementById('article-tags').value.split(',').map(x => x.trim()).filter(Boolean),
        coverImage: document.getElementById('article-cover').value,
        content: { en: cEn, ru: cRu }
    };
    if (id) await api('/api/admin/articles/' + id, 'PUT', payload);
    else await api('/api/admin/articles', 'POST', payload);
    closeModal('article-modal');
    loadArticles();
}

async function deleteArticle(id) {
    if (confirm('Delete this article?')) { await api('/api/admin/articles/' + id, 'DELETE'); loadArticles(); }
}

// Ctrl+V image upload
document.getElementById('article-cover').addEventListener('paste', async (e) => {
    const items = (e.clipboardData || e.originalEvent.clipboardData).items;
    for (const item of items) {
        if (item.kind === 'file') {
            e.preventDefault();
            const blob = item.getAsFile();
            const reader = new FileReader();
            reader.onload = async (ev) => {
                const input = document.getElementById('article-cover');
                input.value = 'uploading...';
                try {
                    const res = await api('/api/admin/upload', 'POST', { image: ev.target.result });
                    if (res && res.url) {
                        input.value = res.url;
                        const pv = document.getElementById('article-cover-preview');
                        pv.style.backgroundImage = `url(${res.url})`;
                        pv.classList.add('show');
                    }
                } catch { alert('upload failed'); input.value = ''; }
            };
            reader.readAsDataURL(blob);
        }
    }
});

/* ── PROJECTS ──────────────────────────────── */
let currentProjects = [];
async function loadProjects() {
    const data = await fetch('/api/projects').then(r => r.json());
    currentProjects = data;
    const tbody = document.getElementById('projects-table-body');
    tbody.innerHTML = data.map(p => {
        const sc = p.status === 'live' ? 'tag-g' : p.status === 'wip' ? 'tag-y' : 'tag-r';
        return `<tr>
            <td class="td-b">${p.name}</td>
            <td><span class="tag ${sc}">${p.status || 'offline'}</span></td>
            <td>${p.flagship ? '★' : '—'}</td>
            <td class="td-r">
                <button class="act act-e" onclick="editProject('${p.id||p.name}')">edit</button>
                <button class="act act-d" onclick="deleteProject('${p.id||p.name}')">del</button>
            </td>
        </tr>`;
    }).join('');
}

function openProjectModal() {
    document.getElementById('project-modal').classList.add('show');
    document.getElementById('project-modal-title').textContent = 'new project';
    document.getElementById('project-id').value = '';
    document.getElementById('project-name').value = '';
    document.getElementById('project-url').value = '';
    document.getElementById('project-flagship').checked = false;
    document.getElementById('project-wide').checked = false;
    document.getElementById('project-status').value = 'live';
    document.getElementById('project-tags').value = '';
    document.getElementById('project-desc').value = '';
}

function editProject(id) {
    const p = currentProjects.find(x => x.id === id || x.name === id);
    if (!p) return;
    openProjectModal();
    document.getElementById('project-modal-title').textContent = 'edit project';
    document.getElementById('project-id').value = p.id || p.name;
    document.getElementById('project-name').value = p.name || '';
    document.getElementById('project-url').value = p.url || '';
    document.getElementById('project-flagship').checked = !!p.flagship;
    document.getElementById('project-wide').checked = !!p.wide;
    document.getElementById('project-status').value = p.status || 'offline';
    document.getElementById('project-tags').value = (p.tags || []).join(', ');
    document.getElementById('project-desc').value = p.desc || '';
}

async function saveProject() {
    const id = document.getElementById('project-id').value;
    const payload = {
        name: document.getElementById('project-name').value,
        url: document.getElementById('project-url').value,
        flagship: document.getElementById('project-flagship').checked,
        wide: document.getElementById('project-wide').checked,
        status: document.getElementById('project-status').value,
        tags: document.getElementById('project-tags').value.split(',').map(x => x.trim()).filter(Boolean),
        desc: document.getElementById('project-desc').value
    };
    if (id) await api('/api/admin/projects/' + id, 'PUT', payload);
    else await api('/api/admin/projects', 'POST', payload);
    closeModal('project-modal');
    loadProjects();
}

async function deleteProject(id) {
    if (confirm('Delete project?')) { await api('/api/admin/projects/' + id, 'DELETE'); loadProjects(); }
}

/* ── BOARD ─────────────────────────────────── */
async function loadBoard() {
    const data = await fetch('/api/board').then(r => r.json());
    const grid = document.getElementById('board-grid');
    grid.innerHTML = data.map(b => `
        <div class="b-card">
            <button class="b-del" onclick="deleteBoardMsg('${b.id}')">
                <svg width="16" height="16" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"/></svg>
            </button>
            <div class="b-who">
                <div class="b-av">${(b.author||'?')[0]}</div>
                <span class="b-name">${b.author}</span>
                <span class="b-cc">GUEST</span>
            </div>
            <div class="b-msg">${b.text}</div>
            <div class="b-date">${new Date(b.date || b.createdAt).toLocaleString()}</div>
        </div>
    `).join('');
}

async function deleteBoardMsg(id) {
    if (confirm('Delete message?')) { await api('/api/admin/board/' + id, 'DELETE'); loadBoard(); }
}

function closeModal(id) { document.getElementById(id).classList.remove('show'); }

/* ── SPACE USERS ──────────────────────────────── */
let spaceUsers = [];

async function loadSpaceUsers() {
    const data = await api('/api/admin/space/users');
    if (!data) return;
    spaceUsers = data;

    const total   = data.length;
    const pending = data.filter(u => !u.newReg).length;
    const active  = data.filter(u => u.newReg).length;

    document.getElementById('su-total').textContent   = total;
    document.getElementById('su-pending').textContent = pending;
    document.getElementById('su-active').textContent  = active;

    // Show/hide pending badge in sidebar
    const badge = document.getElementById('pending-badge');
    if (badge) badge.style.display = pending > 0 ? 'inline' : 'none';

    const tbody = document.getElementById('space-users-tbody');
    if (!tbody) return;

    tbody.innerHTML = data.map(u => {
        const regDate  = u.createdAt ? new Date(u.createdAt).toLocaleDateString() : '—';
        const lastSeen = u.lastSeen  ? new Date(u.lastSeen).toLocaleString()      : '—';
        const statusTag = u.newReg
            ? `<span class="tag tag-g">approved</span>`
            : `<span class="tag tag-y">pending</span>`;
        const roleCls = u.role === 'owner' ? 'tag-g' : u.role === 'viewer' ? 'tag-r' : '';
        const toggleLabel = u.newReg ? 'Revoke' : 'Approve';
        const toggleCls   = u.newReg ? 'act-d' : 'act-e';

        return `<tr>
            <td>
                <div style="display:flex;align-items:center;gap:8px">
                    <div style="width:26px;height:26px;border:1px solid rgba(255,255,255,0.07);display:flex;align-items:center;justify-content:center;font-size:10px;font-weight:700;background:${u.color||'#111'}20;color:${u.color||'#888'}">${(u.username||'?')[0].toUpperCase()}</div>
                    <div>
                        <div style="font-weight:600;font-size:12px">${u.username}</div>
                        <div style="font-size:9px;color:var(--muted)">${u.email}</div>
                    </div>
                </div>
            </td>
            <td><span class="tag ${roleCls}">${u.role}</span></td>
            <td style="font-family:'JetBrains Mono',monospace;font-size:10px;color:var(--muted)">${regDate}</td>
            <td style="font-family:'JetBrains Mono',monospace;font-size:10px;color:var(--dim)">${lastSeen}</td>
            <td>${statusTag}</td>
            <td class="td-r">
                <button class="act ${toggleCls}" onclick="toggleSpaceApproval('${u._id}', ${!u.newReg})">${toggleLabel}</button>
                <button class="act" style="color:var(--dim)" onclick="changeSpaceRole('${u._id}', '${u.role}')">${u.role === 'owner' ? 'owner' : '&#8645; role'}</button>
                <button class="act act-d" onclick="deleteSpaceUser('${u._id}', '${u.username}')">del</button>
            </td>
        </tr>`;
    }).join('');
}

async function toggleSpaceApproval(id, approve) {
    const label = approve ? 'approve' : 'revoke';
    if (!confirm(`${label} access for this user?`)) return;
    await api('/api/admin/space/users/' + id, 'PATCH', { newReg: approve });
    loadSpaceUsers();
}

async function changeSpaceRole(id, currentRole) {
    const roles = ['member', 'viewer', 'owner'];
    const next = roles[(roles.indexOf(currentRole) + 1) % roles.length];
    if (!confirm(`Change role to "${next}"?`)) return;
    await api('/api/admin/space/users/' + id, 'PATCH', { role: next });
    loadSpaceUsers();
}

async function deleteSpaceUser(id, username) {
    if (!confirm(`Delete user "${username}" permanently?\n\nThis will NOT delete their canvas data.`)) return;
    await api('/api/admin/space/users/' + id, 'DELETE');
    loadSpaceUsers();
}

// Auto-check pending users after login
const _origShowApp = showApp;
