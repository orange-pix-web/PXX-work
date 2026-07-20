(function () {
  'use strict';

  window.PddModules = window.PddModules || {};

  const ROUTE = 'live.pinduoduo.com/n-creator/video';
  const STYLE_ID = 'pdd-promotion-history-id-css';
  const STORAGE_KEY = 'promotionHistoryIdInjector_v1_videoIndex';
  const ENABLED_KEY = 'promotionHistoryIdInjector_v1_enabled';
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
      let enabled = Boolean(await window.PddStorage?.get?.(ENABLED_KEY, false));
      this.enabled = enabled;
      let scanTimer = null;

      function scheduleScan() {
        window.clearTimeout(scanTimer);
        scanTimer = window.setTimeout(async () => {
          if (!enabled) {
            removeInjectedIds();
            return;
          }

          const changed = collectVideoTableIndex(videoIndex);
          injectHistoryIds(videoIndex);
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

  function injectHistoryIds(index) {
    const items = Array.from(document.querySelectorAll('div[class*="historyPromotion_promotionItem"]'));
    items.forEach((item) => {
      const cover = normalizeCoverUrl(item.querySelector('[class*="historyPromotion_promotionImg"] img')?.getAttribute('src'));
      if (!cover) return;

      const info = item.querySelector('div[class*="historyPromotion_promotionInfo"]');
      if (!info) return;

      const match = index[cover];
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

      const nextMatched = match?.videoId ? '1' : '0';
      const nextText = match?.videoId
        ? `视频ID: ${match.videoId}${match.goodsId ? ` | 商品ID: ${match.goodsId}` : ''}`
        : '视频ID: 未匹配';
      const nextTitle = match?.videoId
        ? '由短视频流量卡页缓存匹配'
        : '先打开短视频流量卡页加载更多视频后，可提高匹配率';

      if (badge.dataset.matched !== nextMatched) badge.dataset.matched = nextMatched;
      if (badge.textContent !== nextText) badge.textContent = nextText;
      if (badge.title !== nextTitle) badge.title = nextTitle;
    });
  }

  function removeInjectedIds() {
    document.querySelectorAll('.pdd-promotion-history-id-badge').forEach((badge) => badge.remove());
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
