(function () {
    'use strict';

    const ROOT_ID = 'videoWorkbench-root';

    window.PddModules = window.PddModules || {};
    window.PddModules.videoWorkbench = {
        inited: false,
        panelEl: null,
        init() {
            if (this.inited) return;
            this.inited = true;
            const moduleApi = this;

            const existingPanel = document.getElementById(ROOT_ID);
            if (existingPanel) {
                moduleApi.panelEl = existingPanel;
                return;
            }

            let isRunning = false;
            let isPaused = false;
            let isBatchUploading = false;
            let isNavigationLocked = false;
            let isPageStable = false;
            let pageStableTimer = null;
            let START_LOCK = false;
            let currentPhase = 'UPLOAD_PHASE';
            let uploadFinished = false;
            let publishLocked = true;
            let currentUploadCompletePromise = null;
            let currentBatchExpectedCount = 0;
            const uploadAttemptState = new Map();
            const executionLogs = [];
            let activeRunSummary = null;
            const MEMORY_KEY = 'pdd_video_helper_memory';
            const DELAY_CONFIG_STORAGE_KEY = 'pdd_video_workbench_delay_config';
            const DELAY_CONFIG_IDS = [
                'cfg-id-wait',
                'cfg-title-sleep',
                'cfg-declare-wait',
                'cfg-modal-wait',
                'cfg-cover-ready-wait',
                'cfg-cover-publish-wait',
                'cfg-loop-wait'
            ];
            const PRODUCT_CONFIG_STORAGE_KEY = 'pdd_product_config_manager_configs';
            const PRODUCT_CONFIG_DB_NAME = 'pdd-product-config-manager';
            const PRODUCT_CONFIG_DB_VERSION = 2;
            const PRODUCT_HANDLE_STORE = 'folderHandles';
            const PRODUCT_VIDEO_EXTENSIONS = ['.mp4', '.mov', '.m4v', '.avi', '.mkv', '.webm'];
            const BATCH_STATES = [
                'INIT',
                'SCANNING_FILES',
                'BATCH_SPLIT',
                'UPLOAD_IN_PROGRESS',
                'UPLOAD_COMPLETED',
                'TITLE_BINDING_DONE',
                'ID_BINDING_DONE',
                'STATEMENT_DONE',
                'COVER_PROCESSING',
                'COVER_WAITING',
                'PUBLISHING',
                'PUBLISH_WAITING',
                'PUBLISHED',
                'BATCH_DONE',
                'BATCH_BLOCKED'
            ];
            const BATCH_STATE_LABELS = {
                INIT: '初始化',
                SCANNING_FILES: '扫描文件',
                BATCH_SPLIT: '批次拆分',
                UPLOAD_IN_PROGRESS: '上传中',
                UPLOAD_COMPLETED: '上传完成',
                TITLE_BINDING_DONE: '标题绑定完成',
                ID_BINDING_DONE: '商品ID绑定完成',
                STATEMENT_DONE: '声明完成',
                COVER_PROCESSING: '封面处理中',
                COVER_WAITING: '等待封面确认',
                PUBLISHING: '发布中',
                PUBLISH_WAITING: '等待发布确认',
                PUBLISHED: '发布完成',
                BATCH_DONE: '批次完成',
                BATCH_BLOCKED: '批次阻断'
            };
            const batchLifecycle = {
                batchId: null,
                state: 'INIT',
                uploadCompleted: false,
                coverCompleted: false,
                consistencyPassed: false,
                publishCompleted: false,
                coverDoneCount: 0,
                publishedCount: 0,
                expectedCount: 0,
                processedFileKeys: new Set()
            };
            const batchExitGuard = {
                upload: false,
                cover: false,
                publish: false
            };
            const publishState = {
                clicked: new Set(),
                successConfirmed: new Set(),
                uiConfirmed: new Set()
            };
            const coverState = {
                uiConfirmed: new Set()
            };
            const videoBindingState = {
                title: { done: new Set() },
                id: { done: new Set() },
                statement: { done: new Set() },
                statementClickLock: new Set()
            };
            const phaseLock = {
                TITLE_BINDING_DONE: false,
                ID_BINDING_DONE: false,
                STATEMENT_DONE: false
            };
            const startupPerf = {
                active: false,
                startedAt: 0,
                marks: {},
                durations: {
                    bootstrap: 0,
                    domReady: 0,
                    fileScan: 0,
                    batchBuild: 0,
                    uploadInit: 0,
                    idleWait: 0
                }
            };

            const getCfg = (id, defaultVal) => {
                const el = document.getElementById(id);
                if (!el) return defaultVal;
                if (el.type === 'checkbox') return el.checked;
                const val = parseInt(el.value, 10);
                return Number.isNaN(val) ? defaultVal : val;
            };

            function restoreDelayConfig() {
                let saved = {};
                try {
                    saved = JSON.parse(localStorage.getItem(DELAY_CONFIG_STORAGE_KEY) || '{}');
                } catch (error) {
                    saved = {};
                }
                DELAY_CONFIG_IDS.forEach((id) => {
                    const el = document.getElementById(id);
                    if (!el || saved[id] === undefined) return;
                    el.value = saved[id];
                });
            }

            function saveDelayConfig() {
                const saved = {};
                DELAY_CONFIG_IDS.forEach((id) => {
                    const el = document.getElementById(id);
                    if (!el) return;
                    saved[id] = el.value;
                });
                localStorage.setItem(DELAY_CONFIG_STORAGE_KEY, JSON.stringify(saved));
            }

            function bindDelayConfigPersistence() {
                restoreDelayConfig();
                DELAY_CONFIG_IDS.forEach((id) => {
                    const el = document.getElementById(id);
                    if (!el) return;
                    el.addEventListener('input', saveDelayConfig);
                    el.addEventListener('change', saveDelayConfig);
                });
                saveDelayConfig();
            }

            const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

            function nowTimeLabel() {
                const now = new Date();
                return `${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}:${now.getSeconds().toString().padStart(2, '0')}`;
            }

            function resetStartupPerf() {
                startupPerf.active = true;
                startupPerf.startedAt = performance.now();
                startupPerf.marks = {};
                startupPerf.durations = {
                    bootstrap: 0,
                    domReady: 0,
                    fileScan: 0,
                    batchBuild: 0,
                    uploadInit: 0,
                    idleWait: 0
                };
                renderStartupPerfPanel();
            }

            function timerMark(name, metricName) {
                const now = performance.now();
                startupPerf.marks[name] = now;
                if (metricName && startupPerf.marks[`${name}_start`]) {
                    startupPerf.durations[metricName] = Math.max(0, Math.round(now - startupPerf.marks[`${name}_start`]));
                }
                const elapsed = Math.round(now - (startupPerf.startedAt || now));
                console.log(`[TIMER] ${name}`, { elapsed });
                addLog(`[TIMER] ${name}`, 'info');
                renderStartupPerfPanel();
            }

            function timerLog(name) {
                console.log(`[TIMER] ${name}`, {
                    batchId: batchLifecycle.batchId,
                    state: batchLifecycle.state
                });
                addLog(`[TIMER] ${name}`, 'info');
            }

            function timerStart(name) {
                startupPerf.marks[`${name}_start`] = performance.now();
                console.log(`[TIMER][${name}] start`);
            }

            function timerEnd(name, metricName = name) {
                const started = startupPerf.marks[`${name}_start`] || performance.now();
                const duration = Math.max(0, Math.round(performance.now() - started));
                startupPerf.durations[metricName] = duration;
                console.log(`[${nowTimeLabel()}][TIMER][${name}] ${duration}ms`);
                addLog(`[TIMER][${name}] ${duration}ms`, 'info');
                renderStartupPerfPanel();
                return duration;
            }

            function renderStartupPerfPanel() {
                const map = {
                    bootstrap: startupPerf.durations.bootstrap,
                    domReady: startupPerf.durations.domReady,
                    fileScan: startupPerf.durations.fileScan,
                    batchBuild: startupPerf.durations.batchBuild,
                    uploadInit: startupPerf.durations.uploadInit,
                    idleWait: startupPerf.durations.idleWait
                };
                Object.entries(map).forEach(([key, value]) => {
                    const el = document.getElementById(`video-workbench-perf-${key}`);
                    if (el) el.textContent = `${Math.round(value || 0)} ms`;
                });
            }

            async function waitWithTimeout(predicate, timeout = 3000, interval = 250, label = 'wait') {
                const startedAt = performance.now();
                let attempts = 0;
                const safeInterval = Math.min(Math.max(Number(interval) || 250, 50), 500);
                while (performance.now() - startedAt <= timeout) {
                    if (!isRunning && START_LOCK) {
                        console.log(`[TIMER][${label}] interrupted`);
                        return false;
                    }
                    attempts += 1;
                    const passed = await Promise.resolve(predicate());
                    if (passed) {
                        const duration = Math.round(performance.now() - startedAt);
                        console.log(`[${nowTimeLabel()}][TIMER][${label}] ${duration}ms`, { attempts });
                        return true;
                    }
                    await sleep(safeInterval);
                }
                console.log(`[${nowTimeLabel()}][TIMER][${label}] timeout ${timeout}ms`, { attempts });
                return false;
            }

            async function waitUntil(conditionFn, timeout = 600000, interval = 300, label = 'wait_until') {
                const startedAt = Date.now();
                const safeInterval = Math.min(Math.max(Number(interval) || 300, 50), 500);
                while (Date.now() - startedAt <= timeout) {
                    if (!isRunning) {
                        console.log(`[${label}] interrupted`);
                        return false;
                    }
                    const passed = await Promise.resolve(conditionFn());
                    if (passed) {
                        console.log(`[${label}] pass`, {
                            elapsedMs: Date.now() - startedAt
                        });
                        return true;
                    }
                    await sleep(safeInterval);
                }
                console.log(`[${label}] timeout`, {
                    timeout,
                    elapsedMs: Date.now() - startedAt
                });
                return false;
            }

            async function waitForStartDomReady() {
                timerStart('domReady');
                const ready = await waitWithTimeout(() => {
                    return Boolean(
                        document.body &&
                        document.getElementById(ROOT_ID) &&
                        document.getElementById('video-workbench-start') &&
                        document.querySelector('#video-workbench-tab-publish')
                    );
                }, 3000, 250, 'dom_ready');
                timerEnd('domReady', 'domReady');
                timerMark('dom_ready');
                return ready;
            }

            function setPhase(phase) {
                currentPhase = phase;
                console.log('PHASE_TRANSITION', phase);
                return phase;
            }

            function assertPhase(expected) {
                if (currentPhase !== expected) {
                    console.log('PHASE_VIOLATION', { expected, actual: currentPhase });
                    throw new Error('PHASE_VIOLATION');
                }
            }

            function transitionBatchState(nextState, data = {}) {
                const currentIndex = BATCH_STATES.indexOf(batchLifecycle.state);
                const nextIndex = BATCH_STATES.indexOf(nextState);

                if (nextIndex === -1) {
                    throw new Error(`UNKNOWN_BATCH_STATE:${nextState}`);
                }
                if (nextState !== 'INIT' && nextIndex !== currentIndex + 1) {
                    console.log('BATCH_STATE_VIOLATION', {
                        from: batchLifecycle.state,
                        to: nextState,
                        data
                    });
                    throw new Error(`BATCH_STATE_VIOLATION:${batchLifecycle.state}->${nextState}`);
                }
                if (nextState === 'COVER_PROCESSING' && batchLifecycle.state !== 'STATEMENT_DONE') {
                    throw new Error('COVER_REQUIRES_STATEMENT_DONE');
                }
                if (nextState === 'COVER_PROCESSING' && !batchLifecycle.uploadCompleted) {
                    throw new Error('COVER_REQUIRES_UPLOAD_COMPLETED');
                }
                if (nextState === 'PUBLISHING' && !batchLifecycle.coverCompleted) {
                    throw new Error('PUBLISH_REQUIRES_COVER_COMPLETED');
                }
                if (nextState === 'BATCH_DONE' && (!batchExitGuard.upload || !batchExitGuard.cover || !batchExitGuard.publish)) {
                    throw new Error('BATCH_DONE_REQUIRES_EXIT_GUARD');
                }
                if (nextState === 'BATCH_DONE' && (
                    !batchLifecycle.uploadCompleted ||
                    !batchLifecycle.consistencyPassed ||
                    !batchLifecycle.coverCompleted ||
                    !batchLifecycle.publishCompleted
                )) {
                    throw new Error('BATCH_DONE_REQUIRES_CLOSED_LIFECYCLE');
                }

                batchLifecycle.state = nextState;
                console.log('BATCH_STATE', {
                    batchId: batchLifecycle.batchId,
                    state: nextState,
                    ...data
                });
                addLog(`[状态] ${BATCH_STATE_LABELS[nextState] || nextState}`, 'info');
                return nextState;
            }

            function resetBatchLifecycle(batchId, expectedCount = 0) {
                batchLifecycle.batchId = batchId;
                batchLifecycle.state = 'INIT';
                batchLifecycle.uploadCompleted = false;
                batchLifecycle.coverCompleted = false;
                batchLifecycle.consistencyPassed = false;
                batchLifecycle.publishCompleted = false;
                batchLifecycle.coverDoneCount = 0;
                batchLifecycle.publishedCount = 0;
                batchLifecycle.expectedCount = expectedCount;
                batchExitGuard.upload = false;
                batchExitGuard.cover = false;
                batchExitGuard.publish = false;
                publishState.clicked = new Set();
                publishState.successConfirmed = new Set();
                publishState.uiConfirmed = new Set();
                coverState.uiConfirmed = new Set();
                resetVideoBindingState();
            }

            function assertBatchState(expectedState) {
                if (batchLifecycle.state !== expectedState) {
                    console.log('BATCH_STATE_ASSERT_FAILED', {
                        expected: expectedState,
                        actual: batchLifecycle.state,
                        batchId: batchLifecycle.batchId
                    });
                    throw new Error(`BATCH_STATE_ASSERT_FAILED:${expectedState}`);
                }
            }

            function resetVideoBindingState() {
                videoBindingState.title.done = new Set();
                videoBindingState.id.done = new Set();
                videoBindingState.statement.done = new Set();
                videoBindingState.statementClickLock = new Set();
                phaseLock.TITLE_BINDING_DONE = false;
                phaseLock.ID_BINDING_DONE = false;
                phaseLock.STATEMENT_DONE = false;
            }

            function markAllBindingDone(type, count) {
                const target = videoBindingState[type]?.done;
                if (!target) return;
                for (let i = 0; i < count; i++) target.add(i);
            }

            function getMissingIndexes(type, expectedCount) {
                const done = videoBindingState[type]?.done || new Set();
                const missing = [];
                for (let i = 0; i < expectedCount; i++) {
                    if (!done.has(i)) missing.push(i);
                }
                return missing;
            }

            function assertPhaseLock(lockName) {
                if (!phaseLock[lockName]) {
                    console.log('PHASE_LOCK_BLOCKED', lockName);
                    throw new Error(`PHASE_LOCK_BLOCKED:${lockName}`);
                }
            }

            function canPublish() {
                return uploadFinished === true && publishLocked === false;
            }

            function canProceedToPublish() {
                return uploadFinished === true && publishLocked === false;
            }

            function robustClick(el) {
                if (!el) return;
                ['mousedown', 'mouseup', 'click'].forEach((type) => {
                    el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
                });
            }

            function safeClick(el) {
                if (!el) return false;
                el.scrollIntoView?.({ block: 'center', behavior: 'auto' });
                ['pointerdown', 'mousedown', 'mouseup', 'click'].forEach((type) => {
                    el.dispatchEvent(new MouseEvent(type, {
                        bubbles: true,
                        cancelable: true,
                        view: window
                    }));
                });
                if (typeof el.click === 'function') {
                    el.click();
                }
                return true;
            }

            function clickPublishButtonOnce(el) {
                if (!el) return false;
                el.scrollIntoView?.({ block: 'center', behavior: 'auto' });
                robustClick(el);
                return true;
            }

            function getCurrentUrl() {
                return window.location?.href || '';
            }

            async function waitForUrlChanged(label, beforeUrl, timeout = 10000) {
                const startedAt = Date.now();
                while (Date.now() - startedAt < timeout) {
                    const currentUrl = getCurrentUrl();
                    if (currentUrl && currentUrl !== beforeUrl) {
                        addLog(`[导航] ${label} URL 已切换`, 'success');
                        console.log('NAVIGATION_URL_CHANGED', {
                            label,
                            beforeUrl,
                            currentUrl
                        });
                        return true;
                    }
                    await sleep(250);
                }
                addLog(`[导航] ${label} URL 未切换`, 'error');
                console.log('NAVIGATION_URL_NOT_CHANGED', {
                    label,
                    beforeUrl,
                    currentUrl: getCurrentUrl()
                });
                return false;
            }

            async function clickSidebarAndWaitUrl(name, beforeUrl, timeout = 10000) {
                for (let attempt = 1; attempt <= 2; attempt++) {
                    const clicked = await clickSidebar(name);
                    if (!clicked) {
                        await sleep(800);
                        continue;
                    }
                    const changed = await waitForUrlChanged(name, beforeUrl, timeout);
                    if (changed) return true;
                    addLog(`[导航] ${name} 第 ${attempt} 次点击未触发跳转，准备重试`, 'error');
                }
                return false;
            }

            function normalizeExecutionLogMessage(message) {
                if (!message) return '';
                const replacements = [
                    ['uploading accepted', '已接收上传'],
                    ['input-dropzone', '上传区域'],
                    ['input-input', '输入框上传'],
                    ['scanned / debug', '调试扫描'],
                    ['batch completed', '批次完成']
                ];

                return replacements.reduce((text, [source, target]) => (
                    text.replace(new RegExp(source.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), target)
                ), String(message));
            }

            function addLog(msg, type = 'info') {
                const logList = document.getElementById('video-workbench-log-list');
                if (!logList) return;

                const now = new Date();
                const time = `${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}:${now.getSeconds().toString().padStart(2, '0')}`;
                const normalizedMessage = normalizeExecutionLogMessage(msg);
                executionLogs.push(`[${time}]${normalizedMessage}`);

                const item = document.createElement('div');
                item.className = `log-item log-${type}`;
                item.style.cssText = 'word-break:break-all; padding:4px 2px; border-bottom:1px solid #f0f0f0; font-size:10.5px; line-height:1.4;';

                let color = '#333';
                if (type === 'success') color = '#27ae60';
                if (type === 'error') color = '#e74c3c';
                if (type === 'info') color = '#2980b9';

                const timeSpan = document.createElement('span');
                timeSpan.className = 'log-time';
                timeSpan.style.color = '#999';
                timeSpan.style.fontSize = '10px';
                timeSpan.style.marginRight = '5px';
                timeSpan.textContent = `[${time}]`;

                const messageSpan = document.createElement('span');
                messageSpan.style.color = color;
                messageSpan.textContent = normalizedMessage;

                item.appendChild(timeSpan);
                item.appendChild(messageSpan);
                logList.prepend(item);
                logList.scrollTop = 0;
                updateLogStatusCard({ logText: msg });
            }

            function normalizeSummaryFileName(fileLike, index = 0) {
                if (typeof fileLike === 'string') {
                    return fileLike.trim() || `视频 ${index + 1}`;
                }
                const rawName = fileLike?.name ||
                    fileLike?.fileName ||
                    fileLike?.relativePath ||
                    fileLike?.webkitRelativePath ||
                    '';
                const name = String(rawName).split(/[\\/]/).filter(Boolean).pop() || '';
                return name.trim() || `视频 ${index + 1}`;
            }

            function extractVideoFileNameFromCard(item, index = 0) {
                const fileNameText = item?.querySelector?.('[class*="video-list_fileName"] p')?.textContent ||
                    item?.querySelector?.('[class*="video-list_fileName"]')?.textContent ||
                    '';
                const directName = String(fileNameText).replace(/^文件名[:：]\s*/u, '').trim();
                if (directName) return directName;
                const text = getElementText(item);
                const matched = text.match(/文件名[:：]\s*([^\n\r]+)/u);
                return matched?.[1]?.trim() || `视频 ${index + 1}`;
            }

            function createRunSummary(productId, mode) {
                return {
                    productId: String(productId || '').trim(),
                    mode,
                    startedAt: Date.now(),
                    totalBatches: 0,
                    batches: []
                };
            }

            function addRunSummaryBatch(summary, batchInfo = {}) {
                if (!summary) return null;
                const files = Array.isArray(batchInfo.files) ? batchInfo.files : [];
                const batchIndex = Math.max(1, Number(batchInfo.batchIndex) || summary.batches.length + 1);
                const totalBatches = Math.max(batchIndex, Number(batchInfo.totalBatches) || summary.totalBatches || batchIndex);
                const entry = {
                    batchIndex,
                    totalBatches,
                    status: batchInfo.status || 'done',
                    reason: batchInfo.reason || '',
                    count: files.length,
                    files: files.map((file, index) => ({
                        name: normalizeSummaryFileName(file, index),
                        size: Number(file?.size || 0) || 0
                    }))
                };
                const existingIndex = summary.batches.findIndex((batch) => batch.batchIndex === batchIndex);
                if (existingIndex >= 0) {
                    summary.batches[existingIndex] = entry;
                } else {
                    summary.batches.push(entry);
                }
                summary.totalBatches = totalBatches;
                summary.updatedAt = Date.now();
                return entry;
            }

            function getRunSummaryVideoCount(summary) {
                return (summary?.batches || []).reduce((total, batch) => total + (batch.files?.length || batch.count || 0), 0);
            }

            function logRunSummary(summary, accepted, reason) {
                if (!summary) return;
                const modeLabel = summary.mode === 'manual' ? '手动发布' : '批量发布';
                const totalVideos = getRunSummaryVideoCount(summary);
                const statusText = accepted ? '完成' : '未完成';
                const reasonText = !accepted && reason ? `，原因：${reason}` : '';
                addLog(`[总结] 商品 ${summary.productId || '-'} ${modeLabel}${statusText}：${totalVideos} 个视频，${summary.batches.length} 个批次${reasonText}`, accepted ? 'success' : 'error');
                (summary.batches || []).forEach((batch) => {
                    const batchStatus = batch.status === 'done' ? '完成' : `未完成${batch.reason ? `/${batch.reason}` : ''}`;
                    addLog(`[总结] 第 ${batch.batchIndex}/${batch.totalBatches || summary.totalBatches || summary.batches.length} 批：${batch.files?.length || 0} 个，${batchStatus}`, batch.status === 'done' ? 'success' : 'error');
                    (batch.files || []).forEach((file, index) => {
                        const sizeText = file.size ? ` / ${formatBytes(file.size)}` : '';
                        addLog(`[总结]   ${index + 1}. ${file.name}${sizeText}`, 'info');
                    });
                });
            }

            async function copyExecutionLogs() {
                const text = executionLogs.join('\n');
                if (!text) {
                    updateStatus('暂无日志可复制');
                    return;
                }
                try {
                    await navigator.clipboard.writeText(text);
                    updateStatus(`已复制 ${executionLogs.length} 条日志`);
                } catch (error) {
                    const textarea = document.createElement('textarea');
                    textarea.value = text;
                    textarea.style.position = 'fixed';
                    textarea.style.left = '-9999px';
                    document.body.appendChild(textarea);
                    textarea.select();
                    document.execCommand('copy');
                    textarea.remove();
                    updateStatus(`已复制 ${executionLogs.length} 条日志`);
                }
            }

            function clearExecutionLogs() {
                executionLogs.length = 0;
                const logList = document.getElementById('video-workbench-log-list');
                if (logList) logList.innerHTML = '';
                updateStatus('日志已清空');
                updateLogStatusCard({ logText: '日志已清空' });
            }

            moduleApi.appendExecutionLog = function (message, type = 'info') {
                addLog(message, type);
            };

            function updateStatus(msg) {
                const statusEl = document.getElementById('video-workbench-status');
                if (statusEl) statusEl.textContent = msg;
                updateLogStatusCard({ statusText: msg });
            }

            function updateLogStatusCard({ statusText, logText } = {}) {
                const productEl = document.getElementById('video-workbench-log-product');
                const statusCardEl = document.getElementById('video-workbench-log-status');
                const batchEl = document.getElementById('video-workbench-log-batch');
                if (!productEl || !statusCardEl || !batchEl) return;

                const sourceText = String(statusText || logText || '');
                const productMatch = sourceText.match(/商品\s*([A-Za-z0-9_-]+)/) || sourceText.match(/pub-id.*?([A-Za-z0-9_-]+)/);
                if (productMatch?.[1]) {
                    productEl.textContent = productMatch[1];
                } else {
                    const currentProductId = document.getElementById('pub-id')?.value?.trim();
                    if (currentProductId) {
                        productEl.textContent = currentProductId;
                    }
                }

                const batchMatch = sourceText.match(/(\d+\/\d+)/);
                if (batchMatch?.[1]) {
                    batchEl.textContent = batchMatch[1];
                }

                if (statusText) {
                    let nextStatus = '等待';
                    if (/失败|错误|终止/.test(statusText)) nextStatus = '失败';
                    else if (/完成|成功/.test(statusText)) nextStatus = '完成';
                    else if (/开始|执行|处理中|发布|装载|排队/.test(statusText)) nextStatus = '运行中';
                    statusCardEl.textContent = nextStatus;
                }
            }

            function isVideoFileName(fileLike) {
                const name = String(fileLike?.name || '').toLowerCase();
                const type = String(fileLike?.type || '').toLowerCase();
                return type.startsWith('video/') || PRODUCT_VIDEO_EXTENSIONS.some((ext) => name.endsWith(ext));
            }

            function openProductConfigDb() {
                return new Promise((resolve, reject) => {
                    const request = indexedDB.open(PRODUCT_CONFIG_DB_NAME, PRODUCT_CONFIG_DB_VERSION);
                    request.onsuccess = () => resolve(request.result);
                    request.onerror = () => reject(request.error);
                });
            }

            async function loadDirectoryHandleForProduct(productId) {
                if (!productId) return null;
                try {
                    const db = await openProductConfigDb();
                    return await new Promise((resolve, reject) => {
                        const transaction = db.transaction(PRODUCT_HANDLE_STORE, 'readonly');
                        const store = transaction.objectStore(PRODUCT_HANDLE_STORE);
                        const request = store.get(productId);
                        request.onsuccess = () => resolve(request.result?.handle || null);
                        request.onerror = () => reject(request.error);
                    });
                } catch (error) {
                    addLog(`读取目录句柄失败：${error?.message || error}`, 'error');
                    return null;
                }
            }

            async function requestDirectoryPermission(handle) {
                if (!handle?.queryPermission) return false;
                try {
                    const current = await handle.queryPermission({ mode: 'read' });
                    if (current === 'granted') return true;
                    const requested = await handle.requestPermission({ mode: 'read' });
                    return requested === 'granted';
                } catch (error) {
                    addLog(`目录权限申请失败：${error?.message || error}`, 'error');
                    return false;
                }
            }

            async function collectFilesFromDirectoryHandle(handle) {
                const files = [];

                async function walk(dirHandle, prefix = '') {
                    for await (const entry of dirHandle.values()) {
                        const currentPath = prefix ? `${prefix}/${entry.name}` : entry.name;
                        if (entry.kind === 'file') {
                            const file = await entry.getFile();
                            if (!isVideoFileName(file)) continue;
                            Object.defineProperty(file, 'webkitRelativePath', {
                                configurable: true,
                                enumerable: true,
                                value: currentPath
                            });
                            files.push(file);
                            continue;
                        }

                        if (entry.kind === 'directory') {
                            await walk(entry, currentPath);
                        }
                    }
                }

                await walk(handle, '');
                return files;
            }

            function loadProductConfig(productId) {
                try {
                    const raw = JSON.parse(localStorage.getItem(PRODUCT_CONFIG_STORAGE_KEY) || '[]');
                    if (!Array.isArray(raw)) return null;
                    const config = raw.find((item) => String(item?.productId || '').trim() === productId) || null;
                    const batchConfig = window.PddModules?.productConfigManager?.getGlobalBatchConfig?.();
                    return config && batchConfig ? {
                        ...config,
                        maxCount: batchConfig.maxCount,
                        maxSize: batchConfig.maxSize,
                        maxSizeUnit: batchConfig.maxSizeUnit
                    } : config;
                } catch (error) {
                    addLog(`读取商品配置失败：${error?.message || error}`, 'error');
                    return null;
                }
            }

            function getBatchLimitBytes(config) {
                const maxSize = Number(config?.maxSize) || 2048;
                return String(config?.maxSizeUnit || 'MB') === 'GB'
                    ? maxSize * 1024 * 1024 * 1024
                    : maxSize * 1024 * 1024;
            }

            function formatBytes(bytes) {
                const units = ['B', 'KB', 'MB', 'GB'];
                let value = Number(bytes) || 0;
                let unitIndex = 0;
                while (value >= 1024 && unitIndex < units.length - 1) {
                    value /= 1024;
                    unitIndex += 1;
                }
                return `${value.toFixed(unitIndex === 0 ? 0 : 2)} ${units[unitIndex]}`;
            }

            function splitIntoBatches(files, config) {
                const maxCount = Math.max(1, parseInt(config?.maxCount, 10) || 20);
                const maxSizeBytes = getBatchLimitBytes(config);
                addLog(`[批次限制] 数量上限=${maxCount}，大小上限=${formatBytes(maxSizeBytes)}`, 'info');
                console.log('BATCH_SIZE', config?.maxCount);
                const batches = [];
                let currentBatch = [];
                let currentSize = 0;

                for (const file of files) {
                    const shouldFlush = currentBatch.length > 0
                        && (currentBatch.length >= maxCount || currentSize + file.size > maxSizeBytes);

                    if (shouldFlush) {
                        batches.push({
                            files: currentBatch,
                            totalBytes: currentSize
                        });
                        currentBatch = [];
                        currentSize = 0;
                    }

                    currentBatch.push(file);
                    currentSize += file.size;
                }

                if (currentBatch.length > 0) {
                    batches.push({
                        files: currentBatch,
                        totalBytes: currentSize
                    });
                }

                console.log('BATCH_SPLIT_RESULT', {
                    totalFiles: files.length,
                    batchCount: batches.length,
                    batches: batches.map((batch) => batch.files.length)
                });
                addLog(`[批次拆分] 共 ${files.length} 个文件，拆为 ${batches.length} 批：${batches.map((batch) => batch.files.length).join(' / ')}`, 'info');

                return {
                    batches,
                    maxCount,
                    maxSizeBytes
                };
            }

            function getFileStableKey(file) {
                return [
                    file?.name || '',
                    file?.size || 0,
                    file?.lastModified || 0
                ].join('::');
            }

            function filterDuplicateFiles(files, processedKeys = new Set()) {
                const seen = new Set();
                return Array.from(files || []).filter((file) => {
                    const key = getFileStableKey(file);
                    if (processedKeys.has(key) || seen.has(key)) return false;
                    seen.add(key);
                    return true;
                });
            }

            function markFilesProcessed(files) {
                Array.from(files || []).forEach((file) => {
                    batchLifecycle.processedFileKeys.add(getFileStableKey(file));
                });
            }

            function formatMb(bytes) {
                return (Number(bytes || 0) / 1024 / 1024).toFixed(2);
            }

            async function scanFolderFiles(productId, config, options = {}) {
                const force = options.force !== false;
                timerMark('scan_start');
                if (startupPerf.marks.dom_ready) {
                    startupPerf.durations.idleWait = Math.max(0, Math.round(performance.now() - startupPerf.marks.dom_ready));
                    renderStartupPerfPanel();
                }
                timerStart('scan');
                transitionBatchState('SCANNING_FILES', {
                    productId,
                    force
                });
                let resolved = null;
                try {
                    resolved = await window.PddModules?.productConfigManager?.getResolvedVideoFiles?.(productId, {
                        config,
                        forceFreshScan: force,
                        batchId: options.batchId || batchLifecycle.batchId
                    });
                } catch (error) {
                    addLog(`[扫描] 目录读取失败：${error?.message || error}，请重新选择视频文件夹`, 'error');
                    timerEnd('scan', 'scan');
                    timerMark('scan_done');
                    return {
                        files: [],
                        totalBytes: 0,
                        sourceType: 'scan-error',
                        error: error?.message || String(error || '')
                    };
                }
                if (!resolved) {
                    addLog('[SCAN] fresh scan failed: no resolver result', 'error');
                    timerEnd('scan', 'fileScan');
                    timerMark('scan_done');
                    return null;
                }

                const freshFiles = filterDuplicateFiles(resolved.files || [], batchLifecycle.processedFileKeys);
                const freshSize = freshFiles.reduce((sum, file) => sum + Number(file?.size || 0), 0);
                addLog('[SCAN] fresh scan executed', 'info');
                addLog(`[SCAN] fileCount=${freshFiles.length} size=${formatMb(freshSize)}MB`, freshFiles.length ? 'info' : 'error');
                timerEnd('scan', 'fileScan');
                timerMark('scan_done');
                console.log('SCAN_FRESH_RESULT', {
                    batchId: batchLifecycle.batchId,
                    productId,
                    sourceType: resolved.sourceType,
                    fileCount: freshFiles.length,
                    sizeBytes: freshSize,
                    skippedProcessed: Math.max(0, Number(resolved.count || 0) - freshFiles.length)
                });
                return {
                    ...resolved,
                    files: freshFiles,
                    count: freshFiles.length,
                    size: freshSize
                };
            }

            function emitUploadTargetFound(type, elementPath) {
                window.PddModules?.productConfigManager?.emitLog?.({
                    type: 'upload_target_found',
                    message: `命中上传目标：${type}`,
                    data: {
                        type,
                        elementPath
                    },
                    timestamp: Date.now()
                });
            }

            function getElementPath(element) {
                if (!element) return 'unknown';
                const segments = [];
                let current = element;
                let depth = 0;
                while (current && depth < 6) {
                    const tag = (current.tagName || 'node').toLowerCase();
                    const id = current.id ? `#${current.id}` : '';
                    const className = typeof current.className === 'string'
                        ? `.${current.className.trim().split(/\s+/).filter(Boolean).slice(0, 2).join('.')}`
                        : '';
                    segments.unshift(`${tag}${id}${className}`);
                    current = current.parentElement || current.getRootNode?.().host || null;
                    depth++;
                }
                return segments.join(' > ');
            }

            function isVisibleElement(element) {
                if (!element) return false;
                if (element.closest?.(`#${ROOT_ID}`)) return false;
                if (element === document.body || element === document.documentElement) return true;
                if (element.offsetParent !== null) return true;
                const style = window.getComputedStyle?.(element);
                return Boolean(style && style.display !== 'none' && style.visibility !== 'hidden');
            }

            function collectShadowRoots(root, collector = []) {
                if (!root?.querySelectorAll) return collector;
                Array.from(root.querySelectorAll('*')).forEach((el) => {
                    if (el.shadowRoot) {
                        collector.push(el.shadowRoot);
                        collectShadowRoots(el.shadowRoot, collector);
                    }
                });
                return collector;
            }

            function findUploadTargetsInRoot(root, sourceType) {
                if (!root?.querySelectorAll) {
                    return { inputs: [], dropZones: [] };
                }

                const inputs = Array.from(root.querySelectorAll('input[type="file"], input[accept*="video"], input[accept*="mp4"]'))
                    .filter((input) => !input.disabled);

                const dropZones = Array.from(root.querySelectorAll('div, section, label, button')).filter((el) => {
                    if (!isVisibleElement(el)) return false;
                    const text = (el.innerText || el.textContent || '').trim();
                    return text.includes('上传') || text.includes('拖拽') || text.includes('选择文件') || text.includes('视频');
                });

                return {
                    inputs: inputs.map((element) => ({ element, type: sourceType })),
                    dropZones: dropZones.slice(0, 8).map((element) => ({ element, type: sourceType }))
                };
            }

            function findUploadTargets() {
                const targets = {
                    inputs: [],
                    dropZones: []
                };

                const appendTargets = (foundTargets, sourceType) => {
                    foundTargets.inputs.forEach((target) => {
                        targets.inputs.push(target);
                        emitUploadTargetFound(sourceType, getElementPath(target.element));
                    });
                    foundTargets.dropZones.forEach((target) => {
                        targets.dropZones.push(target);
                        emitUploadTargetFound(target.type === sourceType ? `${sourceType}-dropzone` : target.type, getElementPath(target.element));
                    });
                };

                appendTargets(findUploadTargetsInRoot(document, 'input'), 'input');

                collectShadowRoots(document).forEach((shadowRoot) => {
                    appendTargets(findUploadTargetsInRoot(shadowRoot, 'shadow'), 'shadow');
                });

                Array.from(document.querySelectorAll('iframe')).forEach((iframe) => {
                    try {
                        const iframeDoc = iframe.contentDocument || iframe.contentWindow?.document;
                        if (!iframeDoc) return;
                        appendTargets(findUploadTargetsInRoot(iframeDoc, 'iframe'), 'iframe');
                        collectShadowRoots(iframeDoc).forEach((shadowRoot) => {
                            appendTargets(findUploadTargetsInRoot(shadowRoot, 'shadow'), 'shadow');
                        });
                    } catch (error) {
                        // ignore cross-origin iframe access errors
                    }
                });

                return targets;
            }

            async function waitForUploadNode({ timeout = 3000, interval = 200 } = {}) {
                let targets = { inputs: [], dropZones: [] };
                await waitWithTimeout(() => {
                    targets = findUploadTargets();
                    return targets.inputs.length || targets.dropZones.length;
                }, Math.min(timeout, 3000), Math.min(interval, 500), 'upload_zone_ready');
                return targets.inputs.length || targets.dropZones.length ? targets : { inputs: [], dropZones: [] };
            }

            function injectFilesIntoInput(input, files) {
                const dt = new DataTransfer();
                files.forEach((file) => dt.items.add(file));
                input.files = dt.files;
                input.dispatchEvent(new Event('input', { bubbles: true }));
                input.dispatchEvent(new Event('change', { bubbles: true }));
                return input.files?.length || 0;
            }

            function dispatchDropToZone(zone, files) {
                const dt = new DataTransfer();
                files.forEach((file) => dt.items.add(file));
                ['dragenter', 'dragover', 'drop'].forEach((type) => {
                    const event = new DragEvent(type, {
                        bubbles: true,
                        cancelable: true,
                        dataTransfer: dt
                    });
                    Object.defineProperty(event, 'dataTransfer', {
                        configurable: true,
                        enumerable: true,
                        value: dt
                    });
                    zone.dispatchEvent(event);
                });
            }

            function clearPreviousInputState() {
                Array.from(document.querySelectorAll('input[type="file"]'))
                    .filter((input) => !input.closest?.(`#${ROOT_ID}`))
                    .forEach((input) => {
                        try {
                            input.value = '';
                        } catch (error) {
                            // ignore inputs that do not allow direct reset
                        }
                    });
            }

            function emitUploadSuccessCheck(filesCount, domAccepted, targetType) {
                window.PddModules?.productConfigManager?.emitLog?.({
                    type: 'upload_success_check',
                    message: `上传验收：${domAccepted ? '已接受' : '未接受'} / ${targetType}`,
                    data: {
                        filesCount,
                        domAccepted,
                        targetType
                    },
                    timestamp: Date.now()
                });
            }

            async function waitForUploadAcceptance(expectedFilesCount, timeout = 4000, interval = 200) {
                let result = {
                    accepted: false,
                    matchedCount: 0,
                    source: 'timeout'
                };
                await waitWithTimeout(() => {
                    const videoItems = Array.from(document.querySelectorAll('div[class*="video-list_singlePublish"]'));
                    if (videoItems.length >= expectedFilesCount) {
                        result = {
                            accepted: true,
                            matchedCount: videoItems.length,
                            source: 'video-list'
                        };
                        return true;
                    }

                    const visibleFileInputs = Array.from(document.querySelectorAll('input[type="file"]')).filter((input) => {
                        return !input.closest?.(`#${ROOT_ID}`) && Number(input.files?.length || 0) >= expectedFilesCount;
                    });
                    if (visibleFileInputs.length > 0) {
                        result = {
                            accepted: true,
                            matchedCount: visibleFileInputs[0].files.length,
                            source: 'input-files'
                        };
                        return true;
                    }
                    return false;
                }, Math.min(timeout, 3000), Math.min(interval, 500), 'upload_acceptance');
                return result;
            }

            async function confirmUploadSuccess(expectedFilesCount) {
                return waitForUploadAcceptance(expectedFilesCount);
            }

            async function waitForUploadCompletionStable(expectedFilesCount, settleMs = 300) {
                const result = await confirmUploadSuccess(expectedFilesCount);
                if (!result?.accepted) {
                    return result;
                }

                await sleep(settleMs);
                const settled = await confirmUploadSuccess(expectedFilesCount);
                return settled?.accepted ? settled : result;
            }

            function getUploadQueueState() {
                const queue = window.__UPLOAD_QUEUE__;
                return Array.isArray(queue) ? queue.length : Number(queue) || 0;
            }

            function applyBatchLimitStrict(files, config) {
                const maxCount = Math.max(1, parseInt(config?.maxCount, 10) || 1);
                const maxSize = Number.isFinite(Number(config?.maxSizeMB))
                    ? Number(config.maxSizeMB) * 1024 * 1024
                    : getBatchLimitBytes(config);

                console.log('UPLOAD_FILTER_CHECK', {
                    raw: files.length,
                    maxCount,
                    maxSize
                });

                const byCount = files.slice(0, maxCount);
                let total = 0;
                const result = [];

                for (const file of byCount) {
                    if (total + file.size > maxSize) break;
                    result.push(file);
                    total += file.size;
                }

                console.log('UPLOAD_FILTER_RESULT', {
                    before: files.length,
                    after: result.length
                });

                return result;
            }

            function getVisibleVideoItems() {
                return Array.from(document.querySelectorAll(".video-item, .upload-item, div[class*='video-list_singlePublish']"))
                    .filter((el) => el.offsetParent !== null && !el.closest?.(`#${ROOT_ID}`));
            }

            function getVisibleUploadLoadingNodes() {
                return Array.from(document.querySelectorAll(".loading, .progress, .uploading, [class*='loading'], [class*='progress'], [class*='uploading']"))
                    .filter((el) => el.offsetParent !== null && !el.closest?.(`#${ROOT_ID}`));
            }

            function hasUploadProgressBelowComplete() {
                const progressText = getVisibleUploadLoadingNodes()
                    .map((el) => el.innerText || el.textContent || '')
                    .join(' ');
                const matches = Array.from(progressText.matchAll(/(\d{1,3})\s*%/g));
                return matches.some((match) => Number(match[1]) < 100);
            }

            async function waitForUploadComplete(expectedCount, timeout = 30000) {
                let stable = 0;

                return new Promise((resolve) => {
                    const startedAt = Date.now();
                    const check = () => {
                        const items = getVisibleVideoItems();
                        const loading = getVisibleUploadLoadingNodes();
                        const fileInputs = Array.from(document.querySelectorAll("input[type='file']"))
                            .filter((el) => !el.closest?.(`#${ROOT_ID}`));
                        const pendingRequests = getUploadQueueState();
                        const realCount = items.length;
                        const progressComplete = !hasUploadProgressBelowComplete();

                        console.log('UPLOAD_STATE_V2', {
                            realCount,
                            expectedCount,
                            loading: loading.length,
                            queue: pendingRequests,
                            progressComplete
                        });

                        const isStable =
                            realCount === expectedCount &&
                            loading.length === 0 &&
                            pendingRequests === 0 &&
                            fileInputs.length > 0 &&
                            progressComplete;

                        if (isStable) {
                            stable += 1;
                        } else {
                            stable = 0;
                        }

                        if (stable >= 2) {
                            console.log('UPLOAD_TRUE_STABLE_CONFIRMED');
                            uploadFinished = true;
                            publishLocked = false;
                            isBatchUploading = false;
                            console.log('UPLOAD_FINISHED_CONFIRMED');
                            console.log('PUBLISH_UNLOCKED', {
                                uploadFinished,
                                publishLocked
                            });
                            resolve(true);
                            return;
                        }

                        if (Date.now() - startedAt >= timeout) {
                            console.log('UPLOAD_COMPLETED_TIMEOUT', {
                                expectedCount,
                                realCount,
                                loading: loading.length,
                                queue: pendingRequests,
                                progressComplete
                            });
                            isBatchUploading = false;
                            resolve(false);
                            return;
                        }

                        setTimeout(check, 500);
                    };

                    check();
                });
            }

            async function waitForUploadCompletionStableV2(expectedCount) {
                return waitForUploadComplete(expectedCount);
            }

            async function waitUntilUploadCompleted(batchId, expectedCount) {
                assertBatchState('UPLOAD_IN_PROGRESS');
                timerLog('upload_wait_start');
                console.log('WAIT_UPLOAD_COMPLETED_START', {
                    batchId,
                    expectedCount
                });
                if (currentUploadCompletePromise) {
                    const uploadStable = await currentUploadCompletePromise;
                    if (!uploadStable) {
                        timerLog('upload_wait_done');
                        return false;
                    }
                }
                const uiReady = await waitForPageStableAfterUpload(expectedCount, 3000, 250, 300);
                const queueEmpty = getUploadQueueState() === 0;
                const loadingEmpty = getVisibleUploadLoadingNodes().length === 0;
                const countReady = getVisibleVideoItems().length === expectedCount;
                const confirmed = Boolean(uiReady && queueEmpty && loadingEmpty && countReady);
                console.log('UPLOAD_COMPLETED_GUARD', {
                    batchId,
                    confirmed,
                    queueEmpty,
                    loadingEmpty,
                    countReady,
                    titleCount: uiReady?.titleCount,
                    declareCount: uiReady?.declareCount
                });
                if (!confirmed) {
                    addLog('[上传完成] 未确认，已阻断下一阶段', 'error');
                    timerLog('upload_wait_done');
                    return false;
                }
                uploadFinished = true;
                publishLocked = false;
                batchLifecycle.uploadCompleted = true;
                batchExitGuard.upload = true;
                transitionBatchState('UPLOAD_COMPLETED', {
                    batchId,
                    expectedCount
                });
                addLog('[上传完成] 已确认', 'success');
                timerLog('upload_wait_done');
                return true;
            }

            function resetPageStableState() {
                isPageStable = false;
                pageStableTimer = null;
            }

            function collectTitleTargets() {
                const selectors = ['.ace-line', '[contenteditable="true"]', '.public-DraftEditor-content'];
                const found = [];
                const roots = [document, ...collectShadowRoots(document)];
                roots.forEach((root) => {
                    selectors.forEach((selector) => {
                        root.querySelectorAll(selector).forEach((node) => {
                            if (node.id !== 'pub-title' && node.offsetHeight > 0 && !node.closest?.(`#${ROOT_ID}`)) {
                                found.push(node);
                            }
                        });
                    });
                });
                return found.filter((target, index, self) => !self.slice(0, index).some((item) => Math.abs(item.getBoundingClientRect().top - target.getBoundingClientRect().top) < 30));
            }

            function collectDeclarationTargets() {
                const roots = [document, ...collectShadowRoots(document)];
                const rawContainers = roots.flatMap((root) => Array.from(root.querySelectorAll('div'))).filter((el) => {
                    const text = el.innerText || '';
                    return text.includes('内容声明') && el.offsetHeight > 20 && el.offsetHeight < 120 && !el.closest?.(`#${ROOT_ID}`);
                });
                const unique = [];
                rawContainers.forEach((el) => {
                    const rect = el.getBoundingClientRect();
                    if (!unique.some((item) => Math.abs(item.getBoundingClientRect().top - rect.top) < 30)) {
                        unique.push(el);
                    }
                });
                return unique;
            }

            function getPageReadySnapshot(expectedFilesCount) {
                const videoItems = Array.from(document.querySelectorAll('div[class*="video-list_singlePublish"]'))
                    .filter((el) => el.offsetHeight > 0 && !el.closest?.(`#${ROOT_ID}`));
                const titleTargets = collectTitleTargets();
                const declarationTargets = collectDeclarationTargets();
                const needTitle = Boolean(document.getElementById('task-chk-title')?.checked);
                const needDeclare = Boolean(document.getElementById('task-chk-declare')?.checked);
                const renderReady = videoItems.length >= expectedFilesCount;
                const titleReady = !needTitle || titleTargets.length >= expectedFilesCount;
                const declareReady = !needDeclare || declarationTargets.length >= expectedFilesCount;

                return {
                    uploadAccepted: renderReady,
                    renderReady,
                    businessReady: titleReady && declareReady,
                    titleReady,
                    declareReady,
                    videoCount: videoItems.length,
                    titleCount: titleTargets.length,
                    declareCount: declarationTargets.length
                };
            }

            async function waitForPageStableAfterUpload(expectedFilesCount, timeout = 3000, interval = 250, stableWindow = 300) {
                resetPageStableState();
                const startedAt = Date.now();
                let stableSignature = '';
                const safeInterval = Math.min(interval, 500);

                while (Date.now() - startedAt <= timeout) {
                    const snapshot = getPageReadySnapshot(expectedFilesCount);
                    const qualified = snapshot.uploadAccepted && snapshot.renderReady && snapshot.businessReady;
                    const signature = JSON.stringify({
                        videoCount: snapshot.videoCount,
                        titleCount: snapshot.titleCount,
                        declareCount: snapshot.declareCount,
                        titleReady: snapshot.titleReady,
                        declareReady: snapshot.declareReady
                    });

                    if (qualified) {
                        if (stableSignature !== signature || pageStableTimer === null) {
                            stableSignature = signature;
                            pageStableTimer = Date.now();
                            isPageStable = false;
                        } else if (Date.now() - pageStableTimer >= stableWindow) {
                            isPageStable = true;
                            console.log('PAGE_READY_GATE_PASS', {
                                expectedFilesCount,
                                videoCount: snapshot.videoCount,
                                titleCount: snapshot.titleCount,
                                declareCount: snapshot.declareCount
                            });
                            return snapshot;
                        }
                    } else {
                        stableSignature = '';
                        resetPageStableState();
                    }

                    await sleep(safeInterval);
                }

                console.log('PAGE_READY_GATE_TIMEOUT', { expectedFilesCount });
                resetPageStableState();
                return null;
            }

            async function injectVideoFiles(files) {
                if (!files.length) {
                    addLog('上传注入跳过：没有可注入的视频文件', 'error');
                    return false;
                }

                timerStart('uploadInit');
                const uploadTargets = await waitForUploadNode({ timeout: 3000, interval: 200 });
                if (!uploadTargets.inputs.length && !uploadTargets.dropZones.length) {
                    addLog('等待上传节点超时：未命中 input / iframe / shadow / dropzone', 'error');
                    timerEnd('uploadInit', 'uploadInit');
                    return false;
                }
                timerMark('upload_ready');

                for (const target of uploadTargets.inputs) {
                    try {
                        const input = target.element;
                        const injectedCount = injectFilesIntoInput(input, files);
                        if (injectedCount > 0) {
                            addLog(`已优先注入上传控件：${target.type} / input.files=${injectedCount}`, 'info');
                            const result = await waitForUploadAcceptance(files.length);
                            emitUploadSuccessCheck(files.length, result.accepted, `${target.type}-input-fast`);
                            if (result.accepted) {
                                addLog(`上传控件已接受文件：${result.source} / ${result.matchedCount} 个`, 'success');
                                timerEnd('uploadInit', 'uploadInit');
                                return true;
                            }
                        }
                    } catch (error) {
                        addLog(`上传控件优先注入失败：${error?.message || error}`, 'error');
                    }
                }

                for (const target of uploadTargets.dropZones) {
                    try {
                        const zone = target.element;
                        dispatchDropToZone(zone, files);
                        addLog(`已尝试拖拽注入：${target.type} / ${files.length} 个文件`, 'info');
                        const result = await waitForUploadAcceptance(files.length);
                        emitUploadSuccessCheck(files.length, result.accepted, `${target.type}-dropzone`);
                        if (result.accepted) {
                            addLog(`上传区域已接受文件：${result.source} / ${result.matchedCount} 个`, 'success');
                            timerEnd('uploadInit', 'uploadInit');
                            return true;
                        }
                    } catch (error) {
                        addLog(`拖拽注入失败：${error?.message || error}`, 'error');
                    }
                }

                for (const target of uploadTargets.inputs) {
                    try {
                        const input = target.element;
                        const injectedCount = injectFilesIntoInput(input, files);
                        if (injectedCount > 0) {
                            addLog(`已回退注入上传控件：${target.type} / input.files=${injectedCount}`, 'info');
                            const result = await waitForUploadAcceptance(files.length);
                            emitUploadSuccessCheck(files.length, result.accepted, `${target.type}-input`);
                            if (result.accepted) {
                                addLog(`上传控件已接受文件：${result.source} / ${result.matchedCount} 个`, 'success');
                                timerEnd('uploadInit', 'uploadInit');
                                return true;
                            }
                        }
                    } catch (error) {
                        addLog(`上传控件注入失败：${error?.message || error}`, 'error');
                    }
                }

                addLog('未找到可用的上传控件或拖拽区域', 'error');
                emitUploadSuccessCheck(files.length, false, 'none');
                timerEnd('uploadInit', 'uploadInit');
                return false;
            }

            async function resetUploadInput() {
                const input = document.querySelector("input[type='file']");
                if (input) {
                    try {
                        input.value = '';
                    } catch (error) {
                        console.log('UPLOAD_INPUT_RESET_ERROR', error?.message || error);
                    }
                    input.dispatchEvent(new Event('change', { bubbles: true }));
                }
            }

            async function uploadSingleBatch(batchFiles) {
                setPhase('UPLOAD_PHASE');
                assertBatchState('BATCH_SPLIT');
                transitionBatchState('UPLOAD_IN_PROGRESS', {
                    batchId: batchLifecycle.batchId,
                    count: batchFiles.length
                });
                uploadFinished = false;
                publishLocked = true;
                currentUploadCompletePromise = null;
                currentBatchExpectedCount = batchFiles.length;
                isBatchUploading = true;
                resetPageStableState();
                clearPreviousInputState();
                await resetUploadInput();
                try {
                    const accepted = await injectVideoFiles(batchFiles);
                    if (!accepted) {
                        isBatchUploading = false;
                        return false;
                    }

                    currentUploadCompletePromise = waitForUploadComplete(batchFiles.length);
                    const uploadStable = await waitUntilUploadCompleted(batchLifecycle.batchId, batchFiles.length);
                    if (!uploadStable) {
                        return false;
                    }
                    if (currentPhase === 'UPLOAD_PHASE') {
                        setPhase('FILL_PHASE');
                    }
                    return true;
                } finally {
                    if (!currentUploadCompletePromise && publishLocked) {
                        isBatchUploading = false;
                    }
                }
            }

            function triggerKey(key) {
                ['keydown', 'keyup'].forEach((eventName) => {
                    document.dispatchEvent(new KeyboardEvent(eventName, {
                        key,
                        bubbles: true,
                        cancelable: true
                    }));
                });
            }

            async function waitForBatchUnlock(timeout = 15000, interval = 200) {
                const startedAt = Date.now();
                while (isBatchUploading && Date.now() - startedAt < timeout) {
                    await sleep(interval);
                }
                return !isBatchUploading;
            }

            function findSidebarItemByText(name) {
                const matches = getUniqueElements(name);
                return matches.find((el) => el.closest('aside, nav, [role="menu"], [class*="menu"], [class*="nav"], [class*="sidebar"]'))
                    || matches[0]
                    || null;
            }

            async function clickSidebar(name) {
                if (isBatchUploading) {
                    console.log('SIDEBAR_BLOCKED_DURING_UPLOAD', name);
                    return false;
                }
                if (currentPhase !== 'NAVIGATION_PHASE') {
                    console.log('PHASE_BLOCKED_NAVIGATION', currentPhase);
                    return false;
                }
                console.log('SIDEBAR_CLICK_ATTEMPT', name);
                const items = Array.from(document.querySelectorAll("li[data-testid='beast-core-menu-menuItem-li'], li"));
                const target = items.find((el) => {
                    const title = el.querySelector?.('[class*="menuItemTitle"]')?.innerText?.trim() || el.innerText?.trim() || '';
                    return title.includes(name) && el.offsetParent !== null;
                });
                if (!target) {
                    console.log('SIDEBAR_NOT_FOUND', name);
                    return false;
                }

                target.scrollIntoView({ block: 'center', behavior: 'auto' });
                safeClick(target);
                console.log('SIDEBAR_CLICKED', name);
                await sleep(1200);
                return true;
            }

            async function clickPublishVideo() {
                if (isBatchUploading) {
                    console.log('PUBLISH_CLICK_STATUS', 'blocked-during-upload');
                    return false;
                }
                if (currentPhase !== 'NAVIGATION_PHASE') {
                    console.log('PHASE_BLOCKED_PUBLISH_VIDEO', currentPhase);
                    return false;
                }
                const clicked = await clickSidebar('发布视频');
                console.log('PUBLISH_CLICK_STATUS', clicked ? 'sidebar' : 'failed');
                return clicked;
            }

            function hasUploadAreaReady() {
                const uploadTexts = Array.from(document.querySelectorAll('body *'))
                    .filter((el) => el.offsetParent !== null && !el.closest?.(`#${ROOT_ID}`))
                    .some((el) => /上传视频|添加视频|点击上传|拖拽至此区域/.test(el.innerText || el.textContent || ''));
                const uploadButton = Array.from(document.querySelectorAll("button[data-testid='beast-core-button'], button"))
                    .filter((btn) => btn.offsetParent !== null && !btn.closest?.(`#${ROOT_ID}`))
                    .some((btn) => /添加视频|上传视频/.test(btn.innerText || btn.textContent || ''));
                const uploadInput = Array.from(document.querySelectorAll('input[type="file"]'))
                    .some((input) => !input.closest?.(`#${ROOT_ID}`));
                const uploadDropzone = Boolean(document.querySelector('.no-video_noVideoWrap__opXQS, [class*="noVideoWrap"], [class*="upload"]'));
                return uploadTexts || uploadButton || uploadInput || uploadDropzone;
            }

            async function waitForUploadAreaReady(timeout = 15000) {
                const startedAt = Date.now();
                while (Date.now() - startedAt < timeout) {
                    if (hasUploadAreaReady()) {
                        addLog('[导航] 发布视频页上传区域已就绪', 'success');
                        return true;
                    }
                    await sleep(300);
                }
                addLog('[导航] 发布视频页上传区域未就绪，禁止进入下一批上传', 'error');
                return false;
            }

            async function closeAllPopups() {
                console.log('POPUP_CLOSE_START');
                const popupSelectors = [
                    '.modal-close',
                    '.close-btn',
                    '.el-dialog__close',
                    "[aria-label='close']",
                    '.popup-close',
                    '.ant-modal-close',
                    '.el-dialog__headerbtn',
                    "[aria-label='Close']"
                ];

                for (const selector of popupSelectors) {
                    try {
                        const nodes = Array.from(document.querySelectorAll(selector))
                            .filter((node) => node.offsetParent !== null);
                        nodes.forEach((node) => robustClick(node));
                    } catch (error) {
                        console.log('POPUP_CLOSE_SELECTOR_ERROR', selector, error?.message || error);
                    }
                }

                triggerKey('Escape');
                await sleep(300);
                console.log('POPUP_CLOSE_DONE');
            }

            async function waitForPageReady(timeout = 12000) {
                const startedAt = Date.now();
                while (Date.now() - startedAt < timeout) {
                    const hasAddProduct = getUniqueElements('添加商品').length > 0;
                    const hasPublishVideo = getUniqueElements('发布视频').length > 0;
                    const hasVisibleFileInput = Array.from(document.querySelectorAll('input[type="file"]'))
                        .some((input) => input.offsetParent !== null && !input.closest?.(`#${ROOT_ID}`));

                    if (hasAddProduct || hasPublishVideo || hasVisibleFileInput || hasUploadAreaReady()) {
                        return true;
                    }

                    await sleep(400);
                }

                console.log('PAGE_READY_TIMEOUT');
                return false;
            }

            function getBatchNavigationConfig() {
                const config = window.PddModules?.productConfigManager?.getGlobalBatchConfig?.() || {};
                const numberOr = (value, fallback) => {
                    const parsed = Number(value);
                    return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
                };
                return {
                    preUploadNavigation: config.preUploadNavigation !== false,
                    beforeHomeClickWait: numberOr(config.beforeHomeClickWait, 3000),
                    homeClickWait: numberOr(config.homeClickWait, 3000),
                    publishClickWait: numberOr(config.publishClickWait, 3000),
                    uploadReadyWait: numberOr(config.uploadReadyWait, 1500),
                    batchTransitionWait: numberOr(config.batchTransitionWait, 3000)
                };
            }

            async function waitAfterUploadAreaReady(config) {
                if (!config.uploadReadyWait) return;
                addLog(`[导航] 上传区就绪后等待 ${config.uploadReadyWait}ms`, 'info');
                await sleep(config.uploadReadyWait);
            }

            async function preparePublishPageBeforeUpload(reason = 'batch') {
                const navConfig = getBatchNavigationConfig();
                if (!navConfig.preUploadNavigation) return true;
                setPhase('NAVIGATION_PHASE');
                addLog(`[导航] 上传前准备发布页：${reason}`, 'info');
                await closeAllPopups();
                if (navConfig.beforeHomeClickWait) {
                    addLog(`[导航] 点击商家首页前等待 ${navConfig.beforeHomeClickWait}ms`, 'info');
                    await sleep(navConfig.beforeHomeClickWait);
                }
                const publishUrlBeforeHome = getCurrentUrl();
                addLog('[导航] 点击左侧商家首页', 'info');
                const sidebarHome = await clickSidebarAndWaitUrl('商家首页', publishUrlBeforeHome);
                if (navConfig.homeClickWait) {
                    addLog(`[导航] 商家首页后等待 ${navConfig.homeClickWait}ms`, 'info');
                    await sleep(navConfig.homeClickWait);
                }
                const homeUrlBeforePublish = getCurrentUrl();
                addLog('[导航] 点击左侧发布视频', 'info');
                const sidebarPublish = await clickSidebarAndWaitUrl('发布视频', homeUrlBeforePublish);
                if (navConfig.publishClickWait) {
                    addLog(`[导航] 发布视频后等待 ${navConfig.publishClickWait}ms`, 'info');
                    await sleep(navConfig.publishClickWait);
                }
                const pageReady = await waitForPageReady();
                const uploadAreaReady = await waitForUploadAreaReady();
                if (uploadAreaReady) {
                    await waitAfterUploadAreaReady(navConfig);
                }
                setPhase('UPLOAD_PHASE');
                return Boolean(sidebarHome && sidebarPublish && pageReady && uploadAreaReady);
            }

            async function afterBatchComplete() {
                if (currentPhase !== 'NAVIGATION_PHASE') {
                    console.log('PHASE_BLOCKED_NAVIGATION', currentPhase);
                    return {
                        sidebar_home: false,
                        sidebar_publish: false
                    };
                }
                if (isNavigationLocked) {
                    console.log('BATCH_NAVIGATION_SKIPPED', 'navigation-locked');
                    return {
                        sidebar_home: false,
                        sidebar_publish: false
                    };
                }

                console.log('BATCH_NAVIGATION_START');
                if (currentUploadCompletePromise) {
                    await currentUploadCompletePromise;
                }
                const uploadUnlocked = await waitForBatchUnlock();
                if (!uploadUnlocked || !canProceedToPublish()) {
                    console.log('NAVIGATION_BLOCKED_UPLOAD_NOT_READY');
                    console.log('BATCH_NAVIGATION_ABORT', {
                        uploadUnlocked,
                        uploadFinished,
                        publishLocked
                    });
                    return {
                        sidebar_home: false,
                        sidebar_publish: false
                    };
                }

                isNavigationLocked = true;
                try {
                    const navConfig = getBatchNavigationConfig();
                    await closeAllPopups();
                    if (navConfig.beforeHomeClickWait) {
                        addLog(`[导航] 点击商家首页前等待 ${navConfig.beforeHomeClickWait}ms`, 'info');
                        await sleep(navConfig.beforeHomeClickWait);
                    }
                    const publishUrlBeforeHome = getCurrentUrl();
                    addLog('[导航] 点击左侧商家首页', 'info');
                    const sidebarHome = await clickSidebarAndWaitUrl('商家首页', publishUrlBeforeHome);
                    await sleep(navConfig.homeClickWait);
                    const homeUrlBeforePublish = getCurrentUrl();
                    addLog('[导航] 点击左侧发布视频', 'info');
                    const sidebarPublish = await clickSidebarAndWaitUrl('发布视频', homeUrlBeforePublish);
                    await sleep(navConfig.publishClickWait);
                    const pageReady = await waitForPageReady();
                    const uploadAreaReady = await waitForUploadAreaReady();
                    if (uploadAreaReady) {
                        await waitAfterUploadAreaReady(navConfig);
                    }
                    console.log('CLICK_VERIFY', {
                        sidebar_home: sidebarHome,
                        sidebar_publish: sidebarPublish,
                        pageReady,
                        uploadAreaReady,
                        publishUrlBeforeHome,
                        homeUrlBeforePublish,
                        currentUrl: getCurrentUrl()
                    });
                    if (!sidebarHome || !sidebarPublish || !uploadAreaReady) {
                        addLog('[导航] 批次间页面切换未完成，禁止进入下一批上传', 'error');
                        return {
                            sidebar_home: sidebarHome,
                            sidebar_publish: sidebarPublish,
                            page_ready: pageReady,
                            upload_area_ready: uploadAreaReady
                        };
                    }
                    console.log('BATCH_NAVIGATION_DONE');
                    return {
                        sidebar_home: sidebarHome,
                        sidebar_publish: sidebarPublish,
                        page_ready: pageReady,
                        upload_area_ready: uploadAreaReady
                    };
                } finally {
                    resetPageStableState();
                    currentUploadCompletePromise = null;
                    isNavigationLocked = false;
                }
            }

            async function runFillPhase() {
                if (!uploadFinished) {
                    console.log('FILL_BLOCKED_UPLOAD_NOT_STABLE');
                    return false;
                }
                assertBatchState('UPLOAD_COMPLETED');
                assertPhase('FILL_PHASE');
                if (document.getElementById('task-chk-title').checked) {
                    await taskPubFillTitle({ missingIndexes: buildBindingDiff(currentBatchExpectedCount).missingTitle });
                } else {
                    markAllBindingDone('title', currentBatchExpectedCount);
                }
                syncBindingStateFromDom(currentBatchExpectedCount);
                phaseLock.TITLE_BINDING_DONE = videoBindingState.title.done.size === currentBatchExpectedCount;
                if (!phaseLock.TITLE_BINDING_DONE) {
                    addLog(`[标题] 未完成 ${videoBindingState.title.done.size}/${currentBatchExpectedCount}`, 'error');
                    logLifecycleChecks(currentBatchExpectedCount, { nextBatchBlocked: true });
                    const recovered = await verifyFillIntegrity(currentBatchExpectedCount);
                    if (!recovered) return false;
                    syncBindingStateFromDom(currentBatchExpectedCount);
                    phaseLock.TITLE_BINDING_DONE = videoBindingState.title.done.size === currentBatchExpectedCount;
                    if (!phaseLock.TITLE_BINDING_DONE) return false;
                }
                transitionBatchState('TITLE_BINDING_DONE', {
                    count: videoBindingState.title.done.size
                });
                assertPhaseLock('TITLE_BINDING_DONE');
                if (document.getElementById('task-chk-id').checked) {
                    await taskPubFillID({ missingIndexes: buildBindingDiff(currentBatchExpectedCount).missingID });
                } else {
                    markAllBindingDone('id', currentBatchExpectedCount);
                }
                syncBindingStateFromDom(currentBatchExpectedCount);
                phaseLock.ID_BINDING_DONE = videoBindingState.id.done.size === currentBatchExpectedCount;
                if (!phaseLock.ID_BINDING_DONE) {
                    addLog(`[商品ID] 未完成 ${videoBindingState.id.done.size}/${currentBatchExpectedCount}`, 'error');
                    logLifecycleChecks(currentBatchExpectedCount, { nextBatchBlocked: true });
                    const recovered = await verifyFillIntegrity(currentBatchExpectedCount);
                    if (!recovered) return false;
                    syncBindingStateFromDom(currentBatchExpectedCount);
                    phaseLock.ID_BINDING_DONE = videoBindingState.id.done.size === currentBatchExpectedCount;
                    if (!phaseLock.ID_BINDING_DONE) return false;
                }
                transitionBatchState('ID_BINDING_DONE', {
                    count: videoBindingState.id.done.size
                });
                assertPhaseLock('ID_BINDING_DONE');
                if (document.getElementById('task-chk-declare').checked) {
                    await taskPubDeclare({ missingIndexes: buildBindingDiff(currentBatchExpectedCount).missingStatement });
                } else {
                    markAllBindingDone('statement', currentBatchExpectedCount);
                }
                syncBindingStateFromDom(currentBatchExpectedCount);
                phaseLock.STATEMENT_DONE = videoBindingState.statement.done.size === currentBatchExpectedCount;
                if (!phaseLock.STATEMENT_DONE) {
                    addLog(`[声明] 未完成 ${videoBindingState.statement.done.size}/${currentBatchExpectedCount}`, 'error');
                    logLifecycleChecks(currentBatchExpectedCount, { nextBatchBlocked: true });
                    const recovered = await verifyFillIntegrity(currentBatchExpectedCount);
                    if (!recovered) return false;
                    syncBindingStateFromDom(currentBatchExpectedCount);
                    phaseLock.STATEMENT_DONE = videoBindingState.statement.done.size === currentBatchExpectedCount;
                    if (!phaseLock.STATEMENT_DONE) return false;
                }
                transitionBatchState('STATEMENT_DONE', {
                    count: videoBindingState.statement.done.size
                });
                const fillVerified = await verifyFillIntegrity(currentBatchExpectedCount);
                if (!fillVerified) {
                    return false;
                }
                console.log('PHASE_FILL_DONE');
                return true;
            }

            async function runPublishPhase() {
                assertPhase('FILL_PHASE');
                assertBatchState('STATEMENT_DONE');
                if (currentUploadCompletePromise) {
                    await currentUploadCompletePromise;
                }
                if (!canProceedToPublish()) {
                    console.log('PUBLISH_BLOCKED_UPLOAD_IN_PROGRESS');
                    return false;
                }
                if (!batchLifecycle.uploadCompleted || !batchLifecycle.consistencyPassed) {
                    console.log('POST_BLOCKED_UPLOAD_OR_CONSISTENCY', {
                        uploadCompleted: batchLifecycle.uploadCompleted,
                        consistencyPassed: batchLifecycle.consistencyPassed
                    });
                    return false;
                }
                if (!phaseLock.TITLE_BINDING_DONE || !phaseLock.ID_BINDING_DONE || !phaseLock.STATEMENT_DONE) {
                    console.log('POST_BLOCKED_PHASE_LOCK', { ...phaseLock });
                    return false;
                }
                await waitForPageStableAfterUpload(currentBatchExpectedCount, 3000, 250, 300);
                setPhase('PUBLISH_PHASE');
                transitionBatchState('COVER_PROCESSING', {
                    expectedCount: currentBatchExpectedCount
                });
                const pipelineReady = await taskCoverAndPublishReadyVideos();
                if (!pipelineReady) return false;
                transitionBatchState('COVER_WAITING', {
                    expectedCount: currentBatchExpectedCount,
                    coverDoneCount: batchLifecycle.coverDoneCount
                });
                const coverCompleted = await waitUntilCoverCompleted(batchLifecycle.batchId, currentBatchExpectedCount);
                if (!coverCompleted) return false;
                transitionBatchState('PUBLISHING', {
                    expectedCount: currentBatchExpectedCount
                });
                transitionBatchState('PUBLISH_WAITING', {
                    publishedCount: batchLifecycle.publishedCount,
                    expectedCount: currentBatchExpectedCount
                });
                const publishCompleted = await waitUntilPublishCompleted(batchLifecycle.batchId, currentBatchExpectedCount);
                if (!publishCompleted) return false;
                console.log('PHASE_PUBLISH_DONE');
                return true;
            }

            async function runNavigationPhase() {
                assertPhase('PUBLISH_PHASE');
                setPhase('NAVIGATION_PHASE');
                const navigationResult = await afterBatchComplete();
                console.log('PHASE_NAVIGATION_DONE', navigationResult);
                return navigationResult;
            }

            async function uploadFilesBatch(files, config) {
                const productId = config?.productId || document.getElementById('pub-id')?.value.trim();
                const maxCount = Math.max(1, parseInt(config?.maxCount, 10) || 20);
                const runSummary = createRunSummary(productId, 'batch');
                activeRunSummary = runSummary;
                batchLifecycle.processedFileKeys = new Set();
                let totalBatches = 0;
                let uploadedBatches = 0;
                const navigateBeforeFirstBatch = Boolean(moduleApi.preUploadNavigationRequired);
                moduleApi.preUploadNavigationRequired = false;

                for (let i = 0; ; i++) {
                    const batchId = `${productId || 'batch'}-${Date.now()}-${i + 1}`;
                    resetBatchLifecycle(batchId);
                    console.log('BATCH_START', i);
                    if (i === 0 && navigateBeforeFirstBatch) {
                        const prepared = await preparePublishPageBeforeUpload('queue-product');
                        if (!prepared) {
                            return {
                                accepted: false,
                                reason: 'navigation-failed',
                                failedBatchIndex: i,
                                totalBatches,
                                uploadedBatches,
                                maxCount,
                                handledWorkflow: true,
                                summary: runSummary
                            };
                        }
                    }
                    const scanned = await scanFolderFiles(productId, config, {
                        force: false,
                        batchId
                    });
                    if (!scanned?.files?.length) {
                        if (i === 0) {
                            return {
                                accepted: false,
                                reason: 'no-files',
                                totalBatches: 0,
                                uploadedBatches: 0,
                                maxCount,
                                handledWorkflow: true,
                                summary: runSummary
                            };
                        }
                        break;
                    }

                    timerStart('batchBuild');
                    const splitResult = splitIntoBatches(scanned.files, config);
                    timerEnd('batchBuild', 'batchBuild');
                    transitionBatchState('BATCH_SPLIT', {
                        fileCount: scanned.files.length,
                        batchCount: splitResult.batches.length
                    });
                    if (i === 0) {
                        totalBatches = splitResult.batches.length;
                        runSummary.totalBatches = totalBatches;
                    }

                    const batch = splitResult.batches[0];
                    if (!batch?.files?.length) break;
                    batchLifecycle.expectedCount = batch.files.length;

                    console.log('UPLOAD_BATCH_START', {
                        index: i,
                        batchSize: batch.files.length,
                        totalBatches
                    });
                    console.log('UPLOAD_BATCH_PROGRESS', {
                        currentBatch: i + 1,
                        total: totalBatches
                    });
                    console.log('UPLOAD_FINAL_CHECK', {
                        totalFiles: scanned.files.length,
                        batchCount: totalBatches,
                        actualUploadedPerBatch: batch.files.length
                    });

                    addLog(`上传批次 ${i + 1}/${totalBatches}：${batch.files.length} 个文件 / ${batch.totalBytes} B`, 'info');

                    const accepted = await uploadSingleBatch(batch.files);
                    if (!accepted) {
                        addRunSummaryBatch(runSummary, {
                            batchIndex: i + 1,
                            totalBatches,
                            files: batch.files,
                            status: 'fail',
                            reason: 'upload-not-accepted'
                        });
                        return {
                            accepted: false,
                            reason: 'upload-not-accepted',
                            failedBatchIndex: i,
                            totalBatches,
                            uploadedBatches: i,
                            maxCount,
                            handledWorkflow: true,
                            summary: runSummary
                        };
                    }

                    assertPhase('FILL_PHASE');
                    const fillReady = await runFillPhase();
                    if (!fillReady) {
                        addRunSummaryBatch(runSummary, {
                            batchIndex: i + 1,
                            totalBatches,
                            files: batch.files,
                            status: 'fail',
                            reason: 'fill-incomplete'
                        });
                        return {
                            accepted: false,
                            reason: 'fill-incomplete',
                            failedBatchIndex: i,
                            totalBatches,
                            uploadedBatches: i,
                            maxCount,
                            handledWorkflow: true,
                            summary: runSummary
                        };
                    }
                    const publishReady = await runPublishPhase();
                    if (!publishReady) {
                        addRunSummaryBatch(runSummary, {
                            batchIndex: i + 1,
                            totalBatches,
                            files: batch.files,
                            status: 'fail',
                            reason: 'publish-incomplete'
                        });
                        return {
                            accepted: false,
                            reason: 'publish-incomplete',
                            failedBatchIndex: i,
                            totalBatches,
                            uploadedBatches: i,
                            maxCount,
                            handledWorkflow: true,
                            summary: runSummary
                        };
                    }
                    const batchDone = await completeBatchIfReady();
                    if (!batchDone) {
                        addRunSummaryBatch(runSummary, {
                            batchIndex: i + 1,
                            totalBatches,
                            files: batch.files,
                            status: 'fail',
                            reason: 'batch-not-done'
                        });
                        return {
                            accepted: false,
                            reason: 'batch-not-done',
                            failedBatchIndex: i,
                            totalBatches,
                            uploadedBatches: i,
                            maxCount,
                            handledWorkflow: true,
                            summary: runSummary
                        };
                    }
                    addRunSummaryBatch(runSummary, {
                        batchIndex: i + 1,
                        totalBatches,
                        files: batch.files,
                        status: 'done'
                    });
                    markFilesProcessed(batch.files);
                    uploadedBatches = i + 1;
                    const navigationResult = await runNavigationPhase();
                    if (!navigationResult?.sidebar_home || !navigationResult?.sidebar_publish || !navigationResult?.upload_area_ready) {
                        return {
                            accepted: false,
                            reason: 'navigation-failed',
                            failedBatchIndex: i,
                            totalBatches,
                            uploadedBatches: i + 1,
                            maxCount,
                            handledWorkflow: true,
                            summary: runSummary
                        };
                    }
                    console.log('BATCH_END', i);
                    if (uploadedBatches >= totalBatches) {
                        break;
                    }
                    addLog(`[下一批] 已回到发布视频页，准备扫描并上传 ${uploadedBatches + 1}/${totalBatches}`, 'info');
                    await sleep(getBatchNavigationConfig().batchTransitionWait);
                }

                return {
                    accepted: true,
                    totalBatches,
                    uploadedBatches,
                    maxCount,
                    handledWorkflow: true,
                    summary: runSummary
                };
            }

            async function triggerManualRebind(productId, reason) {
                addLog('上传被平台拒收，触发二次选择目录', 'error');
                return Boolean(await window.PddModules?.productConfigManager?.rebindProductDirectory?.(productId, reason));
            }

            async function uploadInjectionStep(options = {}) {
                const productId = document.getElementById('pub-id')?.value.trim();
                if (!productId) {
                    addLog('上传注入跳过：当前未填写商品 ID', 'error');
                    return {
                        accepted: false,
                        reason: 'missing-product-id',
                        handledWorkflow: true
                    };
                }

                const allowRebindRetry = options.allowRebindRetry !== false;
                const lockKey = productId;
                if (uploadAttemptState.has(lockKey) && !options.force) {
                    addLog(`上传注入已锁定：商品 ${productId} 本轮只执行一次`, 'info');
                    return false;
                }
                uploadAttemptState.set(lockKey, true);

                const config = loadProductConfig(productId);
                if (!config) {
                    addLog(`上传注入失败：未找到商品 ${productId} 的配置`, 'error');
                    return {
                        accepted: false,
                        reason: 'missing-product-config',
                        handledWorkflow: true
                    };
                }

                addLog(`上传注入启动：商品 ${productId}，即将立即扫描目录`, 'info');
                const uploadResult = await uploadFilesBatch([], {
                    ...config,
                    productId,
                    maxCount: config?.maxCount,
                    maxSize: config?.maxSize
                });
                const canRebind = uploadResult?.reason === 'upload-not-accepted' || uploadResult?.reason === 'no-files';
                if (!uploadResult.accepted && allowRebindRetry && canRebind) {
                    const rebound = await triggerManualRebind(productId, 'upload-rejected');
                    if (rebound) {
                        uploadAttemptState.delete(lockKey);
                        return uploadInjectionStep({ allowRebindRetry: false, force: true });
                    }
                } else if (!uploadResult.accepted) {
                    addLog(`[流程] ${uploadResult?.reason || 'unknown'}，禁止触发二次选择目录`, 'error');
                }

                return uploadResult;
            }

            moduleApi.injectVideoFiles = injectVideoFiles;

            function getUniqueElements(text) {
                const raw = Array.from(document.querySelectorAll('*')).filter((el) =>
                    el.innerText &&
                    el.innerText.trim() === text &&
                    el.offsetHeight > 0 &&
                    el.offsetParent !== null &&
                    Array.from(el.children).every((child) => !child.innerText || child.innerText.trim() !== text)
                );

                const unique = [];
                raw.forEach((el) => {
                    const rect = el.getBoundingClientRect();
                    if (!unique.some((item) => Math.abs(item.getBoundingClientRect().top - rect.top) < 100)) {
                        unique.push(el);
                    }
                });
                return unique;
            }

            async function checkPause() {
                if (!isRunning) return;
                while (isPaused && isRunning) {
                    updateStatus('流程已暂停，等待恢复...');
                    await sleep(500);
                }
            }

            function setControlsVisible(visible) {
                const controlBar = document.getElementById('video-workbench-controls');
                if (controlBar) {
                    controlBar.style.display = visible ? 'flex' : 'flex';
                }
            }

            function resetPauseButton() {
                const pauseButton = document.getElementById('video-workbench-pause');
                if (!pauseButton) return;
                pauseButton.textContent = '暂停';
                pauseButton.style.background = '#f1c40f';
            }

            const cssText = `
                #${ROOT_ID} {
                    position: fixed;
                    top: 80px;
                    right: 20px;
                    z-index: 2147483645;
                    width: 420px;
                    background: #fff;
                    border-radius: 12px;
                    box-shadow: 0 10px 30px rgba(0,0,0,0.4);
                    font-family: sans-serif;
                    border: 2px solid #333;
                    overflow: hidden;
                    display: none;
                    flex-direction: column;
                }
                #${ROOT_ID}[style*="display: flex"],
                #${ROOT_ID}[style*="display:flex"] {
                    display: flex !important;
                }
                #${ROOT_ID} .ws-header {
                    background: #333;
                    color: #fff;
                    padding: 10px 12px;
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                    cursor: move;
                    font-weight: bold;
                    font-size: 14px;
                    user-select: none;
                }
                #${ROOT_ID} .ws-header-actions {
                    display: flex;
                    align-items: center;
                    gap: 8px;
                }
                #${ROOT_ID} .panel-close,
                #${ROOT_ID} #video-workbench-close {
                    position: relative;
                    z-index: 2147483647;
                    display: inline-flex;
                    align-items: center;
                    justify-content: center;
                    width: 24px;
                    height: 24px;
                    padding: 0;
                    border: 0;
                    background: transparent;
                    color: #fff;
                    cursor: pointer;
                    font-size: 18px;
                    line-height: 1;
                }
                #${ROOT_ID} .panel-close:hover,
                #${ROOT_ID} #video-workbench-close:hover {
                    opacity: 0.85;
                }
                #${ROOT_ID} .ws-body {
                    padding: 12px;
                    overflow-y: auto;
                    max-height: 70vh;
                }
                #${ROOT_ID} .ws-tabs {
                    display: flex;
                    padding: 8px 12px 0 12px;
                    background: #fff;
                    border-bottom: 1px solid #e5e7eb;
                }
                #${ROOT_ID} .ws-tab {
                    flex: 1;
                    padding: 8px 10px;
                    border: 1px solid #d1d5db;
                    border-bottom: none;
                    border-radius: 8px 8px 0 0;
                    background: #f3f4f6;
                    color: #4b5563;
                    font-size: 12px;
                    font-weight: bold;
                    cursor: pointer;
                }
                #${ROOT_ID} .ws-tab + .ws-tab {
                    margin-left: 6px;
                }
                #${ROOT_ID} .ws-tab.active {
                    background: #fff;
                    color: #111827;
                }
                #${ROOT_ID} .ws-tab-panel {
                    display: none;
                }
                #${ROOT_ID} .ws-tab-panel.active {
                    display: block;
                }
                #${ROOT_ID} .ws-legacy-publish-tab,
                #${ROOT_ID} .ws-legacy-publish-panel {
                    position: absolute !important;
                    width: 1px !important;
                    height: 1px !important;
                    min-width: 0 !important;
                    min-height: 0 !important;
                    padding: 0 !important;
                    margin: 0 !important;
                    border: 0 !important;
                    overflow: hidden !important;
                    clip: rect(0 0 0 0) !important;
                    clip-path: inset(50%) !important;
                    pointer-events: none !important;
                    opacity: 0 !important;
                }
                #${ROOT_ID} .ws-log-tab {
                    display: grid;
                    gap: 10px;
                }
                #${ROOT_ID} .ws-log-status-card {
                    display: grid;
                    gap: 8px;
                    padding: 10px;
                    border: 1px solid #d6e4ff;
                    border-radius: 10px;
                    background: linear-gradient(180deg, #f7fbff 0%, #eef5ff 100%);
                }
                #${ROOT_ID} .ws-log-status-grid {
                    display: grid;
                    grid-template-columns: repeat(3, minmax(0, 1fr));
                    gap: 8px;
                }
                #${ROOT_ID} .ws-log-status-item {
                    padding: 8px;
                    border-radius: 8px;
                    background: #fff;
                    border: 1px solid #e5e7eb;
                }
                #${ROOT_ID} .ws-log-status-label {
                    display: block;
                    margin-bottom: 4px;
                    color: #64748b;
                    font-size: 10px;
                }
                #${ROOT_ID} .ws-log-status-value {
                    color: #1f2937;
                    font-size: 12px;
                    font-weight: bold;
                }
                #${ROOT_ID} .ws-input {
                    width: 100%;
                    padding: 7px;
                    border: 1px solid #ddd;
                    border-radius: 6px;
                    margin-bottom: 8px;
                    box-sizing: border-box;
                    font-size: 12px;
                }
                #${ROOT_ID} .ws-btn {
                    width: 100%;
                    padding: 10px;
                    border: none;
                    border-radius: 6px;
                    color: #fff;
                    font-weight: bold;
                    cursor: pointer;
                    font-size: 13px;
                    margin-bottom: 6px;
                }
                #${ROOT_ID} .btn-run { background: #27ae60; }
                #${ROOT_ID} .ws-label {
                    font-size: 11px;
                    font-weight: bold;
                    color: #555;
                    margin-bottom: 6px;
                    display: block;
                    border-left: 3px solid #27ae60;
                    padding-left: 5px;
                }
                #${ROOT_ID} .ws-label.collapsible {
                    cursor: pointer;
                    display: flex;
                    justify-content: space-between;
                    background: #fdfdfd;
                    padding: 5px;
                    border-radius: 4px;
                    border: 1px solid #eee;
                }
                #${ROOT_ID} .ws-row {
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                    margin-bottom: 6px;
                    font-size: 11px;
                }
                #${ROOT_ID} .ws-row-input {
                    width: 60px;
                    padding: 2px;
                    text-align: center;
                    border: 1px solid #ccc;
                    border-radius: 4px;
                }
                #${ROOT_ID} .ws-status {
                    padding: 8px;
                    background: #f9f9f9;
                    border-top: 1px solid #eee;
                    font-size: 11px;
                    color: #333;
                    text-align: center;
                    font-weight: bold;
                }
                #${ROOT_ID} .ws-log-list-wrap {
                    border: 1px solid #ddd;
                    border-radius: 8px;
                    background: #fff;
                    display: flex;
                    flex-direction: column;
                    overflow: hidden;
                }
                #${ROOT_ID} .ws-log-list-header {
                    padding: 8px 10px;
                    font-size: 11px;
                    font-weight: bold;
                    background: #eee;
                    display: flex;
                    align-items: center;
                    justify-content: space-between;
                    gap: 6px;
                }
                #${ROOT_ID} .ws-log-actions {
                    display: flex;
                    gap: 6px;
                }
                #${ROOT_ID} .ws-log-action-btn {
                    border: 1px solid #d0d7de;
                    background: #fff;
                    color: #34495e;
                    border-radius: 4px;
                    padding: 2px 8px;
                    font-size: 11px;
                    cursor: pointer;
                }
                #${ROOT_ID} .log-body {
                    height: 320px;
                    overflow-y: auto;
                    padding: 5px;
                    display: block;
                    background: #fafafa;
                }
                #${ROOT_ID} .control-group {
                    display: flex;
                    gap: 4px;
                    padding: 0 12px 10px 12px;
                }
                #${ROOT_ID} .btn-pause {
                    background: #f1c40f;
                    color: #333;
                    flex: 1;
                    margin: 0;
                }
                #${ROOT_ID} .btn-stop {
                    background: #e74c3c;
                    color: #fff;
                    flex: 1;
                    margin: 0;
                }
                #${ROOT_ID} .task-config-row {
                    display: flex;
                    justify-content: space-between;
                    background: #f0f7ff;
                    padding: 8px;
                    border-radius: 6px;
                    border: 1px solid #ddecff;
                    margin-bottom: 8px;
                }
                #${ROOT_ID} .task-config-item {
                    font-size: 11px;
                    color: #2980b9;
                    font-weight: bold;
                    display: flex;
                    align-items: center;
                }
                #${ROOT_ID} .startup-perf-card {
                    border: 1px solid #e5e5e5;
                    border-radius: 6px;
                    background: #fff;
                    margin: 8px 0;
                    overflow: hidden;
                }
                #${ROOT_ID} .startup-perf-header {
                    padding: 7px 8px;
                    font-size: 11px;
                    font-weight: 700;
                    color: #34495e;
                    background: #f6f8fa;
                    cursor: pointer;
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                }
                #${ROOT_ID} .startup-perf-body {
                    padding: 7px 8px;
                    display: grid;
                    gap: 5px;
                    font-size: 11px;
                }
                #${ROOT_ID} .startup-perf-row {
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                }
                #${ROOT_ID} .startup-perf-value {
                    font-family: Consolas, monospace;
                    color: #16a085;
                    font-weight: 700;
                }
                #${ROOT_ID} .collapsible-content {
                    overflow: hidden;
                    transition: max-height 0.3s ease-out;
                }
                #${ROOT_ID} .collapsible-content.collapsed {
                    max-height: 0;
                }
            `;
            window.PddSharedStyle.addStyle(cssText);

            const panel = document.createElement('div');
            panel.id = ROOT_ID;
            panel.dataset.pddModule = 'video-workbench';
            panel.innerHTML = `
                <div class="ws-header">
                    <span id="video-workbench-title">视频工作台 V0.2.2</span>
                    <div>
                        <span id="video-workbench-close" style="cursor:pointer; font-size: 18px; line-height: 1;">×</span>
                    </div>
                </div>
                <div class="ws-tabs" id="video-workbench-tabs">
                    <button type="button" class="ws-tab active" data-tab="manual">手动发布</button>
                    <button type="button" class="ws-tab ws-legacy-publish-tab" data-tab="publish" tabindex="-1" aria-hidden="true">发布配置</button>
                    <button type="button" class="ws-tab" data-tab="product">商品配置</button>
                    <button type="button" class="ws-tab" data-tab="logs">执行日志</button>
                </div>
                <div class="ws-body ws-tab-panel active" id="video-workbench-tab-manual">
                    <input type="text" class="ws-input" id="manual-pub-id" placeholder="输入商品 ID...">
                    <textarea class="ws-input" id="manual-pub-title" style="height:40px; resize:none;" placeholder="输入标题..."></textarea>

                    <span class="ws-label collapsible" id="label-manual-declare-config">
                        <span>内容声明设置</span>
                        <span id="arrow-manual-declare-config">▼</span>
                    </span>
                    <div class="collapsible-content collapsed" id="content-manual-declare-config">
                        <div class="ws-row" style="padding: 5px 0;">
                            <span>选择声明:</span>
                            <select class="ws-input" id="manual-cfg-declare-type" style="width:220px; margin:0;">
                                <option value="内容无需标注（作品不含AI生成、虚构、转载及营销等信息）" selected>内容无需标注（作品不含AI生成、虚构、转载及营销等信息）</option>
                                <option value="含AI生成内容">含AI生成内容</option>
                                <option value="含虚构演绎内容">含虚构演绎内容</option>
                                <option value="内容含营销信息">内容含营销信息</option>
                                <option value="内容为转载">内容为转载</option>
                                <option value="个人观点，仅供参考">个人观点，仅供参考</option>
                            </select>
                        </div>
                    </div>

                    <span class="ws-label collapsible" id="label-manual-delay-config" style="margin-top:8px;">
                        <span>延时参数（毫秒）</span>
                        <span id="arrow-manual-delay-config">▼</span>
                    </span>
                    <div class="collapsible-content collapsed" id="content-manual-delay-config">
                        <div class="ws-row"><span>ID 填充间隔:</span><input type="number" class="ws-row-input" id="manual-cfg-id-wait" value="983"></div>
                        <div class="ws-row"><span>标题录入间隔:</span><input type="number" class="ws-row-input" id="manual-cfg-title-sleep" value="897"></div>
                        <div class="ws-row"><span>声明点击等待:</span><input type="number" class="ws-row-input" id="manual-cfg-declare-wait" value="618"></div>
                        <div class="ws-row"><span>封面弹窗等待:</span><input type="number" class="ws-row-input" id="manual-cfg-modal-wait" value="929"></div>
                        <div class="ws-row"><span>封面点击前等待:</span><input type="number" class="ws-row-input" id="manual-cfg-cover-ready-wait" value="1500"></div>
                        <div class="ws-row"><span>封面后发布等待:</span><input type="number" class="ws-row-input" id="manual-cfg-cover-publish-wait" value="1500"></div>
                        <div class="ws-row"><span>发布循环间隔:</span><input type="number" class="ws-row-input" id="manual-cfg-loop-wait" value="967"></div>
                    </div>

                    <div class="ws-row" style="margin-top:8px; border-top:1px dotted #ccc; padding-top:8px;">
                        <span style="color:#2980b9; font-weight:bold;">任务结束后逐个发布:</span>
                        <input type="checkbox" id="manual-cfg-pub-auto" checked>
                    </div>

                    <span class="ws-label" style="border-left-color: #e67e22; margin-top:8px;">任务勾选</span>
                    <div class="task-config-row">
                        <label class="task-config-item"><input type="checkbox" id="manual-task-chk-id" checked> 填 ID</label>
                        <label class="task-config-item"><input type="checkbox" id="manual-task-chk-title" checked> 标题</label>
                        <label class="task-config-item"><input type="checkbox" id="manual-task-chk-declare" checked> 声明</label>
                        <label class="task-config-item"><input type="checkbox" id="manual-task-chk-cover" checked> 封面</label>
                    </div>

                    <button class="ws-btn btn-run" id="video-workbench-manual-start">开始</button>
                </div>

                <div class="ws-body ws-tab-panel ws-legacy-publish-panel" id="video-workbench-tab-publish" aria-hidden="true">
                    <input type="text" class="ws-input" id="pub-id" placeholder="输入商品 ID（自动关联历史标题）...">
                    <textarea class="ws-input" id="pub-title" style="height:40px; resize:none;" placeholder="输入标题..."></textarea>

                    <span class="ws-label collapsible" id="label-declare-config">
                        <span>内容声明设置</span>
                        <span id="arrow-declare-config">▼</span>
                    </span>
                    <div class="collapsible-content collapsed" id="content-declare-config">
                        <div class="ws-row" style="padding: 5px 0;">
                            <span>选择声明:</span>
                            <select class="ws-input" id="cfg-declare-type" style="width:220px; margin:0;">
                                <option value="内容无需标注（作品不含AI生成、虚构、转载及营销等信息）" selected>内容无需标注（作品不含AI生成、虚构、转载及营销等信息）</option>
                                <option value="含AI生成内容">含AI生成内容</option>
                                <option value="含虚构演绎内容">含虚构演绎内容</option>
                                <option value="内容含营销信息">内容含营销信息</option>
                                <option value="内容为转载">内容为转载</option>
                                <option value="个人观点，仅供参考">个人观点，仅供参考</option>
                            </select>
                        </div>
                    </div>

                    <span class="ws-label collapsible" id="label-delay-config" style="margin-top:8px;">
                        <span>延时参数（毫秒）</span>
                        <span id="arrow-delay-config">▼</span>
                    </span>
                    <div class="collapsible-content collapsed" id="content-delay-config">
                        <div class="ws-row"><span>ID 填充间隔:</span><input type="number" class="ws-row-input" id="cfg-id-wait" value="983"></div>
                        <div class="ws-row"><span>标题录入间隔:</span><input type="number" class="ws-row-input" id="cfg-title-sleep" value="897"></div>
                        <div class="ws-row"><span>声明点击等待:</span><input type="number" class="ws-row-input" id="cfg-declare-wait" value="618"></div>
                        <div class="ws-row"><span>封面弹窗等待:</span><input type="number" class="ws-row-input" id="cfg-modal-wait" value="929"></div>
                        <div class="ws-row"><span>封面点击前等待:</span><input type="number" class="ws-row-input" id="cfg-cover-ready-wait" value="1500"></div>
                        <div class="ws-row"><span>封面后发布等待:</span><input type="number" class="ws-row-input" id="cfg-cover-publish-wait" value="1500"></div>
                        <div class="ws-row"><span>发布循环间隔:</span><input type="number" class="ws-row-input" id="cfg-loop-wait" value="967"></div>
                    </div>

                    <div class="ws-row" style="margin-top:8px; border-top:1px dotted #ccc; padding-top:8px;">
                        <span style="color:#2980b9; font-weight:bold;">任务结束后逐个发布:</span>
                        <input type="checkbox" id="cfg-pub-auto" checked>
                    </div>

                    <span class="ws-label" style="border-left-color: #e67e22; margin-top:8px;">任务勾选</span>
                    <div class="task-config-row">
                        <label class="task-config-item"><input type="checkbox" id="task-chk-id" checked> 填 ID</label>
                        <label class="task-config-item"><input type="checkbox" id="task-chk-title" checked> 标题</label>
                        <label class="task-config-item"><input type="checkbox" id="task-chk-declare" checked> 声明</label>
                        <label class="task-config-item"><input type="checkbox" id="task-chk-cover" checked> 封面</label>
                    </div>

                    <div class="startup-perf-card">
                        <div class="startup-perf-header" id="video-workbench-perf-toggle">
                            <span>启动性能监控</span>
                            <span id="video-workbench-perf-arrow">▶</span>
                        </div>
                        <div class="startup-perf-body collapsible-content collapsed" id="video-workbench-perf-body">
                            <div class="startup-perf-row"><span>bootstrap</span><span class="startup-perf-value" id="video-workbench-perf-bootstrap">0 ms</span></div>
                            <div class="startup-perf-row"><span>DOM ready</span><span class="startup-perf-value" id="video-workbench-perf-domReady">0 ms</span></div>
                            <div class="startup-perf-row"><span>file scan</span><span class="startup-perf-value" id="video-workbench-perf-fileScan">0 ms</span></div>
                            <div class="startup-perf-row"><span>batch build</span><span class="startup-perf-value" id="video-workbench-perf-batchBuild">0 ms</span></div>
                            <div class="startup-perf-row"><span>upload init</span><span class="startup-perf-value" id="video-workbench-perf-uploadInit">0 ms</span></div>
                            <div class="startup-perf-row"><span>idle wait</span><span class="startup-perf-value" id="video-workbench-perf-idleWait">0 ms</span></div>
                        </div>
                    </div>

                    <button class="ws-btn btn-run" id="video-workbench-start">开始</button>
                </div>

                <div class="ws-body ws-tab-panel" id="video-workbench-tab-product">
                    <div id="video-workbench-product-tab"></div>
                </div>

                <div class="control-group" id="video-workbench-controls">
                    <button class="ws-btn btn-pause" id="video-workbench-pause">暂停</button>
                    <button class="ws-btn btn-stop" id="video-workbench-stop">停止</button>
                </div>

                <div class="ws-status" id="video-workbench-status">等待指令...</div>

                <div class="log-panel">
                    <div class="log-header" id="video-workbench-log-toggle">执行日志 <span id="video-workbench-log-arrow">▼</span></div>
                    <div class="log-body" id="video-workbench-log-list"></div>
                </div>
            `;
            document.body.appendChild(panel);
            moduleApi.panelEl = panel;

            const logPanel = panel.querySelector('.log-panel');
            const logList = panel.querySelector('#video-workbench-log-list');

            const logTabPanel = document.createElement('div');
            logTabPanel.className = 'ws-body ws-tab-panel';
            logTabPanel.id = 'video-workbench-tab-logs';
            logTabPanel.innerHTML = `
                <div class="ws-log-tab">
                    <div class="ws-log-status-card">
                        <div class="ws-label" style="margin-bottom:0;">执行状态</div>
                        <div class="ws-log-status-grid">
                            <div class="ws-log-status-item">
                                <span class="ws-log-status-label">当前商品ID</span>
                                <span class="ws-log-status-value" id="video-workbench-log-product">--</span>
                            </div>
                            <div class="ws-log-status-item">
                                <span class="ws-log-status-label">当前状态</span>
                                <span class="ws-log-status-value" id="video-workbench-log-status">等待</span>
                            </div>
                            <div class="ws-log-status-item">
                                <span class="ws-log-status-label">当前批次</span>
                                <span class="ws-log-status-value" id="video-workbench-log-batch">--</span>
                            </div>
                        </div>
                    </div>
                    <div class="ws-log-list-wrap">
                        <div class="ws-log-list-header">
                            <span>执行日志</span>
                            <span class="ws-log-actions">
                                <button type="button" class="ws-log-action-btn" id="video-workbench-copy-logs">复制全部</button>
                                <button type="button" class="ws-log-action-btn" id="video-workbench-clear-logs">清空日志</button>
                            </span>
                        </div>
                    </div>
                </div>
            `;
            panel.querySelector('#video-workbench-tab-product')?.insertAdjacentElement('afterend', logTabPanel);
            const logStatusLabelEls = logTabPanel.querySelectorAll('.ws-log-status-label');
            const logHeaderLabelEl = logTabPanel.querySelector('.ws-label');
            const logListHeaderEl = logTabPanel.querySelector('.ws-log-list-header');
            const logListTitleEl = logListHeaderEl?.querySelector('span');
            const logStatusValueEl = logTabPanel.querySelector('#video-workbench-log-status');
            if (logHeaderLabelEl) logHeaderLabelEl.textContent = '执行状态';
            if (logStatusLabelEls[0]) logStatusLabelEls[0].textContent = '当前商品ID';
            if (logStatusLabelEls[1]) logStatusLabelEls[1].textContent = '当前状态';
            if (logStatusLabelEls[2]) logStatusLabelEls[2].textContent = '当前批次';
            if (logListTitleEl) logListTitleEl.textContent = '执行日志';
            if (logStatusValueEl) logStatusValueEl.textContent = '等待';
            const logListWrap = logTabPanel.querySelector('.ws-log-list-wrap');
            if (logListWrap && logList) {
                logListWrap.appendChild(logList);
            }
            if (logPanel) {
                logPanel.style.display = 'none';
            }

            const MANUAL_TO_LEGACY_IDS = {
                'manual-pub-id': 'pub-id',
                'manual-pub-title': 'pub-title',
                'manual-cfg-declare-type': 'cfg-declare-type',
                'manual-cfg-id-wait': 'cfg-id-wait',
                'manual-cfg-title-sleep': 'cfg-title-sleep',
                'manual-cfg-declare-wait': 'cfg-declare-wait',
                'manual-cfg-modal-wait': 'cfg-modal-wait',
                'manual-cfg-cover-ready-wait': 'cfg-cover-ready-wait',
                'manual-cfg-cover-publish-wait': 'cfg-cover-publish-wait',
                'manual-cfg-loop-wait': 'cfg-loop-wait',
                'manual-cfg-pub-auto': 'cfg-pub-auto',
                'manual-task-chk-id': 'task-chk-id',
                'manual-task-chk-title': 'task-chk-title',
                'manual-task-chk-declare': 'task-chk-declare',
                'manual-task-chk-cover': 'task-chk-cover'
            };

            function syncElementValue(source, target, emit = true) {
                if (!source || !target) return;
                if (source.type === 'checkbox') {
                    target.checked = source.checked;
                } else {
                    target.value = source.value;
                }
                if (emit) {
                    ['input', 'change'].forEach((eventName) => {
                        target.dispatchEvent(new Event(eventName, { bubbles: true }));
                    });
                }
            }

            function syncManualConfigToLegacy() {
                Object.entries(MANUAL_TO_LEGACY_IDS).forEach(([manualId, legacyId]) => {
                    syncElementValue(document.getElementById(manualId), document.getElementById(legacyId));
                });
            }

            function syncLegacyConfigToManual() {
                Object.entries(MANUAL_TO_LEGACY_IDS).forEach(([manualId, legacyId]) => {
                    syncElementValue(document.getElementById(legacyId), document.getElementById(manualId), false);
                });
            }

            function bindManualConfigBridge() {
                syncLegacyConfigToManual();
                Object.keys(MANUAL_TO_LEGACY_IDS).forEach((manualId) => {
                    const el = document.getElementById(manualId);
                    if (!el) return;
                    const sync = () => syncManualConfigToLegacy();
                    el.addEventListener('input', sync);
                    el.addEventListener('change', sync);
                });
            }

            function collectManualExistingVideoCards() {
                return Array.from(document.querySelectorAll('div[class*="video-list_detail"]'))
                    .filter((item) => item.offsetParent !== null && !item.closest?.(`#${ROOT_ID}`));
            }

            function getManualExistingVideoCount() {
                const cards = collectManualExistingVideoCards().length;
                const titleTargets = collectTitleTargets().length;
                const declarationTargets = collectDeclarationTargets().length;
                const publishButtons = Array.from(document.querySelectorAll('div[class*="video-list_singlePublish"]'))
                    .filter((el) => el.offsetParent !== null && !el.closest?.(`#${ROOT_ID}`)).length;
                return Math.max(cards, titleTargets, declarationTargets, publishButtons, collectUploadSuccessVideoCards().length);
            }

            function prepareManualExistingVideoBatch(expectedCount) {
                const batchId = `manual-${Date.now()}`;
                resetBatchLifecycle(batchId, expectedCount);
                collectManualExistingVideoCards().slice(0, expectedCount).forEach((item) => {
                    delete item.dataset.pddCoverDone;
                    delete item.dataset.pddPublishDone;
                    delete item.dataset.pddPublishIndex;
                    delete item.dataset.pddCoverPublishWaitDone;
                });
                currentBatchExpectedCount = expectedCount;
                currentUploadCompletePromise = null;
                isBatchUploading = false;
                uploadFinished = true;
                publishLocked = false;
                batchLifecycle.state = 'UPLOAD_COMPLETED';
                batchLifecycle.uploadCompleted = true;
                batchLifecycle.expectedCount = expectedCount;
                batchExitGuard.upload = true;
                setPhase('FILL_PHASE');
                updateStatus('手动发布接管当前页面视频');
                addLog(`[手动发布] 已接管当前页面 ${expectedCount} 个视频，不执行扫描/上传/切批/导航`, 'info');
            }

            async function runManualExistingVideoFlow(startButton) {
                if (START_LOCK) {
                    addLog('[START_LOCK] 启动流程已在执行，忽略重复触发', 'info');
                    return;
                }
                syncManualConfigToLegacy();
                const tasks = ['task-chk-id', 'task-chk-title', 'task-chk-declare', 'task-chk-cover'];
                if (!tasks.some((task) => document.getElementById(task).checked)) {
                    alert('请至少勾选一个任务！');
                    return;
                }

                const productId = document.getElementById('pub-id')?.value.trim();
                const title = document.getElementById('pub-title')?.value || '';
                if (!productId) {
                    addLog('[手动发布] 请先输入商品 ID', 'error');
                    return;
                }

                const expectedCount = getManualExistingVideoCount();
                if (!expectedCount) {
                    addLog('[手动发布] 当前页面未检测到视频卡片，请先在平台上传视频', 'error');
                    return;
                }

                const manualSummary = createRunSummary(productId, 'manual');
                const manualFiles = collectManualExistingVideoCards()
                    .slice(0, expectedCount)
                    .map((item, index) => ({
                        name: extractVideoFileNameFromCard(item, index),
                        size: 0
                    }));
                while (manualFiles.length < expectedCount) {
                    manualFiles.push({
                        name: `视频 ${manualFiles.length + 1}`,
                        size: 0
                    });
                }
                activeRunSummary = manualSummary;

                isRunning = true;
                isPaused = false;
                START_LOCK = true;
                startButton.disabled = true;
                setControlsVisible(true);
                resetPauseButton();
                resetStartupPerf();

                let flowSucceeded = false;
                let flowReason = 'unknown-failure';
                moduleApi.lastRunResult = null;
                try {
                    const memory = JSON.parse(localStorage.getItem(MEMORY_KEY) || '{}');
                    memory[productId] = title;
                    localStorage.setItem(MEMORY_KEY, JSON.stringify(memory));
                    prepareManualExistingVideoBatch(expectedCount);
                    const fillReady = await runFillPhase();
                    if (!fillReady) {
                        flowReason = 'fill-incomplete';
                        addLog('[手动发布] 信息填充未完成，流程已阻断', 'error');
                        return;
                    }
                    const publishReady = await runPublishPhase();
                    if (!publishReady) {
                        flowReason = 'publish-incomplete';
                        addLog('[手动发布] 封面或发布未完成，流程已阻断', 'error');
                        return;
                    }
                    flowSucceeded = true;
                    flowReason = 'completed';
                    addLog('[手动发布] 当前页面视频处理完成', 'success');
                } catch (error) {
                    console.error('VIDEO_WORKBENCH_MANUAL_FLOW_ERROR', error);
                    flowReason = error?.message || String(error);
                    addLog(`[手动发布] 执行失败：${error?.message || error}`, 'error');
                } finally {
                    addRunSummaryBatch(manualSummary, {
                        batchIndex: 1,
                        totalBatches: 1,
                        files: manualFiles,
                        status: flowSucceeded ? 'done' : 'fail',
                        reason: flowSucceeded ? '' : flowReason
                    });
                    logRunSummary(manualSummary, flowSucceeded, flowReason);
                    moduleApi.lastRunResult = {
                        accepted: flowSucceeded,
                        reason: flowReason,
                        handledWorkflow: true,
                        at: Date.now(),
                        summary: manualSummary
                    };
                    activeRunSummary = null;
                    isRunning = false;
                    isPaused = false;
                    START_LOCK = false;
                    startButton.disabled = false;
                    setControlsVisible(true);
                    resetPauseButton();
                    updateStatus(flowSucceeded ? '手动发布流程完成' : '手动发布流程失败');
                }
            }

            let activeTab = 'manual';

            const switchTab = (tabName) => {
                activeTab = tabName;
                panel.querySelectorAll('.ws-tab').forEach((tabButton) => {
                    tabButton.classList.toggle('active', tabButton.dataset.tab === tabName);
                });
                if (tabName === 'manual') syncLegacyConfigToManual();
                panel.querySelector('#video-workbench-tab-manual')?.classList.toggle('active', tabName === 'manual');
                panel.querySelector('#video-workbench-tab-publish')?.classList.toggle('active', tabName === 'publish');
                panel.querySelector('#video-workbench-tab-product')?.classList.toggle('active', tabName === 'product');
                panel.querySelector('#video-workbench-tab-logs')?.classList.toggle('active', tabName === 'logs');
            };

            panel.querySelectorAll('.ws-tab').forEach((tabButton) => {
                tabButton.addEventListener('click', () => switchTab(tabButton.dataset.tab));
            });

            const productConfigManager = window.PddModules?.productConfigManager;
            if (productConfigManager?.mount) {
                const productTabContainer = panel.querySelector('#video-workbench-product-tab');
                Promise.resolve(productConfigManager.mount(panel, productTabContainer)).catch((error) => {
                    console.error('[PDD插件] productConfigManager 挂载失败', error);
                });
            }
            if (!moduleApi.schedulerLogUnsubscribe && productConfigManager?.onLog) {
                moduleApi.schedulerLogUnsubscribe = productConfigManager.onLog((event) => {
                    const logType = event?.type === 'success' || event?.type === 'error' ? event.type : 'info';
                    moduleApi.appendExecutionLog?.(event?.message || '', logType);
                });
            }

            async function taskPubFillID(options = {}) {
                if (!document.getElementById('task-chk-id').checked) return;
                const id = document.getElementById('pub-id').value.trim();
                if (!id) return addLog('未输入商品 ID，跳过 ID 填充', 'error');
                const requestedIndexes = Array.isArray(options.missingIndexes)
                    ? options.missingIndexes
                    : getMissingIndexes('id', currentBatchExpectedCount);
                const missingIndexes = requestedIndexes.filter((index) => !videoBindingState.id.done.has(index));
                if (!missingIndexes.length) {
                    addLog('[商品ID] 已全部绑定，跳过重复填充', 'info');
                    return;
                }
                const btns = getUniqueElements('添加商品');
                addLog(`[商品ID] 差量填充：缺失 ${missingIndexes.length} 个，可用按钮 ${btns.length} 个`, 'info');
                for (let i = 0; i < Math.min(btns.length, missingIndexes.length); i++) {
                    if (!isRunning) return;
                    await checkPause();
                    const videoIndex = missingIndexes[i];
                    if (videoBindingState.id.done.has(videoIndex)) {
                        addLog(`[商品ID] 视频 ${videoIndex + 1} 已绑定，跳过`, 'info');
                        continue;
                    }
                    updateStatus(`[ID] ${i + 1}/${missingIndexes.length}`);
                    robustClick(btns[i]);
                    await sleep(getCfg('cfg-id-wait', 1500));
                    const tab = Array.from(document.querySelectorAll('*')).find((el) => el.innerText === '商品ID' && el.offsetHeight > 0);
                    if (tab) {
                        robustClick(tab);
                        await sleep(1000);
                        const input = document.querySelector('input[placeholder*="输入商品id"]') || document.querySelector('.ant-input');
                        if (input) {
                            input.focus();
                            document.execCommand('insertText', false, id);
                            input.dispatchEvent(new Event('input', { bubbles: true }));
                            await sleep(800);
                            const next = Array.from(document.querySelectorAll('*')).find((el) => el.innerText === '下一步' && el.offsetHeight > 0);
                            if (next) {
                                robustClick(next);
                                await sleep(1200);
                                videoBindingState.id.done.add(videoIndex);
                                addLog(`[商品ID] 视频 ${videoIndex + 1} 填入成功`, 'success');
                            }
                        }
                    }
                }
            }

            async function taskPubFillTitle(options = {}) {
                if (!document.getElementById('task-chk-title').checked) return;
                const title = document.getElementById('pub-title').value;
                if (!title) return addLog('未输入标题内容，跳过标题录入', 'error');
                const requestedIndexes = Array.isArray(options.missingIndexes)
                    ? options.missingIndexes
                    : getMissingIndexes('title', currentBatchExpectedCount);
                const missingIndexes = requestedIndexes.filter((index) => !videoBindingState.title.done.has(index));
                if (!missingIndexes.length) {
                    addLog('[标题] 已全部填充，跳过重复填充', 'info');
                    return;
                }
                const unique = collectTitleTargets();
                addLog(`[标题] 差量填充：缺失 ${missingIndexes.length} 个，可用输入位 ${unique.length} 个`, 'info');
                for (const videoIndex of missingIndexes) {
                    if (!isRunning) return;
                    await checkPause();
                    if (videoBindingState.title.done.has(videoIndex)) {
                        addLog(`[标题] 视频 ${videoIndex + 1} 已填充，跳过`, 'info');
                        continue;
                    }
                    updateStatus(`[标题] ${videoIndex + 1}/${currentBatchExpectedCount}`);
                    const el = unique[videoIndex];
                    if (!el) {
                        addLog(`[标题] 视频 ${videoIndex + 1} 未找到输入位`, 'error');
                        continue;
                    }
                    el.scrollIntoView({ block: 'center' });
                    el.focus();
                    await sleep(200);
                    const selection = window.getSelection();
                    const range = document.createRange();
                    range.selectNodeContents(el);
                    selection.removeAllRanges();
                    selection.addRange(range);
                    await sleep(100);
                    document.execCommand('insertText', false, title);
                    ['input', 'change', 'blur', 'keyup'].forEach((eventName) => {
                        el.dispatchEvent(new Event(eventName, { bubbles: true }));
                    });
                    videoBindingState.title.done.add(videoIndex);
                    addLog(`[标题] 视频 ${videoIndex + 1}/${currentBatchExpectedCount} 填充完成`, 'success');
                    await sleep(getCfg('cfg-title-sleep', 800));
                }
            }

            async function taskPubDeclare(options = {}) {
                if (!document.getElementById('task-chk-declare').checked) return;
                const targetText = document.getElementById('cfg-declare-type')?.value || '内容无需标注';
                const declareWait = getCfg('cfg-declare-wait', 600);
                const requestedIndexes = Array.isArray(options.missingIndexes)
                    ? options.missingIndexes
                    : getMissingIndexes('statement', currentBatchExpectedCount);
                const missingIndexes = requestedIndexes.filter((index) => !videoBindingState.statement.done.has(index));
                if (!missingIndexes.length) {
                    addLog('[声明] 已全部选择，跳过重复点击', 'info');
                    return;
                }
                const allFormItems = collectDeclarationTargets();

                if (allFormItems.length === 0) {
                    addLog('未找到“内容声明”区域，请检查页面是否加载完成', 'error');
                    return;
                }

                addLog(`[声明] 差量选择：缺失 ${missingIndexes.length} 个，可用声明位 ${allFormItems.length} 个`, 'info');

                for (const videoIndex of missingIndexes) {
                    if (!isRunning) return;
                    await checkPause();
                    if (videoBindingState.statement.done.has(videoIndex)) {
                        addLog(`[声明] 视频 ${videoIndex + 1} 已选择，跳过`, 'info');
                        continue;
                    }
                    if (videoBindingState.statementClickLock.has(videoIndex)) {
                        addLog(`[声明] 视频 ${videoIndex + 1} 点击锁已生效，跳过重复点击`, 'info');
                        continue;
                    }
                    updateStatus(`[声明] 处理中 ${videoIndex + 1}/${currentBatchExpectedCount}`);
                    const container = allFormItems[videoIndex];
                    if (!container) {
                        addLog(`[声明] 视频 ${videoIndex + 1} 未找到声明区域`, 'error');
                        continue;
                    }

                    const trigger = container.querySelector('[data-testid*="select"]') || container.querySelector('[class*="input"]');
                    if (!trigger) {
                        addLog(`[声明] 视频 ${videoIndex + 1} 未找到声明触发器`, 'error');
                        continue;
                    }
                    videoBindingState.statementClickLock.add(videoIndex);
                    container.scrollIntoView({ behavior: 'smooth', block: 'center' });
                    await sleep(500);
                    const selected = await retrySelectDropdown(trigger, targetText);

                    if (selected) {
                        videoBindingState.statement.done.add(videoIndex);
                        addLog(`[声明] 视频 ${videoIndex + 1} 设置成功：${targetText}`, 'success');
                    } else {
                        videoBindingState.statementClickLock.delete(videoIndex);
                        addLog(`[声明] 视频 ${videoIndex + 1} 未找到选项“${targetText}”，可能浮层未弹出或文本不匹配`, 'error');
                        document.body.click();
                    }
                    await sleep(declareWait);
                }
            }

            async function retrySelectDropdown(target, value) {
                let retry = 0;

                while (retry < 3) {
                    const el = target;

                    if (!el) {
                        console.log('FILL_DROPDOWN_NOT_FOUND retry', retry);
                        retry += 1;
                        await sleep(800);
                        continue;
                    }

                    robustClick(el);
                    await sleep(500);

                    const option = Array.from(document.querySelectorAll(".dropdown-item, [class*='ContentDeclaration_title'], .ant-select-item-option"))
                        .find((node) => node.innerText?.includes(value) && node.offsetParent !== null);

                    if (option) {
                        robustClick(option);
                        console.log('FILL_DROPDOWN_SUCCESS', value);
                        return true;
                    }

                    console.log('FILL_DROPDOWN_RETRY', retry);
                    retry += 1;
                    await sleep(800);
                }

                console.log('FILL_DROPDOWN_FAILED', value);
                return false;
            }

            async function reRunMissingFill() {
                const diff = buildBindingDiff(currentBatchExpectedCount);
                addLog(`[回溯修复] 仅补缺失项：标题 ${diff.missingTitle.length} 个，商品ID ${diff.missingID.length} 个，声明 ${diff.missingStatement.length} 个`, 'info');
                if (document.getElementById('task-chk-title').checked) await taskPubFillTitle({ missingIndexes: diff.missingTitle });
                if (document.getElementById('task-chk-id').checked) await taskPubFillID({ missingIndexes: diff.missingID });
                if (document.getElementById('task-chk-declare').checked) await taskPubDeclare({ missingIndexes: diff.missingStatement });
            }

            function getNodeTextAndValue(node) {
                if (!node) return '';
                const values = [
                    node.value,
                    node.innerText,
                    node.textContent,
                    node.getAttribute?.('value'),
                    node.getAttribute?.('aria-label')
                ];
                node.querySelectorAll?.('input, textarea, [contenteditable="true"], .ace-line, .public-DraftEditor-content').forEach((child) => {
                    values.push(child.value, child.innerText, child.textContent, child.getAttribute?.('value'), child.getAttribute?.('aria-label'));
                });
                return values.filter(Boolean).join('\n');
            }

            function markFirstDone(type, count, expectedCount) {
                const done = videoBindingState[type]?.done;
                if (!done) return;
                const limit = Math.min(count, expectedCount);
                for (let i = 0; i < limit; i++) {
                    done.add(i);
                }
            }

            function getTitleDetection(expectedCount) {
                const titleValue = document.getElementById('pub-title')?.value || '';
                const titleTargets = collectTitleTargets();
                if (!titleValue) {
                    return {
                        domCount: 0,
                        valueCount: 0,
                        stateCount: videoBindingState.title.done.size,
                        finalTitleCount: videoBindingState.title.done.size
                    };
                }

                let domCount = 0;
                let valueCount = 0;
                titleTargets.forEach((target, index) => {
                    const visualText = [target.innerText, target.textContent].filter(Boolean).join('\n');
                    const stateText = getNodeTextAndValue(target);
                    if (visualText.includes(titleValue)) {
                        domCount += 1;
                        videoBindingState.title.done.add(index);
                    }
                    if (stateText.includes(titleValue)) {
                        valueCount += 1;
                        videoBindingState.title.done.add(index);
                    }
                });

                const finalTitleCount = Math.min(expectedCount, Math.max(domCount, valueCount, videoBindingState.title.done.size));
                markFirstDone('title', finalTitleCount, expectedCount);
                return {
                    domCount,
                    valueCount,
                    stateCount: videoBindingState.title.done.size,
                    finalTitleCount
                };
            }

            function syncBindingStateFromDom(expectedCount) {
                const titleEnabled = Boolean(document.getElementById('task-chk-title')?.checked);
                const idEnabled = Boolean(document.getElementById('task-chk-id')?.checked);
                const statementEnabled = Boolean(document.getElementById('task-chk-declare')?.checked);
                const addProductRemaining = getUniqueElements('添加商品').length;
                const selectedStatement = document.getElementById('cfg-declare-type')?.value || '内容无需标注';

                if (!titleEnabled) {
                    markAllBindingDone('title', expectedCount);
                } else {
                    getTitleDetection(expectedCount);
                }

                if (!idEnabled) {
                    markAllBindingDone('id', expectedCount);
                } else {
                    markFirstDone('id', Math.max(0, expectedCount - addProductRemaining), expectedCount);
                }

                if (!statementEnabled) {
                    markAllBindingDone('statement', expectedCount);
                } else {
                    collectDeclarationTargets().forEach((target, index) => {
                        const text = getNodeTextAndValue(target);
                        if (text.includes(selectedStatement) || /已选择|无需标注/.test(text)) {
                            videoBindingState.statement.done.add(index);
                        }
                    });
                }
            }

            function buildBindingDiff(expectedCount) {
                syncBindingStateFromDom(expectedCount);
                return {
                    missingTitle: getMissingIndexes('title', expectedCount),
                    missingID: getMissingIndexes('id', expectedCount),
                    missingStatement: getMissingIndexes('statement', expectedCount)
                };
            }

            function getBindingCounts(expectedCount) {
                const titleEnabled = Boolean(document.getElementById('task-chk-title')?.checked);
                const idEnabled = Boolean(document.getElementById('task-chk-id')?.checked);
                const statementEnabled = Boolean(document.getElementById('task-chk-declare')?.checked);
                syncBindingStateFromDom(expectedCount);
                const titleDetection = getTitleDetection(expectedCount);
                const titleCount = titleEnabled
                    ? titleDetection.finalTitleCount
                    : expectedCount;
                const idCount = idEnabled
                    ? videoBindingState.id.done.size
                    : expectedCount;
                const statementCount = statementEnabled
                    ? videoBindingState.statement.done.size
                    : expectedCount;

                return {
                    videoCount: expectedCount,
                    titleCount,
                    idCount,
                    statementCount,
                    titleDomCount: titleDetection.domCount,
                    titleValueCount: titleDetection.valueCount,
                    titleStateCount: titleDetection.stateCount
                };
            }

            function logLifecycleChecks(expectedCount, options = {}) {
                const counts = options.counts || getBindingCounts(expectedCount);
                const publishCompleted = isPublishCompleted(expectedCount);
                const coverCompleted = isCoverCompleted(expectedCount);
                const backtrackTriggered = Boolean(options.backtrackTriggered);
                const nextBatchBlocked = options.nextBatchBlocked === undefined
                    ? !(batchLifecycle.uploadCompleted && batchLifecycle.consistencyPassed && coverCompleted && publishCompleted)
                    : Boolean(options.nextBatchBlocked);
                console.log('[CHECK] idFilled', `${counts.idCount}/${expectedCount}`);
                console.log('[CHECK] statementFilled', `${counts.statementCount}/${expectedCount}`);
                console.log('[CHECK] coverCompleted', coverCompleted);
                console.log('[CHECK] publishCompleted', publishCompleted);
                console.log('[CHECK] backtrackTriggered', backtrackTriggered);
                console.log('[CHECK] nextBatchBlocked', nextBatchBlocked);
                addLog(`[CHECK] idFilled=${counts.idCount}/${expectedCount}`, counts.idCount === expectedCount ? 'success' : 'error');
                addLog(`[CHECK] statementFilled=${counts.statementCount}/${expectedCount}`, counts.statementCount === expectedCount ? 'success' : 'error');
                addLog(`[CHECK] coverCompleted=${coverCompleted}`, coverCompleted ? 'success' : 'error');
                addLog(`[CHECK] publishCompleted=${publishCompleted}`, publishCompleted ? 'success' : 'error');
                addLog(`[CHECK] backtrackTriggered=${backtrackTriggered}`, backtrackTriggered ? 'error' : 'success');
                addLog(`[CHECK] nextBatchBlocked=${nextBatchBlocked}`, nextBatchBlocked ? 'error' : 'success');
                addLog(`[检查] 商品ID=${counts.idCount}/${expectedCount}，声明=${counts.statementCount}/${expectedCount}，封面完成=${coverCompleted}，发布完成=${publishCompleted}，下一批阻断=${nextBatchBlocked}`, nextBatchBlocked ? 'error' : 'success');
                return {
                    counts,
                    coverCompleted,
                    publishCompleted,
                    backtrackTriggered,
                    nextBatchBlocked
                };
            }

            async function verifyFillIntegrity(expectedCount) {
                let counts = getBindingCounts(expectedCount);
                let retryRound = 0;
                let previousMissingCount = null;
                let backtrackTriggered = false;

                while (
                    retryRound < 3 &&
                    (
                        counts.titleCount !== counts.videoCount ||
                        counts.idCount !== counts.videoCount ||
                        counts.statementCount !== counts.videoCount
                    )
                ) {
                    const diff = buildBindingDiff(expectedCount);
                    const missingCount = diff.missingTitle.length + diff.missingID.length + diff.missingStatement.length;
                    if (retryRound > 0 && missingCount === previousMissingCount) {
                        console.log('BACKTRACK_STUCK_DETECTED', {
                            retryRound,
                            missingCount,
                            ...counts
                        });
                        addLog('[回溯修复] 缺失数量未变化，保持差量修复模式并停止重复重试', 'error');
                        break;
                    }
                    previousMissingCount = missingCount;
                    retryRound += 1;
                    backtrackTriggered = true;
                    console.log('BACKTRACK_FIX_TRIGGER', {
                        retryRound,
                        ...counts,
                        missingTitle: diff.missingTitle,
                        missingID: diff.missingID,
                        missingStatement: diff.missingStatement
                    });
                    addLog(`[回溯修复] 第 ${retryRound} 次：标题 ${counts.titleCount}/${counts.videoCount}，商品ID ${counts.idCount}/${counts.videoCount}，声明 ${counts.statementCount}/${counts.videoCount}`, 'error');
                    if (document.getElementById('task-chk-title').checked) await taskPubFillTitle({ missingIndexes: diff.missingTitle });
                    if (document.getElementById('task-chk-id').checked) await taskPubFillID({ missingIndexes: diff.missingID });
                    if (document.getElementById('task-chk-declare').checked) await taskPubDeclare({ missingIndexes: diff.missingStatement });
                    await sleep(1000);
                    counts = getBindingCounts(expectedCount);
                }

                const verified = counts.titleCount === counts.videoCount &&
                    counts.idCount === counts.videoCount &&
                    counts.statementCount === counts.videoCount &&
                    batchLifecycle.uploadCompleted === true;
                batchLifecycle.consistencyPassed = verified;
                phaseLock.TITLE_BINDING_DONE = videoBindingState.title.done.size === expectedCount;
                phaseLock.ID_BINDING_DONE = videoBindingState.id.done.size === expectedCount;
                phaseLock.STATEMENT_DONE = videoBindingState.statement.done.size === expectedCount;

                console.log('FILL_CONSISTENCY_RESULT', {
                    verified,
                    ...counts
                });
                addLog(`[一致性] 标题=${counts.titleCount}/${counts.videoCount} 商品ID=${counts.idCount}/${counts.videoCount} 声明=${counts.statementCount}/${counts.videoCount} 上传完成=${batchLifecycle.uploadCompleted}`, verified ? 'success' : 'error');
                addLog(`[标题校验] 视觉=${counts.titleDomCount} 输入值=${counts.titleValueCount} 状态=${counts.titleStateCount} 最终=${counts.titleCount}`, 'info');
                logLifecycleChecks(expectedCount, {
                    counts,
                    backtrackTriggered,
                    nextBatchBlocked: true
                });
                return verified;
            }

            function collectCoverEditButtons() {
                const rawBtns = Array.from(document.querySelectorAll('button, span')).filter((el) => {
                    return isCoverEditText(el.innerText) &&
                        el.offsetHeight > 0 &&
                        !el.closest(`#${ROOT_ID}`) &&
                        !el.dataset.done;
                });
                return rawBtns.filter((el) => {
                    if (!isEnabledCoverEditTarget(el)) return false;
                    const hasChildWithText = Array.from(el.querySelectorAll('*')).some((child) => isCoverEditText(child.innerText));
                    return !hasChildWithText;
                });
            }

            function isCoverEditText(text) {
                const normalized = String(text || '').trim();
                return normalized === '编辑封面' ||
                    normalized === '设置封面' ||
                    normalized === '更换封面' ||
                    normalized.includes('编辑封面');
            }

            function isEnabledCoverEditTarget(el) {
                if (!el || el.dataset.done === 'true') return false;
                const button = el.closest('button, [role="button"]') || el;
                return button.offsetHeight > 0 &&
                    !button.disabled &&
                    button.dataset.done !== 'true' &&
                    button.getAttribute('aria-disabled') !== 'true' &&
                    !String(button.className || '').includes('BTN_disabled');
            }

            function isUploadSuccessVideoItem(item) {
                const text = getElementText(item);
                return text.includes('视频上传成功') ||
                    Boolean(item.querySelector('[class*="video-list_success"]'));
            }

            function getVisiblePublishItems() {
                const detailItems = Array.from(document.querySelectorAll('div[class*="video-list_detail"]'))
                    .filter((item) => item.offsetParent !== null && !item.closest?.(`#${ROOT_ID}`));
                if (detailItems.length) {
                    return detailItems.filter(isUploadSuccessVideoItem);
                }
                return Array.from(document.querySelectorAll('div[class*="video-list_singlePublish"]'))
                    .filter((item) => item.offsetParent !== null && !item.closest?.(`#${ROOT_ID}`));
            }

            function collectUploadSuccessVideoCards() {
                return Array.from(document.querySelectorAll('div[class*="video-list_detail"]'))
                    .filter((item) => item.offsetParent !== null && !item.closest?.(`#${ROOT_ID}`) && isUploadSuccessVideoItem(item));
            }

            function collectReadyCoverTargets(expectedCount) {
                return collectUploadSuccessVideoCards()
                    .slice(0, expectedCount)
                    .map((item) => ({ item, btn: getCoverButtonFromItem(item) }))
                    .filter(({ item, btn }) => btn && item.dataset.pddCoverDone !== 'true');
            }

            function getCoverButtonFromItem(item) {
                if (!item) return null;
                const candidates = Array.from(item.querySelectorAll('button, [role="button"], span'))
                    .filter((el) => isCoverEditText(el.innerText) &&
                        el.offsetHeight > 0 &&
                        !el.closest(`#${ROOT_ID}`) &&
                        !el.dataset.done &&
                        isEnabledCoverEditTarget(el));
                return candidates.find((el) => {
                    const hasChildWithText = Array.from(el.querySelectorAll('*')).some((child) => isCoverEditText(child.innerText));
                    return !hasChildWithText;
                }) || candidates[0] || null;
            }

            function getVideoItemWrap(item) {
                return item?.closest?.('div[class*="video-list_itemWrap"]') || item;
            }

            function getPublishRootFromItem(item) {
                const wrap = getVideoItemWrap(item);
                return item?.querySelector?.('div[class*="video-list_singlePublish"]') ||
                    wrap?.querySelector?.('div[class*="video-list_singlePublish"]') ||
                    item;
            }

            function isPublishText(text) {
                return /发布|鍙戝竷/.test(text || '');
            }

            function isPublishedText(text) {
                return /已发布|宸插彂甯/.test(text || '');
            }

            function isPublishingText(text) {
                return /发布中|鍙戝竷涓/.test(text || '');
            }

            function getPublishButtonUiState(item) {
                const publishRoot = getPublishRootFromItem(item);
                const buttons = Array.from(publishRoot?.querySelectorAll?.('button') || [])
                    .filter((btn) => btn.offsetParent !== null);
                const publishButtons = buttons
                    .map((btn) => ({
                        btn,
                        text: getElementText(btn),
                        disabled: Boolean(btn.disabled || btn.getAttribute('aria-disabled') === 'true')
                    }))
                    .filter(({ text }) => isPublishText(text) || isPublishedText(text) || isPublishingText(text));
                const published = publishButtons.find(({ text }) => isPublishedText(text));
                const publishing = publishButtons.find(({ text }) => isPublishingText(text));
                const clickable = publishButtons.find(({ text, disabled }) =>
                    isPublishText(text) && !isPublishedText(text) && !isPublishingText(text) && !disabled
                );
                return {
                    buttons: publishButtons,
                    button: clickable?.btn || null,
                    text: (published || publishing || clickable || publishButtons[0])?.text || '',
                    isPublished: Boolean(published),
                    isPublishing: Boolean(publishing),
                    isDisabled: Boolean((published || publishing || clickable || publishButtons[0])?.disabled),
                    hasClickablePublish: Boolean(clickable)
                };
            }

            function getPublishButtonFromItem(item) {
                return getPublishButtonUiState(item).button;
                const publishRoot = item?.querySelector?.('div[class*="video-list_singlePublish"]') || item;
                const publishButtons = Array.from(publishRoot?.querySelectorAll?.('button') || [])
                    .filter((btn) => btn.offsetParent !== null && !btn.disabled && btn.getAttribute('aria-disabled') !== 'true');
                return publishButtons.find((btn) => getElementText(btn) === '发布') ||
                    publishButtons.find((btn) => getElementText(btn).includes('发布')) ||
                    null;
            }

            function ensureImmediatePublishSelected(item) {
                const publishSetting = Array.from(item?.querySelectorAll?.('[class*="PublishTimeSetting"], [data-testid="beast-core-radio"], label') || [])
                    .find((el) => getElementText(el).includes('立即发布'));
                if (publishSetting && publishSetting.getAttribute('data-checked') === 'false') {
                    safeClick(publishSetting);
                    addLog('[发布] 已选择立即发布', 'info');
                }
            }

            async function confirmCoverForVideo(btn, videoIndex, total, modalWait, preClickWait = 0) {
                addLog(`[等待封面确认] 视频 ${videoIndex + 1}/${total}`, 'info');
                updateStatus(`[封面] ${videoIndex + 1}/${total}`);
                const button = btn.closest?.('button, [role="button"]') || btn;
                if (preClickWait > 0) {
                    addLog(`[封面] 视频 ${videoIndex + 1}/${total} 点击前等待 ${preClickWait}ms`, 'info');
                    await sleep(preClickWait);
                }
                btn.scrollIntoView({ block: 'center', behavior: 'smooth' });
                robustClick(btn);
                if (modalWait > 0) {
                    addLog(`[封面] 视频 ${videoIndex + 1}/${total} 弹窗操作等待 ${modalWait}ms`, 'info');
                    await sleep(modalWait);
                }
                let confirm = await waitForCoverConfirmButton(10000);
                if (!confirm && button !== btn) {
                    robustClick(button);
                    if (modalWait > 0) await sleep(modalWait);
                    confirm = await waitForCoverConfirmButton(10000);
                }
                if (!confirm) {
                    addLog(`[封面] 视频 ${videoIndex + 1} 未找到确认按钮，继续轮询`, 'error');
                    document.body.click();
                    return false;
                }
                robustClick(confirm);
                const confirmed = await waitForCoverConfirmed(btn, 10000);
                if (!confirmed) {
                    addLog(`[封面] 视频 ${videoIndex + 1} 确认超时，继续轮询`, 'error');
                    return false;
                }
                const thumbnailReady = await waitForCoverThumbnailReady(btn, Math.max(15000, modalWait + 10000));
                if (!thumbnailReady) {
                    addLog(`[封面] 视频 ${videoIndex + 1} 缩略图未确认，继续轮询`, 'error');
                    return false;
                }
                btn.dataset.done = 'true';
                if (button && button !== btn) button.dataset.done = 'true';
                coverState.uiConfirmed.add(videoIndex);
                batchLifecycle.coverDoneCount = coverState.uiConfirmed.size;
                addLog(`[封面] 视频 ${videoIndex + 1}/${total} 成功（已确认）`, 'success');
                return true;
            }

            async function taskPubCover() {
                if (!canPublish()) {
                    console.log('COVER_BLOCKED_UPLOAD_NOT_FINISHED');
                    return false;
                }
                assertBatchState('COVER_PROCESSING');
                if (!batchLifecycle.uploadCompleted) {
                    console.log('COVER_BLOCKED_UPLOAD_COMPLETED_FLAG_FALSE');
                    return false;
                }
                if (!document.getElementById('task-chk-cover').checked) return;
                batchLifecycle.coverDoneCount = 0;
                coverState.uiConfirmed.clear();
                const expectedCount = currentBatchExpectedCount;
                const configuredModalWait = getCfg('cfg-modal-wait', 1000);
                const modalWait = Math.max(0, configuredModalWait);
                const coverReadyWait = Math.max(0, getCfg('cfg-cover-ready-wait', 1500));
                const maxCoverScanWait = Math.max(60000, expectedCount * Math.max(modalWait, 1000) * 4);
                const startedAt = Date.now();
                const retryAt = new WeakMap();
                let lastReadyCount = -1;
                addLog(`开始确认封面：等待 ${expectedCount} 个视频可编辑，封面弹窗操作等待 ${modalWait}ms`, 'info');

                while (coverState.uiConfirmed.size < expectedCount && Date.now() - startedAt < maxCoverScanWait) {
                    if (!isRunning) return;
                    await checkPause();
                    const readyBtns = collectCoverEditButtons();
                    if (readyBtns.length !== lastReadyCount) {
                        addLog(`[封面] 已确认 ${coverState.uiConfirmed.size}/${expectedCount}，当前可编辑 ${readyBtns.length} 个`, 'info');
                        lastReadyCount = readyBtns.length;
                    }
                    const now = Date.now();
                    const btn = readyBtns.find((item) => (retryAt.get(item) || 0) <= now);
                    if (!btn) {
                        await sleep(500);
                        continue;
                    }
                    const videoIndex = coverState.uiConfirmed.size;
                    const confirmed = await confirmCoverForVideo(btn, videoIndex, expectedCount, modalWait, coverReadyWait);
                    if (confirmed) {
                        await sleep(300);
                    } else {
                        retryAt.set(btn, Date.now() + 3000);
                    }
                }
                const completed = coverState.uiConfirmed.size >= expectedCount;
                if (!completed) {
                    addLog(`[封面] 等待可编辑封面超时：${coverState.uiConfirmed.size}/${expectedCount}`, 'error');
                }
                return completed;
            }

            async function taskCoverAndPublishReadyVideos() {
                if (!canPublish()) {
                    console.log('COVER_PUBLISH_BLOCKED_UPLOAD_NOT_FINISHED');
                    return false;
                }
                assertBatchState('COVER_PROCESSING');
                const expectedCount = currentBatchExpectedCount;
                const coverEnabled = Boolean(document.getElementById('task-chk-cover')?.checked);
                const publishEnabled = Boolean(document.getElementById('cfg-pub-auto')?.checked);
                const configuredModalWait = getCfg('cfg-modal-wait', 1000);
                const modalWait = Math.max(0, configuredModalWait);
                const coverReadyWait = Math.max(0, getCfg('cfg-cover-ready-wait', 1500));
                const coverPublishWait = Math.max(0, getCfg('cfg-cover-publish-wait', 1500));
                const loopWait = Math.max(0, getCfg('cfg-loop-wait', 1000));
                const startedAt = Date.now();
                const maxPipelineWait = Math.max(600000, expectedCount * 45000);
                const coverRetryAt = new WeakMap();
                let lastSummary = '';

                if (!coverEnabled) {
                    batchLifecycle.coverDoneCount = expectedCount;
                    coverState.uiConfirmed = new Set(Array.from({ length: expectedCount }, (_, index) => index));
                } else {
                    batchLifecycle.coverDoneCount = 0;
                    coverState.uiConfirmed.clear();
                }

                if (!publishEnabled) {
                    batchLifecycle.publishedCount = expectedCount;
                    publishState.successConfirmed = new Set(Array.from({ length: expectedCount }, (_, index) => index));
                    publishState.uiConfirmed = new Set(Array.from({ length: expectedCount }, (_, index) => index));
                }

                addLog(`[封面发布] 逐视频闭环启动：目标 ${expectedCount} 个，封面点击前等待 ${coverReadyWait}ms，封面弹窗操作等待 ${modalWait}ms，封面后发布等待 ${coverPublishWait}ms，发布间隔 ${loopWait}ms`, 'info');

                while ((coverState.uiConfirmed.size < expectedCount || publishState.uiConfirmed.size < expectedCount) &&
                    Date.now() - startedAt < maxPipelineWait) {
                    if (!isRunning) return false;
                    await checkPause();
                    let progressed = false;
                    const videoItems = collectUploadSuccessVideoCards().slice(0, expectedCount);
                    const readyCoverTargets = coverEnabled ? collectReadyCoverTargets(expectedCount) : [];
                    const summary = `上传成功视频=${videoItems.length}/${expectedCount} 可封面=${coverEnabled ? readyCoverTargets.length : expectedCount} 封面=${coverState.uiConfirmed.size}/${expectedCount} 发布=${publishState.uiConfirmed.size}/${expectedCount}`;
                    if (summary !== lastSummary) {
                        addLog(`[封面发布] ${summary}`, 'info');
                        lastSummary = summary;
                    }

                    for (const item of videoItems) {
                        if (!isRunning) return false;
                        await checkPause();

                        if (coverEnabled && item.dataset.pddCoverDone !== 'true') {
                            const coverBtn = getCoverButtonFromItem(item);
                            if (coverBtn && (coverRetryAt.get(coverBtn) || 0) <= Date.now()) {
                                const coverIndex = coverState.uiConfirmed.size;
                                const confirmed = await confirmCoverForVideo(coverBtn, coverIndex, expectedCount, modalWait, coverReadyWait);
                                if (confirmed) {
                                    item.dataset.pddCoverDone = 'true';
                                    item.dataset.pddPublishIndex = String(coverIndex);
                                    progressed = true;
                                    await sleep(300);
                                } else {
                                    coverRetryAt.set(coverBtn, Date.now() + 3000);
                                }
                            }
                        }

                        const coverReadyForPublish = !coverEnabled || item.dataset.pddCoverDone === 'true';
                        const publishIndex = Number.isFinite(Number(item.dataset.pddPublishIndex))
                            ? Number(item.dataset.pddPublishIndex)
                            : publishState.uiConfirmed.size;
                        if (publishEnabled && coverReadyForPublish && item.dataset.pddPublishDone !== 'true' && !publishState.clicked.has(publishIndex)) {
                            const pubBtn = getPublishButtonFromItem(item);
                            if (!pubBtn) continue;
                            if (coverPublishWait > 0 && item.dataset.pddCoverPublishWaitDone !== 'true') {
                                addLog(`[发布] 视频 ${publishIndex + 1}/${expectedCount} 封面确认后等待 ${coverPublishWait}ms`, 'info');
                                item.dataset.pddCoverPublishWaitDone = 'true';
                                await sleep(coverPublishWait);
                            }
                            updateStatus(`正在发布第 ${publishIndex + 1}/${expectedCount} 个`);
                            addLog(`[发布] 视频 ${publishIndex + 1}/${expectedCount} 开始`, 'info');
                            publishState.clicked.add(publishIndex);
                            ensureImmediatePublishSelected(item);
                            clickPublishButtonOnce(pubBtn);
                            const published = await waitForPublishSuccess(item, publishIndex + 1);
                            if (!published) {
                                addLog(`[发布] 视频 ${publishIndex + 1}/${expectedCount} 发布成功未确认`, 'error');
                                return false;
                            }
                            item.dataset.pddPublishDone = 'true';
                            batchLifecycle.publishedCount = publishState.uiConfirmed.size;
                            progressed = true;
                            if (loopWait > 0) {
                                addLog(`[发布] 等待 ${loopWait}ms 后继续下一条`, 'info');
                                await sleep(loopWait);
                            }
                        }
                    }

                    if (!progressed) {
                        await sleep(500);
                    }
                }

                const publishedAuditOk = !publishEnabled || auditAllPublishedItems(expectedCount, '发布结束复核');
                const completed = coverState.uiConfirmed.size >= expectedCount &&
                    publishState.uiConfirmed.size >= expectedCount &&
                    publishedAuditOk;
                if (!completed) {
                    addLog(`[封面发布] 等待超时：封面 ${coverState.uiConfirmed.size}/${expectedCount}，发布 ${publishState.uiConfirmed.size}/${expectedCount}`, 'error');
                }
                return completed;
            }

            async function waitForCoverConfirmButton(timeout = 10000) {
                let confirm = null;
                await waitUntil(() => {
                    confirm = Array.from(document.querySelectorAll('button, .ant-btn-primary'))
                        .find((el) => (el.innerText?.trim() === '确定' || el.innerText?.includes('确认')) &&
                            el.offsetHeight > 0 &&
                            !el.closest(`#${ROOT_ID}`));
                    return Boolean(confirm);
                }, timeout, 300, 'cover_confirm_button');
                return confirm;
            }

            function hasPendingCoverUi() {
                return Array.from(document.querySelectorAll('.ant-modal, .el-dialog, [role="dialog"], [class*="modal"]'))
                    .some((el) => {
                        if (el.closest?.(`#${ROOT_ID}`) || el.offsetParent === null) return false;
                        const text = el.innerText || el.textContent || '';
                        return /封面|编辑封面|确定|确认/.test(text);
                    });
            }

            function getPublishButtonState(expectedCount) {
                const videoItems = Array.from(document.querySelectorAll('div[class*="video-list_singlePublish"]'))
                    .filter((item) => item.offsetParent !== null && !item.closest?.(`#${ROOT_ID}`));
                const items = videoItems.slice(0, expectedCount);
                const readyCount = items.filter((item) => Array.from(item.querySelectorAll('button'))
                    .some((btn) => btn.innerText?.includes('发布') && btn.offsetParent !== null && !btn.disabled)).length;
                return {
                    videoCount: videoItems.length,
                    readyCount,
                    allPublishButtonsConfirmed: items.length >= expectedCount && readyCount >= expectedCount
                };
            }

            function isCoverCompleted(total) {
                return batchLifecycle.coverDoneCount >= total &&
                    coverState.uiConfirmed.size === total &&
                    !hasPendingCoverUi();
            }

            async function waitUntilCoverCompleted(batchId, expectedCount) {
                assertBatchState('COVER_WAITING');
                timerLog('cover_wait_start');
                const coverEnabled = Boolean(document.getElementById('task-chk-cover')?.checked);
                if (!coverEnabled) {
                    batchLifecycle.coverDoneCount = expectedCount;
                    coverState.uiConfirmed = new Set(Array.from({ length: expectedCount }, (_, index) => index));
                }
                const completed = await waitUntil(() => {
                    const coverDoneCount = batchLifecycle.coverDoneCount;
                    const publishButtonState = getPublishButtonState(expectedCount);
                    const pendingCoverUi = hasPendingCoverUi();
                    const allCoverUIConfirmed = coverState.uiConfirmed.size === expectedCount;
                    const publishAlreadyHandled = publishState.clicked.size > 0 || publishState.uiConfirmed.size === expectedCount;
                    const publishButtonsReadyOrHandled = publishButtonState.allPublishButtonsConfirmed || publishAlreadyHandled;
                    const passed = coverDoneCount >= expectedCount &&
                        allCoverUIConfirmed &&
                        publishButtonsReadyOrHandled &&
                        !pendingCoverUi;
                    console.log('COVER_WAIT_STATE', {
                        batchId,
                        coverDoneCount,
                        expectedCount,
                        allCoverUIConfirmed,
                        allPublishButtonsConfirmed: publishButtonsReadyOrHandled,
                        pendingCoverUi
                    });
                    return passed;
                }, 600000, 300, 'cover_wait');
                if (!completed) {
                    logLifecycleChecks(expectedCount, { nextBatchBlocked: true });
                    addLog('[等待封面确认] 超时或中断，禁止发布和进入下一批', 'error');
                    timerLog('cover_wait_done');
                    return false;
                }
                batchLifecycle.coverCompleted = true;
                batchExitGuard.cover = isCoverCompleted(expectedCount);
                logLifecycleChecks(expectedCount, { nextBatchBlocked: true });
                if (!batchExitGuard.cover) {
                    addLog('[批次保持] 封面未全部确认，禁止发布和进入下一批', 'error');
                    timerLog('cover_wait_done');
                    return false;
                }
                addLog('[等待封面确认] 完成', 'success');
                addLog('[封面完成]', 'success');
                timerLog('cover_wait_done');
                return true;
            }

            async function waitForCoverConfirmed(triggerButton, timeout = 10000) {
                const startedAt = Date.now();
                while (Date.now() - startedAt < timeout) {
                    const visibleModal = Array.from(document.querySelectorAll('.ant-modal, .el-dialog, [role="dialog"], [class*="modal"]'))
                        .some((el) => el.offsetParent !== null && !el.closest?.(`#${ROOT_ID}`));
                    if (!visibleModal || triggerButton?.dataset.done === 'true') {
                        return true;
                    }
                    await sleep(300);
                }
                return false;
            }

            function getCoverCardFromTrigger(triggerButton) {
                return triggerButton?.closest?.('div[class*="video-list_detail"]') ||
                    triggerButton?.closest?.('div[class*="video-list_itemWrap"]') ||
                    null;
            }

            function isCoverThumbnailReady(card) {
                if (!card) return false;
                const coverRoot = card.querySelector('[class*="video-list_coverImage"]') || card;
                const images = Array.from(coverRoot.querySelectorAll('img'));
                return images.some((img) => {
                    const src = String(img.getAttribute('src') || '').trim();
                    if (!src || src.startsWith('data:')) return false;
                    const retryStatus = String(img.getAttribute('data-retry-status') || '').toLowerCase();
                    if (retryStatus === 'success') return true;
                    return img.complete && (img.naturalWidth || 0) > 0 && (img.naturalHeight || 0) > 0;
                });
            }

            async function waitForCoverThumbnailReady(triggerButton, timeout = 15000) {
                const startedAt = Date.now();
                while (Date.now() - startedAt < timeout) {
                    const card = getCoverCardFromTrigger(triggerButton);
                    if (isCoverThumbnailReady(card)) return true;
                    await sleep(300);
                }
                return false;
            }

            function getElementText(el) {
                return (el && (el.innerText || el.textContent) || '').trim().replace(/\s+/g, ' ');
            }

            function isVisibleElement(el) {
                if (!el) return false;
                const rect = el.getBoundingClientRect();
                const style = window.getComputedStyle(el);
                return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
            }

            function hasPublishedMask(item) {
                const wrap = getVideoItemWrap(item);
                return Boolean(wrap?.querySelector?.('[class*="video-list_mask"]'));
            }

            function hasRateLimitNotice() {
                const pageText = document.body?.innerText || '';
                return /操作频繁|频繁操作|请稍后|稍后再试|太频繁/.test(pageText);
            }

            function findPublishConfirmButton() {
                const dialogs = Array.from(document.querySelectorAll('[role="dialog"], .ant-modal, .el-dialog, [class*="modal"], [class*="Modal"], [class*="dialog"], [class*="Dialog"], [data-testid*="modal"], [class*="MDL_"]'))
                    .filter((dialog) => isVisibleElement(dialog) && !dialog.closest?.(`#${ROOT_ID}`));
                for (const dialog of dialogs) {
                    const dialogText = getElementText(dialog);
                    if (/操作频繁|频繁操作|请稍后|稍后再试|太频繁/.test(dialogText)) continue;
                    if (!/(确认发布|继续发布|发布确认|提交发布|确认提交|风险提示|审核提示)/.test(dialogText)) continue;
                    const candidates = Array.from(dialog.querySelectorAll('button, [role="button"]'))
                        .filter((btn) => {
                            const text = getElementText(btn);
                            return isVisibleElement(btn) &&
                                /(确认|确定|发布|继续发布|提交|我知道了)/.test(text) &&
                                !/(取消|返回|关闭|暂不)/.test(text) &&
                                !btn.disabled &&
                                btn.getAttribute('aria-disabled') !== 'true';
                        });
                    const primary = candidates.find((btn) => /primary|confirm|submit/i.test(String(btn.className || ''))) || candidates[0];
                    if (primary) return primary;
                }
                return null;
            }

            function clickPublishConfirmIfPresent() {
                const primary = findPublishConfirmButton();
                if (primary) {
                    primary.scrollIntoView({ block: 'center' });
                    robustClick(primary);
                    return getElementText(primary) || '确认';
                }
                return '';
                const dialogs = Array.from(document.querySelectorAll('[role="dialog"], .ant-modal, .el-dialog, [class*="modal"], [class*="Modal"], [class*="dialog"], [class*="Dialog"], [data-testid*="modal"], [class*="MDL_"]'))
                    .filter((dialog) => isVisibleElement(dialog) && !dialog.closest?.(`#${ROOT_ID}`));
                for (const dialog of dialogs) {
                    const dialogText = getElementText(dialog);
                    if (!/(确认|确定|提交|发布|审核|风险|提示)/.test(dialogText)) continue;
                    const candidates = Array.from(dialog.querySelectorAll('button, [role="button"]'))
                        .filter((btn) => {
                            const text = getElementText(btn);
                            return isVisibleElement(btn) &&
                                /(确认|确定|发布|继续发布|提交|我知道了)/.test(text) &&
                                !/(取消|返回|关闭|暂不)/.test(text) &&
                                !btn.disabled &&
                                btn.getAttribute('aria-disabled') !== 'true';
                        });
                    const primary = candidates.find((btn) => /primary|confirm|submit/i.test(String(btn.className || ''))) || candidates[0];
                    if (primary) {
                        primary.scrollIntoView({ block: 'center' });
                        robustClick(primary);
                        return getElementText(primary) || '确认';
                    }
                }
                return '';
            }

            function getPublishSuccessSnapshot(item) {
                {
                const itemText = item?.innerText || '';
                const pageText = document.body?.innerText || '';
                const loading = getVisibleUploadLoadingNodes().length;
                const buttonState = getPublishButtonUiState(item);
                const itemGone = Boolean(item && !document.body.contains(item));
                const noPendingUI = !hasPendingUiState();
                const maskPublished = hasPublishedMask(item);
                const cardPublished = maskPublished || buttonState.isPublished;
                const hasSuccessText = /发布成功|已发布|提交成功|审核中|发布完成|鍙戝竷鎴愬姛|宸插彂甯/.test(itemText);
                const hasGlobalSuccessText = /发布成功|提交成功|已发布|审核中|发布完成|视频审核通过后可获得短视频流量卡|鍙戝竷鎴愬姛|宸插彂甯/.test(pageText);
                const rateLimited = hasRateLimitNotice();
                const explicitSuccess = cardPublished || hasSuccessText || (itemGone && hasGlobalSuccessText);
                return {
                    hasSuccessText,
                    hasGlobalSuccessText,
                    publishButtonVisible: buttonState.hasClickablePublish,
                    publishButtonDisabled: buttonState.isDisabled,
                    publishButtonText: buttonState.text,
                    publishButtonPublished: buttonState.isPublished,
                    publishButtonPublishing: buttonState.isPublishing,
                    maskPublished,
                    cardPublished,
                    itemGone,
                    explicitSuccess,
                    rateLimited,
                    loading,
                    noPendingUI,
                    uiStable: cardPublished || (hasSuccessText && noPendingUI && loading === 0 && !buttonState.isPublishing)
                };
                }
                const itemText = item?.innerText || '';
                const pageText = document.body?.innerText || '';
                const loading = getVisibleUploadLoadingNodes().length;
                const hasSuccessText = /发布成功|已发布|提交成功|审核中|审核|发布完成/.test(itemText);
                const hasGlobalSuccessText = /发布成功|提交成功|已发布|审核中|发布完成/.test(pageText);
                const pubBtn = getPublishButtonFromItem(item);
                const publishButtonVisible = Boolean(pubBtn);
                const publishButtonDisabled = Boolean(pubBtn && (pubBtn.disabled || pubBtn.getAttribute('aria-disabled') === 'true'));
                const itemGone = !document.body.contains(item);
                const noPendingUI = !hasPendingUiState();
                const explicitSuccess = hasSuccessText || hasGlobalSuccessText;
                return {
                    hasSuccessText,
                    hasGlobalSuccessText,
                    publishButtonVisible,
                    publishButtonDisabled,
                    itemGone,
                    explicitSuccess,
                    loading,
                    noPendingUI,
                    uiStable: explicitSuccess && noPendingUI && loading === 0
                };
            }

            async function waitPublishConfirm(item, videoIndex, total, timeout = 30000) {
                let successConfirmed = false;
                let uiConfirmed = false;
                let confirmDialogClicked = false;
                addLog(`[等待发布] 视频 ${videoIndex + 1}/${total}`, 'info');
                await waitUntil(() => {
                    const confirmClicked = confirmDialogClicked ? '' : clickPublishConfirmIfPresent();
                    if (confirmClicked && !confirmDialogClicked) {
                        confirmDialogClicked = true;
                        addLog(`[发布] 视频 ${videoIndex + 1}/${total} 已点击确认弹窗：${confirmClicked}`, 'info');
                    }
                    const snapshot = getPublishSuccessSnapshot(item);
                    if (snapshot.rateLimited) {
                        addLog(`[发布] 视频 ${videoIndex + 1}/${total} 检测到操作频繁，停止等待并阻断`, 'error');
                        return true;
                    }
                    if (snapshot.explicitSuccess) {
                        successConfirmed = true;
                        publishState.successConfirmed.add(videoIndex);
                    }
                    if (successConfirmed && snapshot.uiStable) {
                        uiConfirmed = true;
                        publishState.uiConfirmed.add(videoIndex);
                    }
                    console.log('PUBLISH_CONFIRM_STATE', {
                        videoIndex: videoIndex + 1,
                        total,
                        successConfirmed,
                        uiConfirmed,
                        ...snapshot
                    });
                    return successConfirmed && uiConfirmed;
                }, timeout, 300, `publish_confirm_${videoIndex + 1}`);

                if (!successConfirmed || !uiConfirmed) {
                    addLog(`[发布] 视频 ${videoIndex + 1}/${total} 发布成功未确认`, 'error');
                    console.log('PUBLISH_CONFIRM_FAILED', {
                        videoIndex: videoIndex + 1,
                        total,
                        successConfirmed,
                        uiConfirmed
                    });
                    return false;
                }
                addLog(`[发布] 视频 ${videoIndex + 1}/${total} 成功（已确认）`, 'success');
                return true;
            }

            async function waitForPublishSuccess(item, index, timeout = 30000) {
                return waitPublishConfirm(item, index - 1, currentBatchExpectedCount, timeout);
            }

            function getItemPublishIndex(item, fallbackIndex) {
                const datasetIndex = Number(item?.dataset?.pddPublishIndex);
                return Number.isFinite(datasetIndex) ? datasetIndex : fallbackIndex;
            }

            function refreshPublishedStateFromDom(expectedCount) {
                const items = collectUploadSuccessVideoCards().slice(0, expectedCount);
                const missing = [];
                let publishedCount = 0;
                items.forEach((item, fallbackIndex) => {
                    const publishIndex = getItemPublishIndex(item, fallbackIndex);
                    const snapshot = getPublishSuccessSnapshot(item);
                    if (snapshot.cardPublished || snapshot.uiStable) {
                        publishState.successConfirmed.add(publishIndex);
                        publishState.uiConfirmed.add(publishIndex);
                        item.dataset.pddPublishDone = 'true';
                        publishedCount += 1;
                    } else {
                        missing.push(publishIndex + 1);
                    }
                });
                batchLifecycle.publishedCount = publishState.uiConfirmed.size;
                return {
                    itemsCount: items.length,
                    publishedCount,
                    missing
                };
            }

            function auditAllPublishedItems(expectedCount, label = '发布复核') {
                const audit = refreshPublishedStateFromDom(expectedCount);
                addLog(`[${label}] 已发布状态 ${audit.publishedCount}/${expectedCount}`, audit.publishedCount >= expectedCount ? 'success' : 'error');
                if (audit.itemsCount < expectedCount) {
                    addLog(`[${label}] 页面可见上传成功视频不足：${audit.itemsCount}/${expectedCount}`, 'error');
                    return false;
                }
                if (audit.missing.length) {
                    addLog(`[${label}] 未确认已发布的视频：${audit.missing.join(', ')}`, 'error');
                    return false;
                }
                return true;
            }

            function isPublishCompleted(total) {
                return publishState.successConfirmed.size === total && publishState.uiConfirmed.size === total;
            }

            function logPublishChecks(total) {
                const publishCompleted = isPublishCompleted(total);
                const exitBlocked = !publishCompleted || !batchExitGuard.publish;
                console.log('[CHECK] publishCount', `${batchLifecycle.publishedCount}/${total}`);
                console.log('[CHECK] publishSuccessCount', publishState.successConfirmed.size);
                console.log('[CHECK] exitBlocked', exitBlocked);
                console.log('[CHECK] batchExitGuard.publish', batchExitGuard.publish);
                addLog(`[CHECK] publishCount=${batchLifecycle.publishedCount}/${total}`, 'info');
                addLog(`[CHECK] publishSuccessCount=${publishState.successConfirmed.size}`, 'info');
                addLog(`[CHECK] publishUiConfirmedCount=${publishState.uiConfirmed.size}`, 'info');
                addLog(`[CHECK] exitBlocked=${exitBlocked}`, exitBlocked ? 'error' : 'success');
                addLog(`[CHECK] batchExitGuard.publish=${batchExitGuard.publish}`, batchExitGuard.publish ? 'success' : 'error');
                addLog(`[检查] 发布计数=${batchLifecycle.publishedCount}/${total}`, 'info');
                addLog(`[检查] 发布成功确认=${publishState.successConfirmed.size}`, 'info');
                addLog(`[检查] 退出阻断=${exitBlocked}`, exitBlocked ? 'error' : 'success');
                addLog(`[检查] 发布退出锁=${batchExitGuard.publish}`, batchExitGuard.publish ? 'success' : 'error');
                return {
                    publishCompleted,
                    exitBlocked
                };
            }

            async function waitUntilPublishCompleted(batchId, expectedCount) {
                assertBatchState('PUBLISH_WAITING');
                timerLog('publish_wait_start');
                const publishEnabled = Boolean(document.getElementById('cfg-pub-auto')?.checked);
                if (!publishEnabled) {
                    batchLifecycle.publishedCount = expectedCount;
                    publishState.successConfirmed = new Set(Array.from({ length: expectedCount }, (_, index) => index));
                    publishState.uiConfirmed = new Set(Array.from({ length: expectedCount }, (_, index) => index));
                }
                let lastWaitingIndex = null;
                const completed = await waitUntil(() => {
                    const noPendingUI = !hasPendingUiState();
                    const publishCompleted = isPublishCompleted(expectedCount);
                    const waitingIndex = Math.min(batchLifecycle.publishedCount + 1, expectedCount);
                    if (!publishCompleted && waitingIndex !== lastWaitingIndex) {
                        lastWaitingIndex = waitingIndex;
                        addLog(`[等待发布] 视频 ${waitingIndex}/${expectedCount}`, 'info');
                    }
                    console.log('PUBLISH_WAIT_STATE', {
                        batchId,
                        publishedCount: batchLifecycle.publishedCount,
                        publishSuccessCount: publishState.successConfirmed.size,
                        publishUiConfirmedCount: publishState.uiConfirmed.size,
                        expectedCount,
                        publishCompleted,
                        noPendingUI
                    });
                    return publishCompleted && noPendingUI;
                }, 600000, 300, 'publish_wait');
                if (!completed) {
                    logPublishChecks(expectedCount);
                    logLifecycleChecks(expectedCount, { nextBatchBlocked: true });
                    addLog('[等待发布确认] 超时或中断，禁止进入下一批', 'error');
                    timerLog('publish_wait_done');
                    return false;
                }
                if (publishEnabled && !auditAllPublishedItems(expectedCount, '发布完成复核')) {
                    logPublishChecks(expectedCount);
                    logLifecycleChecks(expectedCount, { nextBatchBlocked: true });
                    addLog('[发布完成复核] 仍有视频未显示已发布，禁止结束流程', 'error');
                    timerLog('publish_wait_done');
                    return false;
                }
                batchLifecycle.publishCompleted = true;
                batchExitGuard.publish = isPublishCompleted(expectedCount);
                logPublishChecks(expectedCount);
                logLifecycleChecks(expectedCount, { nextBatchBlocked: !batchExitGuard.publish });
                if (!batchExitGuard.publish) {
                    addLog('[批次保持] 发布未全部完成，禁止进入下一批', 'error');
                    timerLog('publish_wait_done');
                    return false;
                }
                transitionBatchState('PUBLISHED', {
                    publishedCount: batchLifecycle.publishedCount,
                    expectedCount
                });
                addLog('[等待发布] 完成', 'success');
                addLog('[发布完成]', 'success');
                timerLog('publish_wait_done');
                return true;
            }

            function hasPendingUiState() {
                const pendingUpload = getVisibleUploadLoadingNodes().length > 0 || getUploadQueueState() !== 0;
                const visibleDialog = Array.from(document.querySelectorAll('.ant-modal, .el-dialog, [role="dialog"], [class*="modal"]'))
                    .some((el) => el.offsetParent !== null && !el.closest?.(`#${ROOT_ID}`));
                return pendingUpload || visibleDialog;
            }

            async function waitForNoPendingUiState(timeout = 15000) {
                const startedAt = Date.now();
                while (Date.now() - startedAt < timeout) {
                    if (!hasPendingUiState()) return true;
                    await sleep(400);
                }
                return false;
            }

            async function completeBatchIfReady() {
                assertBatchState('PUBLISHED');
                timerLog('batch_exit_check');
                const noPendingUI = await waitForNoPendingUiState();
                const coverCompleted = isCoverCompleted(currentBatchExpectedCount);
                const publishCompleted = isPublishCompleted(currentBatchExpectedCount);
                batchLifecycle.coverCompleted = coverCompleted;
                batchLifecycle.publishCompleted = publishCompleted;
                batchExitGuard.cover = coverCompleted;
                batchExitGuard.publish = publishCompleted;
                const lifecycleClosed = Boolean(
                    batchLifecycle.uploadCompleted &&
                    batchLifecycle.consistencyPassed &&
                    coverCompleted &&
                    publishCompleted
                );
                const allVideosPublished = publishCompleted;
                const exitGuardReady = batchExitGuard.upload && batchExitGuard.cover && batchExitGuard.publish;
                const completed = lifecycleClosed && allVideosPublished && noPendingUI && batchLifecycle.state === 'PUBLISHED' && exitGuardReady;
                logPublishChecks(currentBatchExpectedCount);
                logLifecycleChecks(currentBatchExpectedCount, { nextBatchBlocked: !completed });
                console.log('BATCH_COMPLETE_GUARD', {
                    uploadCompleted: batchLifecycle.uploadCompleted,
                    bindingIntegrityOK: batchLifecycle.consistencyPassed,
                    coverCompleted,
                    publishCompleted,
                    allVideosPublished,
                    noPendingUI,
                    state: batchLifecycle.state,
                    publishedCount: batchLifecycle.publishedCount,
                    expectedCount: currentBatchExpectedCount,
                    batchExitGuard: { ...batchExitGuard }
                });
                if (!completed) {
                    batchLifecycle.state = 'BATCH_BLOCKED';
                    console.log('BATCH_STATE', {
                        batchId: batchLifecycle.batchId,
                        state: 'BATCH_BLOCKED',
                        batchExitGuard: { ...batchExitGuard }
                    });
                    addLog('[批次保持] 上传/校验/封面/发布未全部闭环，禁止进入下一批', 'error');
                    addLog('[批次完成] 已阻断：封面/发布/UI 或一致性仍未完成', 'error');
                    return false;
                }
                transitionBatchState('BATCH_DONE', {
                    publishedCount: batchLifecycle.publishedCount,
                    expectedCount: currentBatchExpectedCount
                });
                addLog('[队列] 全部视频发布完成后批次完成', 'success');
                return true;
            }

            async function taskIndividualPublish() {
                if (!canPublish()) {
                    console.log('PUBLISH_BLOCKED_UPLOAD_IN_PROGRESS');
                    return false;
                }
                assertBatchState('PUBLISHING');
                const videoItems = Array.from(document.querySelectorAll('div[class*="video-list_singlePublish"]'));
                if (videoItems.length === 0) {
                    addLog('未检测到待发布的视频项', 'error');
                    return false;
                }
                addLog(`检测到 ${videoItems.length} 个视频，开始逐一发布`, 'info');
                const loopWait = Math.max(0, getCfg('cfg-loop-wait', 1000));
                for (let i = 0; i < videoItems.length; i++) {
                    if (!isRunning) return false;
                    await checkPause();
                    const item = videoItems[i];
                    item.scrollIntoView({ behavior: 'smooth', block: 'center' });
                    const publishButtons = Array.from(item.querySelectorAll('button'))
                        .filter((btn) => btn.offsetParent !== null && !btn.disabled && btn.getAttribute('aria-disabled') !== 'true');
                    const pubBtn = publishButtons.find((btn) => getElementText(btn) === '发布') ||
                        publishButtons.find((btn) => getElementText(btn).includes('发布'));
                    if (pubBtn) {
                        updateStatus(`正在发布第 ${i + 1}/${videoItems.length} 个`);
                        addLog(`[发布] 视频 ${i + 1}/${videoItems.length} 开始`, 'info');
                        publishState.clicked.add(i);
                        ensureImmediatePublishSelected(item);
                        clickPublishButtonOnce(pubBtn);
                        const published = await waitForPublishSuccess(item, i + 1);
                        if (!published) {
                            addLog(`[发布] 视频 ${i + 1}/${videoItems.length} 发布成功未确认`, 'error');
                            return false;
                        }
                        batchLifecycle.publishedCount = i + 1;
                        if (i < videoItems.length - 1 && loopWait > 0) {
                            addLog(`[发布] 等待 ${loopWait}ms 后继续下一条`, 'info');
                            await sleep(loopWait);
                        }
                    } else {
                        addLog(`[发布] 视频 ${i + 1}/${videoItems.length} 未找到发布按钮`, 'error');
                        return false;
                    }
                }
                return true;
            }

            document.getElementById('video-workbench-start').onclick = async function () {
                if (START_LOCK) {
                    addLog('[START_LOCK] 启动流程已在执行，忽略重复触发', 'info');
                    return;
                }
                const tasks = ['task-chk-id', 'task-chk-title', 'task-chk-declare', 'task-chk-cover'];
                if (!tasks.some((task) => document.getElementById(task).checked)) return alert('请至少勾选一个任务！');
                resetStartupPerf();
                timerMark('bootstrap_start');
                timerStart('bootstrap');
                isRunning = true;
                isPaused = false;
                this.disabled = true;
                setControlsVisible(true);
                resetPauseButton();
                timerEnd('bootstrap', 'bootstrap');
                timerMark('init_complete');
                const domReady = await waitForStartDomReady();
                if (!domReady) {
                    addLog('[TIMER] dom_ready timeout，启动终止', 'error');
                    isRunning = false;
                    isPaused = false;
                    this.disabled = false;
                    setControlsVisible(true);
                    resetPauseButton();
                    return;
                }
                START_LOCK = true;

                const id = document.getElementById('pub-id').value.trim();
                const title = document.getElementById('pub-title').value;
                const memory = JSON.parse(localStorage.getItem(MEMORY_KEY) || '{}');
                if (id) {
                    memory[id] = title;
                    localStorage.setItem(MEMORY_KEY, JSON.stringify(memory));
                }

                let flowSucceeded = false;
                let uploadPhaseResult = null;
                moduleApi.lastRunResult = null;
                try {
                    uploadAttemptState.delete(id);
                    uploadPhaseResult = await uploadInjectionStep();
                    flowSucceeded = Boolean(uploadPhaseResult?.accepted);

                    if (!uploadPhaseResult?.handledWorkflow) {
                        addLog('[流程] 上传流程未进入受控批次状态机，已阻断', 'error');
                    }
                } catch (error) {
                    console.error('VIDEO_WORKBENCH_FLOW_ERROR', error);
                    uploadPhaseResult = {
                        accepted: false,
                        reason: error?.message || String(error),
                        handledWorkflow: true
                    };
                    addLog(`[流程] 执行失败：${error?.message || error}`, 'error');
                } finally {
                    const finalSummary = uploadPhaseResult?.summary || activeRunSummary || null;
                    if (finalSummary) {
                        logRunSummary(
                            finalSummary,
                            flowSucceeded,
                            uploadPhaseResult?.reason || (flowSucceeded ? 'completed' : 'unknown-failure')
                        );
                    }
                    moduleApi.lastRunResult = {
                        accepted: flowSucceeded,
                        reason: uploadPhaseResult?.reason || (flowSucceeded ? 'completed' : 'unknown-failure'),
                        handledWorkflow: Boolean(uploadPhaseResult?.handledWorkflow),
                        at: Date.now(),
                        summary: finalSummary
                    };
                    activeRunSummary = null;
                    isRunning = false;
                    isPaused = false;
                    START_LOCK = false;
                    this.disabled = false;
                    uploadAttemptState.delete(id);
                    setControlsVisible(true);
                    resetPauseButton();
                    updateStatus(flowSucceeded ? '流程执行完毕' : '流程执行失败');
                    addLog(flowSucceeded ? '单商品执行完成' : '单商品执行失败', flowSucceeded ? 'success' : 'error');
                }
            };

            document.getElementById('video-workbench-pause').onclick = function () {
                if (!isRunning) return;
                isPaused = !isPaused;
                this.textContent = isPaused ? '继续' : '暂停';
                this.style.background = isPaused ? '#27ae60' : '#f1c40f';
            };

            document.getElementById('video-workbench-stop').onclick = () => {
                if (!isRunning) return;
                if (confirm('确定要终止流程吗？')) {
                    isRunning = false;
                    isPaused = false;
                    uploadAttemptState.delete(document.getElementById('pub-id')?.value.trim());
                    resetPauseButton();
                    addLog('用户手动终止', 'error');
                    updateStatus('已终止');
                }
            };

            const bindToggle = (labelId, contentId, arrowId) => {
                const label = document.getElementById(labelId);
                if (!label) return;
                label.onclick = () => {
                    const content = document.getElementById(contentId);
                    const isCollapsedNow = content.classList.toggle('collapsed');
                    document.getElementById(arrowId).textContent = isCollapsedNow ? '▼' : '▲';
                };
            };
            bindToggle('label-delay-config', 'content-delay-config', 'arrow-delay-config');
            bindToggle('label-declare-config', 'content-declare-config', 'arrow-declare-config');
            bindToggle('label-manual-delay-config', 'content-manual-delay-config', 'arrow-manual-delay-config');
            bindToggle('label-manual-declare-config', 'content-manual-declare-config', 'arrow-manual-declare-config');
            bindToggle('video-workbench-perf-toggle', 'video-workbench-perf-body', 'video-workbench-perf-arrow');
            bindDelayConfigPersistence();
            bindManualConfigBridge();

            document.getElementById('video-workbench-log-toggle').onclick = () => {
                const body = document.getElementById('video-workbench-log-list');
                const isHidden = body.style.display === 'none';
                body.style.display = isHidden ? 'block' : 'none';
                document.getElementById('video-workbench-log-arrow').textContent = isHidden ? '▲' : '▼';
            };
            document.getElementById('video-workbench-copy-logs')?.addEventListener('click', copyExecutionLogs);
            document.getElementById('video-workbench-clear-logs')?.addEventListener('click', clearExecutionLogs);

            document.getElementById('pub-id').oninput = (e) => {
                const memory = JSON.parse(localStorage.getItem(MEMORY_KEY) || '{}');
                const val = e.target.value.trim();
                if (memory[val]) {
                    document.getElementById('pub-title').value = memory[val];
                    addLog('匹配到历史标题', 'info');
                }
            };

            document.getElementById('video-workbench-manual-start')?.addEventListener('click', function () {
                runManualExistingVideoFlow(this);
            });

            const closeVideoWorkbench = () => {
                panel.style.display = 'none';
            };

            const closeButton = document.getElementById('video-workbench-close');
            closeButton.addEventListener('mousedown', (event) => {
                event.stopPropagation();
            });
            closeButton.addEventListener('click', (event) => {
                event.preventDefault();
                event.stopPropagation();
                closeVideoWorkbench();
            });

            let isDraggingPanel = false;
            let ox;
            let oy;
            panel.querySelector('.ws-header').onmousedown = (e) => {
                if (e.target.closest('#video-workbench-close')) return;
                isDraggingPanel = true;
                ox = e.clientX - panel.offsetLeft;
                oy = e.clientY - panel.offsetTop;
                document.onmousemove = (ev) => {
                    if (isDraggingPanel) {
                        panel.style.left = `${ev.clientX - ox}px`;
                        panel.style.top = `${ev.clientY - oy}px`;
                        panel.style.right = 'auto';
                    }
                };
                document.onmouseup = () => {
                    isDraggingPanel = false;
                };
            };
        },
        show() {
            const panel = this.panelEl || document.getElementById(ROOT_ID);
            if (!panel) return;
            this.panelEl = panel;
            panel.style.display = 'flex';
            panel.style.zIndex = '2147483645';
            window.PddModules?.productConfigManager?.syncUi?.();
        },
        hide() {
            const panel = this.panelEl || document.getElementById(ROOT_ID);
            if (!panel) return;
            this.panelEl = panel;
            panel.style.display = 'none';
        }
    };
})();
