(function() {
    'use strict';

    window.PddModules = window.PddModules || {};
    window.PddModules.videoMonitor = {
        inited: false,
        panelEl: null,
        init() {
            if (this.inited) return;
            this.inited = true;
            const moduleApi = this;

            const STORAGE_KEY = "PDD_VIDEO_DATA_FINAL_V1";
            let lastCapturedList = [];
            let currentGoodsId = "";
            let isDragging = false;

            // 自动翻页相关变量
            let autoPageDelay = 3000;
            let isAutoPageRunning = false;

            // 排序状态记录
            let sortConfig = {
                key: null,
                direction: 'desc'
            };

            // 数据对比排序相关
            let lastCompareData = {
                goodsId: null,
                snapshotA: null,
                snapshotB: null,
                allVids: [],
                mapA: new Map(),
                mapB: new Map(),
                sortOrder: 'desc'
            };

            // 1. 样式注入（增加上传时间列宽度）
            const injectStyle = () => {
                if (document.getElementById('pdd-monitor-css')) return;
                const cssText = `
                    #pdd-main-window {
                        position: fixed !important; top: 100px; left: 100px;
                        width: 1300px; height: 750px;
                        background: #fff !important; z-index: 9999999999 !important;
                        border-radius: 12px !important; display: none; flex-direction: column;
                        box-shadow: 0 10px 40px rgba(0,0,0,0.3) !important;
                        border: 1px solid #ccc !important; font-family: sans-serif !important;
                        overflow: hidden; resize: both; min-width: 700px; min-height: 400px;
                    }
                    #pdd-drag-handle {
                        padding: 12px 20px; background: #f1f1f1; cursor: move;
                        display: flex; justify-content: space-between; align-items: center;
                        border-bottom: 1px solid #ddd; user-select: none;
                        flex-shrink: 0;
                    }
                    .nav-bar { display: flex; background: #eee; border-bottom: 1px solid #ddd; flex-shrink: 0; }
                    .nav-item { padding: 10px 25px; cursor: pointer; font-weight: bold; font-size: 14px; color: #666; }
                    .nav-item.active { background: #fff; color: #e02020; border-bottom: 2px solid #e02020; }
                    .table-container { flex: 1; overflow-y: auto; overflow-x: auto; position: relative; background: #fff; }
                    .data-table { width: 100%; border-collapse: collapse; table-layout: fixed; min-width: 1000px; }
                    .data-table thead th {
                        background: #fafafa; padding: 12px 5px; border-bottom: 2px solid #eee;
                        font-size: 12px; position: sticky; top: 0; z-index: 10;
                        box-shadow: 0 1px 0 #eee;
                        cursor: pointer;
                        user-select: none;
                        transition: background 0.2s;
                    }
                    .data-table thead th:hover { background: #f0f0f0; }
                    .data-table thead th.sort-active { color: #e02020; }

                    .data-table td { padding: 10px 8px; border-bottom: 1px solid #f0f0f0; text-align: center; font-size: 12px; word-break: break-all; }

                    .compare-table { width: 100%; border-collapse: collapse; min-width: 1100px; }
                    .compare-table th, .compare-table td { padding: 10px 6px; border: 1px solid #eee; text-align: center; font-size: 12px; }
                    .compare-table th { background: #f5f5f5; position: sticky; top: 0; }
                    .compare-table .positive { color: #52c41a; }
                    .compare-table .negative { color: #ff4d4f; }

                    .btn-red { background: #e02020; color: white; border: none; padding: 10px 20px; border-radius: 6px; cursor: pointer; font-weight: bold; }
                    .btn-green { background: #52c41a; color: white; border: none; padding: 10px 20px; border-radius: 6px; cursor: pointer; font-weight: bold; }
                    .btn-gray { background: #aaa; color: white; border: none; padding: 8px 16px; border-radius: 6px; cursor: pointer; }
                    .compare-select { padding: 6px 12px; margin: 0 8px; border-radius: 4px; border: 1px solid #ddd; width: 220px; }

                    .card-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 15px; padding: 15px; }
                    .card { border: 1px solid #eee; padding: 15px; border-radius: 8px; background: #fff; box-shadow: 0 2px 8px rgba(0,0,0,0.05); position: relative; cursor: pointer; }
                    .card:hover { border-color: #e02020; }
                    .card-del { position: absolute; top: 5px; right: 8px; color: #ccc; font-size: 20px; }
                    .card-del:hover { color: #f00; }

                    .compare-panel {
                        padding: 15px;
                        background: #f9f9f9;
                        flex-shrink: 0;
                        border-bottom: 1px solid #eee;
                    }
                    .compare-toolbar {
                        display: flex;
                        align-items: center;
                        justify-content: space-between;
                        flex-wrap: wrap;
                        margin-top: 10px;
                        padding-top: 10px;
                        border-top: 1px solid #eee;
                    }
                    .sort-btn {
                        background: #fff;
                        border: 1px solid #ddd;
                        border-radius: 4px;
                        padding: 4px 12px;
                        cursor: pointer;
                        font-size: 12px;
                    }
                    .sort-btn:hover { background: #f0f0f0; }

                    .compare-result { flex: 1; overflow: auto; padding: 15px; background: #fff; }

                    .his-filter-bar {
                        padding: 10px 15px;
                        background: #f8f8f8;
                        border-bottom: 1px solid #eee;
                        display: flex;
                        align-items: center;
                        gap: 12px;
                        flex-wrap: wrap;
                    }
                    .his-filter-bar label {
                        font-size: 13px;
                        font-weight: bold;
                        color: #555;
                    }
                    .his-filter-bar select {
                        padding: 6px 10px;
                        border-radius: 4px;
                        border: 1px solid #ccc;
                        background: #fff;
                        min-width: 200px;
                    }
                    .his-group-title {
                        font-size: 16px;
                        font-weight: bold;
                        padding: 10px 15px 5px 15px;
                        background: #fafafa;
                        border-top: 1px solid #eee;
                        margin-top: 10px;
                        color: #e02020;
                    }
                    .his-group-title:first-of-type {
                        margin-top: 0;
                        border-top: none;
                    }

                    .autopage-bar {
                        padding: 8px 15px;
                        background: #fef9e6;
                        border-bottom: 1px solid #ffebcc;
                        display: flex;
                        align-items: center;
                        gap: 12px;
                        flex-wrap: wrap;
                        font-size: 13px;
                    }
                    .autopage-bar label {
                        font-weight: bold;
                        color: #d48806;
                    }
                    .autopage-bar input {
                        padding: 4px 8px;
                        width: 80px;
                        border-radius: 4px;
                        border: 1px solid #ffd591;
                    }
                    .autopage-status {
                        color: #e02020;
                        font-weight: bold;
                        margin-left: 8px;
                    }

                    .export-panel {
                        padding: 20px;
                        background: #fff;
                        flex: 1;
                        overflow: auto;
                    }
                    .export-section {
                        background: #f9f9f9;
                        border-radius: 8px;
                        padding: 15px;
                        margin-bottom: 20px;
                        border: 1px solid #eee;
                    }
                    .export-section h3 {
                        margin: 0 0 12px 0;
                        font-size: 16px;
                        color: #e02020;
                    }
                    .export-buttons {
                        display: flex;
                        gap: 12px;
                        flex-wrap: wrap;
                    }
                    .export-buttons button {
                        padding: 8px 16px;
                        cursor: pointer;
                        border: none;
                        border-radius: 4px;
                        background: #e02020;
                        color: white;
                    }
                    .export-buttons button:hover { opacity: 0.9; }
                `;
                const style = window.PddSharedStyle.addStyle(cssText);
                style.id = 'pdd-monitor-css';
            };

            // 2. 视觉锚点识别法 - 深度获取商品ID
            const getGoodsId = () => {
                let foundId = "";
                const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null, false);
                let node;
                while(node = walker.nextNode()){
                    const text = node.textContent.trim();
                    const match = text.match(/ID[:：\s]*(\d{10,15})/);
                    if(match){
                        foundId = match[1];
                        if(node.parentElement.closest('[class*="modal"], [class*="Modal"], [class*="MDL_"]')){
                           return foundId;
                        }
                    }
                }
                if(!foundId){
                    const allElements = document.querySelectorAll('div, span, p');
                    for (let el of allElements) {
                        if (el.children.length === 0 && /^\d{10,15}$/.test(el.innerText)) {
                           foundId = el.innerText;
                           if(el.closest('[class*="modal"], [class*="Modal"]')) return foundId;
                        }
                    }
                }
                return foundId;
            };

            // 3. 拖拽逻辑
            function enableDrag(el) {
                const handle = document.getElementById('pdd-drag-handle');
                let offsetX, offsetY;
                handle.addEventListener('mousedown', (e) => {
                    if (e.target.tagName === 'BUTTON' || (e.target.tagName === 'SPAN' && e.target.id === 'pdd-close')) return;
                    isDragging = true;
                    offsetX = e.clientX - el.offsetLeft;
                    offsetY = e.clientY - el.offsetTop;
                    el.style.transition = 'none';
                });
                document.addEventListener('mousemove', (e) => {
                    if (!isDragging) return;
                    el.style.left = (e.clientX - offsetX) + 'px';
                    el.style.top = (e.clientY - offsetY) + 'px';
                });
                document.addEventListener('mouseup', () => { isDragging = false; });
            }

            // 辅助: 解析数值（支持万、k等）
            function parseNumeric(val) {
                if (val === undefined || val === null) return 0;
                if (typeof val === 'number') return val;
                let str = val.toString().trim();
                if (str === "" || str === "-") return 0;
                let multiplier = 1;
                if (str.includes('万') || str.includes('w')) multiplier = 10000;
                if (str.includes('亿')) multiplier = 100000000;
                let num = parseFloat(str.replace(/[^\d.-]/g, '')) || 0;
                return num * multiplier;
            }

            function formatDiff(oldVal, newVal) {
                let oldNum = parseNumeric(oldVal);
                let newNum = parseNumeric(newVal);
                let diff = newNum - oldNum;
                if (diff === 0) return '持平';
                let prefix = diff > 0 ? '+' : '';
                let absDiff = Math.abs(diff);
                let displayDiff;
                if (absDiff >= 10000) {
                    displayDiff = (diff / 10000).toFixed(1) + '万';
                } else {
                    displayDiff = Math.round(diff);
                }
                let cls = diff > 0 ? 'positive' : 'negative';
                return `<span class="${cls}">${prefix}${displayDiff}</span>`;
            }

            function formatValue(val) {
                if (!val && val !== 0) return '-';
                return val;
            }

            // ================= 自动翻页核心逻辑 =================
            function getModalRoot() {
                let modal = document.querySelector('[data-testid="beast-core modal"]');
                if (modal) return modal;
                modal = document.querySelector('.beast-core-modal-content');
                if (modal) return modal;
                modal = document.querySelector('.MDL_outerWrapper_5-180-0');
                return modal;
            }

            function getNextPageButton() {
                const modal = getModalRoot();
                if (!modal) return null;

                let nextBtn = modal.querySelector('li[class*="PGT_next_"]:not([class*="PGT_disabled_"])');
                if (nextBtn) return nextBtn;

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

            function clickNextPage() {
                const nextBtn = getNextPageButton();
                if (nextBtn) {
                    nextBtn.click();
                    console.log("自动翻页：已点击下一页");
                    return true;
                }
                console.log("自动翻页：未找到下一页按钮");
                return false;
            }

            async function autoPageStep() {
                if (!isAutoPageRunning) return false;

                doCapture(false);
                await new Promise(resolve => setTimeout(resolve, 1000));

                const nextBtnExists = getNextPageButton() !== null;
                if (!nextBtnExists) {
                    console.log("自动翻页：已到达最后一页，停止翻页。");
                    stopAutoPage();
                    alert("✅ 自动翻页捕获完成，已无更多数据。");
                    return false;
                }

                const clicked = clickNextPage();
                if (!clicked) {
                    console.log("自动翻页：点击下一页失败，可能已到末尾");
                    stopAutoPage();
                    alert("⚠️ 无法点击下一页，自动翻页已停止。");
                    return false;
                }

                await new Promise(resolve => setTimeout(resolve, autoPageDelay));

                if (isAutoPageRunning) {
                    autoPageStep();
                }
                return true;
            }

            function startAutoPage() {
                if (isAutoPageRunning) {
                    alert("自动翻页已在运行中！");
                    return;
                }
                const delaySec = parseFloat(document.getElementById('auto-page-delay').value);
                if (isNaN(delaySec) || delaySec < 1) {
                    alert("请设置有效的翻页间隔（≥1秒）");
                    return;
                }
                autoPageDelay = delaySec * 1000;

                const modal = getModalRoot();
                if (!modal) {
                    alert("未检测到视频列表弹窗，请先打开视频列表（查看全部视频弹窗）。");
                    return;
                }

                isAutoPageRunning = true;
                const statusSpan = document.getElementById('auto-page-status');
                if (statusSpan) statusSpan.innerText = "● 运行中";
                document.getElementById('btn-start-autopage').disabled = true;
                document.getElementById('btn-stop-autopage').disabled = false;

                doCapture(false);
                setTimeout(() => {
                    if (isAutoPageRunning) autoPageStep();
                }, 1000);
            }

            function stopAutoPage() {
                if (!isAutoPageRunning) return;
                isAutoPageRunning = false;
                const statusSpan = document.getElementById('auto-page-status');
                if (statusSpan) statusSpan.innerText = "○ 已停止";
                document.getElementById('btn-start-autopage').disabled = false;
                document.getElementById('btn-stop-autopage').disabled = true;
                console.log("用户停止了自动翻页");
            }

            // ================= 数据导出功能 =================
            function downloadFile(content, fileName, mimeType) {
                const blob = new Blob([content], { type: mimeType });
                const link = document.createElement('a');
                const url = URL.createObjectURL(blob);
                link.href = url;
                link.download = fileName;
                document.body.appendChild(link);
                link.click();
                document.body.removeChild(link);
                URL.revokeObjectURL(url);
            }

            // 将视频数据数组转换为CSV（增加上传时间）
            function convertToCSV(dataArray) {
                if (!dataArray || dataArray.length === 0) return "";
                const headers = ["商品ID", "状态", "视频ID", "上传时间", "播放量", "评论数", "点赞数", "成交金额", "订单数", "买家数"];
                const rows = dataArray.map(item => [
                    item.goodsId || "",
                    item.status || "",
                    item.vid || "",
                    item.uploadTime || "",
                    item.play || "0",
                    item.comment || "0",
                    item.like || "0",
                    item.amount || "0",
                    item.order || "0",
                    item.user || "0"
                ]);
                const csvContent = [headers, ...rows].map(row => row.map(cell => `"${String(cell).replace(/"/g, '""')}"`).join(",")).join("\n");
                return "\uFEFF" + csvContent;
            }

            function exportCurrentDataAsCSV() {
                if (lastCapturedList.length === 0) {
                    alert("当前没有捕获数据，请先获取数据！");
                    return;
                }
                const csv = convertToCSV(lastCapturedList);
                const fileName = `pdd_video_${currentGoodsId || "current"}_${new Date().toISOString().slice(0,19).replace(/:/g, '-')}.csv`;
                downloadFile(csv, fileName, "text/csv;charset=utf-8;");
                alert(`已导出 ${lastCapturedList.length} 条数据至 ${fileName}`);
            }

            function exportCurrentDataAsJSON() {
                if (lastCapturedList.length === 0) {
                    alert("当前没有捕获数据，请先获取数据！");
                    return;
                }
                const data = {
                    exportTime: new Date().toLocaleString(),
                    goodsId: currentGoodsId,
                    totalCount: lastCapturedList.length,
                    data: lastCapturedList
                };
                const jsonStr = JSON.stringify(data, null, 2);
                const fileName = `pdd_video_${currentGoodsId || "current"}_${new Date().toISOString().slice(0,19).replace(/:/g, '-')}.json`;
                downloadFile(jsonStr, fileName, "application/json");
                alert(`已导出 ${lastCapturedList.length} 条数据至 ${fileName}`);
            }

            async function exportAllHistoryAsCSV() {
                const his = await window.PddStorage.get(STORAGE_KEY, []);
                if (his.length === 0) {
                    alert("暂无历史存档数据！");
                    return;
                }
                let allRecords = [];
                his.forEach(snapshot => {
                    const snapshotData = snapshot.data.map(item => ({
                        ...item,
                        snapshotTime: snapshot.time,
                        snapshotGoodsId: snapshot.goodsId
                    }));
                    allRecords.push(...snapshotData);
                });
                if (allRecords.length === 0) {
                    alert("历史存档中无可导出的记录");
                    return;
                }
                const csv = convertToCSV(allRecords);
                const fileName = `pdd_all_history_${new Date().toISOString().slice(0,19).replace(/:/g, '-')}.csv`;
                downloadFile(csv, fileName, "text/csv;charset=utf-8;");
                alert(`已导出 ${allRecords.length} 条历史记录至 ${fileName}`);
            }

            async function exportHistoryGrouped() {
                const his = await window.PddStorage.get(STORAGE_KEY, []);
                if (his.length === 0) {
                    alert("暂无历史存档数据！");
                    return;
                }
                const dataToExport = his.map(snap => ({
                    snapshotId: snap.id,
                    snapshotTime: snap.time,
                    goodsId: snap.goodsId,
                    videoCount: snap.data.length,
                    videos: snap.data
                }));
                const jsonStr = JSON.stringify(dataToExport, null, 2);
                const fileName = `pdd_history_grouped_${new Date().toISOString().slice(0,19).replace(/:/g, '-')}.json`;
                downloadFile(jsonStr, fileName, "application/json");
                alert(`已导出 ${his.length} 个快照至 ${fileName}`);
            }

            // ================= 数据对比排序渲染函数（增加上传时间列） =================
            function renderCompareResultWithSort(order) {
                if (!lastCompareData.snapshotA || !lastCompareData.snapshotB) return;
                lastCompareData.sortOrder = order;
                const { mapA, mapB, allVids } = lastCompareData;

                const vidList = Array.from(allVids);
                const vidWithDiff = vidList.map(vid => {
                    const itemA = mapA.get(vid);
                    const itemB = mapB.get(vid);
                    const playA = itemA ? parseNumeric(itemA.play) : 0;
                    const playB = itemB ? parseNumeric(itemB.play) : 0;
                    const diff = playB - playA;
                    return { vid, diff };
                });
                vidWithDiff.sort((a, b) => order === 'desc' ? b.diff - a.diff : a.diff - b.diff);
                const sortedVids = vidWithDiff.map(v => v.vid);

                let html = `<table class="compare-table" style="width:100%; border-collapse:collapse;">
                    <thead>
                        <tr>
                            <th>视频ID</th>
                            <th>上传时间</th>
                            <th>状态 (A→B)</th>
                            <th>播放量对比</th>
                            <th>评论量对比</th>
                            <th>点赞量对比</th>
                            <th>成交金额对比</th>
                            <th>订单数对比</th>
                            <th>买家数对比</th>
                        </tr>
                    </thead>
                    <tbody>`;

                for (let vid of sortedVids) {
                    const itemA = mapA.get(vid);
                    const itemB = mapB.get(vid);
                    const uploadTime = (itemA && itemA.uploadTime) || (itemB && itemB.uploadTime) || '-';
                    const statusA = itemA ? (itemA.status || '-') : '-';
                    const statusB = itemB ? (itemB.status || '-') : '-';
                    const statusHtml = `${statusA} → ${statusB}`;

                    const getCellHtml = (key) => {
                        const valA = itemA ? (itemA[key] || '0') : '-';
                        const valB = itemB ? (itemB[key] || '0') : '-';
                        if (valA === '-' && valB === '-') return '-';
                        if (valA === '-') return `新增: ${formatValue(valB)}`;
                        if (valB === '-') return `已消失: ${formatValue(valA)}`;
                        const diffHtml = formatDiff(valA, valB);
                        return `${formatValue(valA)} → ${formatValue(valB)}<br>${diffHtml}`;
                    };

                    html += `<tr>
                        <td style="font-weight:bold;">${vid}</td>
                        <td>${uploadTime}</td>
                        <td>${statusHtml}</td>
                        <td>${getCellHtml('play')}</td>
                        <td>${getCellHtml('comment')}</td>
                        <td>${getCellHtml('like')}</td>
                        <td>${getCellHtml('amount')}</td>
                        <td>${getCellHtml('order')}</td>
                        <td>${getCellHtml('user')}</td>
                    </tr>`;
                }
                html += `</tbody></table><div style="margin-top:8px; font-size:12px; color:#888;">📌 当前排序：${order === 'desc' ? '播放增长（从高到低）' : '播放增长（从低到高）'}</div>`;
                document.getElementById('compare-result-area').innerHTML = html;
            }

            // 4. UI 初始化
            const initUI = () => {
                if (document.getElementById('pdd-main-window')) {
                    moduleApi.panelEl = document.getElementById('pdd-main-window');
                    return;
                }
                injectStyle();

                const win = document.createElement('div');
                win.id = 'pdd-main-window';
                win.innerHTML = `
                    <div id="pdd-drag-handle">
                        <b style="font-size:15px;">📊 视频监控管理系统</b>
                        <span id="pdd-close" style="cursor:pointer; font-size:24px;">&times;</span>
                    </div>
                    <div class="nav-bar">
                        <div class="nav-item active" id="tab-cap">🔍 实时捕获</div>
                        <div class="nav-item" id="tab-his">📦 历史存档</div>
                        <div class="nav-item" id="tab-compare">📈 数据对比</div>
                        <div class="nav-item" id="tab-export">📤 数据导出</div>
                    </div>

                    <!-- 实时捕获面板 -->
                    <div id="pane-cap" style="display:flex; flex-direction:column; height: calc(100% - 100px);">
                        <div style="padding:12px; border-bottom:1px solid #eee; display:flex; gap:10px; align-items:center; flex-shrink:0; background:#fff;">
                            <button id="btn-scan" class="btn-red" style="flex:1;">📄 单次捕获当前页</button>
                            <button id="btn-save" class="btn-green">💾 保存快照</button>
                            <button id="btn-clear" style="padding:8px 15px; border:1px solid #ddd; background:#fff; cursor:pointer; border-radius:4px;">🗑 清空本页</button>
                        </div>

                        <div class="autopage-bar">
                            <span>🤖 自动翻页捕获</span>
                            <label>间隔(秒):</label>
                            <input type="number" id="auto-page-delay" value="3" min="1" step="0.5">
                            <button id="btn-start-autopage" class="btn-green" style="padding:4px 12px;">▶ 开始</button>
                            <button id="btn-stop-autopage" class="btn-gray" style="padding:4px 12px;" disabled>⏹ 停止</button>
                            <span id="auto-page-status" class="autopage-status">○ 未启动</span>
                            <span style="font-size:12px; color:#888;">（自动翻页并累加所有页数据）</span>
                        </div>

                        <div style="padding:8px 15px; font-size:13px; color:#e02020; background:#fff1f0; font-weight:bold; flex-shrink:0; display:flex; justify-content: space-between;" id="goods-info-bar">
                            <span id="goods-id-display">当前监测商品: 未识别</span>
                            <span id="capture-count-display" style="background:#e02020; color:white; padding:2px 8px; border-radius:12px;">捕获条数: 0</span>
                        </div>
                        <div class="table-container">
                            <table class="data-table">
                                <thead>
                                    <tr>
                                        <th style="width:100px" data-sort="goodsId">商品ID</th>
                                        <th style="width:70px" data-sort="status">状态</th>
                                        <th style="width:120px" data-sort="vid">视频ID</th>
                                        <th style="width:140px" data-sort="uploadTime">上传时间</th>
                                        <th data-sort="play">播放</th>
                                        <th data-sort="comment">评论</th>
                                        <th data-sort="like">点赞</th>
                                        <th data-sort="amount">金额</th>
                                        <th data-sort="order">订单</th>
                                        <th data-sort="user">买家</th>
                                    </tr>
                                </thead>
                                <tbody id="tbody-cap"></tbody>
                            </table>
                        </div>
                    </div>

                    <!-- 历史存档面板 -->
                    <div id="pane-his" style="display:none; flex-direction:column; flex:1; overflow:auto;">
                        <div class="his-filter-bar">
                            <label>📌 按商品ID筛选：</label>
                            <select id="his-goods-filter">
                                <option value="__ALL__">📋 全部商品（分组显示）</option>
                            </select>
                            <button id="his-reset-filter" class="btn-gray" style="padding:4px 12px;">重置筛选</button>
                        </div>
                        <div id="history-content" class="card-grid" style="padding-top:5px;"></div>
                    </div>

                    <!-- 数据对比面板 -->
                    <div id="pane-compare" style="display:none; flex-direction:column; flex:1; overflow:hidden;">
                        <div class="compare-panel">
                            <div style="margin-bottom:12px;">
                                <label>选择商品ID：</label>
                                <select id="compare-goods-select" class="compare-select"></select>
                                <button id="refresh-compare-btn" style="margin-left:10px; padding:4px 12px;">刷新列表</button>
                            </div>
                            <div style="display:flex; gap:20px; align-items:center; flex-wrap:wrap;">
                                <div>
                                    <label>时间点 A：</label>
                                    <select id="compare-snapshot-a" class="compare-select"></select>
                                </div>
                                <div>
                                    <label>时间点 B：</label>
                                    <select id="compare-snapshot-b" class="compare-select"></select>
                                </div>
                                <button id="btn-do-compare" class="btn-green">开始对比</button>
                            </div>
                            <div class="compare-toolbar">
                                <span style="font-size:12px; color:#666;">📊 播放增长排序：</span>
                                <button id="sort-growth-desc" class="sort-btn">📈 从高到低</button>
                                <button id="sort-growth-asc" class="sort-btn">📉 从低到高</button>
                            </div>
                        </div>
                        <div class="compare-result" id="compare-result-area">
                            <div style="text-align:center; color:#999; margin-top:50px;">请选择商品ID和时间点后点击“开始对比”</div>
                        </div>
                    </div>

                    <!-- 数据导出面板 -->
                    <div id="pane-export" style="display:none; flex-direction:column; flex:1; overflow:auto;">
                        <div class="export-panel">
                            <div class="export-section">
                                <h3>📋 当前实时捕获数据</h3>
                                <div class="export-buttons">
                                    <button id="export-current-csv">导出为 CSV</button>
                                    <button id="export-current-json">导出为 JSON</button>
                                </div>
                                <p style="margin-top:10px; font-size:12px; color:#666;">当前共有 <strong id="export-current-count">0</strong> 条视频数据</p>
                            </div>

                            <div class="export-section">
                                <h3>📦 全部历史存档数据</h3>
                                <div class="export-buttons">
                                    <button id="export-all-csv">合并导出为 CSV</button>
                                    <button id="export-all-json">分快照导出为 JSON</button>
                                </div>
                                <p style="margin-top:10px; font-size:12px; color:#666;">历史存档快照总数: <strong id="export-history-count">0</strong> 个</p>
                            </div>
                        </div>
                    </div>
                `;
                document.body.appendChild(win);
                moduleApi.panelEl = win;
                enableDrag(win);

                // 绑定排序点击事件（实时捕获表格）
                win.querySelectorAll('.data-table thead th').forEach(th => {
                    th.onclick = () => {
                        const key = th.getAttribute('data-sort');
                        if (sortConfig.key === key) {
                            sortConfig.direction = sortConfig.direction === 'desc' ? 'asc' : 'desc';
                        } else {
                            sortConfig.key = key;
                            sortConfig.direction = 'desc';
                        }
                        sortData();
                        renderCaptureTable();
                    };
                });

                const switchTab = async (tab) => {
                    document.getElementById('tab-cap').classList.toggle('active', tab === 'cap');
                    document.getElementById('tab-his').classList.toggle('active', tab === 'his');
                    document.getElementById('tab-compare').classList.toggle('active', tab === 'compare');
                    document.getElementById('tab-export').classList.toggle('active', tab === 'export');
                    document.getElementById('pane-cap').style.display = tab === 'cap' ? 'flex' : 'none';
                    document.getElementById('pane-his').style.display = tab === 'his' ? 'flex' : 'none';
                    document.getElementById('pane-compare').style.display = tab === 'compare' ? 'flex' : 'none';
                    document.getElementById('pane-export').style.display = tab === 'export' ? 'flex' : 'none';
                    if (tab === 'his') {
                        await updateGoodsFilterOptions();
                        await renderHistory();
                    }
                    if (tab === 'compare') await refreshComparePanelData();
                    if (tab === 'export') await updateExportPanelStats();
                };

                document.getElementById('tab-cap').onclick = () => switchTab('cap');
                document.getElementById('tab-his').onclick = () => switchTab('his');
                document.getElementById('tab-compare').onclick = () => switchTab('compare');
                document.getElementById('tab-export').onclick = () => switchTab('export');
                document.getElementById('pdd-close').onclick = () => win.style.display = 'none';

                document.getElementById('btn-scan').onclick = () => {
                    if (isAutoPageRunning) {
                        if (confirm("自动翻页正在运行，是否停止并执行单次捕获？")) {
                            stopAutoPage();
                        } else {
                            return;
                        }
                    }
                    doCapture(true);
                };

                document.getElementById('btn-clear').onclick = () => {
                    if(confirm("确定要清空当前显示的所有捕获数据吗？")) {
                        lastCapturedList = [];
                        currentGoodsId = "";
                        renderCaptureTable();
                        document.getElementById('btn-scan').innerText = "📄 单次捕获当前页";
                    }
                };
                document.getElementById('btn-save').onclick = async () => {
                    if (!lastCapturedList.length) return alert("请先获取数据");
                    const his = await window.PddStorage.get(STORAGE_KEY, []);
                    his.unshift({ id: Date.now(), goodsId: currentGoodsId, data: JSON.parse(JSON.stringify(lastCapturedList)), time: new Date().toLocaleString() });
                    await window.PddStorage.set(STORAGE_KEY, his);
                    alert("已存入历史存档！");
                    if (document.getElementById('pane-his').style.display === 'flex') {
                        await updateGoodsFilterOptions();
                        await renderHistory();
                    }
                    if (document.getElementById('pane-export').style.display === 'flex') {
                        await updateExportPanelStats();
                    }
                };

                document.getElementById('btn-start-autopage').onclick = startAutoPage;
                document.getElementById('btn-stop-autopage').onclick = stopAutoPage;

                const filterSelect = document.getElementById('his-goods-filter');
                const resetBtn = document.getElementById('his-reset-filter');
                filterSelect.onchange = () => renderHistory();
                resetBtn.onclick = () => {
                    filterSelect.value = '__ALL__';
                    renderHistory();
                };

                document.getElementById('refresh-compare-btn').onclick = () => refreshComparePanelData();
                document.getElementById('compare-goods-select').onchange = () => loadSnapshotsForGoods();
                document.getElementById('btn-do-compare').onclick = () => performCompare();

                document.getElementById('sort-growth-desc').onclick = () => {
                    if (lastCompareData.snapshotA && lastCompareData.snapshotB) {
                        renderCompareResultWithSort('desc');
                    } else {
                        alert("请先进行数据对比");
                    }
                };
                document.getElementById('sort-growth-asc').onclick = () => {
                    if (lastCompareData.snapshotA && lastCompareData.snapshotB) {
                        renderCompareResultWithSort('asc');
                    } else {
                        alert("请先进行数据对比");
                    }
                };

                document.getElementById('export-current-csv').onclick = exportCurrentDataAsCSV;
                document.getElementById('export-current-json').onclick = exportCurrentDataAsJSON;
                document.getElementById('export-all-csv').onclick = exportAllHistoryAsCSV;
                document.getElementById('export-all-json').onclick = exportHistoryGrouped;
            };

            async function updateExportPanelStats() {
                const currentCountSpan = document.getElementById('export-current-count');
                if (currentCountSpan) currentCountSpan.innerText = lastCapturedList.length;
                const his = await window.PddStorage.get(STORAGE_KEY, []);
                const historyCountSpan = document.getElementById('export-history-count');
                if (historyCountSpan) historyCountSpan.innerText = his.length;
            }

            async function updateGoodsFilterOptions() {
                const his = await window.PddStorage.get(STORAGE_KEY, []);
                const goodsSet = new Set();
                his.forEach(snap => {
                    if (snap.goodsId) goodsSet.add(snap.goodsId);
                });
                const filterSelect = document.getElementById('his-goods-filter');
                if (!filterSelect) return;
                const currentValue = filterSelect.value;
                filterSelect.innerHTML = '<option value="__ALL__">📋 全部商品（分组显示）</option>';
                Array.from(goodsSet).sort().forEach(gid => {
                    filterSelect.innerHTML += `<option value="${gid}">📦 ${gid}</option>`;
                });
                if (currentValue !== '__ALL__' && goodsSet.has(currentValue)) {
                    filterSelect.value = currentValue;
                } else {
                    filterSelect.value = '__ALL__';
                }
            }

            async function renderHistory() {
                const container = document.getElementById('history-content');
                const his = await window.PddStorage.get(STORAGE_KEY, []);
                const filterValue = document.getElementById('his-goods-filter').value;

                if (!his.length) {
                    container.innerHTML = '<div style="grid-column:1/-1;text-align:center;margin-top:50px;color:#999;">暂无存档，请先在“实时捕获”中保存快照</div>';
                    return;
                }

                let filteredHis = his;
                if (filterValue !== '__ALL__') {
                    filteredHis = his.filter(snap => snap.goodsId === filterValue);
                }

                if (filteredHis.length === 0) {
                    container.innerHTML = `<div style="grid-column:1/-1;text-align:center;margin-top:50px;color:#999;">没有找到商品ID为 “${filterValue}” 的存档</div>`;
                    return;
                }

                const groups = new Map();
                filteredHis.forEach(snap => {
                    const gid = snap.goodsId || '未识别商品';
                    if (!groups.has(gid)) groups.set(gid, []);
                    groups.get(gid).push(snap);
                });

                for (let [gid, snaps] of groups.entries()) {
                    snaps.sort((a, b) => b.id - a.id);
                    groups.set(gid, snaps);
                }

                container.innerHTML = '';
                for (let [gid, snaps] of groups.entries()) {
                    const groupDiv = document.createElement('div');
                    groupDiv.style.width = '100%';
                    groupDiv.style.marginBottom = '20px';

                    const titleDiv = document.createElement('div');
                    titleDiv.className = 'his-group-title';
                    titleDiv.innerHTML = `🎯 商品ID: ${gid}  <span style="font-size:13px; font-weight:normal; color:#888;">(共 ${snaps.length} 条存档)</span>`;
                    groupDiv.appendChild(titleDiv);

                    const gridDiv = document.createElement('div');
                    gridDiv.className = 'card-grid';
                    gridDiv.style.paddingTop = '0';

                    snaps.forEach(snap => {
                        const card = document.createElement('div');
                        card.className = 'card';
                        card.innerHTML = `
                            <div class="card-del" data-id="${snap.id}">&times;</div>
                            <div style="font-weight:bold;color:#333;margin-bottom:5px;">📦 商品: ${snap.goodsId}</div>
                            <div style="font-size:12px;color:#999;">🕒 时间: ${snap.time}</div>
                            <div style="margin-top:8px;font-size:13px;color:#e02020;">视频总数: ${snap.data.length} 条</div>
                        `;
                        card.onclick = async (e) => {
                            if (e.target.classList.contains('card-del')) {
                                if (confirm('删除此存档？')) {
                                    const newHis = (await window.PddStorage.get(STORAGE_KEY, [])).filter(x => x.id !== snap.id);
                                    await window.PddStorage.set(STORAGE_KEY, newHis);
                                    await updateGoodsFilterOptions();
                                    await renderHistory();
                                    if (document.getElementById('pane-compare').style.display === 'flex') {
                                        await refreshComparePanelData();
                                    }
                                    if (document.getElementById('pane-export').style.display === 'flex') {
                                        await updateExportPanelStats();
                                    }
                                }
                                return;
                            }
                            lastCapturedList = snap.data;
                            currentGoodsId = snap.goodsId;
                            document.getElementById('tab-cap').click();
                            renderCaptureTable();
                        };
                        gridDiv.appendChild(card);
                    });
                    groupDiv.appendChild(gridDiv);
                    container.appendChild(groupDiv);
                }
            }

            function sortData() {
                if (!sortConfig.key) return;
                lastCapturedList.sort((a, b) => {
                    let valA = a[sortConfig.key];
                    let valB = b[sortConfig.key];
                    if (['play', 'comment', 'like', 'amount', 'order', 'user'].includes(sortConfig.key)) {
                        valA = parseNumeric(valA);
                        valB = parseNumeric(valB);
                    }
                    if (valA < valB) return sortConfig.direction === 'asc' ? -1 : 1;
                    if (valA > valB) return sortConfig.direction === 'asc' ? 1 : -1;
                    return 0;
                });
            }

            function renderCaptureTable() {
                const tbody = document.getElementById('tbody-cap');
                const thead = document.querySelector('.data-table thead');
                tbody.innerHTML = '';
                const displayId = currentGoodsId || '未识别';
                document.getElementById('goods-id-display').innerText = `当前监测商品: ${displayId}`;
                const countSpan = document.getElementById('capture-count-display');
                if (countSpan) countSpan.innerText = `捕获条数: ${lastCapturedList.length}`;

                thead.querySelectorAll('th').forEach(th => {
                    const key = th.getAttribute('data-sort');
                    const baseText = th.innerText.replace(/[▲▼]/g, '').trim();
                    if (key === sortConfig.key) {
                        th.classList.add('sort-active');
                        th.innerText = `${baseText} ${sortConfig.direction === 'asc' ? '▲' : '▼'}`;
                    } else {
                        th.classList.remove('sort-active');
                        th.innerText = baseText;
                    }
                });

                lastCapturedList.forEach(item => {
                    const tr = document.createElement('tr');
                    tr.innerHTML = `
                        <td style="color:#888">${item.goodsId}</td>
                        <td style="color:${item.status.includes('通过')?'#52c41a':'#ff4d4f'}">${item.status}</td>
                        <td>${item.vid}</td>
                        <td>${item.uploadTime || '-'}</td>
                        <td><b>${item.play}</b></td>
                        <td>${item.comment}</td>
                        <td>${item.like}</td>
                        <td style="color:#e02020">${item.amount}</td>
                        <td>${item.order}</td>
                        <td>${item.user}</td>
                    `;
                    tbody.appendChild(tr);
                });
                if (document.getElementById('pane-export') && document.getElementById('pane-export').style.display === 'flex') {
                    updateExportPanelStats();
                }
            }

            let allSnapshots = [];

            async function refreshComparePanelData() {
                const his = await window.PddStorage.get(STORAGE_KEY, []);
                allSnapshots = his;
                const goodsSet = new Set();
                his.forEach(snap => {
                    if (snap.goodsId) goodsSet.add(snap.goodsId);
                });
                const goodsSelect = document.getElementById('compare-goods-select');
                goodsSelect.innerHTML = '<option value="">-- 请选择商品ID --</option>';
                Array.from(goodsSet).sort().forEach(gid => {
                    goodsSelect.innerHTML += `<option value="${gid}">${gid}</option>`;
                });
                if (goodsSet.size === 0) {
                    document.getElementById('compare-result-area').innerHTML = '<div style="text-align:center; color:#999; margin-top:50px;">暂无历史数据，请先在“实时捕获”中保存快照</div>';
                } else {
                    goodsSelect.value = Array.from(goodsSet)[0];
                    loadSnapshotsForGoods();
                }
            }

            function loadSnapshotsForGoods() {
                const goodsId = document.getElementById('compare-goods-select').value;
                if (!goodsId) return;
                const snapshots = allSnapshots.filter(s => s.goodsId === goodsId).sort((a,b) => a.id - b.id);
                const selectA = document.getElementById('compare-snapshot-a');
                const selectB = document.getElementById('compare-snapshot-b');
                selectA.innerHTML = '';
                selectB.innerHTML = '';
                if (snapshots.length === 0) {
                    selectA.innerHTML = '<option>无快照</option>';
                    selectB.innerHTML = '<option>无快照</option>';
                    return;
                }
                snapshots.forEach((snap, idx) => {
                    const optionText = `${snap.time} (${snap.data.length}条视频)`;
                    selectA.innerHTML += `<option value="${snap.id}">${optionText}</option>`;
                    selectB.innerHTML += `<option value="${snap.id}">${optionText}</option>`;
                });
                if (snapshots.length > 0) {
                    selectA.value = snapshots[0].id;
                    selectB.value = snapshots[snapshots.length-1].id;
                }
            }

            function performCompare() {
                const goodsId = document.getElementById('compare-goods-select').value;
                const snapIdA = document.getElementById('compare-snapshot-a').value;
                const snapIdB = document.getElementById('compare-snapshot-b').value;
                if (!goodsId || !snapIdA || !snapIdB) {
                    alert("请完整选择商品ID和时间点");
                    return;
                }
                if (snapIdA === snapIdB) {
                    alert("请选择两个不同的时间点进行对比");
                    return;
                }
                const snapshotA = allSnapshots.find(s => s.id == snapIdA);
                const snapshotB = allSnapshots.find(s => s.id == snapIdB);
                if (!snapshotA || !snapshotB) {
                    alert("快照数据加载失败");
                    return;
                }

                const mapA = new Map();
                snapshotA.data.forEach(v => { mapA.set(v.vid, v); });
                const mapB = new Map();
                snapshotB.data.forEach(v => { mapB.set(v.vid, v); });

                const allVids = new Set([...mapA.keys(), ...mapB.keys()]);
                if (allVids.size === 0) {
                    document.getElementById('compare-result-area').innerHTML = '<div style="text-align:center;color:#999;">两个时间点均无视频数据</div>';
                    return;
                }

                lastCompareData = {
                    goodsId: goodsId,
                    snapshotA: snapshotA,
                    snapshotB: snapshotB,
                    allVids: allVids,
                    mapA: mapA,
                    mapB: mapB,
                    sortOrder: 'desc'
                };

                renderCompareResultWithSort('desc');
            }

            // 核心捕获函数（增加上传时间抓取）
            function doCapture(showAlert = true) {
                const gid = getGoodsId();
                if (gid && gid !== currentGoodsId) {
                    if (lastCapturedList.length > 0) {
                        if (confirm(`检测到商品 ID 已变更为 ${gid}，是否清空旧数据开始新捕获？`)) {
                            lastCapturedList = [];
                        }
                    }
                    currentGoodsId = gid;
                } else if (!currentGoodsId && gid) {
                    currentGoodsId = gid;
                }

                const rows = document.querySelectorAll('tr[data-testid="beast-core-table-body-tr"]');
                if (!rows.length) {
                    if (showAlert) alert("未识别到表格行，请确保视频列表弹窗已打开。");
                    return;
                }

                rows.forEach(row => {
                    const tds = row.querySelectorAll('td');
                    if (tds.length < 7) return;

                    // 第一列：包含视频ID、状态、上传时间
                    const firstColText = tds[0].innerText;
                    const vidMatch = firstColText.match(/ID:\s*(\d+)/);
                    const vid = vidMatch ? vidMatch[1] : "未知";
                    const status = firstColText.match(/(通过|失败|待审核)/)?.[0] || "未知";

                    // 抓取上传时间：常见格式 "上传时间：2025-01-01" 或 "发布时间：2025-01-01"
                    let uploadTime = "";
                    const timeMatch = firstColText.match(/(?:上传时间|发布时间)[：:]\s*([\d\-:\s]+)/);
                    if (timeMatch) {
                        uploadTime = timeMatch[1].trim();
                    } else {
                        // 尝试匹配纯日期格式（如 2025-01-01 或 2025-01-01 12:00）
                        const dateMatch = firstColText.match(/(\d{4}-\d{2}-\d{2}(?:\s+\d{2}:\d{2})?)/);
                        if (dateMatch) uploadTime = dateMatch[1];
                    }

                    const safeText = (el) => {
                        let t = el.innerText.trim();
                        return (t === "" || t === "-") ? "0" : t;
                    };

                    if (!lastCapturedList.find(i => i.vid === vid)) {
                        lastCapturedList.push({
                            goodsId: currentGoodsId,
                            status,
                            vid,
                            uploadTime,
                            play: safeText(tds[1]),
                            comment: safeText(tds[2]),
                            like: safeText(tds[3]),
                            amount: safeText(tds[4]),
                            order: safeText(tds[5]),
                            user: safeText(tds[6])
                        });
                    }
                });

                sortData();
                renderCaptureTable();
                if (showAlert) {
                    const btn = document.getElementById('btn-scan');
                    btn.innerText = `✅ 成功更新 (${lastCapturedList.length}条)`;
                    setTimeout(() => {
                        if (btn.innerText.includes('成功更新')) btn.innerText = "📄 单次捕获当前页";
                    }, 2000);
                }
            }

            initUI();
            setInterval(initUI, 2000);
        },
        show() {
            const panel = this.panelEl || document.getElementById('pdd-main-window');
            if (!panel) return;
            this.panelEl = panel;
            panel.style.display = 'flex';
            panel.style.zIndex = '2147483646';
        },
        hide() {
            const panel = this.panelEl || document.getElementById('pdd-main-window');
            if (!panel) return;
            this.panelEl = panel;
            panel.style.display = 'none';
        }
    };
})();
