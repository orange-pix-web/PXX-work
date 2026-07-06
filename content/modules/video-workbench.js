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
            let currentPhase = 'UPLOAD_PHASE';
            let uploadFinished = false;
            let publishLocked = true;
            let currentUploadCompletePromise = null;
            let currentBatchExpectedCount = 0;
            const uploadAttemptState = new Map();
            const MEMORY_KEY = 'pdd_video_helper_memory';
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
                'PUBLISHING',
                'PUBLISHED',
                'BATCH_DONE'
            ];
            const batchLifecycle = {
                batchId: null,
                state: 'INIT',
                uploadCompleted: false,
                coverCompleted: false,
                consistencyPassed: false,
                publishedCount: 0,
                expectedCount: 0,
                processedFileKeys: new Set()
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

            const getCfg = (id, defaultVal) => {
                const el = document.getElementById(id);
                if (!el) return defaultVal;
                if (el.type === 'checkbox') return el.checked;
                const val = parseInt(el.value, 10);
                return Number.isNaN(val) ? defaultVal : val;
            };

            const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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

                batchLifecycle.state = nextState;
                console.log('BATCH_STATE', {
                    batchId: batchLifecycle.batchId,
                    state: nextState,
                    ...data
                });
                addLog(`[STATE] ${nextState}`, 'info');
                return nextState;
            }

            function resetBatchLifecycle(batchId, expectedCount = 0) {
                batchLifecycle.batchId = batchId;
                batchLifecycle.state = 'INIT';
                batchLifecycle.uploadCompleted = false;
                batchLifecycle.coverCompleted = false;
                batchLifecycle.consistencyPassed = false;
                batchLifecycle.publishedCount = 0;
                batchLifecycle.expectedCount = expectedCount;
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
                el.addEventListener('click', (event) => {
                    event.stopPropagation();
                }, { once: true });
                el.dispatchEvent(new MouseEvent('click', {
                    bubbles: true,
                    cancelable: true,
                    view: window
                }));
                return true;
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

                if (logList.children.length > 80) {
                    logList.removeChild(logList.lastChild);
                }

                const now = new Date();
                const time = `${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}:${now.getSeconds().toString().padStart(2, '0')}`;

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
                messageSpan.textContent = normalizeExecutionLogMessage(msg);

                item.appendChild(timeSpan);
                item.appendChild(messageSpan);
                logList.prepend(item);
                logList.scrollTop = 0;
                updateLogStatusCard({ logText: msg });
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
                    return raw.find((item) => String(item?.productId || '').trim() === productId) || null;
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

            function splitIntoBatches(files, config) {
                const maxCount = Math.max(1, parseInt(config?.maxCount, 10) || 20);
                const maxSizeBytes = getBatchLimitBytes(config);
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
                transitionBatchState('SCANNING_FILES', {
                    productId,
                    force
                });
                const resolved = await window.PddModules?.productConfigManager?.getResolvedVideoFiles?.(productId, {
                    config,
                    forceFreshScan: force,
                    batchId: options.batchId || batchLifecycle.batchId
                });
                if (!resolved) {
                    addLog('[SCAN] fresh scan failed: no resolver result', 'error');
                    return null;
                }

                const freshFiles = filterDuplicateFiles(resolved.files || [], batchLifecycle.processedFileKeys);
                const freshSize = freshFiles.reduce((sum, file) => sum + Number(file?.size || 0), 0);
                addLog('[SCAN] fresh scan executed', 'info');
                addLog(`[SCAN] fileCount=${freshFiles.length} size=${formatMb(freshSize)}MB`, freshFiles.length ? 'info' : 'error');
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

            async function waitForUploadNode({ timeout = 5000, interval = 200 } = {}) {
                const startedAt = Date.now();
                while (Date.now() - startedAt <= timeout) {
                    const targets = findUploadTargets();
                    if (targets.inputs.length || targets.dropZones.length) {
                        return targets;
                    }
                    await sleep(interval);
                }
                return { inputs: [], dropZones: [] };
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
                const startedAt = Date.now();
                while (Date.now() - startedAt <= timeout) {
                    const videoItems = Array.from(document.querySelectorAll('div[class*="video-list_singlePublish"]'));
                    if (videoItems.length > 0) {
                        return {
                            accepted: true,
                            matchedCount: videoItems.length,
                            source: 'video-list'
                        };
                    }

                    const visibleFileInputs = Array.from(document.querySelectorAll('input[type="file"]')).filter((input) => {
                        return !input.closest?.(`#${ROOT_ID}`) && Number(input.files?.length || 0) >= expectedFilesCount;
                    });
                    if (visibleFileInputs.length > 0) {
                        return {
                            accepted: true,
                            matchedCount: visibleFileInputs[0].files.length,
                            source: 'input-files'
                        };
                    }

                    await sleep(interval);
                }

                return {
                    accepted: false,
                    matchedCount: 0,
                    source: 'timeout'
                };
            }

            async function confirmUploadSuccess(expectedFilesCount) {
                return waitForUploadAcceptance(expectedFilesCount);
            }

            async function waitForUploadCompletionStable(expectedFilesCount, settleMs = 1200) {
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

            async function waitForUploadComplete(expectedCount, timeout = 10 * 60 * 1000) {
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

                        if (stable >= 5) {
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

                        setTimeout(check, 800);
                    };

                    check();
                });
            }

            async function waitForUploadCompletionStableV2(expectedCount) {
                return waitForUploadComplete(expectedCount);
            }

            async function waitUntilUploadCompleted(batchId, expectedCount) {
                assertBatchState('UPLOAD_IN_PROGRESS');
                console.log('WAIT_UPLOAD_COMPLETED_START', {
                    batchId,
                    expectedCount
                });
                if (currentUploadCompletePromise) {
                    const uploadStable = await currentUploadCompletePromise;
                    if (!uploadStable) return false;
                }
                const uiReady = await waitForPageStableAfterUpload(expectedCount, 30000, 300, 1600);
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
                    addLog('[UPLOAD_COMPLETED] not confirmed, blocked next phase', 'error');
                    return false;
                }
                uploadFinished = true;
                publishLocked = false;
                batchLifecycle.uploadCompleted = true;
                transitionBatchState('UPLOAD_COMPLETED', {
                    batchId,
                    expectedCount
                });
                addLog('[UPLOAD_COMPLETED] confirmed', 'success');
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

            async function waitForPageStableAfterUpload(expectedFilesCount, timeout = 15000, interval = 250, stableWindow = 1500) {
                resetPageStableState();
                const startedAt = Date.now();
                let stableSignature = '';

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

                    await sleep(interval);
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

                const uploadTargets = await waitForUploadNode({ timeout: 5000, interval: 200 });
                if (!uploadTargets.inputs.length && !uploadTargets.dropZones.length) {
                    addLog('等待上传节点超时：未命中 input / iframe / shadow / dropzone', 'error');
                    return false;
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
                                return true;
                            }
                        }
                    } catch (error) {
                        addLog(`上传控件注入失败：${error?.message || error}`, 'error');
                    }
                }

                addLog('未找到可用的上传控件或拖拽区域', 'error');
                emitUploadSuccessCheck(files.length, false, 'none');
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
                const items = Array.from(document.querySelectorAll('li'));
                const target = items.find((el) => el.innerText?.trim().includes(name) && el.offsetParent !== null);
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
                const btn = document.querySelector("button[data-testid='beast-core-button']");
                if (btn && btn.offsetParent !== null) {
                    safeClick(btn);
                    console.log('PUBLISH_CLICKED_BUTTON');
                    console.log('PUBLISH_CLICK_STATUS', 'button');
                    return true;
                }

                const clicked = await clickSidebar('发布视频');
                console.log('PUBLISH_CLICK_STATUS', clicked ? 'fallback-sidebar' : 'failed');
                return clicked;
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

                    if (hasAddProduct || hasPublishVideo || hasVisibleFileInput) {
                        return true;
                    }

                    await sleep(400);
                }

                console.log('PAGE_READY_TIMEOUT');
                return false;
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
                    await closeAllPopups();
                    const sidebarHome = await clickSidebar('商家首页');
                    await sleep(1200);
                    const sidebarPublish = await clickPublishVideo();
                    await waitForPageReady();
                    console.log('CLICK_VERIFY', {
                        sidebar_home: sidebarHome,
                        sidebar_publish: sidebarPublish
                    });
                    console.log('BATCH_NAVIGATION_DONE');
                    return {
                        sidebar_home: sidebarHome,
                        sidebar_publish: sidebarPublish
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
                    addLog(`[TITLE] incomplete ${videoBindingState.title.done.size}/${currentBatchExpectedCount}`, 'error');
                    return false;
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
                    addLog(`[ID] incomplete ${videoBindingState.id.done.size}/${currentBatchExpectedCount}`, 'error');
                    return false;
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
                    addLog(`[STATEMENT] incomplete ${videoBindingState.statement.done.size}/${currentBatchExpectedCount}`, 'error');
                    return false;
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
                await waitForPageStableAfterUpload(currentBatchExpectedCount, 30000, 300, 1200);
                setPhase('PUBLISH_PHASE');
                transitionBatchState('COVER_PROCESSING', {
                    expectedCount: currentBatchExpectedCount
                });
                if (document.getElementById('task-chk-cover').checked) {
                    const coverReady = await taskPubCover();
                    if (!coverReady) return false;
                }
                batchLifecycle.coverCompleted = true;
                transitionBatchState('PUBLISHING', {
                    expectedCount: currentBatchExpectedCount
                });
                if (document.getElementById('cfg-pub-auto').checked) {
                    const publishReady = await taskIndividualPublish();
                    if (!publishReady) return false;
                }
                transitionBatchState('PUBLISHED', {
                    publishedCount: batchLifecycle.publishedCount,
                    expectedCount: currentBatchExpectedCount
                });
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
                batchLifecycle.processedFileKeys = new Set();
                let totalBatches = 0;
                let uploadedBatches = 0;

                for (let i = 0; ; i++) {
                    const batchId = `${productId || 'batch'}-${Date.now()}-${i + 1}`;
                    resetBatchLifecycle(batchId);
                    console.log('BATCH_START', i);
                    const scanned = await scanFolderFiles(productId, config, {
                        force: true,
                        batchId
                    });
                    if (!scanned?.files?.length) {
                        if (i === 0) {
                            return {
                                accepted: false,
                                totalBatches: 0,
                                uploadedBatches: 0,
                                maxCount,
                                handledWorkflow: true
                            };
                        }
                        break;
                    }

                    const splitResult = splitIntoBatches(scanned.files, config);
                    transitionBatchState('BATCH_SPLIT', {
                        fileCount: scanned.files.length,
                        batchCount: splitResult.batches.length
                    });
                    if (i === 0) {
                        totalBatches = splitResult.batches.length;
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
                        return {
                            accepted: false,
                            failedBatchIndex: i,
                            totalBatches,
                            uploadedBatches: i,
                            maxCount,
                            handledWorkflow: true
                        };
                    }

                    assertPhase('FILL_PHASE');
                    const fillReady = await runFillPhase();
                    if (!fillReady) {
                        return {
                            accepted: false,
                            failedBatchIndex: i,
                            totalBatches,
                            uploadedBatches: i,
                            maxCount,
                            handledWorkflow: true
                        };
                    }
                    const publishReady = await runPublishPhase();
                    if (!publishReady) {
                        return {
                            accepted: false,
                            failedBatchIndex: i,
                            totalBatches,
                            uploadedBatches: i,
                            maxCount,
                            handledWorkflow: true
                        };
                    }
                    const batchDone = await completeBatchIfReady();
                    if (!batchDone) {
                        return {
                            accepted: false,
                            failedBatchIndex: i,
                            totalBatches,
                            uploadedBatches: i,
                            maxCount,
                            handledWorkflow: true
                        };
                    }
                    markFilesProcessed(batch.files);
                    uploadedBatches = i + 1;
                    const navigationResult = await runNavigationPhase();
                    if (!navigationResult?.sidebar_home || !navigationResult?.sidebar_publish) {
                        return {
                            accepted: false,
                            failedBatchIndex: i,
                            totalBatches,
                            uploadedBatches: i + 1,
                            maxCount,
                            handledWorkflow: true
                        };
                    }
                    console.log('BATCH_END', i);
                    if (uploadedBatches >= totalBatches) {
                        break;
                    }
                    await sleep(3000);
                }

                return {
                    accepted: true,
                    totalBatches,
                    uploadedBatches,
                    maxCount,
                    handledWorkflow: true
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
                    return false;
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
                    return false;
                }

                const resolved = await window.PddModules?.productConfigManager?.getResolvedVideoFiles?.(productId, {
                    config,
                    forceFreshScan: true,
                    batchId: `${productId}-preflight-${Date.now()}`
                });
                if (!resolved) {
                    addLog(`上传注入失败：商品 ${productId} 文件源解析失败`, 'error');
                    return false;
                }

                addLog(`上传注入文件源：${resolved.sourceType} / ${resolved.count} 个文件`, resolved.count ? 'info' : 'error');
                const rawFiles = resolved.files || [];
                const files = typeof structuredClone === 'function'
                    ? structuredClone(rawFiles)
                    : Array.from(rawFiles);
                const filteredFiles = applyBatchLimitStrict(files, {
                    ...config,
                    maxSizeMB: Number(config?.maxSizeMB) || (String(config?.sizeUnit || 'MB').toUpperCase() === 'GB'
                        ? Number(config?.maxSize || 0) * 1024
                        : Number(config?.maxSize || 0))
                });
                console.log('BATCH_SELECTION_MISMATCH_CHECK', {
                    expected: config?.maxCount,
                    actualSelected: filteredFiles.length
                });
                if (filteredFiles.length > Number(config?.maxCount || 0)) {
                    console.log('BATCH_SELECTION_MISMATCH_BLOCK');
                    throw new Error('BATCH_FILTER_BROKEN');
                }
                const selectedFiles = typeof structuredClone === 'function'
                    ? structuredClone(filteredFiles)
                    : Array.from(filteredFiles);
                const batchInputFiles = selectedFiles;
                console.log('UPLOAD_SOURCE_LOCK', {
                    original: config?.files?.length,
                    selected: config?.selectedFiles?.length,
                    resolved: batchInputFiles.length
                });
                console.log('UPLOAD_SOURCE_FILES', batchInputFiles.length);
                if (!batchInputFiles.length) {
                    throw new Error('NO_FILES_FOUND');
                }
                const splitResult = splitIntoBatches(batchInputFiles, {
                    ...config,
                    maxCount: config?.maxCount,
                    maxSize: config?.maxSize
                });
                const firstBatch = splitResult.batches[0] || { files: [], totalBytes: 0 };
                const batch = {
                    files: firstBatch.files,
                    maxCount: splitResult.maxCount,
                    totalBytes: firstBatch.totalBytes
                };
                addLog(`上传注入选中 ${batch.files.length}/${batch.maxCount} 个文件 / ${batch.totalBytes} B`, batch.files.length ? 'info' : 'error');

                if (!firstBatch.files.length) {
                    addLog(`上传注入失败：商品 ${productId} 没有命中本批文件 / 来源 ${resolved.sourceType}`, 'error');
                    if (allowRebindRetry) {
                        const rebound = await triggerManualRebind(productId, 'empty-or-corrupted-files');
                        if (rebound) {
                            uploadAttemptState.delete(lockKey);
                            return uploadInjectionStep({ allowRebindRetry: false, force: true });
                        }
                    }
                    return false;
                }

                const uploadResult = await uploadFilesBatch(batchInputFiles, {
                    ...config,
                    maxCount: config?.maxCount,
                    maxSize: config?.maxSize
                });
                if (!uploadResult.accepted && allowRebindRetry) {
                    const rebound = await triggerManualRebind(productId, 'upload-rejected');
                    if (rebound) {
                        uploadAttemptState.delete(lockKey);
                        return uploadInjectionStep({ allowRebindRetry: false, force: true });
                    }
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
                    <span id="video-workbench-title">视频工作台 V15.1</span>
                    <div>
                        <span id="video-workbench-close" style="cursor:pointer; font-size: 18px; line-height: 1;">×</span>
                    </div>
                </div>
                <div class="ws-tabs" id="video-workbench-tabs">
                    <button type="button" class="ws-tab active" data-tab="publish">发布配置</button>
                    <button type="button" class="ws-tab" data-tab="product">商品配置</button>
                    <button type="button" class="ws-tab" data-tab="logs">执行日志</button>
                </div>
                <div class="ws-body ws-tab-panel active" id="video-workbench-tab-publish">
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
                                <option value="内容可能引人不适，请谨慎观看">内容可能引人不适，请谨慎观看</option>
                                <option value="内容含有高危险行为，请勿模仿">内容含有高危险行为，请勿模仿</option>
                                <option value="请理性适度消费">请理性适度消费</option>
                                <option value="未成年人请在监护人指导下浏览">未成年人请在监护人指导下浏览</option>
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
                        <div class="ws-log-list-header">执行日志</div>
                    </div>
                </div>
            `;
            panel.querySelector('#video-workbench-tab-product')?.insertAdjacentElement('afterend', logTabPanel);
            const logStatusLabelEls = logTabPanel.querySelectorAll('.ws-log-status-label');
            const logHeaderLabelEl = logTabPanel.querySelector('.ws-label');
            const logListHeaderEl = logTabPanel.querySelector('.ws-log-list-header');
            const logStatusValueEl = logTabPanel.querySelector('#video-workbench-log-status');
            if (logHeaderLabelEl) logHeaderLabelEl.textContent = '执行状态';
            if (logStatusLabelEls[0]) logStatusLabelEls[0].textContent = '当前商品ID';
            if (logStatusLabelEls[1]) logStatusLabelEls[1].textContent = '当前状态';
            if (logStatusLabelEls[2]) logStatusLabelEls[2].textContent = '当前批次';
            if (logListHeaderEl) logListHeaderEl.textContent = '执行日志';
            if (logStatusValueEl) logStatusValueEl.textContent = '等待';
            const logListWrap = logTabPanel.querySelector('.ws-log-list-wrap');
            if (logListWrap && logList) {
                logListWrap.appendChild(logList);
            }
            if (logPanel) {
                logPanel.style.display = 'none';
            }

            let activeTab = 'publish';

            const switchTab = (tabName) => {
                activeTab = tabName;
                panel.querySelectorAll('.ws-tab').forEach((tabButton) => {
                    tabButton.classList.toggle('active', tabButton.dataset.tab === tabName);
                });
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
                    addLog('[ID] skip: all videos already bound', 'info');
                    return;
                }
                const btns = getUniqueElements('添加商品');
                addLog(`[ID] selective fill: missing=${missingIndexes.length}, buttons=${btns.length}`, 'info');
                for (let i = 0; i < Math.min(btns.length, missingIndexes.length); i++) {
                    if (!isRunning) return;
                    await checkPause();
                    const videoIndex = missingIndexes[i];
                    if (videoBindingState.id.done.has(videoIndex)) {
                        addLog(`[ID] skip video ${videoIndex + 1}: already bound`, 'info');
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
                                addLog(`ID 填入成功：视频 ${videoIndex + 1}`, 'success');
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
                    addLog('[TITLE] skip: all videos already filled', 'info');
                    return;
                }
                const unique = collectTitleTargets();
                addLog(`[TITLE] selective fill: missing=${missingIndexes.length}, targets=${unique.length}`, 'info');
                for (const videoIndex of missingIndexes) {
                    if (!isRunning) return;
                    await checkPause();
                    if (videoBindingState.title.done.has(videoIndex)) {
                        addLog(`[TITLE] skip video ${videoIndex + 1}: already filled`, 'info');
                        continue;
                    }
                    updateStatus(`[标题] ${videoIndex + 1}/${currentBatchExpectedCount}`);
                    const el = unique[videoIndex];
                    if (!el) {
                        addLog(`[TITLE] video ${videoIndex + 1} target missing`, 'error');
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
                    addLog(`[TITLE] filled video ${videoIndex + 1}/${currentBatchExpectedCount}`, 'success');
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
                    addLog('[STATEMENT] skip: all videos already selected', 'info');
                    return;
                }
                const allFormItems = collectDeclarationTargets();

                if (allFormItems.length === 0) {
                    addLog('未找到“内容声明”区域，请检查页面是否加载完成', 'error');
                    return;
                }

                addLog(`[STATEMENT] selective fill: missing=${missingIndexes.length}, targets=${allFormItems.length}`, 'info');

                for (const videoIndex of missingIndexes) {
                    if (!isRunning) return;
                    await checkPause();
                    if (videoBindingState.statement.done.has(videoIndex)) {
                        addLog(`[STATEMENT] skip video ${videoIndex + 1}: already selected`, 'info');
                        continue;
                    }
                    if (videoBindingState.statementClickLock.has(videoIndex)) {
                        addLog(`[STATEMENT] skip video ${videoIndex + 1}: click locked`, 'info');
                        continue;
                    }
                    updateStatus(`[声明] 处理中 ${videoIndex + 1}/${currentBatchExpectedCount}`);
                    const container = allFormItems[videoIndex];
                    if (!container) {
                        addLog(`[STATEMENT] video ${videoIndex + 1} target missing`, 'error');
                        continue;
                    }

                    const trigger = container.querySelector('[data-testid*="select"]') || container.querySelector('[class*="input"]');
                    if (!trigger) {
                        addLog(`视频 ${videoIndex + 1} 未找到声明触发器`, 'error');
                        continue;
                    }
                    videoBindingState.statementClickLock.add(videoIndex);
                    container.scrollIntoView({ behavior: 'smooth', block: 'center' });
                    await sleep(500);
                    const selected = await retrySelectDropdown(trigger, targetText);

                    if (selected) {
                        videoBindingState.statement.done.add(videoIndex);
                        addLog(`视频 ${videoIndex + 1} 声明设置成功：${targetText}`, 'success');
                    } else {
                        videoBindingState.statementClickLock.delete(videoIndex);
                        addLog(`视频 ${videoIndex + 1} 未找到选项“${targetText}”，可能浮层未弹出或文本不匹配`, 'error');
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
                addLog(`[BACKTRACK] diff-only title=${diff.missingTitle.length} id=${diff.missingID.length} statement=${diff.missingStatement.length}`, 'info');
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

            async function verifyFillIntegrity(expectedCount) {
                let counts = getBindingCounts(expectedCount);
                let retryRound = 0;
                let previousMissingCount = null;

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
                        addLog('[BACKTRACK] stuck detected -> switch to selective fix mode', 'error');
                        break;
                    }
                    previousMissingCount = missingCount;
                    retryRound += 1;
                    console.log('BACKTRACK_FIX_TRIGGER', {
                        retryRound,
                        ...counts,
                        missingTitle: diff.missingTitle,
                        missingID: diff.missingID,
                        missingStatement: diff.missingStatement
                    });
                    addLog(`[BACKTRACK_FIX] retry=${retryRound} title=${counts.titleCount}/${counts.videoCount} id=${counts.idCount}/${counts.videoCount} statement=${counts.statementCount}/${counts.videoCount}`, 'error');
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
                addLog(`[CONSISTENCY] title=${counts.titleCount}/${counts.videoCount} id=${counts.idCount}/${counts.videoCount} statement=${counts.statementCount}/${counts.videoCount} upload=${batchLifecycle.uploadCompleted}`, verified ? 'success' : 'error');
                addLog(`[TITLE_VERIFY] dom=${counts.titleDomCount} value=${counts.titleValueCount} state=${counts.titleStateCount} final=${counts.titleCount}`, 'info');
                return verified;
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
                const rawBtns = Array.from(document.querySelectorAll('button, span')).filter((el) => {
                    return el.innerText?.trim() === '编辑封面' &&
                        el.offsetHeight > 0 &&
                        !el.closest(`#${ROOT_ID}`) &&
                        !el.dataset.done;
                });
                const btns = rawBtns.filter((el) => {
                    const hasChildWithText = Array.from(el.querySelectorAll('*')).some((child) => child.innerText?.trim() === '编辑封面');
                    return !hasChildWithText;
                });
                addLog(`开始确认封面：识别到 ${btns.length} 个视频`, 'info');
                if (btns.length < currentBatchExpectedCount) {
                    addLog(`[COVER] blocked: expected ${currentBatchExpectedCount}, found ${btns.length}`, 'error');
                    return false;
                }
                for (let i = 0; i < btns.length; i++) {
                    if (!isRunning) return;
                    await checkPause();
                    updateStatus(`[封面] ${i + 1}/${btns.length}`);
                    const btn = btns[i];
                    btn.scrollIntoView({ block: 'center', behavior: 'smooth' });
                    await sleep(500);
                    robustClick(btn);
                    await sleep(getCfg('cfg-modal-wait', 1500));
                    const confirm = Array.from(document.querySelectorAll('button, .ant-btn-primary'))
                        .find((el) => (el.innerText?.trim() === '确定' || el.innerText?.includes('确认')) &&
                            el.offsetHeight > 0 &&
                            !el.closest(`#${ROOT_ID}`));
                    if (confirm) {
                        robustClick(confirm);
                        const confirmed = await waitForCoverConfirmed(btn);
                        if (!confirmed) {
                            addLog(`[COVER] confirm timeout: video ${i + 1}`, 'error');
                            return false;
                        }
                        addLog(`[COVER] confirmed video ${i + 1}/${btns.length}`, 'success');
                        btn.dataset.done = 'true';
                        await sleep(1000);
                    } else {
                        addLog(`[COVER] confirm button missing: video ${i + 1}`, 'error');
                        document.body.click();
                        return false;
                    }
                }
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

            async function waitForPublishSuccess(item, index, timeout = 30000) {
                const startedAt = Date.now();
                while (Date.now() - startedAt < timeout) {
                    const itemText = item?.innerText || '';
                    const pageText = document.body?.innerText || '';
                    const loading = getVisibleUploadLoadingNodes().length;
                    const hasSuccessText = /发布成功|已发布|提交成功|审核中/.test(itemText) || /发布成功|提交成功/.test(pageText);
                    const publishButtonVisible = Array.from(item?.querySelectorAll?.('button') || [])
                        .some((btn) => btn.innerText?.includes('发布') && btn.offsetParent !== null && !btn.disabled);

                    if (hasSuccessText || (!publishButtonVisible && loading === 0)) {
                        console.log('PUBLISH_SUCCESS_CONFIRMED', {
                            index,
                            hasSuccessText,
                            publishButtonVisible,
                            loading
                        });
                        return true;
                    }
                    await sleep(500);
                }
                console.log('PUBLISH_SUCCESS_TIMEOUT', { index });
                return false;
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
                const noPendingUI = await waitForNoPendingUiState();
                const allVideosPublished = batchLifecycle.publishedCount >= currentBatchExpectedCount ||
                    !document.getElementById('cfg-pub-auto')?.checked;
                const completed = allVideosPublished && noPendingUI && batchLifecycle.state === 'PUBLISHED';
                console.log('BATCH_COMPLETE_GUARD', {
                    allVideosPublished,
                    noPendingUI,
                    state: batchLifecycle.state,
                    publishedCount: batchLifecycle.publishedCount,
                    expectedCount: currentBatchExpectedCount
                });
                if (!completed) {
                    addLog('[BATCH_DONE] blocked: pending publish/UI state', 'error');
                    return false;
                }
                transitionBatchState('BATCH_DONE', {
                    publishedCount: batchLifecycle.publishedCount,
                    expectedCount: currentBatchExpectedCount
                });
                addLog('[QUEUE] completed after all videos published', 'success');
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
                addLog(`检测到 ${videoItems.length} 个视频，开始逐一发布...`, 'info');
                for (let i = 0; i < videoItems.length; i++) {
                    if (!isRunning) return false;
                    await checkPause();
                    const item = videoItems[i];
                    item.scrollIntoView({ behavior: 'smooth', block: 'center' });
                    await sleep(500);
                    const pubBtn = Array.from(item.querySelectorAll('button')).find((btn) => btn.innerText.includes('发布'));
                    if (pubBtn) {
                        updateStatus(`正在发布第 ${i + 1}/${videoItems.length} 个`);
                        addLog(`[PUBLISH] video ${i + 1}/${videoItems.length} start`, 'info');
                        robustClick(pubBtn);
                        const published = await waitForPublishSuccess(item, i + 1);
                        if (!published) {
                            addLog(`[PUBLISH] video ${i + 1}/${videoItems.length} success not confirmed`, 'error');
                            return false;
                        }
                        batchLifecycle.publishedCount = i + 1;
                        addLog(`[PUBLISH] video ${i + 1}/${videoItems.length} success confirmed`, 'success');
                        await sleep(getCfg('cfg-loop-wait', 2000));
                    } else {
                        addLog(`[PUBLISH] video ${i + 1}/${videoItems.length} button missing`, 'error');
                        return false;
                    }
                }
                return true;
            }

            document.getElementById('video-workbench-start').onclick = async function () {
                const tasks = ['task-chk-id', 'task-chk-title', 'task-chk-declare', 'task-chk-cover'];
                if (!tasks.some((task) => document.getElementById(task).checked)) return alert('请至少勾选一个任务！');
                isRunning = true;
                isPaused = false;
                this.disabled = true;
                setControlsVisible(true);
                resetPauseButton();

                const id = document.getElementById('pub-id').value.trim();
                const title = document.getElementById('pub-title').value;
                const memory = JSON.parse(localStorage.getItem(MEMORY_KEY) || '{}');
                if (id) {
                    memory[id] = title;
                    localStorage.setItem(MEMORY_KEY, JSON.stringify(memory));
                }

                let flowSucceeded = false;
                try {
                    uploadAttemptState.delete(id);
                    const uploadPhaseResult = await uploadInjectionStep();
                    flowSucceeded = Boolean(uploadPhaseResult?.accepted);

                    if (!uploadPhaseResult?.handledWorkflow) {
                        addLog('[FLOW] blocked: upload workflow did not reach controlled batch lifecycle', 'error');
                    }
                } catch (error) {
                    console.error('VIDEO_WORKBENCH_FLOW_ERROR', error);
                    addLog(`[FLOW] failed: ${error?.message || error}`, 'error');
                } finally {
                    isRunning = false;
                    isPaused = false;
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

            document.getElementById('video-workbench-log-toggle').onclick = () => {
                const body = document.getElementById('video-workbench-log-list');
                const isHidden = body.style.display === 'none';
                body.style.display = isHidden ? 'block' : 'none';
                document.getElementById('video-workbench-log-arrow').textContent = isHidden ? '▲' : '▼';
            };

            document.getElementById('pub-id').oninput = (e) => {
                const memory = JSON.parse(localStorage.getItem(MEMORY_KEY) || '{}');
                const val = e.target.value.trim();
                if (memory[val]) {
                    document.getElementById('pub-title').value = memory[val];
                    addLog('匹配到历史标题', 'info');
                }
            };

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
