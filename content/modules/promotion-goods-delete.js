(function () {
  'use strict';

  window.PddModules = window.PddModules || {};

  const ROUTE = 'yingxiao.pinduoduo.com/goods/promotion/list';
  const STORAGE_PREFIX = 'promotionGoodsDelete_v1_';

  window.PddModules.promotionGoodsDelete = {
    inited: false,
    panelEl: null,

    async init() {
      if (this.inited) return;
      if (!window.location.href.includes(ROUTE)) return;
      this.inited = true;

      const moduleApi = this;
      const DEFAULTS = {
        intervalSeconds: 2,
        confirmDelaySeconds: 0.6,
        loopCount: 0
      };

      let intervalSeconds = Number(await window.PddStorage.get(`${STORAGE_PREFIX}intervalSeconds`, DEFAULTS.intervalSeconds));
      let confirmDelaySeconds = Number(await window.PddStorage.get(`${STORAGE_PREFIX}confirmDelaySeconds`, DEFAULTS.confirmDelaySeconds));
      let loopCount = Number(await window.PddStorage.get(`${STORAGE_PREFIX}loopCount`, DEFAULTS.loopCount));
      let running = false;
      let stopRequested = false;
      let deletedCount = 0;
      let failedCount = 0;
      let logs = [];

      const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

      function injectStyle() {
        if (document.getElementById('pdd-promotion-delete-css')) return;
        const style = window.PddSharedStyle.addStyle(`
          #pdd-promotion-delete-window {
            position: fixed !important;
            top: 110px;
            left: 110px;
            width: 420px;
            max-height: 80vh;
            display: none;
            flex-direction: column;
            overflow: hidden;
            z-index: 2147483646 !important;
            border: 1px solid #ddd;
            border-radius: 12px;
            background: #fff;
            box-shadow: 0 12px 40px rgba(0,0,0,.25);
            color: #222;
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
          }
          #pdd-promotion-delete-header {
            display: flex;
            align-items: center;
            justify-content: space-between;
            padding: 12px 16px;
            border-bottom: 1px solid #eee;
            background: #f7f7f7;
            cursor: move;
            user-select: none;
          }
          #pdd-promotion-delete-header strong { font-size: 15px; }
          #pdd-promotion-delete-close {
            border: 0;
            background: transparent;
            color: #888;
            cursor: pointer;
            font-size: 22px;
            line-height: 1;
          }
          #pdd-promotion-delete-content {
            padding: 16px;
            overflow-y: auto;
          }
          .pdd-promotion-delete-label {
            display: block;
            margin: 0 0 6px;
            color: #333;
            font-size: 13px;
            font-weight: 700;
          }
          .pdd-promotion-delete-input {
            width: 100%;
            box-sizing: border-box;
            margin-bottom: 5px;
            padding: 9px 10px;
            border: 1px solid #d9d9d9;
            border-radius: 6px;
            outline: none;
            font-size: 13px;
          }
          .pdd-promotion-delete-input:focus {
            border-color: #e02e24;
            box-shadow: 0 0 0 2px rgba(224,46,36,.1);
          }
          .pdd-promotion-delete-help {
            margin: 0 0 14px;
            color: #888;
            font-size: 11px;
            line-height: 1.55;
          }
          .pdd-promotion-delete-warning {
            margin-bottom: 14px;
            padding: 10px 12px;
            border: 1px solid #ffd8bf;
            border-radius: 6px;
            background: #fff7e6;
            color: #ad4e00;
            font-size: 12px;
            line-height: 1.55;
          }
          .pdd-promotion-delete-actions {
            display: flex;
            gap: 10px;
          }
          .pdd-promotion-delete-btn {
            flex: 1;
            padding: 10px 0;
            border: 0;
            border-radius: 6px;
            color: #fff;
            cursor: pointer;
            font-size: 14px;
            font-weight: 700;
          }
          #pdd-promotion-delete-start { background: #e02e24; }
          #pdd-promotion-delete-stop { background: #888; }
          .pdd-promotion-delete-btn:disabled { opacity: .55; cursor: not-allowed; }
          #pdd-promotion-delete-status {
            margin-top: 12px;
            padding: 8px 10px;
            border-radius: 6px;
            background: #f5f5f5;
            font-size: 12px;
          }
          #pdd-promotion-delete-log {
            height: 180px;
            margin-top: 10px;
            overflow-y: auto;
            padding: 8px 10px;
            border: 1px solid #eee;
            border-radius: 6px;
            background: #fafafa;
            font-size: 11px;
            line-height: 1.6;
            white-space: pre-wrap;
            word-break: break-all;
          }
          .pdd-promotion-delete-log-item { padding: 2px 0; border-bottom: 1px dashed #eee; }
        `);
        style.id = 'pdd-promotion-delete-css';
      }

      function addLog(message, type = 'info') {
        const icon = type === 'success' ? '✅' : type === 'error' ? '❌' : type === 'warning' ? '⚠️' : 'ℹ️';
        const text = `[${new Date().toLocaleTimeString()}] ${icon} ${message}`;
        console.log(`[PDD插件] ${text}`);
        logs.push(text);
        if (logs.length > 200) logs = logs.slice(-200);
        const logEl = document.getElementById('pdd-promotion-delete-log');
        if (logEl) {
          logEl.innerHTML = logs.map((line) => {
            const item = document.createElement('div');
            item.className = 'pdd-promotion-delete-log-item';
            item.textContent = line;
            return item.outerHTML;
          }).join('');
          logEl.scrollTop = logEl.scrollHeight;
        }
      }

      function updateStatus() {
        const statusEl = document.getElementById('pdd-promotion-delete-status');
        if (!statusEl) return;
        statusEl.textContent = `${running ? '运行中' : '已停止'}｜成功 ${deletedCount}｜失败/跳过 ${failedCount}`;
      }

      function getRows() {
        return Array.from(document.querySelectorAll('tr.anq-table-row[data-row-key]'));
      }

      function findVisibleDeleteOption() {
        const candidates = Array.from(document.querySelectorAll('.OperationsRow_moreOperationsItem__kUoKt'));
        return candidates.find((item) => item.offsetParent !== null && item.textContent.trim() === '删除') || null;
      }

      function findVisibleConfirmButton() {
        const selectors = [
          '.anq-modal-new-footer .anq-btn-dangerous',
          '.anq-modal-new .anq-btn-dangerous'
        ];
        for (const selector of selectors) {
          const btn = Array.from(document.querySelectorAll(selector)).find((el) => el.offsetParent !== null && !el.disabled);
          if (btn) return btn;
        }
        return Array.from(document.querySelectorAll('.anq-modal-new-footer button'))
          .find((btn) => btn.offsetParent !== null && btn.textContent.trim() === '确定删除' && !btn.disabled) || null;
      }

      async function waitFor(predicate, timeoutMs = 5000, intervalMs = 100) {
        const startedAt = Date.now();
        while (Date.now() - startedAt < timeoutMs) {
          if (stopRequested) return null;
          const result = predicate();
          if (result) return result;
          await wait(intervalMs);
        }
        return null;
      }

      async function waitForRowRemoved(rowKey, originalCount, timeoutMs = 8000) {
        return Boolean(await waitFor(() => {
          const rows = getRows();
          const rowStillExists = rows.some((row) => row.dataset.rowKey === rowKey);
          return !rowStillExists || rows.length < originalCount;
        }, timeoutMs, 150));
      }

      async function deleteOneRow(row) {
        const rowKey = row.dataset.rowKey || '未知商品';
        const beforeCount = getRows().length;
        row.scrollIntoView({ behavior: 'smooth', block: 'center' });
        await wait(400);
        if (stopRequested) return false;

        const moreBtn = row.querySelector('[data-testid="OperationsRow_More"]');
        if (!moreBtn) throw new Error('未找到“更多”按钮');
        moreBtn.click();

        const deleteOption = await waitFor(findVisibleDeleteOption, 4000);
        if (!deleteOption) throw new Error('未找到“删除”选项');
        deleteOption.click();

        if (confirmDelaySeconds > 0) {
          addLog(`等待 ${confirmDelaySeconds} 秒后确认删除`);
          await wait(confirmDelaySeconds * 1000);
          if (stopRequested) return false;
        }

        const confirmBtn = await waitFor(findVisibleConfirmButton, 5000);
        if (!confirmBtn) throw new Error('未找到“确定删除”按钮');
        confirmBtn.click();

        const removed = await waitForRowRemoved(rowKey, beforeCount);
        if (!removed) throw new Error('点击确认后商品行未消失，可能删除失败或页面响应超时');
        return true;
      }

      async function startDelete() {
        if (running) {
          addLog('任务已经在运行中', 'warning');
          return;
        }

        intervalSeconds = Math.max(0.2, Number(document.getElementById('pdd-promotion-delete-interval')?.value) || DEFAULTS.intervalSeconds);
        confirmDelaySeconds = Math.max(0, Number(document.getElementById('pdd-promotion-delete-confirm-delay')?.value) || 0);
        loopCount = Math.max(0, Math.floor(Number(document.getElementById('pdd-promotion-delete-loop')?.value) || 0));
        await window.PddStorage.set(`${STORAGE_PREFIX}intervalSeconds`, intervalSeconds);
        await window.PddStorage.set(`${STORAGE_PREFIX}confirmDelaySeconds`, confirmDelaySeconds);
        await window.PddStorage.set(`${STORAGE_PREFIX}loopCount`, loopCount);

        const initialRows = getRows();
        if (initialRows.length === 0) {
          addLog('未找到商品行，请确认列表已经加载并且当前页存在商品', 'error');
          return;
        }

        const confirmed = window.confirm(`即将执行不可恢复的批量删除。\n当前可见商品：${initialRows.length} 个\n删除后确认等待：${confirmDelaySeconds} 秒\n本次循环次数：${loopCount === 0 ? '直到当前列表为空' : loopCount + ' 次'}\n是否继续？`);
        if (!confirmed) {
          addLog('用户取消了批量删除');
          return;
        }

        running = true;
        stopRequested = false;
        deletedCount = 0;
        failedCount = 0;
        document.getElementById('pdd-promotion-delete-start').disabled = true;
        updateStatus();
        addLog(`开始执行，商品间隔 ${intervalSeconds} 秒，删除到确认间隔 ${confirmDelaySeconds} 秒，循环 ${loopCount === 0 ? '不限' : loopCount + ' 次'}`);

        let attempts = 0;
        let consecutiveFailures = 0;
        const skippedKeys = new Set();

        try {
          while (!stopRequested && (loopCount === 0 || attempts < loopCount)) {
            const rows = getRows();
            if (rows.length === 0) {
              addLog('当前列表已无商品，任务完成', 'success');
              break;
            }

            const row = rows.find((item) => !skippedKeys.has(item.dataset.rowKey)) || rows[0];
            const rowKey = row.dataset.rowKey || `第${attempts + 1}项`;
            attempts += 1;
            addLog(`正在删除 ${rowKey}，当前可见 ${rows.length} 个`);

            try {
              await deleteOneRow(row);
              deletedCount += 1;
              consecutiveFailures = 0;
              skippedKeys.delete(rowKey);
              addLog(`已删除 ${rowKey}`, 'success');
            } catch (error) {
              failedCount += 1;
              consecutiveFailures += 1;
              skippedKeys.add(rowKey);
              document.body.click();
              addLog(`${rowKey} 删除失败：${error.message}`, 'error');

              if (consecutiveFailures >= Math.min(5, rows.length)) {
                addLog('连续多个商品删除失败，已自动停止，避免无限循环。请检查页面结构或弹窗状态', 'warning');
                break;
              }
            }

            updateStatus();
            if (!stopRequested && (loopCount === 0 || attempts < loopCount)) {
              await wait(intervalSeconds * 1000);
            }
          }
        } finally {
          running = false;
          document.getElementById('pdd-promotion-delete-start').disabled = false;
          updateStatus();
          addLog(stopRequested ? '任务已手动停止' : `任务结束：成功 ${deletedCount}，失败/跳过 ${failedCount}`, stopRequested ? 'warning' : 'success');
        }
      }

      function stopDelete() {
        if (!running) {
          addLog('当前没有正在运行的任务', 'warning');
          return;
        }
        stopRequested = true;
        addLog('已请求停止，将在当前步骤结束后停止', 'warning');
      }

      function createPanel() {
        if (document.getElementById('pdd-promotion-delete-window')) return;
        injectStyle();

        const panel = document.createElement('div');
        panel.id = 'pdd-promotion-delete-window';
        panel.innerHTML = `
          <div id="pdd-promotion-delete-header">
            <strong>营销商品批量删除</strong>
            <button id="pdd-promotion-delete-close" type="button" aria-label="关闭">×</button>
          </div>
          <div id="pdd-promotion-delete-content">
            <div class="pdd-promotion-delete-warning">删除操作不可恢复。运行前请确认筛选条件和商品范围正确；单个商品失败时会记录并跳过，不会立即中断整个任务。</div>

            <label class="pdd-promotion-delete-label" for="pdd-promotion-delete-interval">操作时间间隔（秒）</label>
            <input id="pdd-promotion-delete-interval" class="pdd-promotion-delete-input" type="number" min="0.2" step="0.1" value="${intervalSeconds}">
            <div class="pdd-promotion-delete-help">每次商品删除完成后等待的时间。建议不少于 1 秒。</div>

            <label class="pdd-promotion-delete-label" for="pdd-promotion-delete-confirm-delay">点击删除到确认删除间隔（秒）</label>
            <input id="pdd-promotion-delete-confirm-delay" class="pdd-promotion-delete-input" type="number" min="0" step="0.1" value="${confirmDelaySeconds}">
            <div class="pdd-promotion-delete-help">点击菜单中的“删除”后，等待多久再点击弹窗中的“确定删除”。</div>

            <label class="pdd-promotion-delete-label" for="pdd-promotion-delete-loop">循环次数</label>
            <input id="pdd-promotion-delete-loop" class="pdd-promotion-delete-input" type="number" min="0" step="1" value="${loopCount}">
            <div class="pdd-promotion-delete-help">每次循环处理一个商品；填 0 表示持续处理，直到当前列表为空或手动停止。</div>

            <div class="pdd-promotion-delete-actions">
              <button id="pdd-promotion-delete-start" class="pdd-promotion-delete-btn" type="button">开始删除</button>
              <button id="pdd-promotion-delete-stop" class="pdd-promotion-delete-btn" type="button">停止</button>
            </div>

            <div id="pdd-promotion-delete-status">已停止｜成功 0｜失败/跳过 0</div>
            <div id="pdd-promotion-delete-log"></div>
          </div>
        `;
        document.body.appendChild(panel);
        moduleApi.panelEl = panel;

        document.getElementById('pdd-promotion-delete-close').addEventListener('click', () => {
          panel.style.display = 'none';
        });
        document.getElementById('pdd-promotion-delete-start').addEventListener('click', startDelete);
        document.getElementById('pdd-promotion-delete-stop').addEventListener('click', stopDelete);

        let dragging = false;
        let offsetX = 0;
        let offsetY = 0;
        const header = document.getElementById('pdd-promotion-delete-header');
        header.addEventListener('mousedown', (event) => {
          if (event.target.tagName === 'BUTTON') return;
          dragging = true;
          const rect = panel.getBoundingClientRect();
          offsetX = event.clientX - rect.left;
          offsetY = event.clientY - rect.top;
        });
        document.addEventListener('mousemove', (event) => {
          if (!dragging) return;
          panel.style.left = `${Math.max(0, event.clientX - offsetX)}px`;
          panel.style.top = `${Math.max(0, event.clientY - offsetY)}px`;
        });
        document.addEventListener('mouseup', () => {
          dragging = false;
        });

        addLog('模块已加载，请设置商品间隔、确认间隔与循环次数后开始');
      }

      createPanel();
    },

    show() {
      if (this.panelEl) this.panelEl.style.display = 'flex';
    }
  };
})();
