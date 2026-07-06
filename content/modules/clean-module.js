(function () {
  'use strict';

  const ROOT_ID = 'clean-module-root';

  window.PddModules = window.PddModules || {};

  function getCleanService() {
    const moduleApi = window.PddModules?.cleanService;
    if (!moduleApi) {
      console.error('[PDD插件] cleanService 模块不存在');
      return null;
    }

    return moduleApi;
  }

  window.PddModules.cleanModule = {
    inited: false,
    panelEl: null,
    init() {
      if (this.inited) return;
      this.inited = true;

      const existingPanel = document.getElementById(ROOT_ID);
      if (existingPanel) {
        this.panelEl = existingPanel;
        return;
      }

      const cssText = `
        #${ROOT_ID} {
          position: fixed;
          top: 80px;
          right: 360px;
          z-index: 2147483646;
          width: 320px;
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
        #${ROOT_ID} .clean-header {
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
        #${ROOT_ID} .clean-body {
          padding: 12px;
          overflow-y: auto;
          max-height: 70vh;
        }
        #${ROOT_ID} .clean-label {
          font-size: 11px;
          font-weight: bold;
          color: #555;
          margin-bottom: 6px;
          display: block;
          border-left: 3px solid #ff4d4f;
          padding-left: 5px;
        }
        #${ROOT_ID} .clean-row {
          display: flex;
          justify-content: space-between;
          align-items: center;
          margin-bottom: 6px;
          font-size: 11px;
        }
        #${ROOT_ID} .clean-input {
          width: 100%;
          padding: 7px;
          border: 1px solid #ddd;
          border-radius: 6px;
          margin-bottom: 8px;
          box-sizing: border-box;
          font-size: 12px;
        }
        #${ROOT_ID} .clean-row-input {
          width: 60px;
          padding: 2px;
          text-align: center;
          border: 1px solid #ccc;
          border-radius: 4px;
        }
        #${ROOT_ID} .clean-btn {
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
        #${ROOT_ID} .clean-start { background: #ff4d4f; }
        #${ROOT_ID} .clean-controls {
          display: flex;
          gap: 4px;
          padding: 0 12px 10px 12px;
        }
        #${ROOT_ID} .clean-pause {
          background: #f1c40f;
          color: #333;
          flex: 1;
          margin: 0;
        }
        #${ROOT_ID} .clean-stop {
          background: #e74c3c;
          color: #fff;
          flex: 1;
          margin: 0;
        }
        #${ROOT_ID} .clean-status {
          padding: 8px;
          background: #f9f9f9;
          border-top: 1px solid #eee;
          font-size: 11px;
          color: #333;
          text-align: center;
          font-weight: bold;
        }
        #${ROOT_ID} .clean-log-panel {
          border-top: 1px solid #ddd;
          background: #fff;
          display: flex;
          flex-direction: column;
        }
        #${ROOT_ID} .clean-log-header {
          padding: 6px 10px;
          font-size: 11px;
          font-weight: bold;
          background: #eee;
          cursor: pointer;
          display: flex;
          justify-content: space-between;
        }
        #${ROOT_ID} .clean-log-body {
          height: 150px;
          overflow-y: auto;
          padding: 5px;
          display: block;
          background: #fafafa;
        }
      `;
      window.PddSharedStyle.addStyle(cssText);

      const panel = document.createElement('div');
      panel.id = ROOT_ID;
      panel.dataset.pddModule = 'clean-module';
      panel.innerHTML = `
        <div class="clean-header">
          <span id="clean-module-title">批量删除</span>
          <div>
            <span id="clean-module-close" style="cursor:pointer; font-size: 18px; line-height: 1;">×</span>
          </div>
        </div>
        <div class="clean-body">
          <span class="clean-label">状态选择</span>
          <div class="clean-row"><span>审核失败:</span><input type="checkbox" class="cfg-clean-chk" value="审核失败" checked></div>
          <div class="clean-row"><span>审核中:</span><input type="checkbox" class="cfg-clean-chk" value="审核中"></div>
          <div class="clean-row"><span>审核通过:</span><input type="checkbox" class="cfg-clean-chk" value="审核通过"></div>
          <input type="text" class="clean-input" id="clean-custom" placeholder="自定义文本（如：违规）...">
          <div class="clean-row">
            <span>随机延时:</span>
            <div><input type="number" class="clean-row-input" id="cfg-clean-min" value="636" style="width:40px"> - <input type="number" class="clean-row-input" id="cfg-clean-max" value="883" style="width:40px"></div>
          </div>
          <div class="clean-row"><span>单次上限:</span><input type="number" class="clean-row-input" id="cfg-clean-limit" value="60"></div>
          <button class="clean-btn clean-start" id="clean-module-start">开始清理</button>
        </div>
        <div class="clean-controls">
          <button class="clean-btn clean-pause" id="clean-module-pause">暂停</button>
          <button class="clean-btn clean-stop" id="clean-module-stop">停止</button>
        </div>
        <div class="clean-status" id="clean-module-status">等待指令...</div>
        <div class="clean-log-panel">
          <div class="clean-log-header" id="clean-module-log-toggle">执行日志 <span id="clean-module-log-arrow">▼</span></div>
          <div class="clean-log-body" id="clean-module-log-list"></div>
        </div>
      `;

      document.body.appendChild(panel);
      this.panelEl = panel;

      document.getElementById('clean-module-close').onclick = () => {
        panel.style.display = 'none';
      };

      document.getElementById('clean-module-log-toggle').onclick = () => {
        const body = document.getElementById('clean-module-log-list');
        const isHidden = body.style.display === 'none';
        body.style.display = isHidden ? 'block' : 'none';
        document.getElementById('clean-module-log-arrow').textContent = isHidden ? '▲' : '▼';
      };

      let isDraggingPanel = false;
      let ox;
      let oy;
      panel.querySelector('.clean-header').onmousedown = (e) => {
        if (e.target.closest('#clean-module-close')) return;
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
    openView() {
      this.init();
      const cleanService = getCleanService();
      if (!cleanService?.openView) return;
      return cleanService.openView();
    },
    start() {
      const cleanService = getCleanService();
      if (!cleanService?.run) return;
      return cleanService.run();
    },
    show() {
      this.openView();
    },
    hide() {
      if (!this.panelEl) return;
      this.panelEl.style.display = 'none';
    }
  };
})();
