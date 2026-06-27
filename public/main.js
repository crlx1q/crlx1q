
    (() => {
        'use strict';

        // Site uptime — measured from page load
        window.__siteStartTime = Date.now();

        const prefersReduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
        const isTouch = matchMedia('(hover: none), (pointer: coarse)').matches;
        const DPR = Math.min(window.devicePixelRatio || 1, 1.5);

        // ============================================================
        // ADAPTIVE RENDER PIPELINE (System-Aware Quality)
        // ============================================================
        const RenderPipeline = {
            quality: 'auto',              // user choice: auto | full | eco
            effectiveQuality: 'balanced', // runtime: eco | balanced | max
            bgEvery: 3,                   // frame skip for BG canvas
            glowRadius: 220,              // cursor glow radius
            shimmerEnabled: true,         // shimmer on ASCII art
            fpsBuffer: [],                // last N fps readings (~5 sec)
            _listeners: [],

            init() {
                try {
                    const saved = localStorage.getItem('crlx1q_quality');
                    if (saved && ['auto','full','eco'].includes(saved)) this.quality = saved;
                } catch(e) {}

                const saveData = navigator.connection && navigator.connection.saveData;
                if (this.quality === 'eco' || prefersReduced || saveData) {
                    this.applyEco();
                } else if (this.quality === 'full') {
                    this.applyMax();
                } else {
                    this.applyBalanced();
                }
            },

            adjustQuality(currentFps) {
                if (this.quality !== 'auto') return;
                this.fpsBuffer.push(currentFps);
                if (this.fpsBuffer.length > 10) this.fpsBuffer.shift();
                if (this.fpsBuffer.length < 5) return;
                const avg = this.fpsBuffer.reduce((a,b) => a+b, 0) / this.fpsBuffer.length;
                if (avg < 40 && this.effectiveQuality !== 'eco') {
                    this.applyEco();
                } else if (avg > 55 && this.effectiveQuality === 'eco') {
                    this.applyBalanced();
                } else if (avg > 58 && this.effectiveQuality === 'balanced') {
                    this.applyMax();
                }
            },

            applyEco() {
                this.effectiveQuality = 'eco';
                this.bgEvery = 6;
                this.glowRadius = 120;
                this.shimmerEnabled = false;
                this._notify();
            },
            applyBalanced() {
                this.effectiveQuality = 'balanced';
                this.bgEvery = 3;
                this.glowRadius = 220;
                this.shimmerEnabled = true;
                this._notify();
            },
            applyMax() {
                this.effectiveQuality = 'max';
                this.bgEvery = 1;
                this.glowRadius = 300;
                this.shimmerEnabled = true;
                this._notify();
            },

            setQuality(mode) {
                this.quality = mode;
                try { localStorage.setItem('crlx1q_quality', mode); } catch(e) {}
                this.fpsBuffer = [];
                if (mode === 'eco') this.applyEco();
                else if (mode === 'full') this.applyMax();
                else this.applyBalanced(); // auto starts at balanced
            },

            getConnectionInfo() {
                if (!navigator.connection) return 'unknown';
                let info = navigator.connection.effectiveType || 'unknown';
                if (navigator.connection.saveData) info += ' [save-data]';
                return info;
            },

            onUpdate(fn) { this._listeners.push(fn); },
            _notify() { this._listeners.forEach(fn => fn(this)); }
        };

        RenderPipeline.init();
        window.__renderPipeline = RenderPipeline;

        // ============================================================
        // SPA ROUTER
        // ============================================================
        const contentWrap = document.getElementById('content-wrap');
        const spaNotes = document.getElementById('spa-notes');
        const spaBoard = document.getElementById('spa-board');

        function spaNavigate(path) {
            // Close mobile menu if open
            if (typeof closeMobileMenu === 'function') closeMobileMenu();

            // Hide all SPA pages
            contentWrap.style.display = '';
            spaNotes.classList.remove('active');
            spaBoard.classList.remove('active');

            if (path === '/notes') {
                if(contentWrap) contentWrap.style.display = 'none';
                spaNotes.classList.add('active');
                document.title = 'CRLX1Q | Notes';
                window.scrollTo(0, 0);
            } else if (path === '/board') {
                if(contentWrap) contentWrap.style.display = 'none';
                spaBoard.classList.add('active');
                document.title = 'CRLX1Q | Board';
                window.scrollTo(0, 0);
                initSpaBoardNotes();
            } else {
                document.title = 'CRLX1Q | Software Developer';
                // Handle hash navigation
                if (path.includes('#')) {
                    const hash = path.split('#')[1];
                    if (hash) {
                        setTimeout(() => {
                            const el = document.getElementById(hash);
                            if (el) el.scrollIntoView({ behavior: 'smooth' });
                        }, 100);
                    }
                }
            }

            history.pushState(null, '', path);
        }

        window.__spaNav = null;

        // Handle browser back/forward
        window.addEventListener('popstate', () => {
            const path = location.pathname;
            contentWrap.style.display = '';
            spaNotes.classList.remove('active');
            spaBoard.classList.remove('active');

            if (path === '/notes') {
                if(contentWrap) contentWrap.style.display = 'none';
                spaNotes.classList.add('active');
                document.title = 'CRLX1Q | Notes';
            } else if (path === '/board') {
                if(contentWrap) contentWrap.style.display = 'none';
                spaBoard.classList.add('active');
                document.title = 'CRLX1Q | Board';
                initSpaBoardNotes();
            } else {
                document.title = 'CRLX1Q | Software Developer';
            }
        });

        // Handle initial route on page load
        if (location.pathname === '/notes') {
            if(contentWrap) contentWrap.style.display = 'none';
            spaNotes.classList.add('active');
            document.title = 'CRLX1Q | Notes';
        } else if (location.pathname === '/board') {
            if(contentWrap) contentWrap.style.display = 'none';
            spaBoard.classList.add('active');
            document.title = 'CRLX1Q | Board';
        }

        // ============================================================
        // SPA BOARD PAGE LOGIC
        // ============================================================
        let spaBoardLoaded = false;
        
        const escapeHTMLSafe = str => {
            if (!str) return '';
            let escaped = str.replace(/[&<>'"]/g, tag => ({
                '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
            }[tag]));
            return escaped.replace(/(\p{Emoji_Presentation}|\p{Extended_Pictographic})/gu, '<span class="emoji">$1</span>');
        };

        function createSpaBoardNote(note) {
            const wrapper = document.createElement('div');
            wrapper.className = 'break-inside-avoid mb-6 w-full inline-block';
            wrapper.innerHTML = `
                <div class="relative p-5 bg-[#0a0a0a] border border-white/10 group hover:border-white/30 transition-all duration-300 hover:-translate-y-1 shadow-lg sticky-note" style="transform: rotate(${note.rot || 0}deg)">
                    <p class="font-sans text-sm text-gray-300 leading-relaxed mb-4 break-words whitespace-pre-wrap">${escapeHTMLSafe(note.text)}</p>
                    <div class="flex justify-between items-center border-t border-gray-800 pt-2 mt-auto">
                        <span class="font-mono text-[9px] text-gray-600 uppercase tracking-widest">${new Date(note.date || Date.now()).toLocaleDateString('en-GB')}</span>
                        <span class="font-mono text-[10px] text-gray-500">- ${escapeHTMLSafe(note.author)}</span>
                    </div>
                </div>
            `;
            return wrapper;
        }

        function initSpaBoardNotes() {
            const container = document.getElementById('spa-board-notes');
            if (!container) return;
            
            fetch('/api/board')
                .then(res => res.json())
                .then(data => {
                    if (Array.isArray(data)) {
                        container.innerHTML = '';
                        data.forEach(n => container.appendChild(createSpaBoardNote(n)));
                    }
                })
                .catch(() => console.error('Failed to load board notes'));
        }

        // Board page input handlers
        const spaBoardInput = document.getElementById('spa-board-input');
        const spaBoardAddBtn = document.getElementById('spa-board-add-btn');
        const spaBoardCounter = document.getElementById('spa-board-char-counter');
        const spaBoardWrap = document.getElementById('spa-board-input-wrap');
        const spaBoardWarning = document.getElementById('spa-board-warning');

        spaBoardInput?.addEventListener('input', () => {
            const len = spaBoardInput.value.length;
            spaBoardCounter.textContent = `${len}/120`;
            if (len >= 120) {
                spaBoardCounter.style.color = '#ef4444';
                spaBoardWrap.classList.add('input-error-glow');
            } else {
                spaBoardCounter.style.color = '';
                spaBoardWrap.classList.remove('input-error-glow');
                spaBoardWarning.classList.remove('opacity-100');
            }
        });

        async function handleSpaBoardPost() {
            const val = spaBoardInput.value.trim().substring(0, 120);
            if (!val) return;
            
            spaBoardAddBtn.disabled = true;
            spaBoardAddBtn.style.opacity = '0.5';

            try {
                const res = await fetch('/api/board', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ text: val })
                });
                const data = await res.json();
                if (!res.ok) {
                    spaBoardWarning.innerHTML = `<span class="inline-block animate-pulse emoji">⚠️</span> [ SYS.ERR ] ${data.error || 'ERROR'}`;
                    spaBoardWarning.classList.add('opacity-100');
                    setTimeout(() => spaBoardWarning.classList.remove('opacity-100'), 3500);
                } else {
                    const container = document.getElementById('spa-board-notes');
                    container.prepend(createSpaBoardNote(data));
                    spaBoardInput.value = '';
                    spaBoardInput.dispatchEvent(new Event('input'));
                    // Also update the main page board
                    const mainBoard = document.getElementById('notes-masonry');
                    if (mainBoard) {
                        const mainNote = createSpaBoardNote(data);
                        mainBoard.prepend(mainNote);
                    }
                }
            } catch (err) {
                spaBoardWarning.innerHTML = `<span class="inline-block animate-pulse emoji">⚠️</span> [ SYS.ERR ] CONNECTION ERROR`;
                spaBoardWarning.classList.add('opacity-100');
                setTimeout(() => spaBoardWarning.classList.remove('opacity-100'), 3500);
            } finally {
                spaBoardAddBtn.disabled = false;
                spaBoardAddBtn.style.opacity = '1';
            }
        }

        spaBoardAddBtn?.addEventListener('click', handleSpaBoardPost);
        spaBoardInput?.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') handleSpaBoardPost();
        });

        // Init board if starting on /board
        if (location.pathname === '/board') {
            setTimeout(initSpaBoardNotes, 100);
        }

        // ============================================================
        // BRAND GLITCH ANIMATION
        // ============================================================
        const brandEl = document.getElementById('nav-brand-text');
        const originalBrand = 'CRL.X1Q()';
        const glyphPool = '#$%@!&*?~^<>/\\|+=;:';
        function scheduleGlitch() { setTimeout(runGlitch, 2500 + Math.random() * 4500); }
        function runGlitch() {
            const count = 1 + Math.floor(Math.random() * 3);
            const indices = [];
            while (indices.length < count) { const i = Math.floor(Math.random() * originalBrand.length); if (!indices.includes(i)) indices.push(i); }
            let frame = 0; const totalFrames = 6 + Math.floor(Math.random() * 6);
            const interval = setInterval(() => {
                let out = '';
                for (let i = 0; i < originalBrand.length; i++) {
                    out += (indices.includes(i) && frame < totalFrames - 1) ? glyphPool[Math.floor(Math.random() * glyphPool.length)] : originalBrand[i];
                }
                brandEl.textContent = out; frame++;
                if (frame >= totalFrames) { clearInterval(interval); brandEl.textContent = originalBrand; scheduleGlitch(); }
            }, 55);
        }
        scheduleGlitch();

        // ============================================================
        // LIFE STATUS WIDGET (TERMINAL STYLE)
        // ============================================================
        const lifeIcon = document.getElementById('life-icon');
        const lifeText = document.getElementById('life-text');
        const lifeTime = document.getElementById('life-time');

        let hasBootedClock = false;
        let currentSecDeg = 0;
        let currentMinDeg = 0;
        let currentHourDeg = 0;

        function updateLifeWidget() {
            if (!lifeIcon || !lifeText || !lifeTime) return;

            const now = new Date();
            const utc = now.getTime() + (now.getTimezoneOffset() * 60000);
            const kztTime = new Date(utc + (3600000 * 5));
            const hours = kztTime.getHours();
            const minutes = kztTime.getMinutes();
            const seconds = kztTime.getSeconds();

            lifeTime.textContent = `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}`;

            let icon = '', text = '';
            // Эмодзи обернуты в .emoji для защиты цвета при светлой теме
            if (hours >= 2 && hours < 10) {
                icon = '<svg class="inline-block w-4 h-4 text-indigo-400 theme-protect" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-3px"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"></path></svg>'; text = '<span class="lang-en">Sleep</span><span class="lang-ru">Сон</span>';
            } else if (hours >= 10 && hours < 13) {
                icon = '<svg class="inline-block w-4 h-4 text-yellow-400 theme-protect" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-3px"><circle cx="12" cy="12" r="5"></circle><line x1="12" y1="1" x2="12" y2="3"></line><line x1="12" y1="21" x2="12" y2="23"></line><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"></line><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"></line><line x1="1" y1="12" x2="3" y2="12"></line><line x1="21" y1="12" x2="23" y2="12"></line><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"></line><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"></line></svg>'; text = '<span class="lang-en">Awake</span><span class="lang-ru">Проснулся</span>';
            } else if (hours >= 13 && hours < 14) {
                icon = '<svg class="inline-block w-4 h-4 text-orange-400 theme-protect" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-3px"><path d="M18 8h1a4 4 0 0 1 0 8h-1"></path><path d="M2 8h16v9a4 4 0 0 1-4 4H6a4 4 0 0 1-4-4V8z"></path><line x1="6" y1="1" x2="6" y2="4"></line><line x1="10" y1="1" x2="10" y2="4"></line><line x1="14" y1="1" x2="14" y2="4"></line></svg>'; text = '<span class="lang-en">Lunch</span><span class="lang-ru">Обед</span>';
            } else if (hours >= 14 && hours < 21) {
                icon = '<span class="text-green-400 font-bold tracking-tighter theme-protect">&lt;/&gt;</span>'; 
                text = '<span class="lang-en">Coding</span><span class="lang-ru">Программирование</span>';
            } else {
                icon = '<svg class="inline-block w-4 h-4 text-purple-400 theme-protect" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-3px"><line x1="6" y1="12" x2="10" y2="12"></line><line x1="8" y1="10" x2="8" y2="14"></line><line x1="15" y1="13" x2="15.01" y2="13"></line><line x1="18" y1="11" x2="18.01" y2="11"></line><rect x="2" y="6" width="20" height="12" rx="2"></rect></svg>'; text = '<span class="lang-en">Gaming</span><span class="lang-ru">Игры</span>';
            }
            
            lifeIcon.innerHTML = icon;
            lifeText.innerHTML = text; 

            // Clock mechanism representation
            if (!window.__bootDone) return;

            const clockH = document.getElementById('clock-h');
            const clockM = document.getElementById('clock-m');
            const clockS = document.getElementById('clock-s');

            const targetSecDeg = seconds * 6;
            const targetMinDeg = minutes * 6 + seconds * 0.1;
            const targetHourDeg = (hours % 12) * 30 + minutes * 0.5;

            if (!hasBootedClock) {
                currentSecDeg = targetSecDeg + 360 * 2;
                currentMinDeg = targetMinDeg + 360;
                currentHourDeg = targetHourDeg + 360;
                hasBootedClock = true;

                setTimeout(() => {
                    if(clockS) clockS.style.transition = 'transform 0.2s cubic-bezier(0.4, 2.0, 0.2, 1)';
                    if(clockM) clockM.style.transition = 'transform 0.2s cubic-bezier(0.4, 2.0, 0.2, 1)';
                    if(clockH) clockH.style.transition = 'transform 0.2s cubic-bezier(0.4, 2.0, 0.2, 1)';
                }, 1500);
            } else {
                let diffS = targetSecDeg - (currentSecDeg % 360);
                if (diffS < 0) diffS += 360;
                currentSecDeg += diffS;

                let diffM = targetMinDeg - (currentMinDeg % 360);
                if (diffM < 0) diffM += 360;
                currentMinDeg += diffM;

                let diffH = targetHourDeg - (currentHourDeg % 360);
                if (diffH < 0) diffH += 360;
                currentHourDeg += diffH;
            }

            if (clockS) clockS.style.transform = `rotate(${currentSecDeg}deg)`;
            if (clockM) clockM.style.transform = `rotate(${currentMinDeg}deg)`;
            if (clockH) clockH.style.transform = `rotate(${currentHourDeg}deg)`;
        }
        
        setInterval(updateLifeWidget, 1000);
        updateLifeWidget();

        // Uptime counter (оставлен только для футера)
        let serverStartTime = window.__siteStartTime || Date.now();
        fetch('/api/init', { cache: 'no-store' })
            .then(res => res.json())
            .then(data => {
                if (data.uptime) {
                    serverStartTime = Date.now() - (data.uptime * 1000);
                }
                if (data.version) {
                    const v = document.getElementById('server-version');
                    if (v) v.textContent = 'v' + data.version;
                }
                if (data.lang) {
                    document.documentElement.lang = data.lang;
                }
            })
            .catch(() => {});

        function updateUptime() {
            const elFooter = document.getElementById('footer-uptime');
            if (!elFooter) return;
            const elapsed = Math.max(0, Math.floor((Date.now() - serverStartTime) / 1000));
            
            const y = Math.floor(elapsed / 31536000);
            const mo = Math.floor((elapsed % 31536000) / 2592000);
            const d = Math.floor((elapsed % 2592000) / 86400);
            const h = Math.floor((elapsed % 86400) / 3600);
            const m = Math.floor((elapsed % 3600) / 60);
            const s = elapsed % 60;
            
            let str = '';
            if (y > 0) str += y + 'y ';
            if (mo > 0) str += mo + 'mo ';
            if (d > 0) str += d + 'd ';
            str += `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
            
            elFooter.textContent = str;
        }
        setInterval(updateUptime, 1000);
        updateUptime();

        const existingBootCb = window.__onBootDone;
        window.__onBootDone = () => {
            if (existingBootCb) existingBootCb();
            updateLifeWidget();
        };

        // ============================================================
        // COMMUNITY BOARD (DOM-based Sticky Notes)
        // ============================================================
        const notesContainer = document.getElementById('notes-masonry');
        const noteInput = document.getElementById('note-input');
        const addNoteBtn = document.getElementById('add-note-btn');
        const noteInputWrap = document.getElementById('note-input-wrap');
        const charCounter = document.getElementById('char-counter');
        const charWarning = document.getElementById('char-warning');
        
        const MAX_CHARS = 120;
        let shakeTimeout;

        // Escape HTML и автоматическая обертка ВСЕХ эмодзи в класс .emoji для защиты их цвета
        const escapeHTML = str => {
            if (!str) return '';
            let escaped = str.replace(/[&<>'"]/g, tag => ({
                '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
            }[tag]));
            return escaped.replace(/(\p{Emoji_Presentation}|\p{Extended_Pictographic})/gu, '<span class="emoji">$1</span>');
        };

        function createNoteEl(note) {
            const wrapper = document.createElement('div');
            wrapper.className = 'break-inside-avoid mb-6 w-full inline-block';
            wrapper.innerHTML = `
                <div class="relative p-5 bg-[#0a0a0a] border border-white/10 group hover:border-white/30 transition-all duration-300 hover:-translate-y-1 shadow-lg sticky-note" style="transform: rotate(${note.rot || 0}deg)">
                    <p class="font-sans text-sm text-gray-300 leading-relaxed mb-4 break-words whitespace-pre-wrap">${escapeHTML(note.text)}</p>
                    <div class="flex justify-between items-center border-t border-gray-800 pt-2 mt-auto">
                        <span class="font-mono text-[9px] text-gray-600 uppercase tracking-widest">${new Date(note.date || Date.now()).toLocaleDateString('en-GB')}</span>
                        <span class="font-mono text-[10px] text-gray-500">- ${escapeHTML(note.author)}</span>
                    </div>
                </div>
            `;
            return wrapper;
        }

        if (notesContainer) {
            fetch('/api/board')
                .then(res => res.json())
                .then(data => {
                    if (Array.isArray(data)) {
                        notesContainer.innerHTML = '';
                        data.forEach(n => notesContainer.appendChild(createNoteEl(n)));
                    }
                })
                .catch(() => console.error('Failed to load notes'));
        }

        noteInput?.addEventListener('input', () => {
            const len = noteInput.value.length;
            charCounter.textContent = `${len}/${MAX_CHARS}`;
            
            if (len >= MAX_CHARS) {
                charCounter.classList.replace('text-gray-500', 'text-red-500');
                noteInputWrap.classList.add('input-error-glow');
            } else {
                if (charCounter.classList.contains('text-red-500')) {
                    charCounter.classList.replace('text-red-500', 'text-gray-500');
                }
                noteInputWrap.classList.remove('input-error-glow');
                charWarning.classList.remove('opacity-100');
            }
        });

        async function handleAddNote() {
            const val = noteInput.value.trim().substring(0, MAX_CHARS);
            if(!val) return;
            
            addNoteBtn.disabled = true;
            addNoteBtn.style.opacity = '0.5';

            try {
                const res = await fetch('/api/board', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ text: val })
                });
                
                const data = await res.json();
                
                if (!res.ok) {
                    showWarningMsg(data.error || 'ERROR SAVING NOTE');
                } else {
                    notesContainer.prepend(createNoteEl(data));
                    noteInput.value = '';
                    noteInput.dispatchEvent(new Event('input'));
                }
            } catch (err) {
                alert('Connection error. Try again later.');
            } finally {
                addNoteBtn.disabled = false;
                addNoteBtn.style.opacity = '1';
            }
        }
        
        addNoteBtn?.addEventListener('click', handleAddNote);
        
        function showWarningMsg(msg) {
            noteInputWrap.classList.remove('animate-error-shake');
            void noteInputWrap.offsetWidth;
            noteInputWrap.classList.add('animate-error-shake');
            charWarning.innerHTML = `<span class="inline-block animate-pulse emoji">⚠️</span> [ SYS.ERR ] ${msg}`;
            charWarning.classList.add('opacity-100');
            clearTimeout(shakeTimeout);
            shakeTimeout = setTimeout(() => {
                charWarning.classList.remove('opacity-100');
            }, 3500);
        }

        noteInput?.addEventListener('keydown', (e) => { 
            if(e.key === 'Enter') {
                handleAddNote();
                return;
            }
            if (noteInput.value.length >= MAX_CHARS && e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
                showWarningMsg('BUFFER OVERFLOW. 120 CHARS MAX.');
            }
        });

        // ============================================================
        // PROJECTS
        // ============================================================
        const grid = document.getElementById('projects-grid');
        function buildCard(p) {
            const a = document.createElement('a');
            a.href = p.url || '#'; a.target = '_blank'; a.rel = 'noopener';
            const statusHTML = p.status ? `<span class="card-status ${p.status}">${p.status === 'live' ? 'Live' : (p.status === 'offline' ? 'Offline' : 'WIP')}</span>` : '';
            const tagsHTML = p.tags && p.tags.length ? `<div class="card-tags mt-4">${p.tags.map(t => `<span class="card-tag">${t}</span>`).join('')}</div>` : '';
            
            const isLive = p.status === 'live';
            const metricsHTML = `
                <div class="flex items-center gap-5 mt-5 font-mono text-[10px] text-gray-400 uppercase tracking-widest border-t border-gray-800 pt-4">
                    <span class="flex items-center gap-1.5" title="Score">
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="text-gray-500"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"></polygon></svg>
                        ${p.rating}/10
                    </span>
                    <span class="flex items-center gap-1.5" title="Server Availability">
                        <span class="relative flex h-2 w-2">
                            <span class="${isLive ? 'animate-ping' : 'hidden'} absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75 color-dot-green"></span>
                            <span class="relative inline-flex rounded-full h-2 w-2 ${isLive ? 'bg-green-500 color-dot-green' : 'bg-yellow-500 color-dot-yellow'}"></span>
                        </span>
                        ${isLive ? p.uptime + '%' : 'Offline'}
                    </span>
                </div>
            `;

            a.className = `project-card p-8 flex flex-col justify-between group fade-up ${p.flagship ? 'uma-badge' : ''} ${p.wide ? 'md:col-span-2' : ''}`;
            a.innerHTML = `
                <span class="glow"></span>
                <div>
                    <div class="flex justify-between items-start mb-4">
                        <h4 class="font-mono ${p.nameSize || 'text-2xl'} font-bold text-white">${p.name}</h4>
                        <div class="flex items-center gap-2 ml-2 shrink-0">
                            ${statusHTML}
                            ${p.flagship ? '<span class="text-xs font-mono bg-white text-black px-2 py-1 rounded uppercase tracking-wider font-bold" style="text-shadow: none; box-shadow: none;">Flagship</span>' : ''}
                        </div>
                    </div>
                    <p class="text-gray-400 ${p.descSize || 'text-sm'} leading-relaxed">${p.desc}</p>
                    ${metricsHTML}
                    ${tagsHTML}
                </div>
                <div class="flex items-center justify-between mt-6 pt-4">
                    <span class="font-mono text-xs text-gray-500 group-hover:text-white transition-colors">${p.url ? p.url.replace('https://', '') : ''}</span>
                    <span class="font-mono text-white opacity-0 group-hover:opacity-100 transition-opacity">-&gt;</span>
                </div>`;
            return a;
        }

        if (grid) {
            fetch('/api/projects', { cache: 'no-store' })
                .then(res => res.json())
                .then(data => {
                    if (Array.isArray(data)) {
                        data.forEach(p => {
                            const card = buildCard(p);
                            grid.appendChild(card);
                            setTimeout(() => card.classList.add('visible'), 50);
                        });
                    }
                })
                .catch(console.error);
        }


        // ============================================================
        // CORE: SCROLL, CURSOR, BG, ASCII, TERMINAL + GLITCH BACKGROUND
        // ============================================================
        const fy = document.getElementById('footer-year'); if (fy) fy.textContent = new Date().getFullYear();
        const progress = document.getElementById('scroll-progress'); const navbar = document.getElementById('navbar');
        let progressTick = false, isScrolling = false, scrollEndTimer = null;
        addEventListener('scroll', () => {
            isScrolling = true; clearTimeout(scrollEndTimer); scrollEndTimer = setTimeout(() => { isScrolling = false; }, 120);
            if (navbar) navbar.classList.toggle('scrolled', scrollY > 60);
            if (progressTick) return; progressTick = true;
            requestAnimationFrame(() => { const h = document.documentElement; progress.style.width = ((h.scrollTop / Math.max(1, (h.scrollHeight - h.clientHeight))) * 100) + '%'; progressTick = false; });
        }, { passive: true });

        const cursorDot = document.getElementById('cursor-dot'); const cursorOutline = document.getElementById('cursor-outline');
        let mx = innerWidth / 2, my = innerHeight / 2, dotX = mx, dotY = my, outX = mx, outY = my, cursorActive = !isTouch && !prefersReduced;
        if (!cursorActive) { cursorDot.style.display = 'none'; cursorOutline.style.display = 'none'; document.body.style.cursor = 'auto'; }
        addEventListener('pointermove', (e) => { mx = e.clientX; my = e.clientY; }, { passive: true });
        document.addEventListener('pointerover', (e) => { if (!cursorActive) return; if (e.target.closest('a, button, input, textarea')) cursorOutline.classList.add('is-hover'); });
        document.addEventListener('pointerout', (e) => { if (!cursorActive) return; if (e.target.closest('a, button, input, textarea')) cursorOutline.classList.remove('is-hover'); });

        // === GLITCH RIPPLE ON CLICK ===
        const ripples = [];
        document.addEventListener('mousedown', (e) => {
            if (e.target.closest('a, button, input, textarea, .project-card, .sticky-note, .about-terminal, .win11-header, #terminal, nav')) return;
            ripples.push({
                x: e.clientX,
                y: e.clientY,
                radius: 0,
                speed: 12,
                thickness: 12
            });
        });
        // ==============================

        const bgStatic = document.getElementById('bg-static'), bgDynamic = document.getElementById('bg-dynamic');
        const sctx = bgStatic.getContext('2d', { alpha: true }), dctx = bgDynamic.getContext('2d', { alpha: true });
        const FONT_SIZE = 16, CHARS = ['+','-','.',':','>','<','=','#','0','1','~','*','^','|'];
        const boostedCells = new Set(); 
        let W = 0, H = 0, cols = 0, rows = 0, cells = [], prevMx = -9999, prevMy = -9999, rafId = null;
        let globalAlphaBoost = 1;     
        let needsFullRedraw = true;   
        let bgFrame = 0;              
        let shimmerActive = false, shimmerT0 = 0;

        // Sync shimmer state with RenderPipeline
        RenderPipeline.onUpdate(p => { shimmerActive = p.shimmerEnabled; }); 
        
        function resize() {
            W = innerWidth; H = innerHeight;
            [bgStatic, bgDynamic].forEach(c => { c.width = Math.round(W * DPR); c.height = Math.round(H * DPR); c.style.width = W + 'px'; c.style.height = H + 'px'; c.getContext('2d').setTransform(DPR, 0, 0, DPR, 0, 0); });
            cols = Math.ceil(W / FONT_SIZE) + 1; rows = Math.ceil(H / FONT_SIZE) + 1; cells = new Array(cols * rows);
            for (let y = 0; y < rows; y++) {
                for (let x = 0; x < cols; x++) {
                    cells[y * cols + x] = { 
                        x: x * FONT_SIZE + FONT_SIZE / 2, 
                        y: y * FONT_SIZE + FONT_SIZE / 2, 
                        char: CHARS[(Math.random() * CHARS.length) | 0], 
                        baseAlpha: Math.random() * 0.06 + 0.03, 
                        boost: 0, 
                        scramble: 0 
                    };
                }
            }
            boostedCells.clear();
            dctx.clearRect(0, 0, W, H); prevMx = prevMy = -9999;
            drawStaticFull(); 
        }

        function drawStaticFull() {
            sctx.clearRect(0, 0, W, H);
            sctx.font = `${FONT_SIZE}px "JetBrains Mono", monospace`;
            sctx.textAlign = 'center';
            sctx.textBaseline = 'middle';
            let cf = '';
            for (let i = 0; i < cells.length; i++) {
                const c = cells[i];
                const a = Math.min(1, (c.baseAlpha + c.boost) * globalAlphaBoost);
                if (a < 0.005) continue;
                const f = `rgba(255,255,255,${a.toFixed(2)})`;
                if (f !== cf) { sctx.fillStyle = f; cf = f; }
                sctx.fillText(c.char, c.x, c.y);
            }
            needsFullRedraw = false;
        }

        function updateCells() {
            if (Math.random() < 0.06) {
                const cx = (Math.random() * cols) | 0, cy = (Math.random() * rows) | 0;
                const rw = ((Math.random() * 3) | 0) + 1, rh = ((Math.random() * 3) | 0) + 1;
                for (let y = cy - rh; y <= cy + rh; y++) {
                    for (let x = cx - rw; x <= cx + rw; x++) {
                        if (x < 0 || x >= cols || y < 0 || y >= rows) continue;
                        if (Math.random() < 0.7) {
                            const idx = y * cols + x;
                            cells[idx].boost = 0.9;
                            cells[idx].scramble = ((Math.random() * 15) | 0) + 5;
                            boostedCells.add(idx);
                        }
                    }
                }
            }

            if (ripples.length > 0) {
                for (let i = ripples.length - 1; i >= 0; i--) {
                    const r = ripples[i];
                    r.radius += r.speed;
                    r.speed *= 0.90;
                    
                    const minX = Math.max(0, Math.floor((r.x - r.radius - r.thickness) / FONT_SIZE));
                    const maxX = Math.min(cols - 1, Math.ceil((r.x + r.radius + r.thickness) / FONT_SIZE));
                    const minY = Math.max(0, Math.floor((r.y - r.radius - r.thickness) / FONT_SIZE));
                    const maxY = Math.min(rows - 1, Math.ceil((r.y + r.radius + r.thickness) / FONT_SIZE));
                    
                    for (let y = minY; y <= maxY; y++) {
                        for (let x = minX; x <= maxX; x++) {
                            const idx = y * cols + x;
                            const c = cells[idx];
                            const dist = Math.hypot(c.x - r.x, c.y - r.y);
                            if (Math.abs(dist - r.radius) < r.thickness) {
                                if (Math.random() < 0.1) {
                                    c.boost = Math.max(c.boost, 0.5);
                                    c.scramble = Math.max(c.scramble, ((Math.random() * 6) | 0) + 2);
                                    boostedCells.add(idx);
                                }
                            }
                        }
                    }
                    if (r.speed < 0.5) ripples.splice(i, 1);
                }
            }

            if (needsFullRedraw) { drawStaticFull(); return; }
            if (boostedCells.size === 0) return;

            sctx.font = `${FONT_SIZE}px "JetBrains Mono", monospace`;
            sctx.textAlign = 'center';
            sctx.textBaseline = 'middle';
            const done = [];
            for (const idx of boostedCells) {
                const c = cells[idx];
                if (c.scramble > 0) { c.char = CHARS[(Math.random() * CHARS.length) | 0]; c.scramble--; }
                if (c.boost > 0.01) c.boost *= 0.93; else { c.boost = 0; done.push(idx); }

                const px = c.x - FONT_SIZE * 0.5 - 1, py = c.y - FONT_SIZE * 0.5 - 1;
                sctx.clearRect(px, py, FONT_SIZE + 2, FONT_SIZE + 2);
                const a = Math.min(1, (c.baseAlpha + c.boost) * globalAlphaBoost);
                if (a >= 0.005) {
                    sctx.fillStyle = `rgba(255,255,255,${a.toFixed(2)})`;
                    sctx.fillText(c.char, c.x, c.y);
                }
            }
            for (const idx of done) boostedCells.delete(idx);
        }

        function flashStatic(peak, durationMs) {
            const start = performance.now(), half = durationMs / 2;
            function tick(now) {
                const t = now - start;
                globalAlphaBoost = t <= half  ? 1 + (peak - 1) * (t / half) :
                                   t < durationMs ? peak - (peak - 1) * ((t - half) / half) : 1;
                needsFullRedraw = true;
                if (t < durationMs) requestAnimationFrame(tick);
                else { globalAlphaBoost = 1; needsFullRedraw = true; }
            }
            requestAnimationFrame(tick);
        }

        function loop() {
            dotX += (mx - dotX) * 0.6; dotY += (my - dotY) * 0.6;
            outX += (mx - outX) * 0.18; outY += (my - outY) * 0.18;
            if (cursorActive) {
                cursorDot.style.transform = `translate3d(${dotX}px,${dotY}px,0)`;
                cursorOutline.style.transform = `translate3d(${outX}px,${outY}px,0)`;
            }

            bgFrame++;
            const _bgEvery = RenderPipeline.bgEvery;
            const _glowR = RenderPipeline.glowRadius;
            if (bgFrame >= _bgEvery) {
                bgFrame = 0;
                
                updateCells();
                
                const clearR = _glowR + 20;
                if (prevMx > -9000) dctx.clearRect(prevMx - clearR, prevMy - clearR, clearR * 2, clearR * 2);
                dctx.clearRect(mx - clearR, my - clearR, clearR * 2, clearR * 2);
                const grad = dctx.createRadialGradient(mx, my, 0, mx, my, _glowR);
                grad.addColorStop(0, 'rgba(255,255,255,0.07)');
                grad.addColorStop(0.3, 'rgba(255,255,255,0.04)');
                grad.addColorStop(0.7, 'rgba(255,255,255,0.015)');
                grad.addColorStop(1, 'rgba(255,255,255,0)');
                dctx.fillStyle = grad;
                dctx.fillRect(mx - _glowR, my - _glowR, _glowR * 2, _glowR * 2);
                prevMx = mx; prevMy = my;
            }

            if (shimmerActive) {
                const now = performance.now();
                if (!shimmerT0) shimmerT0 = now;
                const cycleTime = 6500, waveDuration = 2500, t = ((now - shimmerT0) % cycleTime) / waveDuration;
                renderArt(targetAscii, t <= 1.0 ? -0.2 + t * 1.4 : -999);
            }

            rafId = requestAnimationFrame(loop);
        }

        let resizeTimer; addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(resize, 120); });
        resize(); if (!prefersReduced) rafId = requestAnimationFrame(loop);
        
        document.addEventListener('visibilitychange', () => { if (document.hidden) { if (rafId) { cancelAnimationFrame(rafId); rafId = null; } } else if (!rafId && !prefersReduced) rafId = requestAnimationFrame(loop); });

        // ============================================================
        // ASCII ENGINE & ART SCALE LOGIC
        // ============================================================
        const asciiContainer = document.getElementById('ascii-art');
        const targetAscii = `  ██████╗ ██████╗ ██╗     ██╗  ██╗ ██╗ ██████╗ \n ██╔════╝ ██╔══██╗██║     ╚██╗██╔╝███║██╔═══██╗\n ██║      ██████╔╝██║      ╚███╔╝ ╚██║██║   ██║\n ██║      ██╔══██╗██║      ██╔██╗  ██║██║▄▄ ██║\n ╚██████╗ ██║  ██║███████╗██╔╝ ██╗ ██║╚██████╔╝\n  ╚═════╝ ╚═╝  ╚═╝╚══════╝╚═╝  ╚═╝ ╚═╝ ╚══▀▀═╝`;
        const decryptChars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789@#$%&*<>'; 
        const artLines = targetAscii.split('\n'); 
        const artCanvas = document.createElement('canvas'); 
        const actx = artCanvas.getContext('2d'); 
        const ART_FONT = '##SIZE##px Consolas, Monaco, "Courier New", monospace';
        let artW = 0, artH = 0, artLineH = 0, artFs = 0, charW = 0, maxChars = 0;
        
        function getArtFontSize() { 
            const w = innerWidth;
            // The ASCII art is ~48 characters wide. Safely calculate max font size to avoid overflow on any device.
            // On some mobile OS, monospace characters can render slightly wider.
            const dynamicFs = Math.max(5, (w - 40) / 29); // 40px safe margin
            
            if (w <= 360) return Math.min(dynamicFs, 8.5); 
            if (w <= 420) return Math.min(dynamicFs, 10.5); 
            if (w <= 480) return Math.min(dynamicFs, 12);
            if (w <= 640) return Math.min(dynamicFs, 14); 
            if (w <= 900) return Math.min(dynamicFs, 18); 
            if (w <= 1200) return Math.min(dynamicFs, 21); 
            return 26; 
        }
        
        function initArtCanvas() { 
            artFs = getArtFontSize(); 
            actx.font = ART_FONT.replace('##SIZE##', artFs); 
            charW = actx.measureText('█').width; 
            maxChars = 0; 
            for (const line of artLines) { if (line.length > maxChars) maxChars = line.length; } 
            artLineH = artFs * 1.15; 
            artW = Math.ceil(maxChars * charW) + 4; 
            artH = Math.ceil(artLineH * artLines.length) + 4; 
            const dpr = Math.min(devicePixelRatio || 1, 2); 
            artCanvas.width = Math.ceil(artW * dpr); 
            artCanvas.height = Math.ceil(artH * dpr); 
            artCanvas.style.width = artW + 'px'; 
            artCanvas.style.height = artH + 'px'; 
            actx.setTransform(dpr, 0, 0, dpr, 0, 0); 
        }

        function renderArt(text, waveNormalizedX = -999, isDecoding = false) { 
            actx.clearRect(0, 0, artW, artH); 
            actx.font = ART_FONT.replace('##SIZE##', artFs); 
            actx.textBaseline = 'top'; 
            const tLines = text.split('\n'); 
            for (let i = 0; i < tLines.length; i++) { 
                const line = tLines[i]; 
                for (let j = 0; j < line.length; j++) { 
                    const ch = line[j]; 
                    if (ch === ' ') continue; 
                    let fillStyle = '#fff'; 
                    if (waveNormalizedX !== -999 && !isDecoding) { 
                        const waveCenterIdx = waveNormalizedX * maxChars; 
                        const tilt = (i / tLines.length) * (maxChars * 0.15); 
                        const dist = Math.abs(j - (waveCenterIdx - tilt)); 
                        const spread = maxChars * 0.12; 
                        if (dist < spread) { 
                            if (dist < spread * 0.3) fillStyle = '#333'; 
                            else if (dist < spread * 0.6) fillStyle = '#666'; 
                            else if (dist < spread * 0.9) fillStyle = '#aaa'; 
                        } 
                    } 
                    actx.fillStyle = fillStyle; 
                    actx.fillText(ch, 2 + j * charW, 2 + i * artLineH); 
                } 
            } 
        }
        
        if (asciiContainer) {
            artCanvas.style.display = 'block'; 
            artCanvas.style.margin = '0 auto'; 
            asciiContainer.innerHTML = ''; 
            asciiContainer.appendChild(artCanvas);
        }

        const fontReady = document.fonts ? document.fonts.ready : Promise.resolve();
        fontReady.then(() => { 
            function startAsciiAnim() { 
                initArtCanvas(); 
                if (prefersReduced) { 
                    renderArt(targetAscii, -999, false); 
                    if (asciiContainer) asciiContainer.style.opacity = 1; 
                } else { 
                    let iter = 0; 
                    const maxIter = 40; 
                    function animateDecode() { 
                        if (asciiContainer) asciiContainer.style.opacity = 1; 
                        let result = '', done = true; 
                        for (let i = 0; i < artLines.length; i++) { 
                            const line = artLines[i]; 
                            const threshold = (iter / maxIter) * line.length; 
                            let decoded = ''; 
                            for (let j = 0; j < line.length; j++) { 
                                const ch = line[j]; 
                                if (ch === ' ') decoded += ' '; 
                                else if (j < threshold) decoded += ch; 
                                else { decoded += decryptChars[(Math.random() * decryptChars.length) | 0]; done = false; } 
                            } 
                            result += decoded + '\n'; 
                        } 
                        renderArt(result, -999, true); 
                        if (!done && iter < maxIter) { 
                            iter++; setTimeout(animateDecode, 40); 
                        } else { 
                            renderArt(targetAscii, -999, false); 
                            if (!prefersReduced) { shimmerActive = RenderPipeline.shimmerEnabled; shimmerT0 = 0; } 
                        } 
                    } 
                    setTimeout(animateDecode, 120); 
                } 
            } 
            if (window.__bootDone) startAsciiAnim(); else window.__onBootDone = startAsciiAnim; 
            addEventListener('resize', () => { initArtCanvas(); renderArt(targetAscii, -999, false); }); 
        });

        const io = new IntersectionObserver((entries, obs) => { entries.forEach(entry => { if (entry.isIntersecting) { entry.target.classList.add('visible'); obs.unobserve(entry.target); } }); }, { threshold: 0.1 });
        document.querySelectorAll('.fade-up').forEach(el => io.observe(el));
        
        if (!isTouch) {
            document.querySelectorAll('.project-card').forEach(card => { 
                let pending = false, lx = 0, ly = 0; 
                card.addEventListener('pointermove', (e) => { 
                    const r = card.getBoundingClientRect(); lx = e.clientX - r.left; ly = e.clientY - r.top; 
                    if (pending) return; pending = true; 
                    requestAnimationFrame(() => { 
                        const mxn = lx - r.width / 2, myn = ly - r.height / 2; 
                        card.style.setProperty('--mx', (mxn * 0.04).toFixed(2) + 'px'); 
                        card.style.setProperty('--my', (myn * 0.04).toFixed(2) + 'px'); 
                        card.style.setProperty('--gx', lx + 'px'); 
                        card.style.setProperty('--gy', ly + 'px'); 
                        pending = false; 
                    }); 
                }); 
                card.addEventListener('pointerleave', () => { 
                    card.style.setProperty('--mx', '0px'); 
                    card.style.setProperty('--my', '0px'); 
                }); 
            });
        }

        const statIO = new IntersectionObserver((entries, obs) => { entries.forEach(entry => { if (!entry.isIntersecting) return; const el = entry.target, target = parseFloat(el.dataset.count) || 0, suffix = el.dataset.suffix || '', duration = 1400, start = performance.now(); function step(now) { const t = Math.min(1, (now - start) / duration), eased = 1 - Math.pow(1 - t, 3), val = target >= 100 ? Math.round(target * eased) : (target * eased).toFixed(0); el.textContent = val + suffix; if (t < 1) requestAnimationFrame(step); else el.textContent = target + suffix; } requestAnimationFrame(step); obs.unobserve(el); }); }, { threshold: 0.4 }); document.querySelectorAll('.stat-num').forEach(el => statIO.observe(el));

        // ============================================================
        // TERMINAL COMMAND PARSER
        // ============================================================
        const term = document.getElementById('terminal'), termLog = document.getElementById('term-log'), termInput = document.getElementById('term-input'), termToggle = document.getElementById('term-toggle');
        function termOpen() { term.classList.add('open'); setTimeout(() => termInput.focus(), 50); } 
        function termClose() { term.classList.remove('open'); termInput.blur(); } 
        function termToggleFn() { term.classList.contains('open') ? termClose() : termOpen(); }
        
        termToggle?.addEventListener('click', termToggleFn); 
        document.getElementById('win11-close-btn')?.addEventListener('click', termClose);
        document.getElementById('win11-tab-close-btn')?.addEventListener('click', termClose);
        document.querySelector('.win11-ctrl.min')?.addEventListener('click', termClose);

        addEventListener('keydown', (e) => { 
            if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); termToggleFn(); } 
            else if (e.key === 'Escape' && term.classList.contains('open')) termClose(); 
        });
        
        function termPrint(html) { termLog.insertAdjacentHTML('beforeend', '\n' + html); termLog.scrollTop = termLog.scrollHeight; }
        
        const commands = {
            help: () => 'Available commands:\n  help       — this help\n  about      — about me\n  ls         — list project files\n  projects   — list projects\n  stack      — tech stack\n  contact    — reach me\n  social     — social links\n  blog       — notes section\n  board      — public board\n  theme      — toggle light/dark\n  debug      — toggle performance monitor\n  system     — system profile\n  profile    — alias for system\n  quality    — set render quality (auto/full/eco)\n  motion     — motion preference status\n  matrix     — surprise\n  clear      — clear log\n  exit       — close terminal',
            about: () => document.documentElement.lang === 'ru' ? 'CRLX1Q — Software Developer.\nМасштабируемая архитектура, нейросети, эстетичные интерфейсы.' : 'CRLX1Q — Software Developer.\nScalable architecture, neural networks, aesthetic interfaces.',
            ls: () => '  ./\n  ├── server.js\n  ├── index.html\n  ├── package.json\n  ├── README.md\n  └── projects/\n      ├── uma/\n      ├── aistudymate/\n      ├── tasco/\n      ├── antimat/\n      └── foodlensai/',
            projects: () => 'UMA          → uma.crlx1q.com      (' + (document.documentElement.lang === 'ru' ? 'флагман' : 'flagship') + ')\nAiStudyMate  → aistudymate.crlx1q.com\nTasco        → tasco.crlx1q.com\nAntiMat      → antimat.crlx1q.com\nFoodLensAI   → foodlensai.crlx1q.com',
            stack: () => 'TypeScript · React · Next.js · Node · Go · Python · PyTorch · PostgreSQL · Redis · Docker · K8s · Rust · WebGL · gRPC · Tailwind',
            contact: () => 'Email: contact@crlx1q.com',
            social: () => '[ GitHub: github.com/crlx1q ] [ Telegram: t.me/Alisheruy ] [ Email: contact@crlx1q.com ]',
            blog: () => 'Access /blog section on page.',
            board: () => 'Access /board to leave notes.',
            system: () => {
                const rp = RenderPipeline;
                const conn = rp.getConnectionInfo();
                const saveData = navigator.connection && navigator.connection.saveData ? 'true' : 'false';
                const theme = document.documentElement.classList.contains('light-mode') ? 'light' : 'dark';
                const lang = document.documentElement.lang || 'en';
                return 'SYSTEM PROFILE ———————————————\n' +
                    '  os preference : reduced-motion=' + prefersReduced + '\n' +
                    '  pointer       : ' + (isTouch ? 'coarse (touch)' : 'fine (mouse)') + '\n' +
                    '  canvas        : ' + (prefersReduced ? 'disabled' : 'active') + '\n' +
                    '  render quality: ' + rp.effectiveQuality + ' [' + rp.quality + ']\n' +
                    '  dpr           : ' + DPR.toFixed(1) + ' (capped)\n' +
                    '  bg_every      : ' + rp.bgEvery + '\n' +
                    '  glow_radius   : ' + rp.glowRadius + 'px\n' +
                    '  shimmer       : ' + (rp.shimmerEnabled ? 'on' : 'off') + '\n' +
                    '  connection    : ' + conn + '\n' +
                    '  save-data     : ' + saveData + '\n' +
                    '  theme         : ' + theme + '\n' +
                    '  language      : ' + lang;
            },
            profile: () => commands.system(),
            motion: () => {
                return '> motion preference: ' + (prefersReduced ? 'REDUCED' : 'FULL') + '\n' +
                    '> animations: ' + (prefersReduced ? 'disabled by OS' : 'enabled') + '\n' +
                    '> canvas: ' + (prefersReduced ? 'static mode' : 'active rendering') + '\n' +
                    '> cursor: ' + (isTouch || prefersReduced ? 'native (system)' : 'custom (dot + outline)');
            },
            matrix: () => { flashStatic(5.5, 2000); return 'wake up, neo... the matrix has you.'; },
            debug: () => { if (typeof window.togglePerf === 'function') return window.togglePerf(); return '> error: monitor not found.'; },
            theme: () => {
                const root = document.documentElement;
                const isLight = root.classList.toggle('light-mode');
                try { localStorage.setItem('crlx1q_theme', isLight ? 'light' : 'dark'); } catch (e) {}
                const termEl = document.getElementById('terminal');
                const rect = termEl ? termEl.getBoundingClientRect() : {left:innerWidth/2,top:innerHeight-60,width:0,height:0};
                const cx = (rect.left + rect.width / 2) | 0;
                const cy = (rect.top  + rect.height / 2) | 0;
                const ring = document.createElement('div');
                const maxD = Math.hypot(innerWidth, innerHeight) * 2.1;
                ring.style.cssText = `position:fixed;border-radius:50%;border:1px solid rgba(255,255,255,0.35);pointer-events:none;z-index:99999;left:${cx}px;top:${cy}px;width:0;height:0;transform:translate(-50%,-50%);will-change:width,height,opacity;transition:width .6s ease-out,height .6s ease-out,opacity .6s ease-out;opacity:1`;
                document.body.appendChild(ring);
                requestAnimationFrame(() => requestAnimationFrame(() => {
                    ring.style.width = maxD + 'px';
                    ring.style.height = maxD + 'px';
                    ring.style.opacity = '0';
                    setTimeout(() => ring.remove(), 700);
                }));
                return 'theme toggled. preference saved.';
            },
            clear: () => { termLog.innerHTML = 'Microsoft Windows [Version 10.0.22631.3296]<br>(c) Microsoft Corporation. All rights reserved.<br><br>'; return null; },
            exit: () => { termClose(); return null; }
        };
        
        termInput?.addEventListener('keydown', (e) => { 
            if (e.key !== 'Enter') return; 
            const rawCmd = termInput.value.trim(); 
            const cmdLower = rawCmd.toLowerCase(); 
            termInput.value = ''; 
            if (!cmdLower) return; 
            termPrint('<span class="prompt">C:\\&gt;</span> ' + rawCmd); 
            // Handle quality command with argument
            if (cmdLower.startsWith('quality')) {
                const parts = cmdLower.split(/\s+/);
                if (parts.length >= 2 && ['auto','full','eco'].includes(parts[1])) {
                    RenderPipeline.setQuality(parts[1]);
                    const rp = RenderPipeline;
                    termPrint('> render pipeline set to: ' + parts[1] + '\n> effective: ' + rp.effectiveQuality + '\n> bg_every=' + rp.bgEvery + ', glow=' + rp.glowRadius + 'px, shimmer=' + (rp.shimmerEnabled ? 'on' : 'off') + '\n> saved to localStorage.');
                } else {
                    const rp = RenderPipeline;
                    termPrint('> current quality: ' + rp.effectiveQuality + ' [' + rp.quality + ']\n> usage: quality [auto|full|eco]\n  auto — adapts to FPS automatically\n  full — maximum effects\n  eco  — reduced effects for performance');
                }
                return;
            }
            const fn = commands[cmdLower]; 
            if (fn) { const out = fn(); if (out) termPrint(out); } 
            else termPrint(`'${rawCmd}' is not recognized as an internal or external command,\noperable program or batch file.`); 
        });

        const aboutLines = document.querySelectorAll('.about-line'); 
        if (aboutLines.length) { 
            const aboutIO = new IntersectionObserver((entries, obs) => { 
                entries.forEach(entry => { 
                    if (!entry.isIntersecting) return; 
                    obs.unobserve(entry.target); 
                    document.querySelectorAll('#about .about-line').forEach((line, i) => { 
                        setTimeout(() => { 
                            line.classList.add('typed'); 
                            const row = line.classList.contains('skill-row') ? line : null; 
                            if (row) { 
                                const pct = parseInt(row.dataset.pct) || 0, fill = row.querySelector('.skill-bar-fill'), label = row.querySelector('.skill-pct'); 
                                if (fill) fill.style.width = pct + '%'; 
                                if (label) { 
                                    let cur = 0; 
                                    const step = () => { cur = Math.min(pct, cur + 2); label.textContent = cur + '%'; if (cur < pct) requestAnimationFrame(step); else row.classList.add('filled'); }; 
                                    setTimeout(step, 200); 
                                } 
                            } 
                        }, i * 75); 
                    }); 
                }); 
            }, { threshold: 0.2 }); 
            const aboutSection = document.getElementById('about'); 
            if (aboutSection) aboutIO.observe(aboutSection); 
        }

        const konami = ['ArrowUp','ArrowUp','ArrowDown','ArrowDown','ArrowLeft','ArrowRight','ArrowLeft','ArrowRight','b','a']; let kIdx = 0; 
        addEventListener('keydown', (e) => { 
            if (e.key.toLowerCase() === konami[kIdx].toLowerCase()) { 
                kIdx++; 
                if (kIdx === konami.length) { 
                    kIdx = 0; flashStatic(7, 1800); termOpen(); termPrint('> konami unlocked. welcome, player one.'); 
                } 
            } else kIdx = 0; 
        });
        
        const hint = document.getElementById('term-hint'); 
        try { 
            if (hint && !localStorage.getItem('crlx1q_shell_seen')) { 
                setTimeout(() => hint.classList.add('show'), 2200); 
                setTimeout(() => hint.classList.remove('show'), 7200); 
                const dismiss = () => { localStorage.setItem('crlx1q_shell_seen', '1'); hint.classList.remove('show'); }; 
                termToggle?.addEventListener('click', dismiss, { once: true }); 
                addEventListener('keydown', (e) => { if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') dismiss(); }, { once: true }); 
            } 
        } catch (_) {}

        // ============================================================
        // 🐛 PERF MONITOR
        // ============================================================
        (function initPerfMon() {
            const mon       = document.getElementById('perf-mon');
            const fpsBadge  = document.getElementById('perf-fps-badge');
            const toggleBtn = document.getElementById('perf-toggle-btn');
            const closeBtn  = document.getElementById('perf-close-btn');
            const pvFps     = document.getElementById('pv-fps');
            const pvFt      = document.getElementById('pv-ft');
            const pvCells   = document.getElementById('pv-cells');
            const pvCanvas  = document.getElementById('pv-canvas');
            const pvDpr     = document.getElementById('pv-dpr');
            const pvRes     = document.getElementById('pv-res');
            const pvHeap    = document.getElementById('pv-heap');
            const pvShimmer = document.getElementById('pv-shimmer');
            const pbFps     = document.getElementById('pb-fps');
            const pbFt      = document.getElementById('pb-ft');
            const pbCells   = document.getElementById('pb-cells');
            const pbCanvas  = document.getElementById('pb-canvas');
            const spark     = document.getElementById('perf-spark');
            const sctxP     = spark ? spark.getContext('2d') : null;
            if (!mon) return;

            window.perfActive = false;

            const HIST = 60;
            const fpsHistory = new Float32Array(HIST);
            let histIdx = 0, frameCount = 0, lastSec = performance.now(), lastFrame = performance.now();
            let collapsed = false;

            window.togglePerf = function() {
                window.perfActive = !window.perfActive;
                if (window.perfActive) {
                    mon.style.display = 'block';
                    lastSec = performance.now();
                    lastFrame = performance.now();
                    frameCount = 0;
                    requestAnimationFrame(tick);
                    return '> debug subsystem initialized.';
                } else {
                    mon.style.display = 'none';
                    return '> debug subsystem terminated.';
                }
            };

            let dragOn = false, dragOx = 0, dragOy = 0, pmX = null, pmY = null;
            const bar = document.getElementById('perf-bar');
            bar.addEventListener('pointerdown', (e) => {
                if (e.target === toggleBtn || e.target === closeBtn) return;
                dragOn = true; bar.setPointerCapture(e.pointerId);
                const r = mon.getBoundingClientRect();
                dragOx = e.clientX - r.left; dragOy = e.clientY - r.top;
                mon.style.transition = 'none';
            });
            bar.addEventListener('pointermove', (e) => {
                if (!dragOn) return;
                pmX = e.clientX - dragOx; pmY = e.clientY - dragOy;
                mon.style.right = 'auto'; mon.style.bottom = 'auto';
                mon.style.left = pmX + 'px'; mon.style.top = pmY + 'px';
            });
            bar.addEventListener('pointerup', () => { dragOn = false; mon.style.transition = ''; });

            toggleBtn.addEventListener('click', () => {
                collapsed = !collapsed;
                mon.classList.toggle('pm-collapsed', collapsed);
                toggleBtn.textContent = collapsed ? '▸' : '▾';
            });
            
            closeBtn.addEventListener('click', () => { window.togglePerf(); });

            function barColor(ratio) {
                if (ratio < 0.5) return `hsl(${120 * ratio * 2},80%,55%)`;
                return `hsl(${120 - 120 * (ratio - 0.5) * 2},80%,55%)`;
            }

            function drawSparkline(history, idx) {
                if (!sctxP) return;
                const w = spark.width, h = spark.height;
                sctxP.clearRect(0, 0, w, h);
                const max = 120, step = w / HIST;
                sctxP.beginPath();
                for (let i = 0; i < HIST; i++) {
                    const v = history[(idx + i) % HIST];
                    const x = i * step;
                    const y = h - (v / max) * h;
                    i === 0 ? sctxP.moveTo(x, y) : sctxP.lineTo(x, y);
                }
                sctxP.strokeStyle = 'rgba(74,222,128,0.6)';
                sctxP.lineWidth = 1.2;
                sctxP.stroke();

                sctxP.beginPath();
                const ry = h - (60 / max) * h;
                sctxP.moveTo(0, ry); sctxP.lineTo(w, ry);
                sctxP.strokeStyle = 'rgba(255,255,255,0.1)';
                sctxP.lineWidth = 0.8;
                sctxP.setLineDash([3, 4]); sctxP.stroke(); sctxP.setLineDash([]);
            }

            function tick(now) {
                if (!window.perfActive) return;

                frameCount++;
                const ft = now - lastFrame; lastFrame = now;
                const elapsed = now - lastSec;

                if (elapsed >= 500) {
                    const fps = Math.round(frameCount / (elapsed / 1000));
                    frameCount = 0; lastSec = now;

                    fpsHistory[histIdx] = fps;
                    histIdx = (histIdx + 1) % HIST;

                    fpsBadge.textContent = fps + ' fps';
                    fpsBadge.className = fps >= 55 ? '' : fps >= 35 ? 'warn' : 'bad';

                    const fpsRatio = Math.min(1, fps / 120);
                    pvFps.textContent = fps + ' fps';
                    pbFps.style.width = (fpsRatio * 100) + '%';
                    pbFps.style.background = barColor(fpsRatio);

                    const ftRatio = Math.min(1, ft / 50);
                    pvFt.textContent = ft.toFixed(1) + ' ms';
                    
                    pbFt.style.width = (ftRatio * 100) + '%';
                    pbFt.style.background = barColor(1 - ftRatio);

                    pvCells.textContent = boostedCells.size.toString();
                    pbCells.style.width = Math.min(100, (boostedCells.size / 1000) * 100) + '%';
                    pbCells.style.background = 'rgba(255,255,255,0.8)';

                    pvCanvas.textContent = 'Active';
                    pbCanvas.style.width = '100%';

                    pvDpr.textContent = DPR.toFixed(1);
                    pvRes.textContent = W + 'x' + H;
                    
                    if (performance.memory) {
                        pvHeap.textContent = (performance.memory.usedJSHeapSize / 1048576).toFixed(1) + ' MB';
                    } else {
                        pvHeap.textContent = 'N/A';
                    }
                    
                    pvShimmer.textContent = shimmerActive ? 'ON' : 'OFF';

                    // Feed FPS to adaptive render pipeline
                    RenderPipeline.adjustQuality(fps);

                    // Update SYSTEM PROFILE fields
                    const pvMotion = document.getElementById('pv-motion');
                    const pvPointer = document.getElementById('pv-pointer');
                    const pvQuality = document.getElementById('pv-quality');
                    const pvFpsTarget = document.getElementById('pv-fpstarget');
                    const pvConn = document.getElementById('pv-connection');
                    if (pvMotion) pvMotion.textContent = prefersReduced ? 'reduced' : 'full';
                    if (pvPointer) pvPointer.textContent = isTouch ? 'touch' : 'mouse';
                    if (pvQuality) {
                        const rp = RenderPipeline;
                        pvQuality.textContent = rp.effectiveQuality + ' [' + rp.quality + ']';
                        pvQuality.style.color = rp.effectiveQuality === 'eco' ? '#facc15' : rp.effectiveQuality === 'max' ? '#4ade80' : '#ccc';
                    }
                    if (pvFpsTarget) pvFpsTarget.textContent = RenderPipeline.quality === 'auto' ? 'adaptive' : (RenderPipeline.quality === 'full' ? 'uncapped' : 'low');
                    if (pvConn) pvConn.textContent = RenderPipeline.getConnectionInfo();

                    drawSparkline(fpsHistory, histIdx);
                }
                
                if (window.perfActive) requestAnimationFrame(tick);
            }
        })();
    })();
    
// ARTICLES LOADER
const articlesGrid = document.getElementById('articles-grid');
if (articlesGrid) {
    fetch('/api/articles')
        .then(res => res.json())
        .then(data => {
            if(Array.isArray(data)) {
                articlesGrid.innerHTML = '';
                data.forEach(a => {
                    const title = document.documentElement.lang === 'ru' && a.title.ru ? a.title.ru : a.title.en;
                    const desc = document.documentElement.lang === 'ru' && a.desc.ru ? a.desc.ru : a.desc.en;
                    const tagsHTML = (a.tags||[]).map(t => `<span class="font-mono text-[9px] text-gray-600 uppercase tracking-widest border border-white/5 px-2 py-0.5 rounded">${t}</span>`).join('');
                    
                    articlesGrid.innerHTML += `
                    <a href="/article?id=${a.id}" class="block p-6 bg-[#080808] border border-white/5 hover:border-white/20 transition-colors group relative overflow-hidden">
                        <span class="absolute top-0 left-0 w-1 h-full bg-gray-800 group-hover:bg-white transition-colors"></span>
                        <div class="font-mono text-[10px] text-gray-500 uppercase tracking-widest mb-3 flex justify-between">
                            <div class="flex gap-4"><span>${a.date}</span><span>${a.readTime}</span></div>
                            <div class="flex gap-1 items-center"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"></path></svg> ${a.likes || 0}</div>
                        </div>
                        <h4 class="text-lg font-medium text-white mb-2 group-hover:text-gray-200">${title}</h4>
                        <p class="text-sm text-gray-400 leading-relaxed">${desc}</p>
                        <div class="flex gap-3 mt-4">${tagsHTML}</div>
                    </a>`;
                });
            }
        });
}

// ARTICLE PAGE LOADER
const articleContainer = document.getElementById('article-content');
if (articleContainer) {
    const urlParams = new URLSearchParams(window.location.search);
    const id = urlParams.get('id');
    if(id) {
        fetch('/api/articles/' + id)
            .then(res => res.json())
            .then(a => {
                if(a.error) {
                    articleContainer.innerHTML = '<h1 class="text-white">404 - Article Not Found</h1>';
                    return;
                }
                const title = document.documentElement.lang === 'ru' && a.title.ru ? a.title.ru : a.title.en;
                const content = document.documentElement.lang === 'ru' && a.content.ru ? a.content.ru : a.content.en;
                
                document.getElementById('article-title').textContent = title;
                document.getElementById('article-date').textContent = a.date;
                document.getElementById('article-readtime').textContent = a.readTime;
                document.getElementById('article-like-count').textContent = a.likes || 0;
                document.title = title + ' | CRLX1Q';
                
                articleContainer.innerHTML = content;
                
                // Like button handler
                const likeBtn = document.getElementById('article-like-btn');
                if(likeBtn) {
                    const likedArticles = JSON.parse(localStorage.getItem('crlx1q_liked_articles') || '[]');
                    if(likedArticles.includes(id)) {
                        likeBtn.classList.add('text-red-500');
                        likeBtn.querySelector('svg').setAttribute('fill', 'currentColor');
                    }
                    
                    likeBtn.onclick = () => {
                        if(likedArticles.includes(id)) return; // Already liked
                        
                        fetch('/api/articles/' + id + '/like', { method: 'POST' })
                            .then(res => res.json())
                            .then(data => {
                                if(data.error && data.error !== 'Уже лайкнули') {
                                    alert(data.error);
                                } else {
                                    if(data.likes) document.getElementById('article-like-count').textContent = data.likes;
                                    likeBtn.classList.add('text-red-500');
                                    likeBtn.querySelector('svg').setAttribute('fill', 'currentColor');
                                    
                                    if(!likedArticles.includes(id)) {
                                        likedArticles.push(id);
                                        localStorage.setItem('crlx1q_liked_articles', JSON.stringify(likedArticles));
                                    }
                                }
                            });
                    };
                }
            });
    }
}

// FRONT PAGE LATEST ARTICLES LOADER
const latestArticlesGrid = document.getElementById('latest-articles-grid');
if (latestArticlesGrid) {
    fetch('/api/articles')
        .then(res => res.json())
        .then(data => {
            if(Array.isArray(data)) {
                latestArticlesGrid.innerHTML = '';
                // Only take the first 2
                data.slice(0, 2).forEach(a => {
                    const title = document.documentElement.lang === 'ru' && a.title.ru ? a.title.ru : a.title.en;
                    const desc = document.documentElement.lang === 'ru' && a.desc.ru ? a.desc.ru : a.desc.en;
                    
                    latestArticlesGrid.innerHTML += 
                    '<a href="/article?id=' + a.id + '" class="block p-6 bg-[#080808] border border-white/5 hover:border-white/20 transition-colors group relative overflow-hidden">' +
                        '<span class="absolute top-0 left-0 w-1 h-full bg-gray-800 group-hover:bg-white transition-colors"></span>' +
                        '<div class="font-mono text-[10px] text-gray-500 uppercase tracking-widest mb-3 flex gap-4">' +
                            '<span>' + a.date + '</span>' +
                            '<span>' + a.readTime + '</span>' +
                        '</div>' +
                        '<h4 class="text-lg font-medium text-white mb-2 group-hover:text-gray-200">' + title + '</h4>' +
                        '<p class="text-sm text-gray-400 line-clamp-2">' + desc + '</p>' +
                    '</a>';
                });
            }
        });
}
