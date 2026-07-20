(function () {
  'use strict';

  const VIDEO_ROUTE = 'live.pinduoduo.com/n-creator/video';
  const COMMENT_ROUTE = 'mms.pinduoduo.com/goods/evaluation/index';
  const PROMOTION_GOODS_ROUTE = 'yingxiao.pinduoduo.com/goods/promotion/list';
  const VIDEO_MANAGE_ROUTE = 'live.pinduoduo.com/n-creator/video/video-manage';

  function isVideoPage() {
    return window.location.href.includes(VIDEO_ROUTE);
  }

  function isVideoManagePage() {
    return window.location.href.includes(VIDEO_MANAGE_ROUTE);
  }

  function isCommentPage() {
    return window.location.href.includes(COMMENT_ROUTE);
  }

  function isPromotionGoodsPage() {
    return window.location.href.includes(PROMOTION_GOODS_ROUTE);
  }

  function getAvailableFeatures() {
    if (isVideoPage()) {
      return [
        { id: 'video-workbench', title: '视频工作台', action: startVideoWorkbench },
        { id: 'video-monitor', title: '视频监控', action: startVideoMonitor },
        { id: 'video-download', title: '视频批量下载', action: startVideoDownload },
        { id: 'data-manager', title: '数据导入导出', action: startDataManager },
        { id: 'promotion-history-id-injector', title: getPromotionHistoryIdInjectorTitle, action: startPromotionHistoryIdInjector },
        ...(isVideoManagePage() ? [{ id: 'video-manage-delete', title: '视频管理批量删除', action: startVideoManageDelete }] : [])
      ];
    }

    if (isCommentPage()) {
      return [
        { id: 'comment-auto-reply', title: '评论自动回复', action: startCommentAutoReply },
        { id: 'data-manager', title: '数据导入导出', action: startDataManager }
      ];
    }

    if (isPromotionGoodsPage()) {
      return [
        { id: 'promotion-goods-delete', title: '营销商品批量删除', action: startPromotionGoodsDelete },
        { id: 'data-manager', title: '数据导入导出', action: startDataManager }
      ];
    }

    return [
      { id: 'data-manager', title: '数据导入导出', action: startDataManager }
    ];
  }

  async function openModule(moduleKey, errorMessage) {
    const moduleApi = window.PddModules?.[moduleKey];
    if (!moduleApi?.init) {
      console.error(errorMessage);
      return;
    }

    if (!moduleApi.inited) {
      await Promise.resolve(moduleApi.init());
    }

    if (typeof moduleApi.show === 'function') {
      moduleApi.show();
    }
  }

  function startVideoWorkbench() {
    if (!window.PddModules?.videoWorkbench?.init) {
      console.error('[PDD插件] 视频工作台模块不存在');
      return;
    }
    openModule('videoWorkbench', '[PDD插件] 视频工作台模块不存在');
  }

  function startVideoMonitor() {
    if (!window.PddModules?.videoMonitor?.init) {
      console.error('[PDD插件] 视频监控模块不存在');
      return;
    }
    openModule('videoMonitor', '[PDD插件] 视频监控模块不存在');
  }

  function startVideoDownload() {
    if (!window.PddModules?.videoDownload?.init) {
      console.error('[PDD插件] 视频批量下载模块不存在');
      return;
    }
    openModule('videoDownload', '[PDD插件] 视频批量下载模块不存在');
  }

  function startDataManager() {
    if (!window.PddModules?.dataManager?.init) {
      console.error('[PDD插件] 数据导入导出模块不存在');
      return;
    }
    openModule('dataManager', '[PDD插件] 数据导入导出模块不存在');
  }

  function startVideoManageDelete() {
    if (!window.PddModules?.videoManageDelete?.init) {
      console.error('[PDD插件] 视频管理批量删除模块不存在');
      return;
    }
    openModule('videoManageDelete', '[PDD插件] 视频管理批量删除模块不存在');
  }

  function startCommentAutoReply() {
    if (!window.PddModules?.commentAutoReply?.init) {
      console.error('[PDD插件] 评论自动回复模块不存在');
      return;
    }
    openModule('commentAutoReply', '[PDD插件] 评论自动回复模块不存在');
  }

  function startPromotionGoodsDelete() {
    if (!window.PddModules?.promotionGoodsDelete?.init) {
      console.error('[PDD插件] 营销商品批量删除模块不存在');
      return;
    }
    openModule('promotionGoodsDelete', '[PDD插件] 营销商品批量删除模块不存在');
  }

  function startPromotionHistoryIdInjector() {
    if (!window.PddModules?.promotionHistoryIdInjector?.init) {
      console.error('[PDD插件] 推广ID注入模块不存在');
      return;
    }
    return openModule('promotionHistoryIdInjector', '[PDD插件] 推广ID注入模块不存在');
  }

  function getPromotionHistoryIdInjectorTitle() {
    return window.PddModules?.promotionHistoryIdInjector?.getMenuTitle?.() || '推广ID注入：未开启';
  }

  async function init() {
    if (!window.PddFloatingBall?.init) {
      console.error('[PDD插件] 悬浮球模块不存在');
      return;
    }

    if (isVideoPage() && window.PddModules?.promotionHistoryIdInjector?.init) {
      await Promise.resolve(window.PddModules.promotionHistoryIdInjector.init()).catch((error) => {
        console.error('[PDD插件] 推广ID注入模块初始化失败', error);
      });
    }

    window.PddFloatingBall.init({
      features: getAvailableFeatures(),
      onAction(feature) {
        if (typeof feature.action === 'function') {
          feature.action();
        }
      }
    });
  }

  init();
})();
