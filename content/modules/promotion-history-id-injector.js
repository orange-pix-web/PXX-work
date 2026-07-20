(function () {
  'use strict';

  window.PddModules = window.PddModules || {};

  const ROUTE = 'live.pinduoduo.com/n-creator/video';
  const STYLE_ID = 'pdd-promotion-history-id-css';
  const STORAGE_KEY = 'promotionHistoryIdInjector_v1_videoIndex';
  const ENABLED_KEY = 'promotionHistoryIdInjector_v1_enabled';
  const MARKS_KEY = 'promotionHistoryIdInjector_v1_manualMarks';
  const MAX_CACHE_ITEMS = 1200;
  const OBSERVE_DELAY_MS = 250;

  window.PddModules.promotionHistoryIdInjector = {
    inited: false,
    enabled: false,

    async init() {
      if (this.inited) return;
      if (!isSupportedPage()) return;
      this.inited = true;

      let videoIndex = await loadVideoIndex();
      let manualMarks = await loadManualMarks();
      let enabled = Boolean(await window.PddStorage?.get?.(ENABLED_KEY, false));
      this.enabled = enabled;
      let scanTimer = null;

      async function updateManualMark(recordKey, field, checked) {
        const current = manualMarks[recordKey] || {};
        manualMarks[recordKey] = {
          duplicate: Boolean(current.duplicate),
          justPromoted: Boolean(current.justPromoted),
          [field]: Boolean(checked),
          updatedAt: Date.now()
        };
        await saveManualMarks(manualMarks);
        scheduleScan();
      }

      function scheduleScan() {
        window.clearTimeout(scanTimer);
        scanTimer = window.setTimeout(async () => {
          if (!enabled) {
            removeInjectedIds();
            return;
          }

          const changed = collectVideoTableIndex(videoIndex);
          injectHistoryIds(videoIndex, manualMarks, updateManualMark);
          if (changed) {
            videoIndex = trimVideoIndex(videoIndex);
            await saveVideoIndex(videoIndex);
          }
        }, OBSERVE_DELAY_MS);
      }

      injectStyle();
      scheduleScan();

      const observer = new MutationObserver(scheduleScan);
      observer.observe(document.body || document.documentElement, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['src']
      });

      this.rescan = scheduleScan;
      this.getMenuTitle = () => `推广ID注入：${enabled ? '已开启' : '未开启'}`;
      this.show = async () => {
        enabled = !enabled;
        this.enabled = enabled;
        await window.PddStorage?.set?.(ENABLED_KEY, enabled);
        scheduleScan();
        showToast(enabled
          ? `推广ID注入已开启，缓存 ${Object.keys(videoIndex).length} 条视频`
          : '推广ID注入已关闭');
        return enabled;
      };
    }
  };

  function normalizeCoverUrl(url) {
    if (!url) return '';
    return String(url).split('?')[0].trim();
  }

  function isSupportedPage() {
    return window.location.href.includes(ROUTE);
  }

  function getText(el) {
    return (el?.textContent || '').replace(/\s+/g, ' ').trim();
  }

  function extractId(text) {
    const match = String(text || '').match(/ID\s*[:：]\s*(\d{6,})/i);
    return match ? match[1] : '';
  }

  async function loadVideoIndex() {
    try {
      const cached = await window.PddStorage?.get?.(STORAGE_KEY, {});
      return cached && typeof cached === 'object' && !Array.isArray(cached) ? cached : {};
    } catch (error) {
      console.warn('[PDD插件] 读取推广ID缓存失败', error);
      return {};
    }
  }

  async function loadManualMarks() {
    try {
      const cached = await window.PddStorage?.get?.(MARKS_KEY, {});
      return cached && typeof cached === 'object' && !Array.isArray(cached) ? cached : {};
    } catch (error) {
      console.warn('[PDD插件] 读取推广标记失败', error);
      return {};
    }
  }

  async function saveManualMarks(marks) {
    try {
      await window.PddStorage?.set?.(MARKS_KEY, marks);
    } catch (error) {
      console.warn('[PDD插件] 保存推广标记失败', error);
    }
  }

  async function saveVideoIndex(index) {
    try {
      await window.PddStorage?.set?.(STORAGE_KEY, index);
    } catch (error) {
      console.warn('[PDD插件] 保存推广ID缓存失败', error);
    }
  }

  function trimVideoIndex(index) {
    const entries = Object.entries(index)
      .sort((a, b) => (b[1].updatedAt || 0) - (a[1].updatedAt || 0))
      .slice(0, MAX_CACHE_ITEMS);
    return Object.fromEntries(entries);
  }

  function collectVideoTableIndex(index) {
    let changed = false;
    const rows = Array.from(document.querySelectorAll('tr[data-testid="beast-core-table-body-tr"]'));

    rows.forEach((row) => {
      const videoCell = row.querySelector('td');
      const goodsCell = row.querySelectorAll('td')[1];
      const cover = normalizeCoverUrl(
        row.querySelector('[class*="goodsVideoTable_videoImg"]')?.getAttribute('src')
        || row.querySelector('[class*="goodsVideoTable_leftVideo"] img')?.getAttribute('src')
      );
      const videoId = extractId(getText(row.querySelector('[class*="goodsVideoTable_feedId"]') || videoCell));
      const goodsId = extractId(getText(goodsCell));

      if (!cover || !videoId) return;

      const nextItem = {
        videoId,
        goodsId,
        cover,
        updatedAt: Date.now()
      };
      const oldItem = index[cover];
      if (!oldItem || oldItem.videoId !== videoId || oldItem.goodsId !== goodsId) {
        index[cover] = nextItem;
        changed = true;
      } else {
        oldItem.updatedAt = Date.now();
      }
    });

    return changed;
  }

  function injectHistoryIds(index, manualMarks, onManualMarkChange) {
    const records = collectHistoryRecords(index);
    const exactSeen = new Map();
    const videoSeen = new Map();

    records.forEach((record) => {
      record.autoDuplicate = exactSeen.has(record.recordKey);
      exactSeen.set(record.recordKey, (exactSeen.get(record.recordKey) || 0) + 1);

      if (record.videoKey) {
        record.autoHistorical = videoSeen.has(record.videoKey) && !record.autoDuplicate;
        videoSeen.set(record.videoKey, (videoSeen.get(record.videoKey) || 0) + 1);
      }
    });

    records.forEach((record) => {
      renderHistoryRecord(record, manualMarks, onManualMarkChange);
    });
  }

  function collectHistoryRecords(index) {
    return Array.from(document.querySelectorAll('div[class*="historyPromotion_promotionItem"]'))
      .map((item) => {
      const cover = normalizeCoverUrl(item.querySelector('[class*="historyPromotion_promotionImg"] img')?.getAttribute('src'));
      if (!cover) return null;

      const info = item.querySelector('div[class*="historyPromotion_promotionInfo"]');
      if (!info) return null;

      const match = index[cover];
      const videoId = match?.videoId || '';
      const goodsId = match?.goodsId || '';
      const time = extractPromotionTime(item);
      const metrics = extractPromotionMetrics(item);
      const status = extractPromotionStatus(item);
      const videoKey = videoId || cover;
      const recordKey = [videoKey, time, metrics.estimate, metrics.done, status].join('|');

      return {
        item,
        info,
        cover,
        videoId,
        goodsId,
        time,
        status,
        videoKey,
        recordKey,
        estimate: metrics.estimate,
        done: metrics.done
      };
    })
      .filter(Boolean);
  }

  function renderHistoryRecord(record, manualMarks, onManualMarkChange) {
      const { item, info, videoId, goodsId, recordKey } = record;
      const manual = manualMarks[recordKey] || {};
      const duplicateChecked = record.autoDuplicate || Boolean(manual.duplicate);
      const justPromotedChecked = record.autoHistorical || Boolean(manual.justPromoted);
      let badge = item.querySelector('.pdd-promotion-history-id-badge');
      if (!badge) {
        badge = document.createElement('div');
        badge.className = 'pdd-promotion-history-id-badge';
        const top = info.querySelector('div[class*="historyPromotion_top"]');
        if (top?.nextSibling) {
          info.insertBefore(badge, top.nextSibling);
        } else {
          info.insertBefore(badge, info.firstChild);
        }
      }

      const nextMatched = videoId ? '1' : '0';
      const statusText = getStatusText(record, manual);
      const nextText = videoId
        ? `视频ID: ${videoId}${goodsId ? ` | 商品ID: ${goodsId}` : ''}${statusText ? ` | ${statusText}` : ''}`
        : '视频ID: 未匹配';
      const nextTitle = videoId
        ? '由短视频流量卡页缓存匹配'
        : '先打开短视频流量卡页加载更多视频后，可提高匹配率';

      if (badge.dataset.matched !== nextMatched) badge.dataset.matched = nextMatched;
      if (badge.textContent !== nextText) badge.textContent = nextText;
      if (badge.title !== nextTitle) badge.title = nextTitle;

      let controls = item.querySelector('.pdd-promotion-history-id-controls');
      if (!controls) {
        controls = document.createElement('div');
        controls.className = 'pdd-promotion-history-id-controls';
        badge.insertAdjacentElement('afterend', controls);
      }

      controls.dataset.recordKey = recordKey;
      renderManualCheckbox(controls, 'duplicate', '重复', duplicateChecked, record.autoDuplicate, recordKey, onManualMarkChange);
      renderManualCheckbox(controls, 'justPromoted', '刚推过', justPromotedChecked, record.autoHistorical, recordKey, onManualMarkChange);
  }

  function extractPromotionTime(item) {
    const text = getText(item.querySelector('[class*="historyPromotion_top"]') || item);
    const match = text.match(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/);
    return match ? match[0] : '';
  }

  function extractPromotionMetrics(item) {
    const values = Array.from(item.querySelectorAll('[class*="historyPromotion_dataLabel"]'))
      .map((el) => getText(el))
      .filter((text) => /^\d+$/.test(text));
    return {
      estimate: values[0] || '',
      done: values[1] || ''
    };
  }

  function extractPromotionStatus(item) {
    if (item.querySelector('[class*="historyPromotion_end"]')) return '已完成';
    if (item.querySelector('[class*="historyPromotion_ing"]')) return '投放中';
    return '';
  }

  function getStatusText(record, manual) {
    if (record.autoDuplicate || manual.duplicate) return '重复';
    if (record.autoHistorical) return '历史已推';
    if (manual.justPromoted) return '刚推过';
    return '';
  }

  function renderManualCheckbox(container, field, label, checked, autoChecked, recordKey, onChange) {
    let wrapper = container.querySelector(`[data-field="${field}"]`);
    if (!wrapper) {
      wrapper = document.createElement('label');
      wrapper.className = 'pdd-promotion-history-id-check';
      wrapper.dataset.field = field;

      const input = document.createElement('input');
      input.type = 'checkbox';
      input.addEventListener('change', () => {
        onChange(recordKey, field, input.checked);
      });

      const text = document.createElement('span');
      wrapper.appendChild(input);
      wrapper.appendChild(text);
      container.appendChild(wrapper);
    }

    const input = wrapper.querySelector('input');
    const text = wrapper.querySelector('span');
    if (input.checked !== checked) input.checked = checked;
    wrapper.dataset.auto = autoChecked ? '1' : '0';
    text.textContent = autoChecked ? `${label}(自动)` : label;
  }

  function removeInjectedIds() {
    document.querySelectorAll('.pdd-promotion-history-id-badge').forEach((badge) => badge.remove());
    document.querySelectorAll('.pdd-promotion-history-id-controls').forEach((controls) => controls.remove());
  }

  function injectStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const style = window.PddSharedStyle.addStyle(`
      .pdd-promotion-history-id-badge {
        display: inline-flex;
        align-items: center;
        width: fit-content;
        max-width: 100%;
        box-sizing: border-box;
        margin: 6px 0 8px;
        padding: 3px 7px;
        border: 1px solid #b7d3ff;
        border-radius: 4px;
        background: #f3f8ff;
        color: #1d4ed8;
        font-size: 12px;
        line-height: 18px;
        word-break: break-all;
      }
      .pdd-promotion-history-id-badge[data-matched="0"] {
        border-color: #ddd;
        background: #f7f7f7;
        color: #888;
      }
      .pdd-promotion-history-id-controls {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
        margin: -2px 0 8px;
        color: #595959;
        font-size: 12px;
        line-height: 18px;
      }
      .pdd-promotion-history-id-check {
        display: inline-flex;
        align-items: center;
        gap: 4px;
        cursor: pointer;
        user-select: none;
      }
      .pdd-promotion-history-id-check input {
        width: 13px;
        height: 13px;
        margin: 0;
        accent-color: #2563eb;
      }
      .pdd-promotion-history-id-check[data-auto="1"] {
        color: #d97706;
        font-weight: 600;
      }
    `);
    style.id = STYLE_ID;
  }

  function showToast(text) {
    const toast = document.createElement('div');
    toast.textContent = text;
    toast.style.cssText = [
      'position:fixed',
      'right:24px',
      'bottom:92px',
      'z-index:2147483647',
      'padding:8px 12px',
      'border-radius:6px',
      'background:rgba(0,0,0,.78)',
      'color:#fff',
      'font-size:12px',
      'line-height:18px',
      'box-shadow:0 6px 20px rgba(0,0,0,.18)'
    ].join(';');
    document.documentElement.appendChild(toast);
    window.setTimeout(() => toast.remove(), 1800);
  }
})();
