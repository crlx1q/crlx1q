// ══════════════════════════════════════════════════════════
//  DEVICE PRESENCE
//  Every connected DEVICE counts as +1, not every account.
//  2 people (iPhone) + you (PC + phone) => 3 devices.
//  Extra tabs on the same device collapse into one row (server dedupes by clientId).
// ══════════════════════════════════════════════════════════
(function () {
    'use strict';

    var data = { sessions: [], selfClientId: null, selfSocketId: null, selfUserId: null };
    var observer = null;

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
        if (k.indexOf('mobile') === 0) return ICONS.mobile;
        if (k.indexOf('tablet') === 0) return ICONS.tablet;
        return ICONS.pc;
    }

    function svg(kind) {
        return '<svg class="dp-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
            'stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" ' +
            'style="width:12px;height:12px;flex-shrink:0;opacity:.7">' + iconFor(kind) + '</svg>';
    }

    // De-duplicate by clientId (belt and braces — the server already does it)
    function uniqueSessions() {
        var seen = {};
        var out = [];
        (data.sessions || []).forEach(function (s) {
            var key = String(s.clientId || s.socketId || s.userId);
            if (seen[key]) return;
            seen[key] = true;
            out.push(s);
        });
        // own devices first, then by username, then by device kind
        out.sort(function (a, b) {
            var sa = String(a.userId) === String(data.selfUserId) ? 0 : 1;
            var sb = String(b.userId) === String(data.selfUserId) ? 0 : 1;
            if (sa !== sb) return sa - sb;
            var n = String(a.username || '').localeCompare(String(b.username || ''));
            if (n) return n;
            return String(a.kind || '').localeCompare(String(b.kind || ''));
        });
        return out;
    }

    function isSelfDevice(s) {
        if (data.selfClientId && s.clientId) return s.clientId === data.selfClientId;
        return !!(data.selfSocketId && s.socketId === data.selfSocketId);
    }

    function rowHTML(s) {
        var meta = [s.os, s.browser].filter(Boolean).join(' ');
        return '<div class="online-user-item dp-row" style="display:flex;align-items:center;gap:7px;">' +
                svg(s.kind) +
                '<span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' +
                    esc(s.username || 'user') +
                    '<span style="opacity:.75"> ' + esc(s.kind || 'Device') + '</span>' +
                    (meta ? '<span style="opacity:.4"> ' + esc(meta) + '</span>' : '') +
                '</span>' +
                (isSelfDevice(s) ? '<span style="opacity:.45;flex-shrink:0">you</span>' : '') +
            '</div>';
    }

    function render() {
        var tip = byId('online-tooltip');
        var list = uniqueSessions();
        var total = list.length;

        // The counter shows DEVICES: every device is +1
        var num = byId('online-num');
        if (num && total) {
            if (num.textContent !== String(total)) num.textContent = String(total);
            var people = {};
            list.forEach(function (s) { people[String(s.userId)] = 1; });
            var pc = Object.keys(people).length;
            num.title = pc + (pc === 1 ? ' person' : ' people') + ', ' +
                total + (total === 1 ? ' device' : ' devices');
        }

        if (!tip) return;

        // "Only you" placeholder is wrong once several devices are connected
        if (total > 1) {
            Array.prototype.slice.call(tip.querySelectorAll('.online-user-item')).forEach(function (el) {
                if (!el.classList.contains('dp-row') && el.textContent.trim().toLowerCase() === 'only you') el.remove();
            });
        }

        var box = tip.querySelector('#device-presence');
        if (!box) {
            box = document.createElement('div');
            box.id = 'device-presence';
            tip.appendChild(box);
        }
        if (!total) { box.innerHTML = ''; return; }

        box.innerHTML =
            '<div style="border-top:1px solid var(--border-h, rgba(255,255,255,.1));margin-top:5px;padding-top:5px;">' +
                '<div style="padding:2px 12px 4px;font-size:9px;letter-spacing:.14em;text-transform:uppercase;opacity:.45;">' +
                    'devices ' + total +
                '</div>' +
                list.map(rowHTML).join('') +
            '</div>';
    }

    // space.js rewrites the tooltip with innerHTML — re-attach our block when it does
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
                // Older server without per-device sessions
                data.sessions = [];
                payload.users.forEach(function (u) {
                    var devs = (u.devices && u.devices.length) ? u.devices : [{ kind: 'Device', clientId: u.userId }];
                    devs.forEach(function (d) {
                        data.sessions.push({
                            userId: u.userId, username: u.username, color: u.color,
                            clientId: d.clientId, socketId: d.socketId,
                            kind: d.kind, os: d.os, browser: d.browser
                        });
                    });
                });
            }
            if (meta) {
                if (meta.selfClientId) data.selfClientId = meta.selfClientId;
                if (meta.selfId) data.selfSocketId = meta.selfId;
                if (meta.selfUserId) data.selfUserId = meta.selfUserId;
            }
            watch();
            render();
        },
        // Device label for a given clientId (used for remote cursor labels)
        kindFor: function (clientId) {
            var hit = (data.sessions || []).filter(function (s) { return s.clientId === clientId; })[0];
            return hit ? (hit.kind || '') : '';
        },
        get total() { return uniqueSessions().length; },
        get sessions() { return uniqueSessions(); }
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', watch);
    } else {
        watch();
    }
})();
