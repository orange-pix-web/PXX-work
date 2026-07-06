(function () {
  'use strict';

  window.PddModules = window.PddModules || {};

  const ROUTE = 'live.pinduoduo.com/n-creator/video/video-manage';
  const STORAGE_PREFIX = 'videoManageDelete_v5_';

  window.PddModules.videoManageDelete = {
    inited: false,
    panelEl: null,

    async init() {
      if (this.inited) return;
      if (!window.location.href.includes(ROUTE)) return;
      this.inited = true;

      const moduleApi = this;
      const DEFAULTS = {
        intervalSeconds: 1.5,
        confirmDelaySeconds: 0.8,
        loopCount: 0,
        auditFilter: 'failed',
        autoNextPage: false,
        pageWaitSeconds: 2
      };

      let intervalSeconds = Number(await window.PddStorage.get(`${STORAGE_PREFIX}intervalSeconds`, DEFAULTS.intervalSeconds));
      let confirmDelaySeconds = Number(await window.PddStorage.get(`${STORAGE_PREFIX}confirmDelaySeconds`, DEFAULTS.confirmDelaySeconds));
      let loopCount = Number(await window.PddStorage.get(`${STORAGE_PREFIX}loopCount`, DEFAULTS.loopCount));
      let auditFilter = await window.PddStorage.get(`${STORAGE_PREFIX}auditFilter`, DEFAULTS.auditFilter);
      let autoNextPage = Boolean(await window.PddStorage.get(`${STORAGE_PREFIX}autoNextPage`, DEFAULTS.autoNextPage));
      let pageWaitSeconds = Number(await window.PddStorage.get(`${STORAGE_PREFIX}pageWaitSeconds`, DEFAULTS.pageWaitSeconds));
      let running = false;
      let stopRequested = false;
      let deletedCount = 0;
      let failedCount = 0;
      let attempts = 0;
      let logs = [];

      const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

      function injectStyle() {
        if (document.getElementById('pdd-video-manage-delete-css')) return;
        const style = window.PddSharedStyle.addStyle(`
          #pdd-video-manage-delete-window {
            position: fixed !important; top: 90px; left: 110px; width: 430px; max-height: 88vh;
            display: none; flex-direction: column; overflow: hidden; z-index: 2147483646 !important;
            border: 1px solid #ddd; border-radius: 12px; background: #fff;
            box-shadow: 0 12px 40px rgba(0,0,0,.25); color: #222;
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
          }
          #pdd-video-manage-delete-header {
            display: flex; align-items: center; justify-content: space-between; padding: 12px 16px;
            border-bottom: 1px solid #eee; background: #f7f7f7; cursor: move; user-select: none;
          }
          #pdd-video-manage-delete-header strong { font-size: 15px; }
          #pdd-video-manage-delete-close { border: 0; background: transparent; color: #888; cursor: pointer; font-size: 22px; line-height: 1; }
          #pdd-video-manage-delete-content { padding: 16px; overflow-y: auto; }
          .pdd-video-manage-delete-label { display: block; margin: 0 0 6px; color: #333; font-size: 13px; font-weight: 700; }
          .pdd-video-manage-delete-input, .pdd-video-manage-delete-select { width: 100%; box-sizing: border-box; margin-bottom: 5px; padding: 9px 10px; border: 1px solid #d9d9d9; border-radius: 6px; outline: none; font-size: 13px; background:#fff; }
          .pdd-video-manage-delete-input:focus, .pdd-video-manage-delete-select:focus { border-color: #e02e24; box-shadow: 0 0 0 2px rgba(224,46,36,.1); }
          .pdd-video-manage-delete-help { margin: 0 0 14px; color: #888; font-size: 11px; line-height: 1.55; }
          .pdd-video-manage-delete-check-row { display:flex; align-items:center; gap:8px; margin:2px 0 8px; padding:9px 10px; border:1px solid #e5e5e5; border-radius:6px; background:#fafafa; font-size:13px; cursor:pointer; }
          .pdd-video-manage-delete-check-row input { width:16px; height:16px; margin:0; accent-color:#e02e24; }
          .pdd-video-manage-delete-warning { margin-bottom: 14px; padding: 10px 12px; border: 1px solid #ffd8bf; border-radius: 6px; background: #fff7e6; color: #ad4e00; font-size: 12px; line-height: 1.55; }
          .pdd-video-manage-delete-actions { display: flex; gap: 10px; }
          .pdd-video-manage-delete-btn { flex: 1; padding: 10px 0; border: 0; border-radius: 6px; color: #fff; cursor: pointer; font-size: 14px; font-weight: 700; }
          #pdd-video-manage-delete-start { background: #e02e24; }
          #pdd-video-manage-delete-stop { background: #888; }
          .pdd-video-manage-delete-btn:disabled { opacity: .55; cursor: not-allowed; }
          #pdd-video-manage-delete-status { margin-top: 12px; padding: 8px 10px; border-radius: 6px; background: #f5f5f5; font-size: 12px; }
          #pdd-video-manage-delete-log { height: 180px; margin-top: 10px; overflow-y: auto; padding: 8px 10px; border: 1px solid #eee; border-radius: 6px; background: #fafafa; font-size: 11px; line-height: 1.6; white-space: pre-wrap; word-break: break-all; }
          .pdd-video-manage-delete-log-item { padding: 2px 0; border-bottom: 1px dashed #eee; }
        `);
        style.id = 'pdd-video-manage-delete-css';
      }

      function addLog(message, type = 'info') {
        const icon = type === 'success' ? '✅' : type === 'error' ? '❌' : type === 'warning' ? '⚠️' : 'ℹ️';
        const text = `[${new Date().toLocaleTimeString()}] ${icon} ${message}`;
        console.log(`[PDD插件] ${text}`);
        logs.push(text);
        if (logs.length > 200) logs = logs.slice(-200);
        const logEl = document.getElementById('pdd-video-manage-delete-log');
        if (logEl) {
          logEl.textContent = logs.join('\n');
          logEl.scrollTop = logEl.scrollHeight;
        }
      }

      function updateStatus() {
        const statusEl = document.getElementById('pdd-video-manage-delete-status');
        if (statusEl) statusEl.textContent = `${running ? '运行中' : '已停止'}｜成功 ${deletedCount}｜失败/跳过 ${failedCount}`;
      }

      function getRows() {
        return Array.from(document.querySelectorAll('tbody tr[data-testid="beast-core-table-body-tr"]'));
      }

      function cleanText(element) {
        if (!element) return '';
        const clone = element.cloneNode(true);
        clone.querySelectorAll('style, script').forEach((node) => node.remove());
        return clone.textContent.replace(/\s+/g, ' ').trim();
      }

      function getRowTitle(row, index = 0) {
        const titleRoot = row.querySelector('.tableStyle_top__SyhMv [data-testid="beast-core-ellipsis"]') ||
          row.querySelector('[data-testid="beast-core-ellipsis"]');
        return cleanText(titleRoot) || `第${index + 1}行视频`;
      }

      function getAuditStatus(row) {
        const statusElement = row.querySelector('[class*="video-manage_status"]');
        const text = cleanText(statusElement);
        if (/审核失败|未通过/.test(text)) return { key: 'failed', label: text || '审核失败' };
        if (/审核通过|审核成功/.test(text)) return { key: 'passed', label: text || '审核通过' };
        return { key: 'unknown', label: text || '状态未知' };
      }

      function matchesAuditFilter(row) {
        if (auditFilter === 'all') return true;
        return getAuditStatus(row).key === auditFilter;
      }

      function getTargetRows() {
        return getRows().filter(matchesAuditFilter);
      }

      function filterLabel(value = auditFilter) {
        if (value === 'passed') return '审核通过';
        if (value === 'failed') return '审核失败';
        return '全部状态';
      }

      function findDeleteButton(row) {
        const textNode = Array.from(row.querySelectorAll('a [class*="video-manage_btnText"], a span'))
          .find((el) => cleanText(el) === '删除');
        if (textNode) return textNode.closest('a[data-testid="beast-core-button-link"]') || textNode.closest('a') || textNode;
        return Array.from(row.querySelectorAll('a, button'))
          .find((el) => el.offsetParent !== null && cleanText(el) === '删除') || null;
      }

      function findConfirmButton() {
        const primary = Array.from(document.querySelectorAll('[data-testid="beast-core-modal-ok-button"]'))
          .find((el) => el.offsetParent !== null && !el.disabled);
        if (primary) return primary;
        return Array.from(document.querySelectorAll('div[role="dialog"] button, .anq-btn-dangerous, .ant-btn-primary'))
          .find((el) => el.offsetParent !== null && !el.disabled && /确定|删除|确认/.test(cleanText(el))) || null;
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

      async function deleteOneRow(row) {
        row.scrollIntoView({ behavior: 'smooth', block: 'center' });
        await wait(300);
        if (stopRequested) return false;

        const deleteBtn = findDeleteButton(row);
        if (!deleteBtn) throw new Error('未找到删除按钮');
        deleteBtn.click();

        const confirmBtn = await waitFor(findConfirmButton, 5000);
        if (!confirmBtn) throw new Error('未找到确认删除按钮');

        if (confirmDelaySeconds > 0) {
          addLog(`等待 ${confirmDelaySeconds} 秒后确认删除`);
          await wait(confirmDelaySeconds * 1000);
          if (stopRequested) return false;
        }

        confirmBtn.click();
        return true;
      }

      async function readSettings() {
        intervalSeconds = Math.max(0.2, Number(document.getElementById('pdd-video-manage-delete-interval')?.value) || DEFAULTS.intervalSeconds);
        confirmDelaySeconds = Math.max(0, Number(document.getElementById('pdd-video-manage-delete-confirm-delay')?.value) || 0);
        loopCount = Math.max(0, Math.floor(Number(document.getElementById('pdd-video-manage-delete-loop')?.value) || 0));
        auditFilter = document.getElementById('pdd-video-manage-delete-audit-filter')?.value || DEFAULTS.auditFilter;
        autoNextPage = Boolean(document.getElementById('pdd-video-manage-delete-auto-next')?.checked);
        pageWaitSeconds = Math.max(0.2, Number(document.getElementById('pdd-video-manage-delete-page-wait')?.value) || DEFAULTS.pageWaitSeconds);
        await Promise.all([
          window.PddStorage.set(`${STORAGE_PREFIX}intervalSeconds`, intervalSeconds),
          window.PddStorage.set(`${STORAGE_PREFIX}confirmDelaySeconds`, confirmDelaySeconds),
          window.PddStorage.set(`${STORAGE_PREFIX}loopCount`, loopCount),
          window.PddStorage.set(`${STORAGE_PREFIX}auditFilter`, auditFilter),
          window.PddStorage.set(`${STORAGE_PREFIX}autoNextPage`, autoNextPage),
          window.PddStorage.set(`${STORAGE_PREFIX}pageWaitSeconds`, pageWaitSeconds)
        ]);
      }

      function isDisabledElement(element) {
        if (!element) return true;
        const classText = String(element.className || '');
        return Boolean(
          element.disabled ||
          element.getAttribute('aria-disabled') === 'true' ||
          /disabled/i.test(classText) ||
          element.closest('[aria-disabled="true"], [class*="disabled"], .disabled')
        );
      }

      function findNextPageButton() {
        const selectors = [
          '[data-testid="beast-core-pagination-next"]',
          '[aria-label="下一页"]',
          '[aria-label="Next page"]',
          'li[class*="PGT_next_"]',
          'button[class*="next"]',
          'a[class*="next"]'
        ];
        for (const selector of selectors) {
          const element = Array.from(document.querySelectorAll(selector))
            .find((el) => el.offsetParent !== null && !isDisabledElement(el));
          if (element) return element;
        }
        return Array.from(document.querySelectorAll('button, a, li, div[role="button"]'))
          .find((el) => el.offsetParent !== null && !isDisabledElement(el) && /^(下一页|Next|›|>)$/i.test(cleanText(el))) || null;
      }

      function pageSignature() {
        return getRows().map((row, index) => {
          const title = getRowTitle(row, index);
          const publish = cleanText(row.querySelector('[class*="tableStyle_publish"]'));
          return `${title}|${publish}`;
        }).join('||');
      }

      async function goToNextPage() {
        const nextButton = findNextPageButton();
        if (!nextButton) return false;
        const beforeSignature = pageSignature();
        nextButton.scrollIntoView({ behavior: 'smooth', block: 'center' });
        await wait(200);
        nextButton.click();
        addLog(`已点击下一页，等待 ${pageWaitSeconds} 秒加载`);
        await wait(pageWaitSeconds * 1000);
        if (stopRequested) return false;
        const changed = await waitFor(() => {
          const rows = getRows();
          return rows.length > 0 && pageSignature() !== beforeSignature;
        }, Math.max(1000, pageWaitSeconds * 1000), 150);
        if (!changed) addLog('翻页后未检测到列表变化，将按当前页面重新检查', 'warning');
        return true;
      }

      async function runDelete() {
        if (running) return addLog('任务已经在运行中', 'warning');
        await readSettings();

        const allRows = getRows();
        const targetRows = getTargetRows();
        if (allRows.length === 0) return addLog('未找到视频行，请确认视频管理列表已经加载', 'error');
        if (targetRows.length === 0 && !autoNextPage) return addLog(`当前页没有“${filterLabel()}”视频，任务结束`, 'success');

        const confirmed = window.confirm(`即将执行不可恢复的视频批量删除。\n删除范围：${filterLabel()}\n当前页共 ${allRows.length} 条，匹配 ${targetRows.length} 条\n删除到确认间隔：${confirmDelaySeconds} 秒\n确认删除后等待：${intervalSeconds} 秒\n自动翻页：${autoNextPage ? `开启（翻页等待 ${pageWaitSeconds} 秒）` : '关闭'}\n循环次数：${loopCount === 0 ? '直到匹配视频为空' : loopCount + ' 次'}\n是否继续？`);
        if (!confirmed) return addLog('用户取消了批量删除');

        deletedCount = 0;
        failedCount = 0;
        attempts = 0;
        running = true;
        stopRequested = false;
        const startBtn = document.getElementById('pdd-video-manage-delete-start');
        if (startBtn) startBtn.disabled = true;
        updateStatus();
        addLog(`开始执行，范围 ${filterLabel()}，确认后等待 ${intervalSeconds} 秒，确认间隔 ${confirmDelaySeconds} 秒，自动翻页 ${autoNextPage ? '开启' : '关闭'}，循环 ${loopCount === 0 ? '不限' : loopCount + ' 次'}`);

        let failedRows = new WeakSet();

        while (!stopRequested) {
          if (loopCount > 0 && attempts >= loopCount) {
            addLog(`已达到循环次数，任务结束：成功 ${deletedCount}，失败/跳过 ${failedCount}`, 'success');
            break;
          }

          const currentRows = getRows();
          const rawTargetRows = currentRows.filter(matchesAuditFilter);
          const candidates = rawTargetRows.filter((row) => !failedRows.has(row));

          // 每确认删除一条后，系统会在当前页自动补入下一条。
          // 因此这里始终重新扫描当前页并直接处理第一条匹配视频，
          // 不等待 DOM 节点变化，也不把成功处理过的节点加入跳过集合。
          if (rawTargetRows.length === 0 || currentRows.length === 0) {
            if (autoNextPage) {
              addLog(`当前页已没有“${filterLabel()}”视频，准备进入下一页`);
              const moved = await goToNextPage();
              if (moved) {
                failedRows = new WeakSet();
                continue;
              }
              addLog(`已到最后一页，任务结束`, 'success');
            } else {
              addLog(`当前页已没有“${filterLabel()}”视频，任务结束`, 'success');
            }
            break;
          }

          if (candidates.length === 0) {
            addLog(`当前页剩余 ${rawTargetRows.length} 条匹配视频均曾执行失败，已停止以避免重复点击`, 'warning');
            break;
          }

          const row = candidates[0];
          const title = getRowTitle(row, currentRows.indexOf(row));
          const audit = getAuditStatus(row);
          attempts += 1;
          addLog(`正在删除 ${title}｜${audit.label}｜当前匹配 ${rawTargetRows.length} 条`);

          try {
            const clicked = await deleteOneRow(row);
            if (!clicked && stopRequested) break;

            deletedCount += 1;
            updateStatus();
            addLog(`已确认删除 ${title}，等待 ${intervalSeconds} 秒后继续`, 'success');
            if (intervalSeconds > 0) await wait(intervalSeconds * 1000);
            if (stopRequested) break;
            addLog('重新扫描当前页，继续删除下一条匹配视频');
          } catch (error) {
            failedCount += 1;
            failedRows.add(row);
            updateStatus();
            document.body.click();
            addLog(`${title} 删除失败：${error.message}，已跳过该行并继续`, 'error');
            if (intervalSeconds > 0) await wait(intervalSeconds * 1000);
          }
        }

        running = false;
        if (startBtn) startBtn.disabled = false;
        updateStatus();
        if (stopRequested) addLog(`任务已停止：成功 ${deletedCount}，失败/跳过 ${failedCount}`, 'warning');
        else addLog(`任务结束：成功 ${deletedCount}，失败/跳过 ${failedCount}`, 'success');
      }

      async function startDelete() {
        return runDelete();
      }

      async function stopDelete() {
        stopRequested = true;
        running = false;
        const startBtn = document.getElementById('pdd-video-manage-delete-start');
        if (startBtn) startBtn.disabled = false;
        updateStatus();
        addLog('任务已停止', 'warning');
      }

      function createPanel() {
        if (document.getElementById('pdd-video-manage-delete-window')) return;
        injectStyle();
        const panel = document.createElement('div');
        panel.id = 'pdd-video-manage-delete-window';
        panel.innerHTML = `
          <div id="pdd-video-manage-delete-header">
            <strong>视频管理批量删除</strong>
            <button id="pdd-video-manage-delete-close" type="button" aria-label="关闭">×</button>
          </div>
          <div id="pdd-video-manage-delete-content">
            <div class="pdd-video-manage-delete-warning">删除不可恢复。确认删除后等待你设置的时间并重新读取当前列表；每确认删除一条后会直接重新扫描当前页并继续下一条；只有当前页已经没有所选状态的视频时才会翻页。本模块不会主动刷新页面。</div>
            <label class="pdd-video-manage-delete-label" for="pdd-video-manage-delete-audit-filter">删除范围</label>
            <select id="pdd-video-manage-delete-audit-filter" class="pdd-video-manage-delete-select">
              <option value="failed" ${auditFilter === 'failed' ? 'selected' : ''}>仅审核失败</option>
              <option value="passed" ${auditFilter === 'passed' ? 'selected' : ''}>仅审核通过</option>
              <option value="all" ${auditFilter === 'all' ? 'selected' : ''}>全部状态</option>
            </select>
            <div class="pdd-video-manage-delete-help">根据每行状态文字识别“审核失败”或“审核通过/审核成功”。默认仅删除审核失败。</div>
            <label class="pdd-video-manage-delete-label" for="pdd-video-manage-delete-interval">确认删除后等待时间（秒）</label>
            <input id="pdd-video-manage-delete-interval" class="pdd-video-manage-delete-input" type="number" min="0.2" step="0.1" value="${intervalSeconds}">
            <div class="pdd-video-manage-delete-help">点击确认删除后固定等待此时间，结束后立即重新读取列表，不再额外等待刷新检测。</div>
            <label class="pdd-video-manage-delete-label" for="pdd-video-manage-delete-confirm-delay">点击删除到确认删除间隔（秒）</label>
            <input id="pdd-video-manage-delete-confirm-delay" class="pdd-video-manage-delete-input" type="number" min="0" step="0.1" value="${confirmDelaySeconds}">
            <div class="pdd-video-manage-delete-help">删除弹窗出现后，等待多久再点击确认。</div>
            <label class="pdd-video-manage-delete-label" for="pdd-video-manage-delete-loop">循环次数</label>
            <input id="pdd-video-manage-delete-loop" class="pdd-video-manage-delete-input" type="number" min="0" step="1" value="${loopCount}">
            <div class="pdd-video-manage-delete-help">填 0 表示持续删除。当前页会一直删除，直到没有所选状态的视频后才结束或翻页。</div>
            <label class="pdd-video-manage-delete-check-row" for="pdd-video-manage-delete-auto-next">
              <input id="pdd-video-manage-delete-auto-next" type="checkbox" ${autoNextPage ? 'checked' : ''}>
              <span>当前页确认没有所选状态视频后自动翻页</span>
            </label>
            <label class="pdd-video-manage-delete-label" for="pdd-video-manage-delete-page-wait">翻页后等待时间（秒）</label>
            <input id="pdd-video-manage-delete-page-wait" class="pdd-video-manage-delete-input" type="number" min="0.2" step="0.1" value="${pageWaitSeconds}">
            <div class="pdd-video-manage-delete-help">仅开启自动翻页时生效。点击下一页后等待页面加载，再继续识别视频。</div>
            <div class="pdd-video-manage-delete-actions">
              <button id="pdd-video-manage-delete-start" class="pdd-video-manage-delete-btn" type="button">开始删除</button>
              <button id="pdd-video-manage-delete-stop" class="pdd-video-manage-delete-btn" type="button">停止</button>
            </div>
            <div id="pdd-video-manage-delete-status">已停止｜成功 0｜失败/跳过 0</div>
            <div id="pdd-video-manage-delete-log"></div>
          </div>`;
        document.body.appendChild(panel);
        moduleApi.panelEl = panel;

        document.getElementById('pdd-video-manage-delete-close').addEventListener('click', () => { panel.style.display = 'none'; });
        document.getElementById('pdd-video-manage-delete-start').addEventListener('click', startDelete);
        document.getElementById('pdd-video-manage-delete-stop').addEventListener('click', stopDelete);

        let dragging = false;
        let offsetX = 0;
        let offsetY = 0;
        const header = document.getElementById('pdd-video-manage-delete-header');
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
        document.addEventListener('mouseup', () => { dragging = false; });
        addLog('模块已加载，请选择删除范围、等待时间、循环次数和是否自动翻页');
      }

      createPanel();
    },

    show() {
      if (this.panelEl) this.panelEl.style.display = 'flex';
    }
  };
})();
