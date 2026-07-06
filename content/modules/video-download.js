(function() {
    'use strict';

    window.PddModules = window.PddModules || {};
    window.PddModules.videoDownload = {
        inited: false,
        panelEl: null,
        init() {
            if (this.inited) return;
            this.inited = true;
            const moduleApi = this;

            const STATE = {
                isRunning: false,
                isPaused: false,
                currentIndex: 0,
                clickDelay: 2000,
                nextVideoDelay: 2500,
                pageDelay: 4500,
                totalDownloaded: 0
            };

            let sequenceTimer = null;

            // ========== 样式（保持不变） ==========
            const cssText = `
                #pdd-workstation-panel {
                    position: fixed !important; top: 80px !important; right: 20px !important; z-index: 2147483646 !important;
                    width: 320px !important; background: #fff !important; border-radius: 12px !important; box-shadow: 0 10px 30px rgba(0,0,0,0.4) !important;
                    font-family: sans-serif !important; border: 2px solid #333 !important; display: none; flex-direction: column !important;
                }
                .ws-header { background: #333 !important; color: #fff !important; padding: 10px 12px !important; display: flex !important; justify-content: space-between !important; cursor: move !important; font-weight: bold !important; font-size: 14px !important; }
                .ws-tabs { display: flex !important; background: #f4f4f4 !important; border-bottom: 1px solid #ddd !important; }
                .ws-tab { flex: 1 !important; padding: 8px !important; text-align: center !important; cursor: pointer !important; font-size: 12px !important; font-weight: bold !important; color: #888 !important; }
                .ws-tab.active { background: #fff !important; color: #e74c3c !important; border-bottom: 2px solid #e74c3c !important; }
                .ws-body { padding: 12px !important; flex: 1 !important; overflow-y: auto !important; max-height: 50vh !important; }
                .ws-section { display: none !important; }
                .ws-section.active { display: block !important; }
                .ws-btn { width: 100% !important; padding: 10px !important; border: none !important; border-radius: 6px !important; color: #fff !important; font-weight: bold !important; cursor: pointer !important; margin-bottom: 6px !important; }
                .btn-run { background: #27ae60 !important; }
                .btn-pause { background: #f1c40f !important; color: #333 !important; flex: 1 !important; }
                .btn-stop { background: #e74c3c !important; color: #fff !important; flex: 1 !important; }
                .task-config-row { display: flex !important; justify-content: space-between !important; background: #f0f7ff !important; padding: 8px !important; border-radius: 6px !important; margin-bottom: 8px !important; font-size: 11px; }
                .log-panel { border-top: 1px solid #ddd !important; background: #fafafa !important; }
                .log-header { padding: 6px 10px !important; font-size: 11px !important; font-weight: bold !important; background: #eee !important; cursor: pointer; display: flex; justify-content: space-between; }
                .log-body { height: 120px !important; overflow-y: auto !important; padding: 5px !important; font-family: monospace !important; font-size: 10px !important; }
            `;
            window.PddSharedStyle.addStyle(cssText);

            const log = (msg) => {
                const container = document.getElementById('ws-log-container');
                if (!container) return;
                const item = document.createElement('div');
                item.style.borderBottom = "1px solid #eee";
                item.innerHTML = `<span style="color:#999">[${new Date().toLocaleTimeString()}]</span> ${msg}`;
                container.appendChild(item);
                container.scrollTop = container.scrollHeight;
            };

            // ================= 翻页核心逻辑（同 v18，不再重复） =================
            function getModalRoot() {
                let modal = document.querySelector('[data-testid="beast-core modal"]');
                if (modal) return modal;
                modal = document.querySelector('.beast-core-modal-content');
                if (modal) return modal;
                modal = document.querySelector('.MDL_outerWrapper_5-180-0');
                if (modal) return modal;
                modal = document.querySelector('.beast-core-modal-container');
                if (modal && modal.querySelector('[class*="playIcon"], [class*="Item_left_"]')) return modal;
                return document.body;
            }

            function getNextPageButton() {
                const modal = getModalRoot();
                if (!modal) return null;
                let nextBtn = modal.querySelector('li[data-testid="beast-core-pagination-next"]:not(.PGT_disabled_)');
                if (nextBtn && !nextBtn.disabled) return nextBtn;
                nextBtn = modal.querySelector('li[class*="PGT_next_"]:not([class*="PGT_disabled_"])');
                if (nextBtn && !nextBtn.disabled) return nextBtn;
                nextBtn = document.querySelector('li[data-testid="beast-core-pagination-next"]:not(.PGT_disabled_)');
                if (nextBtn && !nextBtn.disabled) return nextBtn;
                nextBtn = document.querySelector('li[class*="PGT_next_"]:not([class*="PGT_disabled_"])');
                if (nextBtn && !nextBtn.disabled) return nextBtn;
                const allPossible = modal.querySelectorAll('li, button, a, div[role="button"]');
                for (let el of allPossible) {
                    const text = el.innerText.trim();
                    if ((text === '下一页' || text === 'Next') && !el.disabled && !el.classList.contains('disabled')) {
                        return el;
                    }
                }
                nextBtn = modal.querySelector('[aria-label="下一页"], [aria-label="Next page"]');
                if (nextBtn && !nextBtn.disabled) return nextBtn;
                return null;
            }

            function safeClick(element) {
                if (!element) return false;
                if (typeof element.click === 'function') {
                    element.click();
                    return true;
                }
                let parent = element.parentElement;
                while (parent) {
                    if (typeof parent.click === 'function') {
                        parent.click();
                        return true;
                    }
                    parent = parent.parentElement;
                }
                const evt = new MouseEvent('click', { bubbles: true, cancelable: true, view: window });
                element.dispatchEvent(evt);
                return true;
            }

            function clickNextPage() {
                const nextBtn = getNextPageButton();
                if (!nextBtn) {
                    log("❌ 未找到下一页按钮");
                    return false;
                }
                log("⏭ 找到下一页按钮，准备点击...");
                let clickTarget = nextBtn;
                if (nextBtn.tagName === 'LI') {
                    const inner = nextBtn.querySelector('button, a');
                    if (inner) clickTarget = inner;
                    else if (nextBtn.children.length > 0) clickTarget = nextBtn.children[0];
                }
                const success = safeClick(clickTarget);
                log(success ? "🖱️ 翻页点击已执行" : "⚠️ 翻页点击失败");
                return success;
            }

            // ================= 关闭弹窗（同 v18） =================
            function closeVideoPopup() {
                const closeSvg = document.querySelector('svg path[d="M566.306 512l244.376-244.376c14.997-14.996 14.997-39.309 0-54.305-14.996-14.997-39.309-14.997-54.305 0L512 457.694 267.624 213.318c-14.996-14.997-39.31-14.997-54.306 0-14.996 14.996-14.996 39.309 0 54.305L457.694 512 213.318 756.376c-14.996 14.996-14.996 39.31 0 54.306 14.996 14.996 39.31 14.996 54.306 0L512 566.306l244.376 244.376c14.996 14.996 39.309 14.996 54.305 0 14.997-14.996 14.997-39.31 0-54.306L566.306 512z"]');
                if (closeSvg) {
                    let btn = closeSvg.closest('button, div[role="button"], span, a');
                    if (btn) {
                        log("✅ 通过 SVG path 找到关闭按钮");
                        safeClick(btn);
                        return true;
                    }
                }
                const modal = document.querySelector('.beast-core-modal-container');
                if (modal) {
                    const closeBtn = modal.querySelector('[class*="close"], [class*="Close"], button[aria-label="关闭"], svg');
                    if (closeBtn) {
                        log("✅ 通过 modal 容器找到关闭按钮");
                        safeClick(closeBtn);
                        return true;
                    }
                    const mask = modal.previousElementSibling;
                    if (mask && (mask.classList.contains('mask') || mask.classList.contains('overlay'))) {
                        safeClick(mask);
                        return true;
                    }
                }
                log("⚠️ 未找到关闭按钮，按 ESC");
                document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', keyCode: 27 }));
                return false;
            }

            // ================= 获取播放按钮（修复重复识别） =================
            function getPlayButtons() {
                const container = getModalRoot();
                // 1. 精确匹配 class 中包含 "playIcon" 的元素（不区分大小写），避免匹配封面图
                let candidates = Array.from(container.querySelectorAll('[class*="playIcon" i]'));
                log(`🔍 原始匹配到 ${candidates.length} 个 playIcon 元素`);

                // 2. 按视频项去重：每个视频项只保留一个播放按钮
                const unique = [];
                const seenItems = new Set();
                for (let el of candidates) {
                    // 找到视频项的根容器（包含 Item_ 类名的父级）
                    let item = el.closest('[class*="Item_"], [class*="video-item"], [class*="list-item"], [role="listitem"]');
                    if (!item) {
                        // 如果找不到，尝试向上找两层（有些结构可能没有明确 Item_ 类）
                        let parent = el.parentElement;
                        while (parent && parent !== container) {
                            if (parent.classList && parent.classList.length > 0 &&
                                (parent.className.includes('Item_') || parent.className.includes('item'))) {
                                item = parent;
                                break;
                            }
                            parent = parent.parentElement;
                        }
                    }
                    if (!item) item = el;
                    const key = item;
                    if (!seenItems.has(key)) {
                        seenItems.add(key);
                        unique.push(el);
                    }
                }
                log(`📊 去重后得到 ${unique.length} 个播放按钮`);
                if (unique.length === 0) {
                    log("💡 未检测到播放按钮，请确认已打开视频列表弹窗");
                } else {
                    log(`📌 第一个按钮: ${unique[0].tagName} class="${unique[0].className}"`);
                }
                return unique;
            }

            // ================= 核心流程（同 v18） =================
            async function startSequence() {
                if (sequenceTimer) clearTimeout(sequenceTimer);
                if (!STATE.isRunning || STATE.isPaused) return;

                const playBtns = getPlayButtons();
                if (playBtns.length === 0) {
                    log("❌ 未检测到视频列表，请确保弹窗已打开");
                    STATE.isRunning = false;
                    updateControlUI(false);
                    return;
                }

                if (STATE.currentIndex >= playBtns.length) {
                    log("🏁 本页处理完，尝试翻页...");
                    handleNextPage();
                    return;
                }

                const target = playBtns[STATE.currentIndex];
                target.scrollIntoView({ block: 'center' });
                document.getElementById('stat-index').innerText = STATE.currentIndex + 1;
                log(`▶️ 点开第 ${STATE.currentIndex + 1} 个视频...`);
                safeClick(target);

                sequenceTimer = setTimeout(() => {
                    handleDownloadAndClose();
                }, STATE.clickDelay);
            }

            async function handleDownloadAndClose() {
                if (!STATE.isRunning || STATE.isPaused) return;
                let video = document.querySelector('video[data-testid="beast-core-preview-video"]') || document.querySelector('video');
                if (!video) {
                    log("⚠️ 未检测到视频元素，跳过");
                    closeVideoPopup();
                    STATE.currentIndex++;
                    sequenceTimer = setTimeout(startSequence, STATE.nextVideoDelay);
                    return;
                }
                if (video.src && video.src.startsWith('http')) {
                    log(`📥 下载: ${video.src.substring(0, 80)}...`);
                    // TODO: 此处下载远程视频链接，MV3 下需要 background/service-worker 通过 chrome.downloads 配合处理跨域下载与文件名。
                    window.PddDownload.downloadFile({
                        url: video.src,
                        name: `PDD_video_${Date.now()}.mp4`,
                        onload: () => {
                            STATE.totalDownloaded++;
                            document.getElementById('stat-count').innerText = STATE.totalDownloaded;
                            log(`✅ 下载完成，累计 ${STATE.totalDownloaded}`);
                        },
                        onerror: (err) => log(`❌ 下载失败: ${err}`)
                    });
                } else {
                    log("⚠️ 视频链接无效");
                }
                setTimeout(() => {
                    closeVideoPopup();
                    STATE.currentIndex++;
                    sequenceTimer = setTimeout(startSequence, STATE.nextVideoDelay);
                }, 1200);
            }

            function handleNextPage() {
                const clicked = clickNextPage();
                if (!clicked) {
                    log("📄 无法点击下一页，任务结束");
                    STATE.isRunning = false;
                    updateControlUI(false);
                    return;
                }
                STATE.currentIndex = 0;
                if (sequenceTimer) clearTimeout(sequenceTimer);
                sequenceTimer = setTimeout(() => {
                    log("🔄 翻页等待结束，继续任务");
                    startSequence();
                }, STATE.pageDelay);
            }

            // ================= UI 控制（同 v18） =================
            function updateControlUI(isActive) {
                const root = moduleApi.panelEl || document;
                const startBtn = root.querySelector('#btn-start-task');
                const controlGroup = root.querySelector('#ws-control-group');
                if (!startBtn) return;
                if (isActive) {
                    startBtn.style.display = 'none';
                    controlGroup.style.display = 'flex';
                } else {
                    startBtn.style.display = 'block';
                    controlGroup.style.display = 'none';
                    root.querySelector('#stat-index').innerText = '0';
                    STATE.currentIndex = 0;
                    STATE.totalDownloaded = 0;
                    root.querySelector('#stat-count').innerText = '0';
                }
            }

            function loadConfigFromUI() {
                const clickDelayInput = document.getElementById('cfg-click');
                if (clickDelayInput) {
                    let val = parseInt(clickDelayInput.value, 10);
                    if (!isNaN(val) && val > 500) STATE.clickDelay = val;
                }
            }

            function bindEvents(panel) {
                panel.querySelector('#ws-panel-close').onclick = () => panel.style.display = 'none';
                const tabs = panel.querySelectorAll('.ws-tab');
                const sections = {
                    'sec-task': panel.querySelector('#sec-task'),
                    'sec-setting': panel.querySelector('#sec-setting')
                };
                tabs.forEach(tab => {
                    tab.addEventListener('click', () => {
                        const targetId = tab.getAttribute('data-target');
                        if (!targetId || !sections[targetId]) return;
                        tabs.forEach(t => t.classList.remove('active'));
                        tab.classList.add('active');
                        Object.values(sections).forEach(sec => sec.classList.remove('active'));
                        sections[targetId].classList.add('active');
                    });
                });
                panel.querySelector('#btn-start-task').onclick = () => {
                    if (STATE.isRunning) {
                        log("⚠️ 任务已在运行");
                        return;
                    }
                    loadConfigFromUI();
                    STATE.isRunning = true;
                    STATE.isPaused = false;
                    STATE.currentIndex = 0;
                    updateControlUI(true);
                    log("🚀 任务启动，请确保视频列表弹窗已打开");
                    if (sequenceTimer) clearTimeout(sequenceTimer);
                    startSequence();
                };
                const pauseBtn = panel.querySelector('#btn-pause-task');
                pauseBtn.onclick = () => {
                    if (!STATE.isRunning) return;
                    STATE.isPaused = !STATE.isPaused;
                    pauseBtn.innerText = STATE.isPaused ? "▶ 继续" : "⏸ 暂停";
                    log(STATE.isPaused ? "⏸ 已暂停" : "▶ 继续");
                    if (!STATE.isPaused) {
                        if (sequenceTimer) clearTimeout(sequenceTimer);
                        startSequence();
                    }
                };
                panel.querySelector('#btn-stop-task').onclick = () => {
                    STATE.isRunning = false;
                    STATE.isPaused = false;
                    if (sequenceTimer) clearTimeout(sequenceTimer);
                    updateControlUI(false);
                    const pauseBtnInner = panel.querySelector('#btn-pause-task');
                    if (pauseBtnInner) pauseBtnInner.innerText = "⏸ 暂停";
                    log("🛑 已停止");
                };
            }

            function initUI() {
                if (document.querySelector('[data-pdd-module="video-download"]')) {
                    moduleApi.panelEl = document.querySelector('[data-pdd-module="video-download"]');
                    return;
                }
                const panel = document.createElement('div');
                panel.id = 'pdd-workstation-panel';
                panel.dataset.pddModule = 'video-download';
                panel.innerHTML = `
                    <div class="ws-header" id="ws-header-drag"><span>下载工作台 V19.0</span><span id="ws-panel-close">✕</span></div>
                    <div class="ws-tabs">
                        <div class="ws-tab active" data-target="sec-task">任务</div>
                        <div class="ws-tab" data-target="sec-setting">设置</div>
                    </div>
                    <div class="ws-body">
                        <div class="ws-section active" id="sec-task">
                            <button class="ws-btn btn-run" id="btn-start-task">▶ 开始全自动下载</button>
                            <div id="ws-control-group" style="display:none; gap:5px;">
                                <button class="ws-btn btn-pause" id="btn-pause-task">⏸ 暂停</button>
                                <button class="ws-btn btn-stop" id="btn-stop-task">⏹ 停止</button>
                            </div>
                            <div class="task-config-row">
                                <div>已保存: <span id="stat-count">0</span></div>
                                <div>当前: 第 <span id="stat-index">0</span> 个</div>
                            </div>
                        </div>
                        <div class="ws-section" id="sec-setting">
                            <div style="font-size:11px; margin-bottom:5px;">点击延迟(ms)</div>
                            <input type="number" id="cfg-click" style="width:100%; padding:8px; border-radius:6px; border:1px solid #ccc;" value="${STATE.clickDelay}">
                        </div>
                    </div>
                    <div class="log-panel">
                        <div class="log-header">📋 运行日志</div>
                        <div class="log-body" id="ws-log-container"></div>
                    </div>
                `;
                document.body.appendChild(panel);
                moduleApi.panelEl = panel;
                bindEvents(panel);
                log("💡 工作台 V19.0 已加载 | 播放按钮去重优化");
            }

            setInterval(() => {
                if (!document.querySelector('[data-pdd-module="video-download"]') && document.body) initUI();
            }, 2000);
            if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initUI);
            else initUI();
        },
        show() {
            const panel = this.panelEl || document.querySelector('[data-pdd-module="video-download"]');
            if (!panel) return;
            this.panelEl = panel;
            panel.style.display = 'flex';
            panel.style.zIndex = '2147483646';
        },
        hide() {
            const panel = this.panelEl || document.querySelector('[data-pdd-module="video-download"]');
            if (!panel) return;
            this.panelEl = panel;
            panel.style.display = 'none';
        }
    };
})();
