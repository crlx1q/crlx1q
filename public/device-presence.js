// ═══════════════════════════════════════════════════════════
//  DEVICE PRESENCE  —  shows WHICH devices are online,
//  not just which accounts. One row per live session,
//  e.g. "admin · PC", "admin · Mobile".
//  Fed by the extra `space:online` listener in space.js.
// ═══════════════════════════════════════════════════════════
(function () {
    'use strict';

    var data = { sessions: [], selfSocketId: null, selfUserId: null };
    var observer = null;

    function byId(id) { return document.getElementById(id); }

    function esc(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    function icon(kind) {
        var k = String(kind || '').toLowerCase();
        if (k.indexOf('mobile') === 0) return '📱';
        if (k.indexOf('tablet') === 0) return '📲';
        return '🖥';
    }

    // Group live sessions by user so devices of one account stay together
    function grouped() {
        var order = [];
        var map = {};
        (data.sessions || []).forEach(function (s) {
            var key = String(s.userId || s.socketId);
            if (!map[key]) { map[key] = { username: s.username || 'user', color: s.color || '', userId: s.userId, devices: [] }; order.push(key); }
            map[key].devices.push(s);
        });
        // self first, then everyone else alphabetically
        order.sort(function (a, b) {
            var sa = a === String(data.selfUserId) ? 0 : 1;
            var sb = b === String(data.selfUserId) ? 0 : 1;
            if (sa !== sb) return sa - sb;
            return String(map[a].username).localeCompare(String(map[b].username));
        });
        return order.map(function (k) { return map[k]; });
    }

    function rowHTML(user, dev) {
        var isSelf = data.selfSocketId && dev.socketId === data.selfSocketId;
        var meta = [dev.os, dev.browser].filter(Boolean).join(' · ');
        return '' +
            '<div class="dp-row" style="display:flex;align-items:center;gap:7px;padding:4px 12px;font-size:10px;line-height:1.3;">' +
                '<span style="width:12px;text-align:center;flex-shrink:0;">' + icon(dev.kind) + '</span>' +
                '<span style="width:6px;height:6px;border-radius:50%;flex-shrink:0;background:' + esc(user.color || '#4ade80') + ';"></span>' +
                '<span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' +
                    '<b style="font-weight:600;">' + esc(user.username) + '</b> ' +
                    '<span style="opacity:.85;">' + esc(dev.kind || 'Device') + '</span>' +
                    (meta ? '<span style="opacity:.5;"> — ' + esc(meta) + '</span>' : '') +
                '</span>' +
                (isSelf ? '<span style="opacity:.55;flex-shrink:0;">you</span>' : '') +
            '</div>';
    }

    function render() {
        var tip = byId('online-tooltip');
        if (!tip) return;

        var box = tip.querySelector('#device-presence');
        if (!box) {
            box = document.createElement('div');
            box.id = 'device-presence';
            tip.appendChild(box);
        }

        var users = grouped();
        var total = (data.sessions || []).length;
        if (!total) { box.innerHTML = ''; return; }

        var html = '<div style="border-top:1px solid var(--border-h, rgba(255,255,255,.12));margin-top:6px;padding-top:6px;">' +
            '<div style="padding:2px 12px 5px;font-size:9px;letter-spacing:.12em;text-transform:uppercase;opacity:.5;">' +
                'Devices · ' + total +
            '</div>';
        users.forEach(function (u) {
            u.devices.forEach(function (d) { html += rowHTML(u, d); });
        });
        html += '</div>';
        box.innerHTML = html;

        // Counter tooltip: "3 devices / 2 people"
        var num = byId('online-num');
        if (num) {
            num.title = users.length + (users.length === 1 ? ' person' : ' people') +
                ' · ' + total + (total === 1 ? ' device' : ' devices');
        }
        var badge = byId('online-device-num');
        if (badge) badge.textContent = total;
    }

    // The tooltip is re-rendered by space.js (innerHTML = ...), which wipes our
    // block — re-append it whenever that happens.
    function watch() {
        var tip = byId('online-tooltip');
        if (!tip || observer) return;
        observer = new MutationObserver(function () {
            if (!tip.querySelector('#device-presence')) render();
        });
        observer.observe(tip, { childList: true });
    }

    window.SpaceDevices = {
        update: function (payload, meta) {
            if (!payload) return;
            if (Array.isArray(payload.sessions)) {
                data.sessions = payload.sessions;
            } else if (Array.isArray(payload.users)) {
                // Fallback for an older server without per-device sessions
                data.sessions = [];
                payload.users.forEach(function (u) {
                    (u.devices && u.devices.length ? u.devices : [{ kind: 'Device', socketId: u.userId }])
                        .forEach(function (d) {
                            data.sessions.push({
                                userId: u.userId, username: u.username, color: u.color,
                                socketId: d.socketId, kind: d.kind, os: d.os, browser: d.browser
                            });
                        });
                });
            }
            if (meta) {
                if (meta.selfId) data.selfSocketId = meta.selfId;
                if (meta.selfUserId) data.selfUserId = meta.selfUserId;
            }
            watch();
            render();
        },
        get sessions() { return data.sessions.slice(); }
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', watch);
    } else {
        watch();
    }
})();
