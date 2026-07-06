(function () {
  'use strict';

  window.PddModules = window.PddModules || {};

  let isRunning = false;
  let isPaused = false;
  let cleanedCount = 0;

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function getPanel() {
    return document.getElementById('clean-module-root');
  }

  function getStartButton() {
    return document.getElementById('clean-module-start');
  }

  function getPauseButton() {
    return document.getElementById('clean-module-pause');
  }

  function getStopButton() {
    return document.getElementById('clean-module-stop');
  }

  function getStatusElement() {
    return document.getElementById('clean-module-status');
  }

  function getLogList() {
    return document.getElementById('clean-module-log-list');
  }

  function updateStatus(message) {
    const statusEl = getStatusElement();
    if (statusEl) {
      statusEl.textContent = message;
    }
  }

  function addLog(message, type) {
    const logList = getLogList();
    if (!logList) return;

    if (logList.children.length > 80) {
      logList.removeChild(logList.lastChild);
    }

    const now = new Date();
    const time = `${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}:${now.getSeconds().toString().padStart(2, '0')}`;

    const item = document.createElement('div');
    item.className = `log-item log-${type || 'info'}`;
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
    messageSpan.textContent = message;

    item.appendChild(timeSpan);
    item.appendChild(messageSpan);
    logList.prepend(item);
    logList.scrollTop = 0;
  }

  function getCfg(id, defaultValue) {
    const el = document.getElementById(id);
    if (!el) return defaultValue;
    if (el.type === 'checkbox') return el.checked;
    const value = parseInt(el.value, 10);
    return Number.isNaN(value) ? defaultValue : value;
  }

  async function checkPause() {
    while (isPaused && isRunning) {
      updateStatus('清理流程已暂停，等待恢复...');
      await sleep(500);
    }
  }

  function showPanel() {
    const panel = getPanel();
    if (!panel) return;
    panel.style.display = 'flex';
    panel.style.zIndex = '2147483646';
  }

  function resetPauseButton() {
    const pauseButton = getPauseButton();
    if (!pauseButton) return;
    pauseButton.textContent = '暂停';
    pauseButton.style.background = '#f1c40f';
  }

  const handleCleanStart = async function () {
    isRunning = true;
    isPaused = false;
    cleanedCount = 0;
    this.disabled = true;
    resetPauseButton();

    const chks = Array.from(document.querySelectorAll('.cfg-clean-chk')).filter((c) => c.checked).map((c) => c.value);
    const custom = document.getElementById('clean-custom')?.value.trim() || '';
    const activeKeywords = [...chks];
    if (custom) activeKeywords.push(custom);

    const minDelay = getCfg('cfg-clean-min', 1000);
    const maxDelay = getCfg('cfg-clean-max', 3000);
    const limit = getCfg('cfg-clean-limit', 60);

    addLog(`开始清理：${activeKeywords.join('+')}`, 'info');

    while (isRunning && cleanedCount < limit) {
      await checkPause();

      const target = Array.from(document.querySelectorAll('span, div, p, strong')).find((el) => el.innerText && activeKeywords.includes(el.innerText.trim()) && el.children.length === 0 && el.offsetHeight > 0);
      if (!target) {
        addLog('页面已无匹配项', 'info');
        break;
      }

      let row = target.parentElement;
      let safe = 0;
      while (row && !row.innerText.includes('删除') && safe < 15) {
        row = row.parentElement;
        safe++;
      }

      if (row) {
        const deleteButton = Array.from(row.querySelectorAll('button, span, a')).find((el) => el.innerText?.trim() === '删除');
        if (deleteButton) {
          deleteButton.click();
          await sleep(1000);
          const confirmButton = Array.from(document.querySelectorAll('button')).find((el) => (el.innerText.includes('确定') || el.classList.contains('ant-btn-primary')) && el.offsetHeight > 0);
          if (confirmButton) {
            confirmButton.click();
            cleanedCount += 1;
            addLog(`删除成功：${target.innerText}（${cleanedCount}）`, 'success');
          }
        }
      }

      await sleep(Math.floor(Math.random() * (maxDelay - minDelay + 1) + minDelay));
    }

    isRunning = false;
    isPaused = false;
    this.disabled = false;
    resetPauseButton();
    updateStatus('清理流程结束');
  };

  function bindStartButton() {
    const startButton = getStartButton();
    if (!startButton || startButton.dataset.cleanServiceBound === 'true') return;

    startButton.dataset.cleanServiceBound = 'true';
    startButton.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopImmediatePropagation();
      window.PddModules.cleanService.run();
    });
  }

  function bindPauseButton() {
    const pauseButton = getPauseButton();
    if (!pauseButton || pauseButton.dataset.cleanServiceBound === 'true') return;

    pauseButton.dataset.cleanServiceBound = 'true';
    pauseButton.addEventListener('click', (event) => {
      if (!isRunning) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      isPaused = !isPaused;
      pauseButton.textContent = isPaused ? '继续' : '暂停';
      pauseButton.style.background = isPaused ? '#27ae60' : '#f1c40f';
    }, true);
  }

  function bindStopButton() {
    const stopButton = getStopButton();
    if (!stopButton || stopButton.dataset.cleanServiceBound === 'true') return;

    stopButton.dataset.cleanServiceBound = 'true';
    stopButton.addEventListener('click', (event) => {
      if (!isRunning) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (window.confirm('确定要终止清理流程吗？')) {
        isRunning = false;
        isPaused = false;
        addLog('用户手动终止', 'error');
        updateStatus('已终止');
        resetPauseButton();
      }
    }, true);
  }

  function bindUi() {
    bindStartButton();
    bindPauseButton();
    bindStopButton();
  }

  window.PddModules.cleanService = {
    bindUi,
    openView() {
      bindUi();
      showPanel();
    },
    run() {
      bindUi();
      const startButton = getStartButton();
      if (!startButton) {
        console.error('[PDD插件] 未找到批量删除开始按钮');
        return;
      }
      return handleCleanStart.call(startButton);
    }
  };
})();
