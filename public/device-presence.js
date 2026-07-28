// ═════════════════════════════════════════════════════════════
//  DEVICE PRESENCE — tab list
//  Every participant and every device, myself always included.
//  Row = colored dot (user color) + nickname + device kind (PC / Mobile).
//  Every device counts as +1 in the online badge.
// ═════════════════════════════════════════════════════════════
(function () {
    'use strict';

    var sessions = [];
    var meta = {
        selfUserId: null, selfUsername: 'you', selfClientId: null,
        selfSocketId: null, selfColor: '', others: []
    };
    var tipEl = null;

    var PALETTE = ['#4ade80', '#60a5fa', '#c084fc', '#fb923c', '#f472b6', '#34d399', '#fbbf24', '#f87171'];

    // Lucide-style stroke icons — same family as the rest of the app (no emoji)
    var ICONS = {
        pc:     '<rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8"/><path d="M12 17v4"/>',
        mobile: '<rect x="5" y="2" width="14" height="20" rx="2"/><path d="M12 18h.01"/>',
        tablet: '<rect x="4" y="2" width="16" height="20" rx="2"/><path d="M12 18h.01"/>'
    };

    function byId(id) { return document.getElementById(id); }

    function esc(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    function iconFor(kind) {
        var k = String(kind || '').toLowerCase();
        if (k.indexOf('mobile') === 0 || k.indexOf('phone') === 0) return ICONS.mobile;
        if (k.indexOf('tablet') === 0 || k.indexOf('ipad') === 0) return ICONS.tablet;
        return ICONS.pc;
    }

    function svg(kind) {
        return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" ' +
            'stroke-linecap="round" stroke-linejoin="round" ' +
            'style="width:12px;height:12px;flex:0 0 auto;opacity:.55">' + iconFor(kind) + '</svg>';
    }

    // Stable fallback color when the server did not send one
    function hashColor(seed) {
        var s = String(seed || ''), h = 0;
        for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 100000;
        return PALETTE[h % PALETTE.length];
    }

    function colorFor(r) {
        if (r.color) return r.color;
        if (r.self && meta.selfColor) return meta.selfColor;
        var known = (meta.others || []).filter(function (u) {
            return u && String(u.userId) === String(r.userId) && u.color;
        })[0];
        if (known) return known.color;
        return hashColor(r.userId || r.username);
    }

    // Local guess for my own device, so I am listed even before the server answers
    function selfKind() {
        var ua = navigator.userAgent || '';
        if (/iPad|Tablet|Nexus 7|SM-T/i.test(ua)) return 'Tablet';
        if (/Mobi|Android|iPhone|iPod|Windows Phone/i.test(ua)) return 'Mobile';
        if ((navigator.maxTouchPoints || 0) > 1 && /Macintosh/i.test(ua)) return 'Tablet';
        return 'PC';
    }

    function sameUser(a, b) { return a != null && b != null && String(a) === String(b); }

    function isSelfSession(s) {
        if (meta.selfClientId && s.clientId) return s.clientId === meta.selfClientId;
        if (meta.selfSocketId && s.socketId) return s.socketId === meta.selfSocketId;
        return false;
    }

    function rows() {
        var out = [];
        var seen = {};
        (sessions || []).forEach(function (s) {
            var key = String(s.clientId || s.socketId || (s.userId + '|' + s.kind));
            if (seen[key]) return;
            seen[key] = true;
            out.push({
                userId: s.userId,
                username: s.username || 'user',
                color: s.color || '',
                kind: s.kind || 'Device',
                os: s.os,
                browser: s.browser,
                self: isSelfSession(s)
            });
        });

        // Me: always present in the list
        if (!out.some(function (r) { return r.self; })) {
            out.push({
                userId: meta.selfUserId,
                username: meta.selfUsername || 'you',
                color: meta.selfColor || '',
                kind: selfKind(),
                self: true
            });
        }

        // Anyone the server list missed (e.g. presence arrived only via cursors)
        (meta.others || []).forEach(function (u) {
            if (sameUser(u.userId, meta.selfUserId)) return;
            if (out.some(function (r) { return sameUser(r.userId, u.userId); })) return;
            out.push({
                userId: u.userId, username: u.username || 'user',
                color: u.color || '', kind: 'Device', self: false
            });
        });

        out.sort(function (a, b) {
            if (a.self !== b.self) return a.self ? -1 : 1;
            var n = String(a.username).localeCompare(String(b.username));
            if (n) return n;
            return String(a.kind).localeCompare(String(b.kind));
        });
        return out;
    }

    function rowHTML(r) {
        var col = colorFor(r);
        // Only the device kind (PC / Mobile / Tablet) — no OS/browser, so long
        // nicknames always fit.
        var kind = String(r.kind || 'PC');
        return '<div class="online-user-item dp-row" style="display:flex;align-items:center;gap:8px;min-width:0;">' +
                '<span class="online-user-dot" style="background:' + esc(col) + ';flex:0 0 auto;"></span>' +
                '<span style="color:#e8e8e8;font-weight:500;flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' +
                    esc(r.username) + (r.self ? '<span style="opacity:.45"> (you)</span>' : '') +
                '</span>' +
                svg(kind) +
                '<span style="opacity:.5;flex:0 0 auto;white-space:nowrap;">' + esc(kind) + '</span>' +
            '</div>';
    }

    function paint() {
        var list = rows();
        var total = list.length;

        var num = byId('online-num');
        if (num) {
            if (num.textContent !== String(total)) num.textContent = String(total);
            var people = {};
            list.forEach(function (r) { people[String(r.userId)] = 1; });
            var pc = Object.keys(people).length;
            num.title = pc + (pc === 1 ? ' person' : ' people') + ', ' +
                total + (total === 1 ? ' device' : ' devices');
        }

        var tip = tipEl || byId('online-tooltip');
        if (!tip) return total;
        tip.innerHTML =
            '<div id="device-presence">' +
                '<div style="padding:2px 12px 5px;font-size:9px;letter-spacing:.14em;text-transform:uppercase;opacity:.4;">' +
                    'online ' + total +
                '</div>' +
                list.map(rowHTML).join('') +
            '</div>';
        return total;
    }

    window.SpaceDevices = {
        renderTooltip: function (el, m) {
            try {
                tipEl = el || tipEl;
                if (m) {
                    if (m.selfUserId) meta.selfUserId = m.selfUserId;
                    if (m.selfUsername) meta.selfUsername = m.selfUsername;
                    if (m.selfClientId) meta.selfClientId = m.selfClientId;
                    if (m.selfColor) meta.selfColor = m.selfColor;
                    if (m.selfSocketId || m.selfId) meta.selfSocketId = m.selfSocketId || m.selfId;
                    if (Array.isArray(m.others)) meta.others = m.others;
                }
                paint();
                return true;
            } catch (e) { return false; }
        },

        update: function (payload, m) {
            if (m) {
                if (m.selfClientId) meta.selfClientId = m.selfClientId;
                if (m.selfId) meta.selfSocketId = m.selfId;
                if (m.selfUserId) meta.selfUserId = m.selfUserId;
                if (m.selfColor) meta.selfColor = m.selfColor;
            }
            if (!payload) return;
            if (Array.isArray(payload.sessions)) {
                sessions = payload.sessions;
            } else if (Array.isArray(payload.users)) {
                sessions = [];
                payload.users.forEach(function (u) {
                    var devs = (u.devices && u.devices.length) ? u.devices : [{ kind: 'Device', clientId: u.userId }];
                    devs.forEach(function (d) {
                        sessions.push({
                            userId: u.userId, username: u.username, color: u.color,
                            clientId: d.clientId, socketId: d.socketId,
                            kind: d.kind, os: d.os, browser: d.browser
                        });
                    });
                });
            }
            paint();
        },

        kindFor: function (clientId) {
            var hit = (sessions || []).filter(function (s) { return s.clientId === clientId; })[0];
            return hit ? (hit.kind || '') : '';
        },

        get total() { return rows().length; },
        get rows() { return rows(); },
        get sessions() { return sessions.slice(); }
    };

    function boot() { tipEl = byId('online-tooltip'); if (tipEl) paint(); }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
    else boot();
})();
