(function () {
    'use strict';

    const ROOT_ID = 'product-config-manager-root';
    const STORAGE_KEY = 'pdd_product_config_manager_configs';
    const DB_NAME = 'pdd-product-config-manager';
    const DB_VERSION = 3;
    const SNAPSHOT_STORE = 'folderSnapshots';
    const HANDLE_STORE = 'folderHandles';
    const FILE_STORE = 'resolvedVideoFiles';
    const VIDEO_EXTENSIONS = ['.mp4', '.mov', '.m4v', '.avi', '.mkv', '.webm'];
    const MIN_VALID_VIDEO_SIZE = 10 * 1024;
    const DEFAULT_GLOBAL_BATCH_CONFIG = {
        maxCount: 20,
        maxSize: 1024,
        maxSizeUnit: 'MB'
    };

    const state = {
        mounted: false,
        hostPanel: null,
        rootEl: null,
        listEl: null,
        listToolbarEl: null,
        batchControlEl: null,
        createModalEl: null,
        createModalFields: null,
        statusEl: null,
        folderHintEl: null,
        hiddenDirectoryInput: null,
        folderSnapshots: {},
        liveFiles: {},
        persistedFiles: {},
        directoryHandles: {},
        logListeners: new Set(),
        schedulerRunning: false,
        stopRequested: false,
        currentFolderMeta: null,
        selectedProductIds: [],
        editorCollapsed: false,
        batchControlCollapsed: false,
        cardCollapsedMap: {},
        globalBatchConfig: { ...DEFAULT_GLOBAL_BATCH_CONFIG }
    };

    function isVideoFile(fileLike) {
        const name = String(fileLike?.name || '').toLowerCase();
        const type = String(fileLike?.type || '').toLowerCase();
        return type.startsWith('video/') || VIDEO_EXTENSIONS.some((ext) => name.endsWith(ext));
    }

    function isValidResolvedVideoFile(fileLike) {
        return fileLike instanceof File &&
            isVideoFile(fileLike) &&
            Number(fileLike.size || 0) > MIN_VALID_VIDEO_SIZE;
    }

    function toNumber(value, fallback) {
        const parsed = Number(value);
        return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
    }

    function cloneSnapshot(snapshot) {
        if (!snapshot) return null;
        return {
            folderName: snapshot.folderName || '',
            fileCount: snapshot.fileCount || 0,
            files: Array.isArray(snapshot.files) ? snapshot.files.map((file) => ({ ...file })) : [],
            updatedAt: snapshot.updatedAt || Date.now()
        };
    }

    function normalizeConfig(rawConfig) {
        return {
            productId: String(rawConfig?.productId || '').trim(),
            title: String(rawConfig?.title || ''),
            content: String(rawConfig?.content || ''),
            declaration: String(rawConfig?.declaration || ''),
            videoFolderPath: String(rawConfig?.videoFolderPath || ''),
            persistent: rawConfig?.persistent !== false,
            maxCount: Math.max(1, Math.floor(toNumber(rawConfig?.maxCount, 20))),
            maxSize: toNumber(rawConfig?.maxSize, 2048),
            maxSizeUnit: rawConfig?.maxSizeUnit === 'GB' ? 'GB' : 'MB',
            updatedAt: rawConfig?.updatedAt || Date.now()
        };
    }

    function normalizeBatchConfig(rawConfig) {
        return {
            maxCount: Math.max(1, Math.floor(toNumber(rawConfig?.maxCount, DEFAULT_GLOBAL_BATCH_CONFIG.maxCount))),
            maxSize: toNumber(rawConfig?.maxSize, DEFAULT_GLOBAL_BATCH_CONFIG.maxSize),
            maxSizeUnit: rawConfig?.maxSizeUnit === 'GB' ? 'GB' : 'MB'
        };
    }

    function getGlobalBatchConfig() {
        return normalizeBatchConfig(state.globalBatchConfig);
    }

    function applyGlobalBatchConfig(config) {
        const batchConfig = getGlobalBatchConfig();
        return normalizeConfig({
            ...config,
            maxCount: batchConfig.maxCount,
            maxSize: batchConfig.maxSize,
            maxSizeUnit: batchConfig.maxSizeUnit
        });
    }

    function loadConfigs() {
        try {
            const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
            if (!Array.isArray(raw)) return [];
            return raw.map(normalizeConfig).filter((item) => item.productId);
        } catch (error) {
            console.error('[PDD插件] 读取商品配置失败', error);
            return [];
        }
    }

    function saveConfigs(configs) {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(configs));
    }

    function openDb() {
        return new Promise((resolve, reject) => {
            const request = indexedDB.open(DB_NAME, DB_VERSION);
            request.onupgradeneeded = () => {
                const db = request.result;
                if (!db.objectStoreNames.contains(SNAPSHOT_STORE)) {
                    db.createObjectStore(SNAPSHOT_STORE, { keyPath: 'productId' });
                }
                if (!db.objectStoreNames.contains(HANDLE_STORE)) {
                    db.createObjectStore(HANDLE_STORE, { keyPath: 'productId' });
                }
                if (!db.objectStoreNames.contains(FILE_STORE)) {
                    db.createObjectStore(FILE_STORE, { keyPath: 'productId' });
                }
            };
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
    }

    async function loadSnapshotsFromDb() {
        try {
            const db = await openDb();
            const rows = await new Promise((resolve, reject) => {
                const transaction = db.transaction([SNAPSHOT_STORE, HANDLE_STORE, FILE_STORE], 'readonly');
                const snapshotStore = transaction.objectStore(SNAPSHOT_STORE);
                const handleStore = transaction.objectStore(HANDLE_STORE);
                const fileStore = transaction.objectStore(FILE_STORE);
                const snapshotRequest = snapshotStore.getAll();
                const handleRequest = handleStore.getAll();
                const fileRequest = fileStore.getAll();
                const result = { snapshots: [], handles: [], files: [] };

                snapshotRequest.onsuccess = () => {
                    result.snapshots = snapshotRequest.result || [];
                };
                snapshotRequest.onerror = () => reject(snapshotRequest.error);

                handleRequest.onsuccess = () => {
                    result.handles = handleRequest.result || [];
                };
                handleRequest.onerror = () => reject(handleRequest.error);

                fileRequest.onsuccess = () => {
                    result.files = fileRequest.result || [];
                };
                fileRequest.onerror = () => reject(fileRequest.error);

                transaction.oncomplete = () => resolve(result);
                transaction.onerror = () => reject(transaction.error);
            });

            state.folderSnapshots = {};
            rows.snapshots.forEach((row) => {
                if (!row?.productId) return;
                state.folderSnapshots[row.productId] = cloneSnapshot(row.snapshot);
            });
            state.directoryHandles = {};
            rows.handles.forEach((row) => {
                if (!row?.productId || !row.handle) return;
                state.directoryHandles[row.productId] = row.handle;
            });
            state.persistedFiles = {};
            rows.files.forEach((row) => {
                if (!row?.productId || !Array.isArray(row.files)) return;
                state.persistedFiles[row.productId] = row.files.filter(isValidResolvedVideoFile);
            });
        } catch (error) {
            console.error('[PDD插件] 读取目录缓存失败', error);
        }
    }

    async function saveSnapshotToDb(productId, snapshot) {
        try {
            const db = await openDb();
            await new Promise((resolve, reject) => {
                const transaction = db.transaction(SNAPSHOT_STORE, 'readwrite');
                const store = transaction.objectStore(SNAPSHOT_STORE);
                const request = store.put({ productId, snapshot });
                request.onsuccess = () => resolve();
                request.onerror = () => reject(request.error);
            });
        } catch (error) {
            console.error('[PDD插件] 保存目录缓存失败', error);
        }
    }

    async function deleteSnapshotFromDb(productId) {
        try {
            const db = await openDb();
            await new Promise((resolve, reject) => {
                const transaction = db.transaction([SNAPSHOT_STORE, HANDLE_STORE, FILE_STORE], 'readwrite');
                const snapshotStore = transaction.objectStore(SNAPSHOT_STORE);
                const handleStore = transaction.objectStore(HANDLE_STORE);
                const fileStore = transaction.objectStore(FILE_STORE);
                snapshotStore.delete(productId);
                handleStore.delete(productId);
                fileStore.delete(productId);
                transaction.oncomplete = () => resolve();
                transaction.onerror = () => reject(transaction.error);
            });
        } catch (error) {
            console.error('[PDD插件] 删除目录缓存失败', error);
        }
    }

    async function saveDirectoryHandleToDb(productId, handle, folderName) {
        try {
            const db = await openDb();
            await new Promise((resolve, reject) => {
                const transaction = db.transaction(HANDLE_STORE, 'readwrite');
                const store = transaction.objectStore(HANDLE_STORE);
                const request = handle
                    ? store.put({
                        productId,
                        handle,
                        folderName: folderName || handle.name || '',
                        updatedAt: Date.now()
                    })
                    : store.delete(productId);
                request.onsuccess = () => resolve();
                request.onerror = () => reject(request.error);
            });
        } catch (error) {
            console.error('[PDD插件] 保存目录句柄失败', error);
        }
    }

    async function saveResolvedFilesToDb(productId, files, folderName) {
        try {
            const db = await openDb();
            await new Promise((resolve, reject) => {
                const transaction = db.transaction(FILE_STORE, 'readwrite');
                const store = transaction.objectStore(FILE_STORE);
                const request = Array.isArray(files) && files.length
                    ? store.put({
                        productId,
                        folderName: folderName || '',
                        files,
                        updatedAt: Date.now()
                    })
                    : store.delete(productId);
                request.onsuccess = () => resolve();
                request.onerror = () => reject(request.error);
            });
        } catch (error) {
            console.error('[PDD插件] 保存文件缓存失败', error);
        }
    }

    function setStatus(text, type = 'info') {
        if (!state.statusEl) return;
        state.statusEl.textContent = text;
        state.statusEl.dataset.statusType = type;
        state.statusEl.style.color = type === 'error' ? '#c0392b' : type === 'success' ? '#1e8449' : '#555';
    }

    function normalizeLogMessage(message) {
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

    function emitLog(event) {
        if (event && typeof event === 'object') {
            event.message = normalizeLogMessage(event.message);
        }
        state.logListeners.forEach((listener) => {
            try {
                listener(event);
            } catch (error) {
                console.error('[PDD插件] 调度日志监听器执行失败', error);
            }
        });
    }

    function logEvent(type, message, data = {}) {
        const event = {
            type,
            message,
            data,
            timestamp: Date.now()
        };
        emitLog(event);
        return event;
    }

    function onLog(callback) {
        if (typeof callback !== 'function') {
            return function noop() {};
        }

        state.logListeners.add(callback);
        return () => {
            state.logListeners.delete(callback);
        };
    }

    function setStatusAndLog(text, type = 'info', data = {}) {
        setStatus(text, type);
        logEvent(type, text, data);
    }

    function buildVideoMeta(file) {
        const relativePath = String(file.webkitRelativePath || file.name || '');
        return {
            name: file.name,
            size: file.size,
            type: file.type,
            lastModified: file.lastModified || 0,
            relativePath
        };
    }

    function cloneResolvedFile(fileLike) {
        if (fileLike instanceof File) {
            return fileLike;
        }
        return null;
    }

    async function requestDirectoryPermission(handle) {
        if (!handle?.queryPermission) return false;
        try {
            const current = await handle.queryPermission({ mode: 'read' });
            if (current === 'granted') return true;
            const requested = await handle.requestPermission({ mode: 'read' });
            return requested === 'granted';
        } catch (error) {
            console.error('[PDD插件] 请求目录权限失败', error);
            return false;
        }
    }

    async function invalidateDirectoryHandle(productId, reason, error) {
        if (productId) {
            delete state.directoryHandles[productId];
            await saveDirectoryHandleToDb(productId, null, state.folderSnapshots[productId]?.folderName || '');
        }
        logEvent('error', '目录句柄已失效，请重新选择视频文件夹', {
            productId,
            reason,
            error: error?.message || String(error || '')
        });
        renderConfigListV2();
    }

    async function collectVideoFilesFromDirectoryHandle(handle, prefix = '') {
        const files = [];
        for await (const entry of handle.values()) {
            const currentPath = prefix ? `${prefix}/${entry.name}` : entry.name;
            if (entry.kind === 'file') {
                const file = await entry.getFile();
                if (!isVideoFile(file)) continue;
                Object.defineProperty(file, 'webkitRelativePath', {
                    configurable: true,
                    enumerable: true,
                    value: currentPath
                });
                files.push(file);
                continue;
            }

            if (entry.kind === 'directory') {
                files.push(...await collectVideoFilesFromDirectoryHandle(entry, currentPath));
            }
        }
        return files;
    }

    async function triggerRebindFlow(productId, reason = 'handle-invalid') {
        logEvent('info', '目录句柄不可用，准备重新绑定', {
            productId,
            reason
        });

        if (!productId) return false;

        const productInput = getFormEl('pcm-product-id');
        if (productInput) {
            productInput.value = productId;
        }

        try {
            if (typeof window.showDirectoryPicker === 'function') {
                await openDirectoryPickerForCurrentProduct();
                return Boolean(state.liveFiles[productId]?.length || state.persistedFiles[productId]?.length || state.directoryHandles[productId]);
            }
        } catch (error) {
            console.error('[PDD插件] 自动重绑定失败', error);
        }

        state.hiddenDirectoryInput?.click();
        return false;
    }

    async function rebindProductDirectory(productId, reason = 'manual-rebind') {
        return triggerRebindFlow(productId, reason);
    }

    function createResolvedFilePayload(files, sourceType, folderName, extra = {}) {
        const resolvedFiles = Array.isArray(files)
            ? files.map(cloneResolvedFile).filter(isValidResolvedVideoFile)
            : [];
        const totalSize = resolvedFiles.reduce((sum, file) => sum + (file.size || 0), 0);
        return {
            files: resolvedFiles,
            size: totalSize,
            count: resolvedFiles.length,
            sourceType,
            folderName: folderName || '',
            ...extra
        };
    }

    function getFileStableKey(file) {
        return [
            file?.name || '',
            file?.size || 0,
            file?.lastModified || 0
        ].join('::');
    }

    function dedupeResolvedFiles(files) {
        const seen = new Set();
        return Array.from(files || []).filter((file) => {
            const key = getFileStableKey(file);
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        });
    }

    function formatMb(bytes) {
        return (Number(bytes || 0) / 1024 / 1024).toFixed(2);
    }

    async function getResolvedVideoFiles(productId, options = {}) {
        const config = options.config || normalizeConfig(loadConfigs().find((item) => item.productId === productId) || { productId });
        const forceFreshScan = options.forceFreshScan === true;
        const handle = state.directoryHandles[productId] || null;

        if (forceFreshScan) {
            if (!handle || !(await requestDirectoryPermission(handle))) {
                const fallbackFiles = dedupeResolvedFiles([
                    ...(state.liveFiles[productId] || []),
                    ...(state.persistedFiles[productId] || [])
                ].filter(isValidResolvedVideoFile));
            const folderName = fallbackFiles[0]?.webkitRelativePath?.split('/')[0] || config.videoFolderPath || '';
                const totalSize = fallbackFiles.reduce((sum, file) => sum + Number(file?.size || 0), 0);
                logEvent('scan_debug', fallbackFiles.length ? '[SCAN] fresh scan fallback once' : '[SCAN] fresh scan failed: folder handle unavailable', {
                    productId,
                    batchId: options.batchId || '',
                    forceFreshScan,
                    handleValid: false,
                    fallbackCount: fallbackFiles.length,
                    totalSizeBytes: totalSize
                });
                logEvent('scan_debug', `[SCAN] fileCount=${fallbackFiles.length} size=${formatMb(totalSize)}MB`, {
                    productId,
                    batchId: options.batchId || '',
                    fileCount: fallbackFiles.length,
                    totalSizeBytes: totalSize
                });
                return createResolvedFilePayload(fallbackFiles, fallbackFiles.length ? 'fresh-fallback-once' : 'fresh-scan-unavailable', folderName, {
                    handleValid: false,
                    forceFreshScan: true
                });
            }

            let handleFiles = [];
            try {
                handleFiles = dedupeResolvedFiles((await collectVideoFilesFromDirectoryHandle(handle)).filter(isValidResolvedVideoFile));
            } catch (error) {
                await invalidateDirectoryHandle(productId, 'fresh-scan-handle-error', error);
                const fallbackFiles = dedupeResolvedFiles([
                    ...(state.liveFiles[productId] || []),
                    ...(state.persistedFiles[productId] || [])
                ].filter(isValidResolvedVideoFile));
                const folderName = fallbackFiles[0]?.webkitRelativePath?.split('/')[0] || config.videoFolderPath || state.folderSnapshots[productId]?.folderName || '';
                const totalSize = fallbackFiles.reduce((sum, file) => sum + Number(file?.size || 0), 0);
                logEvent('scan_debug', fallbackFiles.length ? '[SCAN] fresh scan fallback after handle error' : '[SCAN] fresh scan failed: handle error and no fallback files', {
                    productId,
                    batchId: options.batchId || '',
                    forceFreshScan,
                    handleValid: false,
                    fallbackCount: fallbackFiles.length,
                    totalSizeBytes: totalSize,
                    error: error?.message || String(error || '')
                });
                logEvent('scan_debug', `[SCAN] fileCount=${fallbackFiles.length} size=${formatMb(totalSize)}MB`, {
                    productId,
                    batchId: options.batchId || '',
                    fileCount: fallbackFiles.length,
                    totalSizeBytes: totalSize
                });
                if (fallbackFiles.length) {
                    return createResolvedFilePayload(fallbackFiles, 'fresh-handle-error-fallback', folderName, {
                        handleValid: false,
                        forceFreshScan: true
                    });
                }
                const rebound = await triggerRebindFlow(productId, 'fresh-scan-handle-error');
                if (rebound) {
                    return getResolvedVideoFiles(productId, options);
                }
                return createResolvedFilePayload([], 'fresh-handle-error', folderName, {
                    handleValid: false,
                    forceFreshScan: true,
                    error: error?.message || String(error || '')
                });
            }
            const folderName = handle.name || config.videoFolderPath || '';
            const snapshot = createSnapshotFromFiles(folderName, handleFiles.map(buildVideoMeta));
            state.persistedFiles[productId] = handleFiles;
            state.folderSnapshots[productId] = snapshot;
            delete state.liveFiles[productId];
            await saveSnapshotToDb(productId, snapshot);
            await saveResolvedFilesToDb(productId, handleFiles, folderName);
            const totalSize = handleFiles.reduce((sum, file) => sum + Number(file?.size || 0), 0);
            logEvent('scan_debug', '[SCAN] fresh scan executed', {
                productId,
                batchId: options.batchId || '',
                folderPath: folderName,
                rawFiles: handleFiles.length,
                filteredFiles: handleFiles.length,
                totalSizeBytes: totalSize,
                cacheHit: false,
                handleValid: true,
                forceFreshScan
            });
            logEvent('scan_debug', `[SCAN] fileCount=${handleFiles.length} size=${formatMb(totalSize)}MB`, {
                productId,
                batchId: options.batchId || '',
                fileCount: handleFiles.length,
                totalSizeBytes: totalSize
            });
            return createResolvedFilePayload(handleFiles, 'fresh-folder-handle', folderName, {
                handleValid: true,
                forceFreshScan: true
            });
        }

        const memoryFiles = state.liveFiles[productId] || [];
        if (memoryFiles.length) {
            const folderName = memoryFiles[0]?.webkitRelativePath?.split('/')[0] || config.videoFolderPath || '';
            logEvent('scan_debug', '扫描调试', {
                productId,
                folderPath: folderName,
                rawFiles: memoryFiles.length,
                filteredFiles: memoryFiles.filter(isValidResolvedVideoFile).length,
                cacheHit: 'memory',
                handleValid: false
            });
            return createResolvedFilePayload(memoryFiles, 'memory-cache', folderName);
        }

        const persistedFiles = state.persistedFiles[productId] || [];
        if (persistedFiles.length) {
            const folderName = persistedFiles[0]?.webkitRelativePath?.split('/')[0] || config.videoFolderPath || '';
            logEvent('scan_debug', '扫描调试', {
                productId,
                folderPath: folderName,
                rawFiles: persistedFiles.length,
                filteredFiles: persistedFiles.filter(isValidResolvedVideoFile).length,
                cacheHit: 'indexeddb-files',
                handleValid: false
            });
            return createResolvedFilePayload(persistedFiles, 'indexeddb-files', folderName);
        }

        if (!handle || !(await requestDirectoryPermission(handle))) {
            const rebound = await triggerRebindFlow(productId, !handle ? 'missing-handle' : 'permission-denied');
            if (rebound) {
                return getResolvedVideoFiles(productId, options);
            }
        }

        if (handle) {
            let handleFiles = [];
            try {
                handleFiles = await collectVideoFilesFromDirectoryHandle(handle);
            } catch (error) {
                await invalidateDirectoryHandle(productId, 'handle-scan-error', error);
                const fallbackFiles = dedupeResolvedFiles([
                    ...(state.liveFiles[productId] || []),
                    ...(state.persistedFiles[productId] || [])
                ].filter(isValidResolvedVideoFile));
                if (fallbackFiles.length) {
                    const fallbackFolder = fallbackFiles[0]?.webkitRelativePath?.split('/')[0] || config.videoFolderPath || state.folderSnapshots[productId]?.folderName || '';
                    logEvent('scan_debug', '扫描调试', {
                        productId,
                        folderPath: fallbackFolder,
                        rawFiles: fallbackFiles.length,
                        filteredFiles: fallbackFiles.length,
                        cacheHit: 'handle-error-fallback',
                        handleValid: false,
                        error: error?.message || String(error || '')
                    });
                    return createResolvedFilePayload(fallbackFiles, 'handle-error-fallback', fallbackFolder, {
                        handleValid: false
                    });
                }
                handleFiles = [];
            }
            const folderName = handle.name || config.videoFolderPath || '';
            if (handleFiles.length) {
                state.persistedFiles[productId] = handleFiles.filter(isValidResolvedVideoFile);
                const snapshot = createSnapshotFromFiles(folderName, handleFiles.map(buildVideoMeta));
                state.folderSnapshots[productId] = snapshot;
                await saveSnapshotToDb(productId, snapshot);
                await saveResolvedFilesToDb(productId, handleFiles, folderName);
                logEvent('scan_debug', '扫描调试', {
                    productId,
                    folderPath: folderName,
                    rawFiles: handleFiles.length,
                    filteredFiles: handleFiles.filter(isValidResolvedVideoFile).length,
                    cacheHit: 'folder-handle',
                    handleValid: true
                });
                return createResolvedFilePayload(handleFiles, 'folder-handle', folderName, {
                    handleValid: true
                });
            }
        }

        const snapshot = cloneSnapshot(state.folderSnapshots[productId]);
        if (snapshot?.files?.length) {
            logEvent('scan_debug', '扫描调试', {
                productId,
                folderPath: snapshot.folderName || config.videoFolderPath || '',
                rawFiles: snapshot.files.length,
                filteredFiles: snapshot.files.length,
                cacheHit: 'indexeddb-snapshot',
                handleValid: false
            });
        }

        return createResolvedFilePayload([], snapshot?.files?.length ? 'indexeddb-snapshot' : 'unresolved', snapshot?.folderName || config.videoFolderPath || '', {
            snapshot
        });
    }

    function createSnapshotFromFiles(folderName, files) {
        return {
            folderName,
            fileCount: files.length,
            files: files.map((file) => ({ ...file })),
            updatedAt: Date.now()
        };
    }

    async function resolveSnapshotForProduct(productId, config = {}) {
        const resolved = await getResolvedVideoFiles(productId, {
            config,
            forceFreshScan: true,
            batchId: `${productId}-snapshot-${Date.now()}`
        });
        if (!resolved.files.length && resolved.snapshot?.files?.length) {
            return cloneSnapshot(resolved.snapshot);
        }

        return createSnapshotFromFiles(
            resolved.folderName || config.videoFolderPath || '',
            resolved.files.map(buildVideoMeta)
        );
    }

    function getSnapshotForProduct(productId) {
        if (state.liveFiles[productId]?.length) {
            const files = state.liveFiles[productId].map(buildVideoMeta);
            const folderName = state.liveFiles[productId][0]?.webkitRelativePath?.split('/')[0] || state.currentFolderMeta?.folderName || '';
            return {
                folderName,
                fileCount: files.length,
                files,
                updatedAt: Date.now()
            };
        }

        if (state.persistedFiles[productId]?.length) {
            const files = state.persistedFiles[productId].map(buildVideoMeta);
            const folderName = state.persistedFiles[productId][0]?.webkitRelativePath?.split('/')[0] || state.currentFolderMeta?.folderName || '';
            return {
                folderName,
                fileCount: files.length,
                files,
                updatedAt: Date.now()
            };
        }

        return cloneSnapshot(state.folderSnapshots[productId]);
    }

    function formatBytes(bytes) {
        if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
        const units = ['B', 'KB', 'MB', 'GB'];
        let value = bytes;
        let index = 0;
        while (value >= 1024 && index < units.length - 1) {
            value /= 1024;
            index++;
        }
        return `${value.toFixed(index === 0 ? 0 : 2)} ${units[index]}`;
    }

    function getSizeLimitBytes(config) {
        const size = toNumber(config.maxSize, 2048);
        return config.maxSizeUnit === 'GB' ? size * 1024 * 1024 * 1024 : size * 1024 * 1024;
    }

    function buildTask(config) {
        const snapshot = getSnapshotForProduct(config.productId);
        const files = snapshot?.files || [];
        const limitBytes = getSizeLimitBytes(config);
        const maxCount = Math.max(1, Math.floor(toNumber(config.maxCount, DEFAULT_GLOBAL_BATCH_CONFIG.maxCount)));
        const selectedVideos = [];
        let totalBytes = 0;

        for (const file of files) {
            if (selectedVideos.length >= maxCount) break;
            if (totalBytes + file.size > limitBytes) break;
            selectedVideos.push(file);
            totalBytes += file.size;
        }

        return {
            productId: config.productId,
            videos: selectedVideos,
            maxCount,
            maxSize: config.maxSize,
            maxSizeUnit: config.maxSizeUnit,
            status: selectedVideos.length ? 'ready' : 'empty',
            totalSizeBytes: totalBytes,
            folderName: snapshot?.folderName || config.videoFolderPath || '',
            scannedVideoCount: files.length,
            sizeLimitBytes: limitBytes
        };
    }

    function isVideoFileNameLike(value) {
        const text = String(value || '').trim().toLowerCase();
        return VIDEO_EXTENSIONS.some((ext) => text.endsWith(ext));
    }

    function getDisplayFolderPath(config, snapshot) {
        const candidates = [
            snapshot?.folderPath,
            snapshot?.folderName,
            config?.videoFolderPath
        ].map((value) => String(value || '').trim()).filter(Boolean);
        const folder = candidates.find((value) => !isVideoFileNameLike(value));
        return folder || '浏览器未暴露完整路径';
    }

    function getFolderConfigured(config, snapshot) {
        const folder = getDisplayFolderPath(config, snapshot);
        const hasHandle = Boolean(state.directoryHandles[config?.productId]);
        return Boolean(hasHandle && folder && folder !== '浏览器未暴露完整路径');
    }

    function createInput(id, placeholder) {
        const input = document.createElement('input');
        input.type = 'text';
        input.id = id;
        input.className = 'ws-input pcm-input';
        input.placeholder = placeholder;
        return input;
    }

    function createTextarea(id, placeholder, rows = 3) {
        const textarea = document.createElement('textarea');
        textarea.id = id;
        textarea.className = 'ws-input pcm-textarea';
        textarea.placeholder = placeholder;
        textarea.rows = rows;
        textarea.style.resize = 'vertical';
        return textarea;
    }

    function createSelect(id) {
        const select = document.createElement('select');
        select.id = id;
        select.className = 'ws-input pcm-input';
        const source = document.getElementById('cfg-declare-type');
        if (source) {
            Array.from(source.options).forEach((option) => {
                const clone = document.createElement('option');
                clone.value = option.value;
                clone.textContent = option.textContent;
                select.appendChild(clone);
            });
        }
        return select;
    }

    function createButton(text, variant = 'default') {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = `ws-btn pcm-btn pcm-btn--${variant}`;
        button.textContent = text;
        return button;
    }

    function getFormEl(id) {
        return state.rootEl?.querySelector(`#${id}`);
    }

    function syncHiddenBatchFormFields() {
        const batchConfig = getGlobalBatchConfig();
        const countEl = getFormEl('pcm-max-count');
        const sizeEl = getFormEl('pcm-max-size');
        const unitEl = getFormEl('pcm-max-size-unit');
        if (countEl) countEl.value = String(batchConfig.maxCount);
        if (sizeEl) sizeEl.value = String(batchConfig.maxSize);
        if (unitEl) unitEl.value = batchConfig.maxSizeUnit;
    }

    function updateGlobalBatchConfig(nextConfig = {}) {
        state.globalBatchConfig = normalizeBatchConfig({
            ...state.globalBatchConfig,
            ...nextConfig
        });
        syncHiddenBatchFormFields();
        renderConfigListV2();
    }

    function getFormValues() {
        return normalizeConfig({
            productId: getFormEl('pcm-product-id')?.value,
            title: getFormEl('pcm-title')?.value,
            content: getFormEl('pcm-content')?.value,
            declaration: getFormEl('pcm-declaration')?.value,
            videoFolderPath: state.currentFolderMeta?.folderName || getFormEl('pcm-folder-path')?.value || '',
            persistent: Boolean(getFormEl('pcm-persistent')?.checked),
            maxCount: getFormEl('pcm-max-count')?.value,
            maxSize: getFormEl('pcm-max-size')?.value,
            maxSizeUnit: getFormEl('pcm-max-size-unit')?.value
        });
    }

    function applyCardEditorValuesToForm(productId, values = {}) {
        const currentConfig = normalizeConfig(loadConfigs().find((item) => item.productId === productId) || { productId });
        const nextConfig = normalizeConfig({
            ...currentConfig,
            ...values,
            productId
        });

        getFormEl('pcm-product-id').value = nextConfig.productId;
        getFormEl('pcm-title').value = nextConfig.title;
        getFormEl('pcm-content').value = nextConfig.content;
        getFormEl('pcm-declaration').value = nextConfig.declaration;
        getFormEl('pcm-folder-path').value = nextConfig.videoFolderPath;
        getFormEl('pcm-persistent').checked = nextConfig.persistent !== false;
        syncHiddenBatchFormFields();
        state.currentFolderMeta = getSnapshotForProduct(productId) || {
            folderName: nextConfig.videoFolderPath,
            fileCount: 0,
            files: []
        };
    }

    function syncCreateConfigModalFolderDisplay() {
        const fields = state.createModalFields;
        if (!fields?.folderHint) return;
        const folderName = state.currentFolderMeta?.folderName || getFormEl('pcm-folder-path')?.value || '';
        fields.folderHint.textContent = folderName || '未选择视频文件夹';
    }

    function closeCreateConfigModal() {
        if (!state.createModalEl) return;
        state.createModalEl.classList.remove('is-open');
    }

    function openCreateConfigModal() {
        if (!state.createModalEl || !state.createModalFields) return;
        const { productId, title, content, declaration, folderHint } = state.createModalFields;
        productId.value = '';
        title.value = '';
        content.value = '';
        declaration.value = '';
        getFormEl('pcm-product-id').value = '';
        getFormEl('pcm-title').value = '';
        getFormEl('pcm-content').value = '';
        getFormEl('pcm-declaration').value = '';
        getFormEl('pcm-folder-path').value = '';
        state.currentFolderMeta = null;
        folderHint.textContent = '未选择视频文件夹';
        state.createModalEl.classList.add('is-open');
        window.setTimeout(() => productId.focus(), 0);
    }

    function setWorkbenchInputValue(id, value) {
        const element = document.getElementById(id);
        if (!element) return;
        element.focus();
        element.value = value;
        ['input', 'change', 'blur'].forEach((eventName) => {
            element.dispatchEvent(new Event(eventName, { bubbles: true }));
        });
    }

    function setWorkbenchSelectValue(id, value) {
        const element = document.getElementById(id);
        if (!element) return;
        if (Array.from(element.options).some((option) => option.value === value)) {
            element.value = value;
            element.dispatchEvent(new Event('change', { bubbles: true }));
        }
    }

    function applyConfigToWorkbench(config, task) {
        window.PddModules?.videoWorkbench?.show?.();
        setWorkbenchInputValue('pub-id', config.productId);
        setWorkbenchInputValue('pub-title', config.title);
        setWorkbenchSelectValue('cfg-declare-type', config.declaration);
        setStatus(`已装载商品 ${config.productId}，本批 ${task.videos.length} 个视频 / ${formatBytes(task.totalSizeBytes)}`, 'info');
    }

    function triggerWorkbenchStart() {
        const startButton = document.getElementById('video-workbench-start');
        if (!startButton || startButton.disabled) return false;
        startButton.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
        return true;
    }

    function waitFor(predicate, timeoutMs, intervalMs = 250) {
        return new Promise((resolve) => {
            const startedAt = Date.now();
            const timer = window.setInterval(() => {
                if (predicate()) {
                    window.clearInterval(timer);
                    resolve(true);
                    return;
                }
                if (Date.now() - startedAt >= timeoutMs) {
                    window.clearInterval(timer);
                    resolve(false);
                }
            }, intervalMs);
        });
    }

    async function runTask(config) {
        const effectiveConfig = applyGlobalBatchConfig(config);
        const resolvedSnapshot = getSnapshotForProduct(effectiveConfig.productId);
        const task = buildTask({
            ...effectiveConfig,
            videoFolderPath: resolvedSnapshot?.folderName || effectiveConfig.videoFolderPath || ''
        });
        if (resolvedSnapshot) {
            task.folderName = resolvedSnapshot.folderName || task.folderName;
            task.scannedVideoCount = resolvedSnapshot.fileCount || resolvedSnapshot.files?.length || task.scannedVideoCount;
        }
        logEvent('info', `商品开始：${effectiveConfig.productId}`, {
            productId: effectiveConfig.productId,
            folderName: task.folderName
        });
        logEvent('info', `缓存视频数量：${task.scannedVideoCount}，实际扫描将在启动后立即执行`, {
            productId: effectiveConfig.productId,
            scannedVideoCount: task.scannedVideoCount,
            folderName: task.folderName
        });
        logEvent('info', `大小计算结果：上限 ${effectiveConfig.maxSize}${effectiveConfig.maxSizeUnit} / ${formatBytes(task.sizeLimitBytes)}，本批 ${formatBytes(task.totalSizeBytes)}`, {
            productId: effectiveConfig.productId,
            sizeLimitBytes: task.sizeLimitBytes,
            totalSizeBytes: task.totalSizeBytes
        });
        logEvent('info', `本次批次数量：${task.videos.length}/${task.maxCount}`, {
            productId: effectiveConfig.productId,
            selectedCount: task.videos.length,
            maxCount: task.maxCount
        });

        applyConfigToWorkbench(effectiveConfig, task);
        setStatusAndLog(`商品 ${effectiveConfig.productId} 已装载到工作台`, 'info', {
            productId: effectiveConfig.productId,
            selectedCount: task.videos.length
        });
        logEvent('info', `开始发布：${effectiveConfig.productId}`, {
            productId: effectiveConfig.productId,
            selectedCount: task.videos.length
        });
        const clickAccepted = triggerWorkbenchStart();
        if (!clickAccepted) {
            setStatusAndLog(`商品 ${effectiveConfig.productId} 启动失败：开始按钮不可用`, 'error', {
                productId: effectiveConfig.productId
            });
            return {
                productId: effectiveConfig.productId,
                status: 'fail',
                isFatal: false
            };
        }

        const workbenchStarted = await waitFor(() => {
            const button = document.getElementById('video-workbench-start');
            return Boolean(button?.disabled);
        }, 3000);

        if (!workbenchStarted) {
            setStatusAndLog(`商品 ${effectiveConfig.productId} 未进入发布流程`, 'error', {
                productId: effectiveConfig.productId
            });
            return {
                productId: effectiveConfig.productId,
                status: 'fail',
                isFatal: false
            };
        }

        setStatusAndLog(`商品 ${effectiveConfig.productId} 正在执行原发布流程...`, 'info', {
            productId: effectiveConfig.productId
        });
        const workbenchFinished = await waitFor(() => {
            const button = document.getElementById('video-workbench-start');
            return Boolean(button) && !button.disabled;
        }, 60 * 60 * 1000);

        if (!workbenchFinished) {
            setStatusAndLog(`发布失败：${effectiveConfig.productId} 超时未确认完成`, 'error', {
                productId: effectiveConfig.productId
            });
            return {
                productId: effectiveConfig.productId,
                status: 'fail',
                isFatal: false
            };
        }

        const workbenchResult = window.PddModules?.videoWorkbench?.lastRunResult;
        if (!workbenchResult?.accepted) {
            setStatusAndLog(`发布失败：${effectiveConfig.productId} ${workbenchResult?.reason || '工作台未确认完成'}`, 'error', {
                productId: effectiveConfig.productId,
                reason: workbenchResult?.reason || 'workbench-not-accepted'
            });
            return {
                productId: effectiveConfig.productId,
                status: 'fail',
                isFatal: false,
                reason: workbenchResult?.reason || 'workbench-not-accepted'
            };
        }

        setStatusAndLog(`发布成功：${effectiveConfig.productId}`, 'success', {
            productId: effectiveConfig.productId,
            selectedCount: task.videos.length,
            totalSizeBytes: task.totalSizeBytes
        });
        return {
            productId: effectiveConfig.productId,
            status: 'done',
            isFatal: false
        };
    }

    async function navigateToHome() {
        logEvent('info', '队列过渡：准备返回首页', {});
        await new Promise((resolve) => window.setTimeout(resolve, 1500));
    }

    async function navigateToPublishPage() {
        logEvent('info', '队列过渡：准备进入下一商品发布页', {});
        await new Promise((resolve) => window.setTimeout(resolve, 1500));
    }

    async function executeProductQueue(productQueue) {
        let isProcessing = true;
        let productIndex = 0;
        const results = [];

        while (isProcessing && productIndex < productQueue.length) {
            if (state.stopRequested) break;
            const config = productQueue[productIndex];
            const remainingQueueLength = Math.max(productQueue.length - productIndex - 1, 0);

            logEvent('info', `队列商品：${config.productId}`, {
                productId: config.productId,
                productIndex,
                remainingQueueLength
            });
            setStatusAndLog(`任务排队中：${config.productId}`, 'info', {
                productId: config.productId,
                productIndex,
                remainingQueueLength
            });

            const result = await runTask(config);
            results.push(result);
            productIndex += 1;

            if (state.stopRequested) {
                break;
            }

            if (productIndex >= productQueue.length) {
                isProcessing = false;
                break;
            }

            if (result?.status === 'fail' && !result?.isFatal) {
                await navigateToHome();
                await new Promise((resolve) => window.setTimeout(resolve, 2000));
                await navigateToPublishPage();
                continue;
            }

            if (result?.status === 'done' || result?.status === 'skip') {
                await navigateToHome();
                await new Promise((resolve) => window.setTimeout(resolve, 2000));
                await navigateToPublishPage();
            }
        }

        return {
            results,
            productIndex,
            queueLength: productQueue.length,
            completed: productIndex >= productQueue.length && !state.stopRequested
        };
    }

    async function startScheduler() {
        if (state.schedulerRunning) {
            setStatusAndLog('批量发布已在执行中', 'error');
            return;
        }

        const configs = loadConfigs();
        if (!configs.length) {
            setStatusAndLog('请先保存至少一个商品配置', 'error');
            return;
        }

        const taskQueue = configs.slice();
        const results = [];
        state.schedulerRunning = true;
        state.stopRequested = false;
        renderConfigListV2();
        setStatusAndLog(`调度已启动，共 ${taskQueue.length} 个商品待处理`, 'info', {
            queueLength: taskQueue.length
        });

        try {
            const queueResult = await executeProductQueue(taskQueue);

            if (state.stopRequested) {
                setStatusAndLog('批量调度已停止', 'error', {
                    remainingQueueLength: Math.max(taskQueue.length - queueResult.productIndex, 0)
                });
                return;
            }

            const doneCount = queueResult.results.filter((result) => result?.status === 'done').length;
            const skipCount = queueResult.results.filter((result) => result?.status === 'skip').length;
            const failCount = queueResult.results.filter((result) => result?.status === 'fail').length;
            setStatusAndLog('队列执行完成', failCount ? 'error' : 'success', {
                totalProducts: queueResult.results.length,
                doneCount,
                skipCount,
                failCount
            });
            return;
            while (taskQueue.length > 0) {
                if (state.stopRequested) break;
                const config = taskQueue.shift();
                logEvent('info', `下一个商品：${config.productId}`, {
                    productId: config.productId,
                    remainingQueueLength: taskQueue.length
                });
                setStatusAndLog(`任务排队中：${config.productId}`, 'info', {
                    productId: config.productId,
                    remainingQueueLength: taskQueue.length
                });
                results.push(await runTask(config));
            }

            if (state.stopRequested) {
                setStatusAndLog('批量调度已停止', 'error', {
                    remainingQueueLength: taskQueue.length
                });
                return;
            }

            const allTasksFinished = results.length === configs.length && results.every((result) => result?.finished === true);
            const executedCount = results.filter((result) => result?.executed).length;

            if (taskQueue.length === 0 && allTasksFinished) {
                setStatusAndLog('流程结束', 'success', {
                    totalProducts: results.length,
                    executedCount
                });
                return;
            }

            if (taskQueue.length === 0 && executedCount === 0) {
                setStatusAndLog('调度结束，未生成可执行发布任务', 'error', {
                    totalProducts: results.length
                });
                return;
            }

            if (taskQueue.length === 0) {
                setStatusAndLog('调度结束，存在未完成任务', 'error', {
                    totalProducts: results.length,
                    executedCount
                });
            }
        } finally {
            state.schedulerRunning = false;
            state.stopRequested = false;
            renderConfigListV2();
        }
    }

    async function startSelectedScheduler() {
        if (state.schedulerRunning) {
            setStatusAndLog('鎵归噺鍙戝竷宸插湪鎵ц涓?', 'error');
            return;
        }

        const configs = getSelectedConfigs();
        if (!configs.length) {
            setStatusAndLog('璇峰厛鍕鹃€変笉灏戜簬涓€涓晢鍝侀厤缃?', 'error');
            return;
        }

        const taskQueue = configs.slice();
        const results = [];
        state.schedulerRunning = true;
        state.stopRequested = false;
        renderConfigListV2();
        setStatusAndLog(`璋冨害宸插惎鍔紝鍏?${taskQueue.length} 涓晢鍝佸緟澶勭悊`, 'info', {
            queueLength: taskQueue.length
        });

        try {
            const queueResult = await executeProductQueue(taskQueue);

            if (state.stopRequested) {
                setStatusAndLog('批量调度已停止', 'error', {
                    remainingQueueLength: Math.max(taskQueue.length - queueResult.productIndex, 0)
                });
                return;
            }

            const doneCount = queueResult.results.filter((result) => result?.status === 'done').length;
            const skipCount = queueResult.results.filter((result) => result?.status === 'skip').length;
            const failCount = queueResult.results.filter((result) => result?.status === 'fail').length;
            setStatusAndLog('队列执行完成', failCount ? 'error' : 'success', {
                totalProducts: queueResult.results.length,
                doneCount,
                skipCount,
                failCount
            });
            return;
            while (taskQueue.length > 0) {
                if (state.stopRequested) break;
                const config = taskQueue.shift();
                logEvent('info', `涓嬩竴涓晢鍝侊細${config.productId}`, {
                    productId: config.productId,
                    remainingQueueLength: taskQueue.length
                });
                setStatusAndLog(`浠诲姟鎺掗槦涓細${config.productId}`, 'info', {
                    productId: config.productId,
                    remainingQueueLength: taskQueue.length
                });
                results.push(await runTask(config));
            }

            if (state.stopRequested) {
                setStatusAndLog('鎵归噺璋冨害宸插仠姝?', 'error', {
                    remainingQueueLength: taskQueue.length
                });
                return;
            }

            const allTasksFinished = results.length === configs.length && results.every((result) => result?.finished === true);
            const executedCount = results.filter((result) => result?.executed).length;

            if (taskQueue.length === 0 && allTasksFinished) {
                setStatusAndLog('闃熷垪鎵ц瀹屾垚', 'success', {
                    totalProducts: results.length,
                    executedCount
                });
                return;
            }

            if (taskQueue.length === 0 && executedCount === 0) {
                setStatusAndLog('璋冨害缁撴潫锛屾湭鐢熸垚鍙墽琛屽彂甯冧换鍔?', 'error', {
                    totalProducts: results.length
                });
                return;
            }

            if (taskQueue.length === 0) {
                setStatusAndLog('璋冨害缁撴潫锛屽瓨鍦ㄦ湭瀹屾垚浠诲姟', 'error', {
                    totalProducts: results.length,
                    executedCount
                });
            }
        } finally {
            state.schedulerRunning = false;
            state.stopRequested = false;
            renderConfigListV2();
        }
    }

    function stopScheduler() {
        if (!state.schedulerRunning) return;
        state.stopRequested = true;
        setStatusAndLog('收到停止请求，等待当前商品流程结束', 'info');
    }

    function fillForm(config) {
        const current = normalizeConfig(config);
        getFormEl('pcm-product-id').value = current.productId;
        getFormEl('pcm-title').value = current.title;
        getFormEl('pcm-content').value = current.content;
        getFormEl('pcm-declaration').value = current.declaration;
        getFormEl('pcm-folder-path').value = current.videoFolderPath;
        getFormEl('pcm-persistent').checked = current.persistent;
        syncHiddenBatchFormFields();
        state.currentFolderMeta = getSnapshotForProduct(current.productId) || {
            folderName: current.videoFolderPath,
            fileCount: 0,
            files: []
        };
        updateFolderHint();
    }

    function updateFolderHint() {
        if (!state.folderHintEl) return;
        const productId = getFormEl('pcm-product-id')?.value.trim();
        const snapshot = productId ? getSnapshotForProduct(productId) : state.currentFolderMeta;

        if (!snapshot?.folderName) {
            state.folderHintEl.textContent = '未选择视频文件夹';
            return;
        }

        state.folderHintEl.textContent = `当前目录：${snapshot.folderName}，缓存 ${snapshot.fileCount || snapshot.files?.length || 0} 个视频`;
    }

    async function handleFolderSelected(event) {
        const productId = getFormEl('pcm-product-id')?.value.trim();
        if (!productId) {
            setStatusAndLog('请先输入商品 ID，再选择视频文件夹', 'error');
            event.target.value = '';
            syncCreateConfigModalFolderDisplay();
            return;
        }

        const rawFiles = Array.from(event.target.files || []);
        const files = rawFiles.filter(isVideoFile);
        logEvent('scan_debug', '扫描调试', {
            productId,
            folderPath: rawFiles[0]?.webkitRelativePath?.split('/')[0] || '',
            rawFiles: rawFiles.length,
            filteredFiles: files.length,
            cacheHit: 'input-memory',
            handleValid: false
        });
        if (!files.length) {
            setStatusAndLog('目录中未检测到视频文件', 'error');
            event.target.value = '';
            syncCreateConfigModalFolderDisplay();
            return;
        }

        const validFiles = files.filter(isValidResolvedVideoFile);
        state.liveFiles[productId] = validFiles;
        state.persistedFiles[productId] = validFiles;
        const folderName = files[0]?.webkitRelativePath?.split('/')[0] || getFormEl('pcm-folder-path')?.value || '';
        const snapshot = {
            folderName,
            fileCount: validFiles.length,
            files: validFiles.map(buildVideoMeta),
            updatedAt: Date.now()
        };
        state.folderSnapshots[productId] = snapshot;
        delete state.directoryHandles[productId];
        state.currentFolderMeta = snapshot;
        getFormEl('pcm-folder-path').value = folderName;
        updateFolderHint();
        syncCreateConfigModalFolderDisplay();
        setStatusAndLog(`已绑定目录 ${folderName}，有效视频 ${validFiles.length} 个`, validFiles.length ? 'success' : 'error', {
            productId,
            folderName,
            fileCount: validFiles.length
        });
        await saveSnapshotToDb(productId, snapshot);
        await saveResolvedFilesToDb(productId, validFiles, folderName);
        await saveDirectoryHandleToDb(productId, null, folderName);
        renderConfigListV2();
        event.target.value = '';
    }

    async function openDirectoryPickerForCurrentProduct() {
        const productId = getFormEl('pcm-product-id')?.value.trim();
        if (!productId) {
            setStatusAndLog('请先输入商品 ID，再选择视频文件夹', 'error');
            return;
        }

        if (typeof window.showDirectoryPicker !== 'function') {
            state.hiddenDirectoryInput?.click();
            return;
        }

        try {
            const handle = await window.showDirectoryPicker();
            const granted = await requestDirectoryPermission(handle);
            if (!granted) {
                setStatusAndLog('目录读取权限未授予', 'error', { productId, folderPath: handle?.name || '' });
                return;
            }

            const files = await collectVideoFilesFromDirectoryHandle(handle);
            logEvent('scan_debug', '扫描调试', {
                productId,
                folderPath: handle.name || '',
                rawFiles: files.length,
                filteredFiles: files.length,
                cacheHit: 'handle-direct',
                handleValid: true
            });

            if (!files.length) {
                setStatusAndLog('目录中未检测到视频文件', 'error', {
                    productId,
                    folderName: handle.name || ''
                });
                return;
            }

            const validFiles = files.filter(isValidResolvedVideoFile);
            const snapshot = createSnapshotFromFiles(handle.name || '', validFiles.map(buildVideoMeta));
            state.directoryHandles[productId] = handle;
            state.folderSnapshots[productId] = snapshot;
            state.persistedFiles[productId] = validFiles;
            state.currentFolderMeta = snapshot;
            delete state.liveFiles[productId];
            getFormEl('pcm-folder-path').value = snapshot.folderName;
            updateFolderHint();
            syncCreateConfigModalFolderDisplay();
            setStatusAndLog(`已绑定目录 ${snapshot.folderName}，有效视频 ${validFiles.length} 个`, validFiles.length ? 'success' : 'error', {
                productId,
                folderName: snapshot.folderName,
                fileCount: validFiles.length,
                handleStored: true
            });
            await saveSnapshotToDb(productId, snapshot);
            await saveResolvedFilesToDb(productId, validFiles, snapshot.folderName);
            await saveDirectoryHandleToDb(productId, handle, snapshot.folderName);
            renderConfigListV2();
        } catch (error) {
            if (error?.name === 'AbortError') {
                return;
            }
            console.error('[PDD插件] 目录选择失败，回退到文件输入', error);
            state.hiddenDirectoryInput?.click();
        }
    }

    function removeConfig(productId) {
        const nextConfigs = loadConfigs().filter((item) => item.productId !== productId);
        saveConfigs(nextConfigs);
        delete state.liveFiles[productId];
        delete state.persistedFiles[productId];
        delete state.folderSnapshots[productId];
        state.selectedProductIds = state.selectedProductIds.filter((id) => id !== productId);
        deleteSnapshotFromDb(productId);
        renderConfigListV2();
        setStatusAndLog(`已删除商品 ${productId} 配置`, 'success', { productId });
    }

    function getSelectedConfigs() {
        if (!state.selectedProductIds.length) return [];
        const configMap = new Map(loadConfigs().map((item) => [item.productId, item]));
        return state.selectedProductIds
            .map((productId) => configMap.get(productId))
            .filter(Boolean);
    }

    function toggleProductSelection(productId, checked) {
        const current = state.selectedProductIds.filter(Boolean);
        const exists = current.includes(productId);
        if (checked && !exists) {
            state.selectedProductIds = [...current, productId];
        } else if (!checked && exists) {
            state.selectedProductIds = current.filter((id) => id !== productId);
        }
        renderConfigListV2();
    }

    function toggleSelectAllConfigs(checked) {
        state.selectedProductIds = checked ? loadConfigs().map((item) => item.productId) : [];
        renderConfigListV2();
    }

    function renderConfigList() {
        if (!state.listEl) return;
        state.listEl.innerHTML = '';

        const configs = loadConfigs();
        const allSelected = configs.length > 0 && configs.every((config) => state.selectedProductIds.includes(config.productId));
        if (state.listToolbarEl) {
            state.listToolbarEl.innerHTML = '';
            const selectAllWrap = document.createElement('label');
            selectAllWrap.className = 'pcm-list-toolbar__select-all';
            const selectAllCheckbox = document.createElement('input');
            selectAllCheckbox.type = 'checkbox';
            selectAllCheckbox.checked = allSelected;
            selectAllCheckbox.disabled = !configs.length || state.schedulerRunning;
            selectAllCheckbox.addEventListener('change', (event) => {
                toggleSelectAllConfigs(event.target.checked);
            });
            const selectAllText = document.createElement('span');
            selectAllText.textContent = '全选';
            selectAllWrap.appendChild(selectAllCheckbox);
            selectAllWrap.appendChild(selectAllText);

            const clearButton = createButton('清空', 'secondary');
            clearButton.addEventListener('click', () => toggleSelectAllConfigs(false));
            const batchButton = createButton('批量发布', 'primary');
            batchButton.addEventListener('click', () => {
                startSelectedScheduler();
            });

            const createButtonEl = createButton('新增配置', 'primary');
            createButtonEl.addEventListener('click', () => {
                openCreateConfigModal();
            });
            if (state.schedulerRunning) {
                clearButton.disabled = true;
                batchButton.disabled = true;
                createButtonEl.disabled = true;
            } else if (!state.selectedProductIds.length) {
                batchButton.disabled = true;
            }

            state.listToolbarEl.appendChild(selectAllWrap);
            state.listToolbarEl.appendChild(clearButton);
            state.listToolbarEl.appendChild(batchButton);
            state.listToolbarEl.appendChild(createButtonEl);
        }
        if (!configs.length) {
            const empty = document.createElement('div');
            empty.className = 'pcm-empty';
            empty.textContent = '暂无已保存商品配置';
            state.listEl.appendChild(empty);
            return;
        }

        configs.forEach((config, index) => {
            const effectiveConfig = applyGlobalBatchConfig(config);
            const card = document.createElement('div');
            card.className = 'pcm-config-card';

            const header = document.createElement('div');
            header.className = 'pcm-config-card__header';

            const selectWrap = document.createElement('label');
            selectWrap.className = 'pcm-config-card__checkbox';
            const selectCheckbox = document.createElement('input');
            selectCheckbox.type = 'checkbox';
            selectCheckbox.checked = state.selectedProductIds.includes(config.productId);
            selectCheckbox.disabled = state.schedulerRunning;
            selectCheckbox.addEventListener('click', (event) => event.stopPropagation());
            selectCheckbox.addEventListener('change', (event) => {
                toggleProductSelection(config.productId, event.target.checked);
            });
            selectWrap.appendChild(selectCheckbox);

            const title = document.createElement('div');
            title.className = 'pcm-config-card__title';
            title.textContent = `${index + 1}. ${config.productId}`;
            selectWrap.appendChild(title);
            header.appendChild(selectWrap);

            const summary = document.createElement('div');
            summary.className = 'pcm-config-card__summary';
            const snapshot = getSnapshotForProduct(config.productId);
            const task = buildTask(effectiveConfig);
            const folderPath = getDisplayFolderPath(config, snapshot);
            summary.textContent = `标题：${config.title || '未填写'} | 文件夹：${folderPath} | 视频：${task.scannedVideoCount} 个 | 当前批次：${task.videos.length}/${effectiveConfig.maxCount} | 大小：${formatBytes(task.totalSizeBytes)}/${effectiveConfig.maxSize}${effectiveConfig.maxSizeUnit}`;

            const actions = document.createElement('div');
            actions.className = 'pcm-config-card__actions';

            const loadButton = createButton('加载', 'secondary');
            loadButton.addEventListener('click', () => {
                fillForm(config);
                setStatusAndLog(`已加载商品 ${config.productId} 配置`, 'info', { productId: config.productId });
            });

            const runButton = createButton('执行当前商品', 'primary');
            runButton.addEventListener('click', async () => {
                if (state.selectedProductIds.length > 1 && state.selectedProductIds.includes(config.productId)) {
                    await startSelectedScheduler();
                    return;
                }
                if (state.schedulerRunning) return;
                state.schedulerRunning = true;
                renderConfigListV2();
                try {
                    await runTask(config);
                } finally {
                    state.schedulerRunning = false;
                    renderConfigListV2();
                }
            });

            const deleteButton = createButton('删除配置', 'danger');
            deleteButton.addEventListener('click', () => {
                removeConfig(config.productId);
            });

            if (state.schedulerRunning) {
                loadButton.disabled = true;
                runButton.disabled = true;
                deleteButton.disabled = true;
            }

            actions.appendChild(loadButton);
            actions.appendChild(runButton);
            actions.appendChild(deleteButton);

            card.appendChild(header);
            card.appendChild(summary);
            card.appendChild(actions);
            state.listEl.appendChild(card);
        });
    }

    function renderConfigListV2() {
        if (!state.listEl) return;
        state.listEl.innerHTML = '';

        const configs = loadConfigs();
        const allSelected = configs.length > 0 && configs.every((config) => state.selectedProductIds.includes(config.productId));
        if (state.listToolbarEl) {
            state.listToolbarEl.innerHTML = '';
            const selectAllWrap = document.createElement('label');
            selectAllWrap.className = 'pcm-list-toolbar__select-all';
            const selectAllCheckbox = document.createElement('input');
            selectAllCheckbox.type = 'checkbox';
            selectAllCheckbox.checked = allSelected;
            selectAllCheckbox.disabled = !configs.length || state.schedulerRunning;
            selectAllCheckbox.addEventListener('change', (event) => {
                toggleSelectAllConfigs(event.target.checked);
            });
            const selectAllText = document.createElement('span');
            selectAllText.textContent = '全选';
            selectAllWrap.appendChild(selectAllCheckbox);
            selectAllWrap.appendChild(selectAllText);

            const clearButton = createButton('清空选择', 'secondary');
            clearButton.addEventListener('click', () => toggleSelectAllConfigs(false));
            const batchButton = createButton('批量发布', 'primary');
            batchButton.addEventListener('click', () => {
                startSelectedScheduler();
            });

            if (state.schedulerRunning) {
                clearButton.disabled = true;
                batchButton.disabled = true;
            } else if (!state.selectedProductIds.length) {
                batchButton.disabled = true;
            }

            state.listToolbarEl.appendChild(selectAllWrap);
            state.listToolbarEl.appendChild(clearButton);
            state.listToolbarEl.appendChild(batchButton);
            const createButtonEl = createButton('新增配置', 'primary');
            createButtonEl.addEventListener('click', () => {
                openCreateConfigModal();
            });
            if (state.schedulerRunning) {
                createButtonEl.disabled = true;
            }
            state.listToolbarEl.appendChild(createButtonEl);
        }

        if (!configs.length) {
            const empty = document.createElement('div');
            empty.className = 'pcm-empty';
            empty.textContent = '暂无已保存商品配置';
            state.listEl.appendChild(empty);
            return;
        }

        configs.forEach((config, index) => {
            const effectiveConfig = applyGlobalBatchConfig(config);
            const snapshot = getSnapshotForProduct(config.productId);
            const task = buildTask(effectiveConfig);
            const folderPath = getDisplayFolderPath(config, snapshot);
            const configured = getFolderConfigured(config, snapshot);
            const statusText = configured ? '已配置' : (task.scannedVideoCount ? '需重新选择' : '未配置');
            const collapsed = state.cardCollapsedMap[config.productId] !== false;

            const card = document.createElement('div');
            card.className = 'pcm-config-card';

            const header = document.createElement('div');
            header.className = 'pcm-config-card__header pcm-config-card__header--interactive';

            const left = document.createElement('div');
            left.className = 'pcm-config-card__left';
            const selectCheckbox = document.createElement('input');
            selectCheckbox.type = 'checkbox';
            selectCheckbox.checked = state.selectedProductIds.includes(config.productId);
            selectCheckbox.disabled = state.schedulerRunning;
            selectCheckbox.addEventListener('click', (event) => event.stopPropagation());
            selectCheckbox.addEventListener('change', (event) => {
                toggleProductSelection(config.productId, event.target.checked);
            });
            left.appendChild(selectCheckbox);

            const info = document.createElement('div');
            info.className = 'pcm-config-card__info';
            const title = document.createElement('div');
            title.className = 'pcm-config-card__title';
            const productIdTitle = document.createElement('span');
            productIdTitle.textContent = `${index + 1}. 商品ID：${config.productId}`;
            const titleText = String(config.title || '').replace(/\s+/g, ' ').trim();
            const titleSnippet = document.createElement('span');
            titleSnippet.className = 'pcm-config-card__title-snippet';
            titleSnippet.textContent = `标题：${titleText ? titleText.slice(0, 8) : '未填写'}`;
            titleSnippet.title = titleText || '未填写标题';
            title.appendChild(productIdTitle);
            title.appendChild(titleSnippet);
            const summary = document.createElement('div');
            summary.className = 'pcm-config-card__summary';
            summary.textContent = `文件夹：${folderPath} | 视频：${task.scannedVideoCount} 个 | 当前批次：${task.videos.length}/${effectiveConfig.maxCount} | 状态：${statusText}`;
            info.appendChild(title);
            info.appendChild(summary);
            left.appendChild(info);
            header.appendChild(left);

            const toggle = createButton(collapsed ? '展开' : '折叠', 'secondary');
            toggle.classList.add('pcm-config-card__toggle');
            toggle.addEventListener('click', (event) => {
                event.stopPropagation();
                state.cardCollapsedMap[config.productId] = !collapsed;
                renderConfigListV2();
            });
            header.appendChild(toggle);

            const body = document.createElement('div');
            body.className = 'pcm-config-card__body';
            if (collapsed) {
                body.classList.add('is-collapsed');
            }

            const meta = document.createElement('div');
            meta.className = 'pcm-config-card__meta';
            meta.innerHTML = [
                `<div><strong>商品ID：</strong>${config.productId || '未配置'}</div>`,
                `<div><strong>视频文件夹路径：</strong>${folderPath}</div>`,
                `<div><strong>视频总数：</strong>${task.scannedVideoCount} 个</div>`,
                `<div><strong>配置状态：</strong>${statusText}</div>`,
                `<div><strong>当前批次：</strong>${task.videos.length}/${effectiveConfig.maxCount}</div>`,
                `<div><strong>批次上限：</strong>${effectiveConfig.maxSize}${effectiveConfig.maxSizeUnit}</div>`
            ].join('');
            body.appendChild(meta);

            const editor = document.createElement('div');
            editor.className = 'pcm-config-card__editor';

            const productRow = document.createElement('div');
            productRow.className = 'pcm-row';
            const productLabel = document.createElement('label');
            productLabel.textContent = '商品ID';
            const productInput = createInput(`pcm-card-product-${config.productId}`, '');
            productInput.value = config.productId || '';
            productInput.readOnly = true;
            productRow.appendChild(productLabel);
            productRow.appendChild(productInput);

            const titleRow = document.createElement('div');
            titleRow.className = 'pcm-row';
            const titleLabel = document.createElement('label');
            titleLabel.textContent = '标题';
            const titleInput = createInput(`pcm-card-title-${config.productId}`, '输入发布标题');
            titleInput.value = config.title || '';
            titleRow.appendChild(titleLabel);
            titleRow.appendChild(titleInput);

            const contentRow = document.createElement('div');
            contentRow.className = 'pcm-row';
            const contentLabel = document.createElement('label');
            contentLabel.textContent = '内容';
            const contentInput = createTextarea(`pcm-card-content-${config.productId}`, '输入内容文本，仅用于配置持久化', 3);
            contentInput.value = config.content || '';
            contentRow.appendChild(contentLabel);
            contentRow.appendChild(contentInput);

            const declarationRow = document.createElement('div');
            declarationRow.className = 'pcm-row';
            const declarationLabel = document.createElement('label');
            declarationLabel.textContent = '声明';
            const declarationInput = createSelect(`pcm-card-declaration-${config.productId}`);
            if (Array.from(declarationInput.options).some((option) => option.value === (config.declaration || ''))) {
                declarationInput.value = config.declaration || '';
            }
            declarationRow.appendChild(declarationLabel);
            declarationRow.appendChild(declarationInput);

            editor.appendChild(productRow);
            editor.appendChild(titleRow);
            editor.appendChild(contentRow);
            editor.appendChild(declarationRow);
            body.appendChild(editor);

            const actions = document.createElement('div');
            actions.className = 'pcm-config-card__actions';

            const folderButton = createButton('选择视频文件夹', 'secondary');
            folderButton.addEventListener('click', () => {
                fillForm(config);
                openDirectoryPickerForCurrentProduct();
            });

            const runButton = createButton('执行当前商品', 'primary');
            runButton.addEventListener('click', async () => {
                if (state.selectedProductIds.length > 1 && state.selectedProductIds.includes(config.productId)) {
                    await startSelectedScheduler();
                    return;
                }
                if (state.schedulerRunning) return;
                state.schedulerRunning = true;
                renderConfigListV2();
                try {
                    await runTask(config);
                } finally {
                    state.schedulerRunning = false;
                    renderConfigListV2();
                }
            });

            const deleteButton = createButton('删除配置', 'danger');
            deleteButton.addEventListener('click', () => {
                removeConfig(config.productId);
            });

            if (state.schedulerRunning) {
                folderButton.disabled = true;
                runButton.disabled = true;
                deleteButton.disabled = true;
                toggle.disabled = true;
            }

            actions.appendChild(folderButton);
            const saveButton = createButton('保存配置', 'primary');
            saveButton.addEventListener('click', () => {
                applyCardEditorValuesToForm(config.productId, {
                    title: titleInput.value,
                    content: contentInput.value,
                    declaration: declarationInput.value
                });
                saveCurrentConfig();
            });
            if (state.schedulerRunning) {
                saveButton.disabled = true;
                titleInput.disabled = true;
                contentInput.disabled = true;
                declarationInput.disabled = true;
            }
            actions.appendChild(saveButton);
            actions.appendChild(runButton);
            actions.appendChild(deleteButton);
            body.appendChild(actions);

            card.appendChild(header);
            card.appendChild(body);
            state.listEl.appendChild(card);
        });
    }

    function saveCurrentConfig() {
        const config = getFormValues();
        if (!config.productId) {
            setStatusAndLog('商品 ID 不能为空', 'error');
            return;
        }

        const snapshot = getSnapshotForProduct(config.productId) || state.currentFolderMeta;
        if (snapshot?.folderName) {
            config.videoFolderPath = snapshot.folderName;
        }

        const configs = loadConfigs();
        const nextConfigs = configs.filter((item) => item.productId !== config.productId);
        nextConfigs.push({
            ...config,
            updatedAt: Date.now()
        });
        saveConfigs(nextConfigs);
        renderConfigListV2();
        setStatusAndLog(`商品 ${config.productId} 配置已保存`, 'success', { productId: config.productId });
    }

    function injectStyles() {
        const cssText = `
            #${ROOT_ID} {
                margin-bottom: 12px;
                padding: 10px;
                border: 1px solid #dcdfe6;
                border-radius: 10px;
                background: #f8fbff;
            }
            #${ROOT_ID} .pcm-title {
                margin: 0 0 8px;
                font-size: 13px;
                font-weight: 700;
                color: #2c3e50;
            }
            #${ROOT_ID} .pcm-editor-card {
                border: 1px solid #dcdfe6;
                border-radius: 10px;
                background: #ffffff;
                overflow: hidden;
            }
            #${ROOT_ID} .pcm-editor-card__header {
                display: flex;
                align-items: center;
                justify-content: space-between;
                padding: 10px 12px;
                cursor: pointer;
                background: #f8fbff;
                border-bottom: 1px solid #e5e7eb;
            }
            #${ROOT_ID} .pcm-editor-card__toggle {
                font-size: 12px;
                color: #6b7280;
            }
            #${ROOT_ID} .pcm-editor-card__body {
                padding: 10px;
            }
            #${ROOT_ID} .pcm-editor-card__body.is-collapsed {
                display: none;
            }
            #${ROOT_ID} .pcm-grid {
                display: grid;
                gap: 8px;
                grid-template-columns: 1fr 1fr;
            }
            #${ROOT_ID} .pcm-grid--single {
                grid-template-columns: 1fr;
            }
            #${ROOT_ID} .pcm-row {
                display: flex;
                flex-direction: column;
                gap: 4px;
            }
            #${ROOT_ID} .pcm-row label {
                display: block;
                line-height: 1.4;
                min-height: 16px;
                font-size: 11px;
                font-weight: 600;
                color: #4b5563;
            }
            #${ROOT_ID} .pcm-size-group {
                display: grid;
                gap: 6px;
                grid-template-columns: 1fr 78px;
            }
            #${ROOT_ID} .pcm-switch {
                display: flex;
                align-items: center;
                gap: 6px;
                font-size: 12px;
                color: #374151;
            }
            #${ROOT_ID} .pcm-toolbar,
            #${ROOT_ID} .pcm-config-card__actions {
                display: flex;
                gap: 6px;
                flex-wrap: wrap;
            }
            #${ROOT_ID} .pcm-hidden-form {
                display: none;
            }
            #${ROOT_ID} .pcm-modal {
                position: fixed;
                inset: 0;
                display: none;
                align-items: center;
                justify-content: center;
                padding: 24px;
                background: rgba(15, 23, 42, 0.45);
                z-index: 2147483646;
            }
            #${ROOT_ID} .pcm-modal.is-open {
                display: flex;
            }
            #${ROOT_ID} .pcm-modal__dialog {
                width: min(560px, 100%);
                max-height: calc(100vh - 48px);
                overflow: auto;
                border-radius: 14px;
                background: #fff;
                box-shadow: 0 20px 50px rgba(15, 23, 42, 0.22);
            }
            #${ROOT_ID} .pcm-modal__header,
            #${ROOT_ID} .pcm-modal__footer {
                display: flex;
                align-items: center;
                justify-content: space-between;
                gap: 8px;
                padding: 14px 16px;
            }
            #${ROOT_ID} .pcm-modal__header {
                border-bottom: 1px solid #e5e7eb;
            }
            #${ROOT_ID} .pcm-modal__body {
                display: grid;
                gap: 10px;
                padding: 16px;
            }
            #${ROOT_ID} .pcm-modal__footer {
                justify-content: flex-end;
                border-top: 1px solid #e5e7eb;
            }
            #${ROOT_ID} .pcm-btn {
                margin-bottom: 0;
                padding: 8px 10px;
                font-size: 12px;
                width: auto;
                min-width: 88px;
            }
            #${ROOT_ID} .pcm-btn--primary {
                background: #1677ff;
            }
            #${ROOT_ID} .pcm-btn--secondary {
                background: #6b7280;
            }
            #${ROOT_ID} .pcm-btn--danger {
                background: #dc2626;
            }
            #${ROOT_ID} .pcm-folder-bar {
                display: flex;
                gap: 6px;
                align-items: center;
            }
            #${ROOT_ID} .pcm-folder-hint,
            #${ROOT_ID} .pcm-status,
            #${ROOT_ID} .pcm-config-card__summary {
                font-size: 11px;
                line-height: 1.5;
                color: #6b7280;
            }
            #${ROOT_ID} .pcm-status {
                margin-top: 8px;
                padding: 8px 10px;
                border-radius: 8px;
                background: #ffffff;
                border: 1px solid #e5e7eb;
            }
            #${ROOT_ID} .pcm-list {
                margin-top: 10px;
                display: flex;
                flex-direction: column;
                gap: 8px;
            }
            #${ROOT_ID} .pcm-list-toolbar {
                margin-top: 10px;
                display: flex;
                align-items: center;
                gap: 6px;
                flex-wrap: wrap;
            }
            #${ROOT_ID} .pcm-list-toolbar__select-all,
            #${ROOT_ID} .pcm-config-card__checkbox,
            #${ROOT_ID} .pcm-config-card__header {
                display: flex;
                align-items: center;
                gap: 8px;
            }
            #${ROOT_ID} .pcm-config-card__header--interactive {
                justify-content: space-between;
            }
            #${ROOT_ID} .pcm-config-card__left {
                display: flex;
                align-items: flex-start;
                gap: 8px;
                min-width: 0;
                flex: 1;
            }
            #${ROOT_ID} .pcm-config-card__info {
                min-width: 0;
                flex: 1;
            }
            #${ROOT_ID} .pcm-config-card {
                padding: 8px;
                border-radius: 8px;
                background: #fff;
                border: 1px solid #e5e7eb;
            }
            #${ROOT_ID} .pcm-config-card__body.is-collapsed {
                display: none;
            }
            #${ROOT_ID} .pcm-config-card__meta {
                display: grid;
                gap: 6px;
                margin-top: 8px;
                font-size: 12px;
                color: #374151;
            }
            #${ROOT_ID} .pcm-config-card__editor {
                display: grid;
                gap: 8px;
                margin-top: 10px;
                padding-top: 10px;
                border-top: 1px solid #e5e7eb;
            }
            #${ROOT_ID} .pcm-config-card__title {
                display: flex;
                align-items: center;
                gap: 6px;
                flex-wrap: wrap;
                font-size: 12px;
                font-weight: 700;
                color: #1f2937;
                margin-bottom: 4px;
            }
            #${ROOT_ID} .pcm-config-card__title-snippet {
                max-width: 132px;
                overflow: hidden;
                text-overflow: ellipsis;
                white-space: nowrap;
                font-weight: 600;
                color: #64748b;
            }
            #${ROOT_ID} .pcm-empty {
                padding: 8px;
                font-size: 12px;
                color: #9ca3af;
                border: 1px dashed #d1d5db;
                border-radius: 8px;
                background: #fff;
            }
        `;
        window.PddSharedStyle?.addStyle?.(cssText);
    }

    function createRoot() {
        const root = document.createElement('section');
        root.id = ROOT_ID;

        const title = document.createElement('div');
        title.className = 'pcm-title';
        title.textContent = '商品配置面板';

        const editorCard = document.createElement('div');
        editorCard.className = 'pcm-editor-card';
        const editorHeader = document.createElement('div');
        editorHeader.className = 'pcm-editor-card__header';
        const editorHeaderTitle = document.createElement('div');
        editorHeaderTitle.className = 'pcm-title';
        editorHeaderTitle.textContent = '商品配置';
        const editorToggle = document.createElement('span');
        editorToggle.className = 'pcm-editor-card__toggle';
        editorHeader.appendChild(editorHeaderTitle);
        editorHeader.appendChild(editorToggle);
        const editorBody = document.createElement('div');
        editorBody.className = 'pcm-editor-card__body';
        const syncEditorCard = () => {
            editorBody.classList.toggle('is-collapsed', state.editorCollapsed);
            editorToggle.textContent = state.editorCollapsed ? '展开' : '折叠';
        };
        editorHeader.addEventListener('click', () => {
            state.editorCollapsed = !state.editorCollapsed;
            syncEditorCard();
        });
        syncEditorCard();
        editorCard.appendChild(editorHeader);
        editorCard.appendChild(editorBody);
        root.appendChild(editorCard);

        const grid = document.createElement('div');
        grid.className = 'pcm-grid';

        const productRow = document.createElement('div');
        productRow.className = 'pcm-row';
        const productLabel = document.createElement('label');
        productLabel.textContent = '商品 ID';
        productLabel.htmlFor = 'pcm-product-id';
        productRow.appendChild(productLabel);
        productRow.appendChild(createInput('pcm-product-id', '输入商品 ID'));

        const titleRow = document.createElement('div');
        titleRow.className = 'pcm-row';
        const titleLabel = document.createElement('label');
        titleLabel.textContent = '标题';
        titleLabel.htmlFor = 'pcm-title';
        titleRow.appendChild(titleLabel);
        titleRow.appendChild(createInput('pcm-title', '输入发布标题'));

        grid.appendChild(productRow);
        grid.appendChild(titleRow);
        editorBody.appendChild(grid);

        const contentRow = document.createElement('div');
        contentRow.className = 'pcm-row';
        const contentLabel = document.createElement('label');
        contentLabel.textContent = '内容';
        contentLabel.htmlFor = 'pcm-content';
        contentRow.appendChild(contentLabel);
        contentRow.appendChild(createTextarea('pcm-content', '输入内容文本，仅用于配置持久化', 3));
        editorBody.appendChild(contentRow);

        const detailGrid = document.createElement('div');
        detailGrid.className = 'pcm-grid';

        const declarationRow = document.createElement('div');
        declarationRow.className = 'pcm-row';
        const declarationLabel = document.createElement('label');
        declarationLabel.textContent = '声明';
        declarationLabel.htmlFor = 'pcm-declaration';
        declarationRow.appendChild(declarationLabel);
        declarationRow.appendChild(createSelect('pcm-declaration'));

        const countRow = document.createElement('div');
        countRow.className = 'pcm-row';
        const countLabel = document.createElement('label');
        countLabel.textContent = '最大数量';
        countLabel.htmlFor = 'pcm-max-count';
        countRow.appendChild(countLabel);
        const countInput = createInput('pcm-max-count', '20');
        countInput.type = 'number';
        countInput.min = '1';
        countInput.value = '20';
        countRow.appendChild(countInput);

        detailGrid.appendChild(declarationRow);
        detailGrid.appendChild(countRow);
        editorBody.appendChild(detailGrid);

        const limitGrid = document.createElement('div');
        limitGrid.className = 'pcm-grid';

        const sizeRow = document.createElement('div');
        sizeRow.className = 'pcm-row';
        const sizeLabel = document.createElement('label');
        sizeLabel.textContent = '最大总大小';
        sizeLabel.htmlFor = 'pcm-max-size';
        sizeRow.appendChild(sizeLabel);
        const sizeGroup = document.createElement('div');
        sizeGroup.className = 'pcm-size-group';
        const sizeInput = createInput('pcm-max-size', '2048');
        sizeInput.type = 'number';
        sizeInput.min = '1';
        sizeInput.value = '2048';
        const sizeUnit = document.createElement('select');
        sizeUnit.id = 'pcm-max-size-unit';
        sizeUnit.className = 'ws-input pcm-input';
        ['MB', 'GB'].forEach((unit) => {
            const option = document.createElement('option');
            option.value = unit;
            option.textContent = unit;
            sizeUnit.appendChild(option);
        });
        sizeGroup.appendChild(sizeInput);
        sizeGroup.appendChild(sizeUnit);
        sizeRow.appendChild(sizeGroup);

        const persistentRow = document.createElement('div');
        persistentRow.className = 'pcm-row';
        const persistentLabel = document.createElement('label');
        persistentLabel.textContent = '永久保存';
        persistentRow.appendChild(persistentLabel);
        const persistentWrap = document.createElement('label');
        persistentWrap.className = 'pcm-switch';
        const persistentInput = document.createElement('input');
        persistentInput.type = 'checkbox';
        persistentInput.id = 'pcm-persistent';
        persistentInput.checked = true;
        const persistentText = document.createElement('span');
        persistentText.textContent = '启用配置持久化';
        persistentWrap.appendChild(persistentInput);
        persistentWrap.appendChild(persistentText);
        persistentRow.appendChild(persistentWrap);

        limitGrid.appendChild(sizeRow);
        limitGrid.appendChild(persistentRow);
        editorBody.appendChild(limitGrid);

        const folderRow = document.createElement('div');
        folderRow.className = 'pcm-row';
        const folderLabel = document.createElement('label');
        folderLabel.textContent = '视频文件夹';
        folderLabel.htmlFor = 'pcm-folder-path';
        folderRow.appendChild(folderLabel);
        const folderPathInput = createInput('pcm-folder-path', '未绑定目录时使用缓存');
        folderPathInput.readOnly = true;
        folderRow.appendChild(folderPathInput);

        const folderBar = document.createElement('div');
        folderBar.className = 'pcm-folder-bar';
        const folderButton = createButton('选择视频文件夹', 'secondary');
        folderButton.addEventListener('click', () => {
            openDirectoryPickerForCurrentProduct();
        });
        const folderHint = document.createElement('div');
        folderHint.className = 'pcm-folder-hint';
        folderHint.textContent = '未选择视频文件夹';
        state.folderHintEl = folderHint;
        folderBar.appendChild(folderButton);
        folderBar.appendChild(folderHint);
        folderRow.appendChild(folderBar);
        editorBody.appendChild(folderRow);

        const toolbar = document.createElement('div');
        toolbar.className = 'pcm-toolbar';
        const saveButton = createButton('保存配置', 'primary');
        saveButton.addEventListener('click', saveCurrentConfig);
        const startButton = createButton('启动批量发布', 'primary');
        startButton.addEventListener('click', () => {
            startScheduler();
        });
        const stopButton = createButton('停止调度', 'danger');
        stopButton.addEventListener('click', stopScheduler);
        toolbar.appendChild(saveButton);
        toolbar.appendChild(startButton);
        toolbar.appendChild(stopButton);
        editorBody.appendChild(toolbar);

        const status = document.createElement('div');
        status.className = 'pcm-status';
        status.textContent = '等待商品配置任务';
        state.statusEl = status;
        root.appendChild(status);

        const listToolbar = document.createElement('div');
        listToolbar.className = 'pcm-list-toolbar';
        state.listToolbarEl = listToolbar;
        root.appendChild(listToolbar);

        const list = document.createElement('div');
        list.className = 'pcm-list';
        state.listEl = list;
        root.appendChild(list);

        state.rootEl = root;
        const productInput = root.querySelector('#pcm-product-id');
        productInput.addEventListener('input', () => {
            const productId = productInput.value.trim();
            const snapshot = productId ? getSnapshotForProduct(productId) : null;
            state.currentFolderMeta = snapshot;
            getFormEl('pcm-folder-path').value = snapshot?.folderName || '';
            updateFolderHint();
        });
        return root;
    }

    function createBatchControlCard() {
        const card = document.createElement('div');
        card.className = 'pcm-editor-card';

        const header = document.createElement('div');
        header.className = 'pcm-editor-card__header';
        const title = document.createElement('div');
        title.className = 'pcm-title';
        title.textContent = '批次发布控制（Batch Control）';
        const toggle = document.createElement('span');
        toggle.className = 'pcm-editor-card__toggle';
        header.appendChild(title);
        header.appendChild(toggle);

        const body = document.createElement('div');
        body.className = 'pcm-editor-card__body';
        const syncCard = () => {
            body.classList.toggle('is-collapsed', state.batchControlCollapsed);
            toggle.textContent = state.batchControlCollapsed ? '展开' : '折叠';
        };
        header.addEventListener('click', () => {
            state.batchControlCollapsed = !state.batchControlCollapsed;
            syncCard();
        });
        syncCard();

        const grid = document.createElement('div');
        grid.className = 'pcm-grid';

        const countRow = document.createElement('div');
        countRow.className = 'pcm-row';
        const countLabel = document.createElement('label');
        countLabel.textContent = '单批上传数量';
        countLabel.htmlFor = 'pcm-global-max-count';
        const countInput = createInput('pcm-global-max-count', String(DEFAULT_GLOBAL_BATCH_CONFIG.maxCount));
        countInput.type = 'number';
        countInput.min = '1';
        countInput.value = String(getGlobalBatchConfig().maxCount);
        countInput.addEventListener('input', () => {
            updateGlobalBatchConfig({ maxCount: countInput.value });
        });
        countRow.appendChild(countLabel);
        countRow.appendChild(countInput);

        const sizeRow = document.createElement('div');
        sizeRow.className = 'pcm-row';
        const sizeLabel = document.createElement('label');
        sizeLabel.textContent = '单批最大大小';
        sizeLabel.htmlFor = 'pcm-global-max-size';
        const sizeGroup = document.createElement('div');
        sizeGroup.className = 'pcm-size-group';
        const sizeInput = createInput('pcm-global-max-size', String(DEFAULT_GLOBAL_BATCH_CONFIG.maxSize));
        sizeInput.type = 'number';
        sizeInput.min = '1';
        sizeInput.value = String(getGlobalBatchConfig().maxSize);
        sizeInput.addEventListener('input', () => {
            updateGlobalBatchConfig({ maxSize: sizeInput.value });
        });
        const sizeUnit = document.createElement('select');
        sizeUnit.id = 'pcm-global-max-size-unit';
        sizeUnit.className = 'ws-input pcm-input';
        ['MB', 'GB'].forEach((unit) => {
            const option = document.createElement('option');
            option.value = unit;
            option.textContent = unit;
            sizeUnit.appendChild(option);
        });
        sizeUnit.value = getGlobalBatchConfig().maxSizeUnit;
        sizeUnit.addEventListener('change', () => {
            updateGlobalBatchConfig({ maxSizeUnit: sizeUnit.value });
        });
        sizeGroup.appendChild(sizeInput);
        sizeGroup.appendChild(sizeUnit);
        sizeRow.appendChild(sizeLabel);
        sizeRow.appendChild(sizeGroup);

        grid.appendChild(countRow);
        grid.appendChild(sizeRow);
        body.appendChild(grid);
        card.appendChild(header);
        card.appendChild(body);
        return card;
    }

    function createHiddenFormShell(root) {
        const hiddenForm = document.createElement('div');
        hiddenForm.className = 'pcm-hidden-form';

        const productInput = createInput('pcm-product-id', '输入商品 ID');
        const titleInput = createInput('pcm-title', '输入发布标题');
        const contentInput = createTextarea('pcm-content', '输入内容文本，仅用于配置持久化', 3);
        const declarationInput = createSelect('pcm-declaration');
        const folderPathInput = createInput('pcm-folder-path', '未绑定目录时使用缓存');
        folderPathInput.readOnly = true;

        const persistentInput = document.createElement('input');
        persistentInput.type = 'checkbox';
        persistentInput.id = 'pcm-persistent';
        persistentInput.checked = true;

        const maxCountInput = createInput('pcm-max-count', String(DEFAULT_GLOBAL_BATCH_CONFIG.maxCount));
        maxCountInput.type = 'number';
        const maxSizeInput = createInput('pcm-max-size', String(DEFAULT_GLOBAL_BATCH_CONFIG.maxSize));
        maxSizeInput.type = 'number';
        const maxSizeUnitInput = document.createElement('select');
        maxSizeUnitInput.id = 'pcm-max-size-unit';
        maxSizeUnitInput.className = 'ws-input pcm-input';
        ['MB', 'GB'].forEach((unit) => {
            const option = document.createElement('option');
            option.value = unit;
            option.textContent = unit;
            maxSizeUnitInput.appendChild(option);
        });
        maxSizeUnitInput.value = getGlobalBatchConfig().maxSizeUnit;

        hiddenForm.appendChild(productInput);
        hiddenForm.appendChild(titleInput);
        hiddenForm.appendChild(contentInput);
        hiddenForm.appendChild(declarationInput);
        hiddenForm.appendChild(folderPathInput);
        hiddenForm.appendChild(persistentInput);
        hiddenForm.appendChild(maxCountInput);
        hiddenForm.appendChild(maxSizeInput);
        hiddenForm.appendChild(maxSizeUnitInput);
        root.appendChild(hiddenForm);

        productInput.addEventListener('input', () => {
            const productId = productInput.value.trim();
            const snapshot = productId ? getSnapshotForProduct(productId) : null;
            state.currentFolderMeta = snapshot;
            getFormEl('pcm-folder-path').value = snapshot?.folderName || '';
            updateFolderHint();
        });
    }

    function createCreateConfigModal(root) {
        const modal = document.createElement('div');
        modal.className = 'pcm-modal';

        const dialog = document.createElement('div');
        dialog.className = 'pcm-modal__dialog';
        dialog.addEventListener('click', (event) => event.stopPropagation());

        const header = document.createElement('div');
        header.className = 'pcm-modal__header';
        const title = document.createElement('div');
        title.className = 'pcm-title';
        title.textContent = '新增商品配置';
        const closeButton = createButton('取消', 'secondary');
        closeButton.addEventListener('click', closeCreateConfigModal);
        header.appendChild(title);
        header.appendChild(closeButton);

        const body = document.createElement('div');
        body.className = 'pcm-modal__body';

        const productRow = document.createElement('div');
        productRow.className = 'pcm-row';
        const productLabel = document.createElement('label');
        productLabel.textContent = '商品ID';
        const productInput = createInput('pcm-create-product-id', '输入商品ID');
        productRow.appendChild(productLabel);
        productRow.appendChild(productInput);

        const titleRow = document.createElement('div');
        titleRow.className = 'pcm-row';
        const titleLabel = document.createElement('label');
        titleLabel.textContent = '标题';
        const titleInput = createInput('pcm-create-title', '输入发布标题');
        titleRow.appendChild(titleLabel);
        titleRow.appendChild(titleInput);

        const contentRow = document.createElement('div');
        contentRow.className = 'pcm-row';
        const contentLabel = document.createElement('label');
        contentLabel.textContent = '内容';
        const contentInput = createTextarea('pcm-create-content', '输入内容文本，仅用于配置持久化', 4);
        contentRow.appendChild(contentLabel);
        contentRow.appendChild(contentInput);

        const declarationRow = document.createElement('div');
        declarationRow.className = 'pcm-row';
        const declarationLabel = document.createElement('label');
        declarationLabel.textContent = '声明';
        const declarationInput = createSelect('pcm-create-declaration');
        declarationRow.appendChild(declarationLabel);
        declarationRow.appendChild(declarationInput);

        const folderRow = document.createElement('div');
        folderRow.className = 'pcm-row';
        const folderLabel = document.createElement('label');
        folderLabel.textContent = '视频文件夹';
        const folderBar = document.createElement('div');
        folderBar.className = 'pcm-folder-bar';
        const folderButton = createButton('选择视频文件夹', 'secondary');
        const folderHint = document.createElement('div');
        folderHint.className = 'pcm-folder-hint';
        folderHint.textContent = '未选择视频文件夹';
        folderButton.addEventListener('click', async () => {
            applyCardEditorValuesToForm(productInput.value.trim(), {
                productId: productInput.value.trim(),
                title: titleInput.value,
                content: contentInput.value,
                declaration: declarationInput.value,
                videoFolderPath: getFormEl('pcm-folder-path')?.value || ''
            });
            await openDirectoryPickerForCurrentProduct();
            syncCreateConfigModalFolderDisplay();
        });
        folderBar.appendChild(folderButton);
        folderBar.appendChild(folderHint);
        folderRow.appendChild(folderLabel);
        folderRow.appendChild(folderBar);

        body.appendChild(productRow);
        body.appendChild(titleRow);
        body.appendChild(contentRow);
        body.appendChild(declarationRow);
        body.appendChild(folderRow);

        const footer = document.createElement('div');
        footer.className = 'pcm-modal__footer';
        const cancelButton = createButton('取消', 'secondary');
        cancelButton.addEventListener('click', closeCreateConfigModal);
        const confirmButton = createButton('确认创建', 'primary');
        confirmButton.addEventListener('click', () => {
            applyCardEditorValuesToForm(productInput.value.trim(), {
                productId: productInput.value.trim(),
                title: titleInput.value,
                content: contentInput.value,
                declaration: declarationInput.value,
                videoFolderPath: getFormEl('pcm-folder-path')?.value || ''
            });
            state.cardCollapsedMap[productInput.value.trim()] = true;
            saveCurrentConfig();
            if (getFormEl('pcm-product-id')?.value.trim()) {
                closeCreateConfigModal();
                syncCreateConfigModalFolderDisplay();
            }
        });
        footer.appendChild(cancelButton);
        footer.appendChild(confirmButton);

        dialog.appendChild(header);
        dialog.appendChild(body);
        dialog.appendChild(footer);
        modal.appendChild(dialog);
        modal.addEventListener('click', closeCreateConfigModal);

        root.appendChild(modal);
        state.createModalEl = modal;
        state.createModalFields = {
            productId: productInput,
            title: titleInput,
            content: contentInput,
            declaration: declarationInput,
            folderHint
        };

        if (!state.rootEl?.dataset.createModalKeybound) {
            document.addEventListener('keydown', (event) => {
                if (event.key === 'Escape' && state.createModalEl?.classList.contains('is-open')) {
                    closeCreateConfigModal();
                }
            });
            root.dataset.createModalKeybound = 'true';
        }
    }

    function createRootV2() {
        const root = document.createElement('section');
        root.id = ROOT_ID;

        const title = document.createElement('div');
        title.className = 'pcm-title';
        title.textContent = '商品配置面板';
        root.appendChild(title);

        const batchControlCard = createBatchControlCard();
        state.batchControlEl = batchControlCard;
        root.appendChild(batchControlCard);

        createHiddenFormShell(root);
        createCreateConfigModal(root);

        const status = document.createElement('div');
        status.className = 'pcm-status';
        status.textContent = '等待商品配置任务';
        state.statusEl = status;
        root.appendChild(status);

        const listToolbar = document.createElement('div');
        listToolbar.className = 'pcm-list-toolbar';
        state.listToolbarEl = listToolbar;
        root.appendChild(listToolbar);

        const list = document.createElement('div');
        list.className = 'pcm-list';
        state.listEl = list;
        root.appendChild(list);

        state.rootEl = root;
        syncHiddenBatchFormFields();
        return root;
    }

    function ensureHiddenDirectoryInput() {
        if (state.hiddenDirectoryInput) return;
        const input = document.createElement('input');
        input.type = 'file';
        input.multiple = true;
        input.hidden = true;
        input.setAttribute('webkitdirectory', '');
        input.setAttribute('directory', '');
        input.addEventListener('change', handleFolderSelected);
        document.body.appendChild(input);
        state.hiddenDirectoryInput = input;
    }

    async function mount(hostPanel, mountContainer) {
        state.hostPanel = hostPanel || document.getElementById('videoWorkbench-root');
        if (!state.hostPanel) return;

        ensureHiddenDirectoryInput();
        const targetContainer = mountContainer
            || state.hostPanel.querySelector('#video-workbench-product-tab')
            || state.hostPanel.querySelector('.ws-body');
        if (!targetContainer) return;

        if (!state.mounted) {
            injectStyles();
            await loadSnapshotsFromDb();

            const root = createRootV2();
            targetContainer.appendChild(root);
            state.mounted = true;
            renderConfigListV2();
            updateFolderHint();
            return;
        }

        if (state.rootEl && state.rootEl.parentElement !== targetContainer) {
            targetContainer.appendChild(state.rootEl);
        }

        renderConfigListV2();
        updateFolderHint();
    }

    function syncUi() {
        renderConfigListV2();
        updateFolderHint();
    }

    window.PddModules = window.PddModules || {};
    window.PddModules.productConfigManager = {
        mount,
        syncUi,
        onLog,
        emitLog,
        getResolvedVideoFiles,
        getGlobalBatchConfig
    };
})();
