(function() {
    'use strict';

    window.PddModules = window.PddModules || {};
    window.PddModules.commentAutoReply = {
        inited: false,
        panelEl: null,
        init() {
            if (this.inited) return;
            if (!window.location.href.includes('mms.pinduoduo.com/goods/evaluation/index')) return;
            this.inited = true;
            const moduleApi = this;

            return (async () => {
                // ==================== 默认配置 ====================
                const DEFAULTS = {
                    replyText: '感谢您的支持与反馈！',
                    loopCount: 5,               // 0 = 全部
                    clickDelay: 500,            // 毫秒（点击按钮后等待弹窗加载）
                    intervalMin: 2,             // 秒（两条回复之间的最小间隔）
                    intervalMax: 4,             // 秒（两条回复之间的最大间隔）
                    starFilter: 'all',          // 'all' / '1' ~ '5'
                    autoNextPage: true,         // 是否自动翻页
                    pageDelay: 3                // 秒（翻页后等待页面加载）
                };

                // ==================== 持久化变量 ====================
                let replyText    = await window.PddStorage.get('replyText_v6',    DEFAULTS.replyText);
                let loopCount    = await window.PddStorage.get('loopCount_v6',    DEFAULTS.loopCount);
                let clickDelay   = await window.PddStorage.get('clickDelay_v6',   DEFAULTS.clickDelay);
                let intervalMin  = await window.PddStorage.get('intervalMin_v6',  DEFAULTS.intervalMin);
                let intervalMax  = await window.PddStorage.get('intervalMax_v6',  DEFAULTS.intervalMax);
                let starFilter   = await window.PddStorage.get('starFilter_v6',   DEFAULTS.starFilter);
                let autoNextPage = await window.PddStorage.get('autoNextPage_v6', DEFAULTS.autoNextPage);
                let pageDelay    = await window.PddStorage.get('pageDelay_v6',    DEFAULTS.pageDelay);
                let processedOrders = await window.PddStorage.get('processedOrders_v6', []);

                // ---------- 新增：回复模板记忆 ----------
                let replyTemplates = await window.PddStorage.get('replyTemplates_v6', []);   // [{ name, text }]

                let isRunning      = false;
                let stopFlag       = false;
                let processedCount = 0;
                let totalProcessed = 0;
                let logs           = [];

                // ==================== 样式注入（新增模板相关样式） ====================
                const injectStyle = () => {
                    if (document.getElementById('pdd-reply-css')) return;
                    const cssText = `
                        /* ---------- 主窗口 ---------- */
                        #pdd-reply-window {
                            position: fixed !important; top: 100px; left: 100px;
                            width: 450px; background: #fff !important; z-index: 9999999999 !important;
                            border-radius: 12px !important; display: none; flex-direction: column;
                            box-shadow: 0 10px 40px rgba(0,0,0,0.3) !important;
                            border: 1px solid #ccc !important; font-family: sans-serif !important;
                            overflow: hidden; resize: both; min-width: 380px;
                        }
                        #pdd-reply-handle {
                            padding: 12px 20px; background: #f5f5f5; cursor: move;
                            display: flex; justify-content: space-between; align-items: center;
                            border-bottom: 1px solid #ddd; user-select: none; flex-shrink: 0;
                        }
                        #pdd-reply-content {
                            padding: 15px 18px; overflow-y: auto; max-height: 70vh; background: #fff;
                        }

                        /* ---------- 表单元素 ---------- */
                        .reply-label {
                            display: block; margin: 10px 0 4px; font-weight: bold; font-size: 13px; color: #333;
                        }
                        .reply-textarea, .reply-input, .reply-select {
                            width: 100%; box-sizing: border-box; margin-bottom: 2px;
                            padding: 8px; border: 1px solid #ddd; border-radius: 6px; font-size: 13px;
                        }
                        .reply-textarea { resize: vertical; min-height: 60px; }
                        .reply-input:focus, .reply-textarea:focus, .reply-select:focus {
                            border-color: #e02020; outline: none; box-shadow: 0 0 0 2px rgba(224,32,32,0.1);
                        }
                        .reply-comment {
                            font-size: 11px; color: #999; margin-bottom: 8px; line-height: 1.5;
                            padding-left: 2px;
                        }
                        .reply-template-row {
                            display: flex; gap: 6px; margin-top: 4px; margin-bottom: 8px;
                            align-items: center;
                        }
                        .reply-template-select {
                            flex: 3; padding: 6px; border: 1px solid #ddd; border-radius: 6px; font-size: 12px;
                        }
                        .reply-template-btn {
                            flex: 1; background: #f0f0f0; border: 1px solid #ccc; border-radius: 6px;
                            padding: 6px 0; cursor: pointer; font-size: 12px; transition: 0.2s;
                        }
                        .reply-template-btn:hover {
                            background: #e0e0e0;
                        }
                        .reply-btn-row {
                            display: flex; gap: 10px; margin-top: 12px;
                        }
                        .reply-btn {
                            flex: 1; padding: 10px 0; border: none; border-radius: 6px;
                            cursor: pointer; font-weight: bold; font-size: 14px; transition: opacity 0.2s;
                        }
                        .reply-btn:hover { opacity: 0.9; }
                        .btn-start { background: #e02020; color: #fff; }
                        .btn-stop  { background: #999; color: #fff; }
                        .reply-checkbox-row {
                            display: flex; align-items: center; gap: 8px; margin: 12px 0 4px;
                        }
                        .reply-checkbox-row input[type="checkbox"] {
                            transform: scale(1.3); accent-color: #e02020;
                        }
                        .reply-checkbox-row label { font-size: 13px; cursor: pointer; font-weight: bold; }

                        /* ---------- 日志区域 ---------- */
                        .reply-log {
                            margin-top: 12px; background: #fafafa; border: 1px solid #eee;
                            border-radius: 6px; padding: 8px 10px; height: 150px; overflow-y: auto;
                            font-size: 11px; color: #444; line-height: 1.6;
                        }
                        .log-item { padding: 3px 0; border-bottom: 1px dashed #eee; }
                        .log-item:last-child { border-bottom: none; }
                        .reply-close {
                            background: none; border: none; font-size: 22px; cursor: pointer; color: #999;
                            line-height: 1; padding: 0 4px; transition: color 0.2s;
                        }
                        .reply-close:hover { color: #333; }
                    `;
                    const style = window.PddSharedStyle.addStyle(cssText);
                    style.id = 'pdd-reply-css';
                };

                // ==================== 创建可拖拽面板 ====================
                let winEl = null, isDragging = false, dragOffsetX = 0, dragOffsetY = 0;

                // 辅助函数：渲染模板下拉菜单
                function renderTemplateSelect(selectEl) {
                    if (!selectEl) return;
                    selectEl.innerHTML = '<option value="">-- 选择历史模板 --</option>';
                    replyTemplates.forEach((tmpl, idx) => {
                        const opt = document.createElement('option');
                        opt.value = idx;
                        opt.textContent = tmpl.name.length > 30 ? tmpl.name.slice(0,27)+'...' : tmpl.name;
                        selectEl.appendChild(opt);
                    });
                }

                // 保存新模板
                async function saveTemplate(name, text) {
                    if (!name.trim()) name = `模板${replyTemplates.length+1}`;
                    replyTemplates.push({ name: name.trim(), text: text });
                    await window.PddStorage.set('replyTemplates_v6', replyTemplates);
                    // 刷新下拉列表
                    const select = document.getElementById('reply-template-select');
                    if (select) renderTemplateSelect(select);
                    addLog(`📝 已保存模板: ${name}`);
                }

                // 应用模板到文本框
                function applyTemplate(index) {
                    const tmpl = replyTemplates[index];
                    if (!tmpl) return;
                    const ta = document.getElementById('reply-text');
                    if (ta) {
                        ta.value = tmpl.text;
                        // 触发 change 事件，以便原有逻辑自动保存到 replyText
                        const evt = new Event('change', { bubbles: true });
                        ta.dispatchEvent(evt);
                        addLog(`📋 已应用模板: ${tmpl.name}`);
                    }
                }

                const createPanel = () => {
                    if (document.getElementById('pdd-reply-window')) {
                        winEl = document.getElementById('pdd-reply-window');
                        moduleApi.panelEl = winEl;
                        return;
                    }
                    const win = document.createElement('div');
                    win.id = 'pdd-reply-window';
                    win.innerHTML = `
                        <div id="pdd-reply-handle">
                            <span><strong>🤖 评价自动回复</strong> · 可拖拽移动</span>
                            <button class="reply-close" id="pdd-reply-close">&times;</button>
                        </div>
                        <div id="pdd-reply-content">
                            <!-- 回复文本 + 模板记忆 -->
                            <label class="reply-label">📝 回复文本</label>
                            <textarea id="reply-text" class="reply-textarea" rows="3">${escapeHtml(replyText)}</textarea>
                            <div class="reply-template-row">
                                <select id="reply-template-select" class="reply-template-select">
                                    <option value="">-- 选择历史模板 --</option>
                                </select>
                                <button id="reply-template-save" class="reply-template-btn">💾 保存为模板</button>
                            </div>
                            <div class="reply-comment">保存常用回复为模板，快速选用</div>

                            <!-- 星级筛选 -->
                            <label class="reply-label">⭐ 选择星级</label>
                            <select id="star-filter" class="reply-select">
                                <option value="all" ${starFilter === 'all' ? 'selected' : ''}>全部星级</option>
                                <option value="5" ${starFilter === '5' ? 'selected' : ''}>★★★★★ (5星)</option>
                                <option value="4" ${starFilter === '4' ? 'selected' : ''}>★★★★ (4星)</option>
                                <option value="3" ${starFilter === '3' ? 'selected' : ''}>★★★ (3星)</option>
                                <option value="2" ${starFilter === '2' ? 'selected' : ''}>★★ (2星)</option>
                                <option value="1" ${starFilter === '1' ? 'selected' : ''}>★ (1星)</option>
                            </select>

                            <!-- 循环次数 -->
                            <label class="reply-label">🔁 循环次数</label>
                            <input type="number" id="loop-count" class="reply-input" value="${loopCount}" min="0">
                            <div class="reply-comment">本次最多回复多少条，0 表示处理所有可见评价（含翻页）</div>

                            <!-- 点击后填写延迟 -->
                            <label class="reply-label">⏱️ 点击后填写延迟（毫秒）</label>
                            <input type="number" id="click-delay" class="reply-input" value="${clickDelay}" min="100" step="100">
                            <div class="reply-comment">点击"回复/互动"按钮后，等待弹出窗口加载完成的延时（建议 300~1000）</div>

                            <!-- 操作间隔 -->
                            <label class="reply-label">⏳ 操作间隔（秒）</label>
                            <div style="display:flex; gap:6px;">
                                <input type="number" id="interval-min" class="reply-input" value="${intervalMin}" min="1" placeholder="最小" style="width:50%;">
                                <input type="number" id="interval-max" class="reply-input" value="${intervalMax}" min="1" placeholder="最大" style="width:50%;">
                            </div>
                            <div class="reply-comment">两条回复之间的随机等待时间范围（秒），避免操作过快被风控</div>

                            <!-- 自动翻页 -->
                            <div class="reply-checkbox-row">
                                <input type="checkbox" id="auto-next-page" ${autoNextPage ? 'checked' : ''}>
                                <label for="auto-next-page">📄 启用自动翻页</label>
                            </div>
                            <label class="reply-label">翻页后等待时间（秒）</label>
                            <input type="number" id="page-delay" class="reply-input" value="${pageDelay}" min="1">
                            <div class="reply-comment">翻到下一页后，等待新页面加载完成的缓冲时间</div>

                            <!-- 按钮 -->
                            <div class="reply-btn-row">
                                <button class="reply-btn btn-start" id="btn-start">▶ 开始</button>
                                <button class="reply-btn btn-stop"  id="btn-stop">⏹ 停止</button>
                            </div>

                            <!-- 日志 -->
                            <div id="reply-log-area" class="reply-log">
                                <div class="log-item">📌 已记录 ${processedOrders.length} 条已回复订单</div>
                            </div>
                        </div>
                    `;
                    document.body.appendChild(win);
                    winEl = win;
                    moduleApi.panelEl = win;

                    // ---- 拖动事件 ----
                    const handle = document.getElementById('pdd-reply-handle');
                    handle.addEventListener('mousedown', (e) => {
                        if (e.target.tagName === 'BUTTON') return;
                        isDragging = true;
                        const rect = winEl.getBoundingClientRect();
                        dragOffsetX = e.clientX - rect.left;
                        dragOffsetY = e.clientY - rect.top;
                        winEl.style.cursor = 'grabbing';
                    });
                    document.addEventListener('mousemove', (e) => {
                        if (!isDragging) return;
                        winEl.style.left = Math.max(0, e.clientX - dragOffsetX) + 'px';
                        winEl.style.top  = Math.max(0, e.clientY - dragOffsetY) + 'px';
                    });
                    document.addEventListener('mouseup', () => {
                        if (isDragging) { isDragging = false; winEl.style.cursor = ''; }
                    });

                    // ---- 关闭按钮 ----
                    document.getElementById('pdd-reply-close').addEventListener('click', () => {
                        winEl.style.display = 'none';
                    });

                    // ========== 模板相关事件 ==========
                    const templateSelect = document.getElementById('reply-template-select');
                    const saveTemplateBtn = document.getElementById('reply-template-save');
                    // 渲染已有的模板列表
                    renderTemplateSelect(templateSelect);
                    // 选择模板时应用
                    templateSelect.addEventListener('change', (e) => {
                        const idx = e.target.value;
                        if (idx !== '') applyTemplate(parseInt(idx));
                        // 清空选中状态
                        e.target.value = '';
                    });
                    // 保存为模板
                    saveTemplateBtn.addEventListener('click', async () => {
                        const ta = document.getElementById('reply-text');
                        const currentText = ta ? ta.value : '';
                        let name = prompt('请输入模板名称（用于记忆）:', `模板_${new Date().toLocaleTimeString()}`);
                        if (name === null) return;
                        await saveTemplate(name || `模板${replyTemplates.length+1}`, currentText);
                    });

                    // ---- 原有控件变更保存 ----
                    document.getElementById('btn-start').addEventListener('click', startAutoReply);
                    document.getElementById('btn-stop').addEventListener('click', stopAutoReply);
                    document.getElementById('reply-text').addEventListener('change', async e => {
                        replyText = e.target.value; await window.PddStorage.set('replyText_v6', replyText);
                    });
                    document.getElementById('loop-count').addEventListener('change', async e => {
                        loopCount = parseInt(e.target.value) || 0; await window.PddStorage.set('loopCount_v6', loopCount);
                    });
                    document.getElementById('click-delay').addEventListener('change', async e => {
                        clickDelay = parseInt(e.target.value) || 500; await window.PddStorage.set('clickDelay_v6', clickDelay);
                    });
                    document.getElementById('interval-min').addEventListener('change', async e => {
                        intervalMin = parseInt(e.target.value) || 2; await window.PddStorage.set('intervalMin_v6', intervalMin);
                    });
                    document.getElementById('interval-max').addEventListener('change', async e => {
                        intervalMax = parseInt(e.target.value) || 4; await window.PddStorage.set('intervalMax_v6', intervalMax);
                    });
                    document.getElementById('star-filter').addEventListener('change', async e => {
                        starFilter = e.target.value; await window.PddStorage.set('starFilter_v6', starFilter);
                    });
                    document.getElementById('auto-next-page').addEventListener('change', async e => {
                        autoNextPage = e.target.checked; await window.PddStorage.set('autoNextPage_v6', autoNextPage);
                    });
                    document.getElementById('page-delay').addEventListener('change', async e => {
                        pageDelay = parseInt(e.target.value) || 3; await window.PddStorage.set('pageDelay_v6', pageDelay);
                    });
                };

                // ==================== 日志系统（保留200条，可滚动） ====================
                function addLog(msg, type = 'info') {
                    const timestamp = new Date().toLocaleTimeString();
                    const prefix = type === 'error' ? '❌' : type === 'success' ? '✅' : 'ℹ️';
                    const text = `[${timestamp}] ${prefix} ${msg}`;
                    console.log(text);
                    logs.push(text);
                    if (logs.length > 200) {
                        logs.splice(0, logs.length - 200);
                    }
                    const logArea = document.getElementById('reply-log-area');
                    if (logArea) {
                        logArea.innerHTML = logs.map(l => `<div class="log-item">${l}</div>`).join('');
                        logArea.scrollTop = logArea.scrollHeight;
                    }
                }

                function stopAutoReply() {
                    stopFlag = true; isRunning = false; addLog('⏹ 手动停止');
                }

                function escapeHtml(str) {
                    const div = document.createElement('div');
                    div.textContent = str; return div.innerHTML;
                }

                // ==================== 提取订单编号和星级 ====================
                function extractOrderId(row) {
                    const cell = row.querySelector('td:nth-child(2)');
                    if (!cell) return null;
                    const m = cell.textContent.match(/订单编号：(\d{6}-\d{15})/);
                    return m ? m[1] : null;
                }

                function getStarRating(commentRow) {
                    let prev = commentRow.previousElementSibling;
                    while (prev && prev.tagName !== 'TR') prev = prev.previousElementSibling;
                    if (!prev || !prev.classList.contains('TB_bodyGroupHeader_5-188-0')) return 0;
                    const stars = prev.querySelectorAll('svg[data-testid="beast-core-icon-star_filled"]');
                    return stars.length || 0;
                }

                function getParentRow(el) {
                    while (el && el.tagName !== 'TR') el = el.parentElement;
                    return el;
                }

                // ==================== 获取待处理按钮 ====================
                function getPendingReplyButtons() {
                    const links = document.querySelectorAll('a[data-testid="beast-core-button-link"]');
                    const buttons = Array.from(links).filter(l => l.textContent.trim() === '回复/互动');
                    const pending = [];
                    for (const btn of buttons) {
                        const row = getParentRow(btn);
                        if (!row) continue;
                        const orderId = extractOrderId(row);
                        if (orderId && processedOrders.includes(orderId)) continue;
                        if (starFilter !== 'all') {
                            if (getStarRating(row) !== parseInt(starFilter)) continue;
                        }
                        pending.push({ button: btn, orderId, row });
                    }
                    return pending;
                }

                // ==================== 工具：等待元素 ====================
                function waitForElement(selector, timeout = 8000) {
                    return new Promise((resolve, reject) => {
                        const start = Date.now();
                        const check = () => {
                            const el = document.querySelector(selector);
                            if (el) return resolve(el);
                            if (Date.now() - start > timeout) return reject(new Error(`等待超时: ${selector}`));
                            setTimeout(check, 200);
                        };
                        check();
                    });
                }

                // ==================== 翻页工具 ====================
                function getNextPageButton() {
                    return document.querySelector('li[data-testid="beast-core-pagination-next"]:not(.PGT_disabled_5-188-0)');
                }

                async function goToNextPage() {
                    const nextBtn = getNextPageButton();
                    if (!nextBtn) return false;
                    const cur = document.querySelector('li.PGT_pagerItemActive_5-188-0');
                    const curPage = cur ? parseInt(cur.textContent) : 1;
                    nextBtn.click();
                    addLog(`📄 翻到第 ${curPage + 1} 页，等待 ${pageDelay} 秒...`);
                    await new Promise(r => setTimeout(r, pageDelay * 1000));
                    try {
                        await waitForElement('a[data-testid="beast-core-button-link"]', 15000);
                        addLog('✅ 新页面加载完成');
                        return true;
                    } catch {
                        addLog('❌ 翻页后等待超时', 'error');
                        return false;
                    }
                }

                // ==================== 回复单条 ====================
                async function replyOne(btnInfo) {
                    const { button, orderId } = btnInfo;
                    return new Promise((resolve, reject) => {
                        (async () => {
                            try {
                                button.click();
                                addLog(`👆 点击订单 ${orderId} 的回复按钮`);
                                await waitForElement('div[data-testid="beast-core-modal-inner"]');
                                await new Promise(r => setTimeout(r, clickDelay));

                                const header = document.querySelector('.MDL_header_5-188-0');
                                if (!header || header.textContent.trim() !== '快捷回复') {
                                    addLog(`⏭ 订单 ${orderId} 已有互动，跳过`);
                                    const cancel = Array.from(document.querySelectorAll('button'))
                                        .find(b => b.textContent.trim() === '取消');
                                    if (cancel) cancel.click();
                                    if (orderId && !processedOrders.includes(orderId)) {
                                        processedOrders.push(orderId);
                                        await window.PddStorage.set('processedOrders_v6', processedOrders);
                                    }
                                    return resolve();
                                }

                                const ta = document.querySelector('textarea[data-testid="beast-core-textArea-htmlInput"]');
                                if (!ta) throw new Error('未找到输入框');
                                const setter = Object.getOwnPropertyDescriptor(
                                    window.HTMLTextAreaElement.prototype, 'value'
                                ).set;
                                setter.call(ta, replyText);
                                ta.dispatchEvent(new Event('input',  { bubbles: true }));
                                ta.dispatchEvent(new Event('change', { bubbles: true }));
                                addLog('✏️ 已填入回复文本');
                                await new Promise(r => setTimeout(r, 300));

                                const submit = Array.from(document.querySelectorAll('button'))
                                    .find(b => b.textContent.trim() === '回复');
                                if (!submit) throw new Error('未找到提交按钮');
                                submit.click();
                                addLog('✅ 已提交回复', 'success');
                                await new Promise(r => setTimeout(r, 1500));

                                if (orderId && !processedOrders.includes(orderId)) {
                                    processedOrders.push(orderId);
                                    await window.PddStorage.set('processedOrders_v6', processedOrders);
                                }
                                resolve();
                            } catch (err) {
                                addLog(`❌ 订单 ${orderId} 失败: ${err.message}`, 'error');
                                const close = document.querySelector('.ant-modal-close, [aria-label="Close"]');
                                if (close) close.click();
                                reject(err);
                            }
                        })();
                    });
                }

                // ==================== 主循环（含翻页） ====================
                async function startAutoReply() {
                    if (isRunning) return addLog('⚠️ 已有任务在运行');
                    stopFlag = false; isRunning = true;
                    processedCount = 0; totalProcessed = 0;
                    let remaining = loopCount;

                    addLog(`🚀 开始任务，目标：${remaining === 0 ? '全部' : remaining + '条'} | 星级：${starFilter === 'all' ? '全部' : starFilter+'星'} | 翻页：${autoNextPage ? '开' : '关'}`);

                    while (!stopFlag) {
                        const pending = getPendingReplyButtons();
                        if (pending.length === 0) {
                            addLog('📭 当前页无可回复评价');
                        } else {
                            const take = remaining === 0 ? pending.length : Math.min(pending.length, remaining);
                            addLog(`📋 本页 ${pending.length} 条，处理 ${take} 条`);
                            for (let i = 0; i < take; i++) {
                                if (stopFlag) {
                                    addLog(`⏹ 已停止，累计 ${totalProcessed} 条`);
                                    return (isRunning = false);
                                }
                                try {
                                    await replyOne(pending[i]);
                                    totalProcessed++; processedCount++;
                                    if (remaining > 0) remaining--;
                                    addLog(`📊 进度：${totalProcessed}/${loopCount === 0 ? '∞' : loopCount}`);
                                    if (remaining === 0 && loopCount > 0) {
                                        addLog('🎉 已完成设定次数', 'success');
                                        return (isRunning = false);
                                    }
                                    const delay = (intervalMin + Math.random() * (intervalMax - intervalMin)) * 1000;
                                    await new Promise(r => setTimeout(r, delay));
                                } catch {
                                    addLog('⚠️ 本条出错，继续下一条', 'error');
                                    await new Promise(r => setTimeout(r, 2000));
                                }
                            }
                        }

                        if (stopFlag || (remaining === 0 && loopCount > 0)) continue;
                        if (!autoNextPage) { addLog('📌 未启用自动翻页，结束'); return (isRunning = false); }
                        if (!getNextPageButton()) { addLog('🏁 已到最后一页', 'success'); return (isRunning = false); }

                        if (!(await goToNextPage())) { addLog('❌ 翻页失败，终止', 'error'); return (isRunning = false); }
                    }
                    isRunning = false;
                }

                // ==================== 初始化 ====================
                function init() {
                    injectStyle();
                    createPanel();
                    addLog(`✅ 脚本就绪 | 历史回复 ${processedOrders.length} 条 | 模板数量 ${replyTemplates.length}`);
                }

                if (document.readyState === 'loading') {
                    document.addEventListener('DOMContentLoaded', init);
                } else {
                    init();
                }
            })();
        },
        show() {
            const panel = this.panelEl || document.getElementById('pdd-reply-window');
            if (!panel) return;
            this.panelEl = panel;
            panel.style.display = 'flex';
            panel.style.zIndex = '2147483646';
        },
        hide() {
            const panel = this.panelEl || document.getElementById('pdd-reply-window');
            if (!panel) return;
            this.panelEl = panel;
            panel.style.display = 'none';
        }
    };
})();
