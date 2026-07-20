(function () {
  'use strict';

  const ROOT_ID = 'pdd-data-manager-root';
  const PRODUCT_CONFIG_STORAGE_KEY = 'pdd_product_config_manager_configs';
  const BATCH_CONFIG_STORAGE_KEY = 'pdd_product_config_manager_batch_config';
  const UPLOAD_PROGRESS_KEY = 'pdd_video_upload_progress_v1';
  const WORKBENCH_MEMORY_KEY = 'pdd_video_helper_memory';
  const WORKBENCH_DELAY_CONFIG_KEY = 'pdd_video_workbench_delay_config';
  const VIDEO_MONITOR_STORAGE_KEY = 'PDD_VIDEO_DATA_FINAL_V1';
  const DB_NAME = 'pdd-product-config-manager';
  const DB_VERSION = 4;
  const SNAPSHOT_STORE = 'folderSnapshots';
  const HANDLE_STORE = 'folderHandles';
  const LEGACY_FILE_STORE = 'resolvedVideoFiles';

  const KNOWN_LOCAL_STORAGE_KEYS = [
    PRODUCT_CONFIG_STORAGE_KEY,
    BATCH_CONFIG_STORAGE_KEY,
    UPLOAD_PROGRESS_KEY,
    WORKBENCH_MEMORY_KEY,
    WORKBENCH_DELAY_CONFIG_KEY
  ];

  function parseLocalStorageJson(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (error) {
      return {
        parseError: error?.message || String(error || ''),
        raw: localStorage.getItem(key)
      };
    }
  }

  function writeLocalStorageJson(key, value) {
    localStorage.setItem(key, JSON.stringify(value));
  }

  function mergeByProductId(currentRows, importedRows) {
    const map = new Map();
    (Array.isArray(currentRows) ? currentRows : []).forEach((row) => {
      if (row?.productId) map.set(String(row.productId), row);
    });
    (Array.isArray(importedRows) ? importedRows : []).forEach((row) => {
      if (row?.productId) map.set(String(row.productId), row);
    });
    return Array.from(map.values());
  }

  function mergePlainObject(currentValue, importedValue) {
    if (!importedValue || typeof importedValue !== 'object' || Array.isArray(importedValue)) {
      return currentValue;
    }
    return {
      ...(currentValue && typeof currentValue === 'object' && !Array.isArray(currentValue) ? currentValue : {}),
      ...importedValue
    };
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
        if (db.objectStoreNames.contains(LEGACY_FILE_STORE)) {
          db.deleteObjectStore(LEGACY_FILE_STORE);
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  async function readDbStoreRows(storeName) {
    try {
      const db = await openDb();
      return await new Promise((resolve, reject) => {
        const transaction = db.transaction(storeName, 'readonly');
        const store = transaction.objectStore(storeName);
        const request = store.getAll();
        request.onsuccess = () => resolve(request.result || []);
        request.onerror = () => reject(request.error);
      });
    } catch (error) {
      return {
        error: error?.message || String(error || '')
      };
    }
  }

  async function upsertDbRows(storeName, rows) {
    if (!Array.isArray(rows) || !rows.length) return 0;
    const db = await openDb();
    return await new Promise((resolve, reject) => {
      const transaction = db.transaction(storeName, 'readwrite');
      const store = transaction.objectStore(storeName);
      let count = 0;
      rows.forEach((row) => {
        if (!row?.productId) return;
        store.put(row);
        count += 1;
      });
      transaction.oncomplete = () => resolve(count);
      transaction.onerror = () => reject(transaction.error);
    });
  }

  async function queryDirectoryPermissionState(handle) {
    if (!handle?.queryPermission) return 'unsupported';
    try {
      return await handle.queryPermission({ mode: 'read' });
    } catch (error) {
      return 'error';
    }
  }

  async function collectDirectoryHandleExportRows(rows) {
    if (!Array.isArray(rows)) return rows;
    const exportedRows = [];
    for (const row of rows) {
      exportedRows.push({
        productId: row?.productId || '',
        folderName: row?.folderName || '',
        updatedAt: row?.updatedAt || null,
        hasHandle: Boolean(row?.handle),
        permission: row?.handle ? await queryDirectoryPermissionState(row.handle) : 'missing'
      });
    }
    return exportedRows;
  }

  function collectKnownLocalStorageData() {
    return KNOWN_LOCAL_STORAGE_KEYS.reduce((data, key) => {
      data[key] = parseLocalStorageJson(key, null);
      return data;
    }, {});
  }

  function collectPddLocalStorageDump() {
    const dump = {};
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index);
      if (!/^pdd_|^PDD_/i.test(key || '')) continue;
      dump[key] = parseLocalStorageJson(key, localStorage.getItem(key));
    }
    return dump;
  }

  function formatTimestamp(date = new Date()) {
    const pad = (value) => String(value).padStart(2, '0');
    return [
      date.getFullYear(),
      pad(date.getMonth() + 1),
      pad(date.getDate())
    ].join('') + '-' + [
      pad(date.getHours()),
      pad(date.getMinutes()),
      pad(date.getSeconds())
    ].join('');
  }

  function downloadJsonFile(data, fileName) {
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = fileName;
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function readJsonFile(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        try {
          resolve(JSON.parse(String(reader.result || '{}')));
        } catch (error) {
          reject(error);
        }
      };
      reader.onerror = () => reject(reader.error);
      reader.readAsText(file, 'utf-8');
    });
  }

  function getExtensionVersion() {
    return typeof chrome !== 'undefined' && chrome.runtime?.getManifest
      ? chrome.runtime.getManifest().version
      : '';
  }

  window.PddModules = window.PddModules || {};
  window.PddModules.dataManager = {
    inited: false,
    panelEl: null,
    selectedImportFile: null,

    log(message, type = 'info') {
      const status = this.panelEl?.querySelector('#pdd-data-manager-status');
      if (status) {
        status.textContent = message;
        status.dataset.type = type;
      }
      const list = this.panelEl?.querySelector('#pdd-data-manager-log');
      if (!list) return;
      const item = document.createElement('div');
      item.className = `pdd-data-manager-log-item is-${type}`;
      item.textContent = `[${new Date().toLocaleTimeString()}] ${message}`;
      list.appendChild(item);
      list.scrollTop = list.scrollHeight;
    },

    async exportAllSavedData() {
      try {
        const snapshotRows = await readDbStoreRows(SNAPSHOT_STORE);
        const handleRows = await readDbStoreRows(HANDLE_STORE);
        const monitorHistory = window.PddStorage
          ? await window.PddStorage.get(VIDEO_MONITOR_STORAGE_KEY, [])
          : null;
        const exportData = {
          exportType: 'pdd-extension-saved-data',
          exportVersion: 1,
          exportedAt: new Date().toISOString(),
          extensionVersion: getExtensionVersion(),
          localStorage: collectKnownLocalStorageData(),
          localStorageDump: collectPddLocalStorageDump(),
          chromeStorageLocal: {
            [VIDEO_MONITOR_STORAGE_KEY]: monitorHistory
          },
          indexedDb: {
            name: DB_NAME,
            version: DB_VERSION,
            [SNAPSHOT_STORE]: snapshotRows,
            [HANDLE_STORE]: await collectDirectoryHandleExportRows(handleRows)
          },
          notes: [
            'Directory handles cannot be restored by import because browsers do not allow exporting reusable file-system permissions.',
            'Imported folder snapshots keep folder names and video metadata, but folders may still need to be selected again.'
          ]
        };
        const fileName = `pdd-extension-saved-data-${formatTimestamp()}.json`;
        downloadJsonFile(exportData, fileName);
        const productCount = Array.isArray(exportData.localStorage[PRODUCT_CONFIG_STORAGE_KEY])
          ? exportData.localStorage[PRODUCT_CONFIG_STORAGE_KEY].length
          : 0;
        const snapshotCount = Array.isArray(snapshotRows) ? snapshotRows.length : 0;
        const monitorCount = Array.isArray(monitorHistory) ? monitorHistory.length : 0;
        this.log(`导出完成：商品 ${productCount}，目录快照 ${snapshotCount}，监控存档 ${monitorCount}`, 'success');
      } catch (error) {
        this.log(`导出失败：${error?.message || error}`, 'error');
      }
    },

    async importSavedData(file) {
      if (!file) {
        this.log('请先选择导入文件', 'error');
        return;
      }
      try {
        const data = await readJsonFile(file);
        if (data?.exportType !== 'pdd-extension-saved-data') {
          this.log('导入文件格式不匹配', 'error');
          return;
        }
        if (!window.confirm('确定导入保存数据吗？相同商品 ID 的配置会以导入文件为准，目录权限仍需重新授权。')) {
          return;
        }

        const importedLocal = data.localStorage || {};
        const currentConfigs = parseLocalStorageJson(PRODUCT_CONFIG_STORAGE_KEY, []);
        const importedConfigs = importedLocal[PRODUCT_CONFIG_STORAGE_KEY];
        if (Array.isArray(importedConfigs)) {
          writeLocalStorageJson(PRODUCT_CONFIG_STORAGE_KEY, mergeByProductId(currentConfigs, importedConfigs));
        }

        [
          BATCH_CONFIG_STORAGE_KEY,
          WORKBENCH_DELAY_CONFIG_KEY
        ].forEach((key) => {
          if (importedLocal[key] && typeof importedLocal[key] === 'object') {
            writeLocalStorageJson(key, importedLocal[key]);
          }
        });

        [
          UPLOAD_PROGRESS_KEY,
          WORKBENCH_MEMORY_KEY
        ].forEach((key) => {
          if (importedLocal[key] && typeof importedLocal[key] === 'object') {
            const currentValue = parseLocalStorageJson(key, {});
            writeLocalStorageJson(key, mergePlainObject(currentValue, importedLocal[key]));
          }
        });

        const monitorHistory = data.chromeStorageLocal?.[VIDEO_MONITOR_STORAGE_KEY];
        if (window.PddStorage && Array.isArray(monitorHistory)) {
          await window.PddStorage.set(VIDEO_MONITOR_STORAGE_KEY, monitorHistory);
        }

        const snapshots = data.indexedDb?.[SNAPSHOT_STORE];
        const importedSnapshotCount = await upsertDbRows(SNAPSHOT_STORE, Array.isArray(snapshots) ? snapshots : []);

        window.PddModules?.productConfigManager?.syncUi?.();
        this.log(`导入完成：商品配置 ${Array.isArray(importedConfigs) ? importedConfigs.length : 0}，目录快照 ${importedSnapshotCount}，监控存档 ${Array.isArray(monitorHistory) ? monitorHistory.length : 0}`, 'success');
        this.log('提示：目录授权无法从文件恢复，需要时请重新选择视频文件夹', 'info');
      } catch (error) {
        this.log(`导入失败：${error?.message || error}`, 'error');
      }
    },

    injectStyles() {
      const cssText = `
        #${ROOT_ID} {
          position: fixed;
          right: 96px;
          top: 96px;
          width: 420px;
          max-height: calc(100vh - 140px);
          display: none;
          flex-direction: column;
          background: #fff;
          border: 1px solid #d9d9d9;
          border-radius: 10px;
          box-shadow: 0 16px 42px rgba(0,0,0,0.22);
          z-index: 2147483646;
          overflow: hidden;
          font-family: sans-serif;
        }
        #${ROOT_ID} .pdd-data-manager-header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          padding: 12px 14px;
          background: #f6f8fa;
          border-bottom: 1px solid #e5e7eb;
          cursor: move;
          font-weight: 700;
          color: #1f2937;
        }
        #${ROOT_ID} .pdd-data-manager-close {
          cursor: pointer;
          font-size: 18px;
          line-height: 1;
        }
        #${ROOT_ID} .pdd-data-manager-body {
          display: grid;
          gap: 10px;
          padding: 12px;
          overflow: auto;
        }
        #${ROOT_ID} .pdd-data-manager-section {
          border: 1px solid #e5e7eb;
          border-radius: 8px;
          padding: 10px;
          display: grid;
          gap: 8px;
        }
        #${ROOT_ID} .pdd-data-manager-title {
          font-size: 13px;
          font-weight: 700;
          color: #374151;
        }
        #${ROOT_ID} .pdd-data-manager-copy {
          margin: 0;
          font-size: 12px;
          line-height: 1.5;
          color: #6b7280;
        }
        #${ROOT_ID} .pdd-data-manager-actions {
          display: flex;
          gap: 8px;
          flex-wrap: wrap;
        }
        #${ROOT_ID} button {
          border: 0;
          border-radius: 7px;
          padding: 8px 11px;
          color: #fff;
          cursor: pointer;
          font-size: 12px;
          font-weight: 700;
          background: #1677ff;
        }
        #${ROOT_ID} button.secondary {
          background: #6b7280;
        }
        #${ROOT_ID} .pdd-data-manager-file {
          font-size: 12px;
          color: #374151;
          word-break: break-all;
        }
        #${ROOT_ID} .pdd-data-manager-status {
          padding: 8px 10px;
          border-radius: 8px;
          background: #f8fafc;
          border: 1px solid #e5e7eb;
          font-size: 12px;
          color: #374151;
        }
        #${ROOT_ID} .pdd-data-manager-status[data-type="error"] {
          color: #b91c1c;
        }
        #${ROOT_ID} .pdd-data-manager-status[data-type="success"] {
          color: #047857;
        }
        #${ROOT_ID} .pdd-data-manager-log {
          max-height: 150px;
          overflow: auto;
          padding: 8px;
          border-radius: 8px;
          background: #f8fafc;
          border: 1px solid #e5e7eb;
          font-size: 11px;
          line-height: 1.5;
          color: #4b5563;
        }
        #${ROOT_ID} .pdd-data-manager-log-item.is-error {
          color: #b91c1c;
        }
        #${ROOT_ID} .pdd-data-manager-log-item.is-success {
          color: #047857;
        }
      `;
      window.PddSharedStyle?.addStyle?.(cssText);
    },

    bindDrag(panel) {
      const header = panel.querySelector('.pdd-data-manager-header');
      let dragging = false;
      let offsetX = 0;
      let offsetY = 0;
      header.addEventListener('mousedown', (event) => {
        if (event.target.closest('.pdd-data-manager-close')) return;
        dragging = true;
        offsetX = event.clientX - panel.offsetLeft;
        offsetY = event.clientY - panel.offsetTop;
        document.onmousemove = (moveEvent) => {
          if (!dragging) return;
          panel.style.left = `${moveEvent.clientX - offsetX}px`;
          panel.style.top = `${moveEvent.clientY - offsetY}px`;
          panel.style.right = 'auto';
        };
        document.onmouseup = () => {
          dragging = false;
        };
      });
    },

    init() {
      if (this.inited) return;
      this.inited = true;
      this.injectStyles();
      const panel = document.createElement('div');
      panel.id = ROOT_ID;
      panel.dataset.pddModule = 'data-manager';
      panel.innerHTML = `
        <div class="pdd-data-manager-header">
          <span>数据导入导出</span>
          <span class="pdd-data-manager-close">×</span>
        </div>
        <div class="pdd-data-manager-body">
          <section class="pdd-data-manager-section">
            <div class="pdd-data-manager-title">导出全部保存数据</div>
            <p class="pdd-data-manager-copy">导出商品配置、批次设置、断点记录、标题历史、视频监控存档和目录快照。</p>
            <div class="pdd-data-manager-actions">
              <button type="button" id="pdd-data-export-all">导出全部数据</button>
            </div>
          </section>
          <section class="pdd-data-manager-section">
            <div class="pdd-data-manager-title">导入保存数据</div>
            <p class="pdd-data-manager-copy">导入会合并数据；相同商品 ID 的配置以导入文件为准。目录权限无法从文件恢复。</p>
            <input type="file" id="pdd-data-import-file" accept="application/json,.json" hidden>
            <div class="pdd-data-manager-file" id="pdd-data-import-name">未选择文件</div>
            <div class="pdd-data-manager-actions">
              <button type="button" class="secondary" id="pdd-data-select-file">选择导入文件</button>
              <button type="button" id="pdd-data-import-run">导入所选文件</button>
            </div>
          </section>
          <div class="pdd-data-manager-status" id="pdd-data-manager-status">等待操作</div>
          <div class="pdd-data-manager-log" id="pdd-data-manager-log"></div>
        </div>
      `;
      document.body.appendChild(panel);
      this.panelEl = panel;
      this.bindDrag(panel);

      panel.querySelector('.pdd-data-manager-close').addEventListener('click', () => this.hide());
      panel.querySelector('#pdd-data-export-all').addEventListener('click', () => this.exportAllSavedData());
      panel.querySelector('#pdd-data-select-file').addEventListener('click', () => {
        panel.querySelector('#pdd-data-import-file').click();
      });
      panel.querySelector('#pdd-data-import-file').addEventListener('change', (event) => {
        this.selectedImportFile = event.target.files?.[0] || null;
        panel.querySelector('#pdd-data-import-name').textContent = this.selectedImportFile?.name || '未选择文件';
      });
      panel.querySelector('#pdd-data-import-run').addEventListener('click', () => {
        this.importSavedData(this.selectedImportFile);
      });
    },

    show() {
      this.init();
      this.panelEl.style.display = 'flex';
      this.panelEl.style.zIndex = '2147483646';
    },

    hide() {
      if (!this.panelEl) return;
      this.panelEl.style.display = 'none';
    }
  };
})();
