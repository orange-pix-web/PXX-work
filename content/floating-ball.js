(function () {
  'use strict';

  const ROOT_ID = 'pdd-extension-floating-root';
  const OPEN_CLASS = 'pdd-extension-floating-root--open';
  const PAGE_FEATURE_IDS = ['comment-auto-reply'];
  const GLOBAL_FEATURE_IDS = ['video-workbench', 'video-monitor', 'video-download'];
  const CONDITIONAL_FEATURE_IDS = ['video-manage-delete', 'promotion-goods-delete'];

  function createButton(className, text) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = className;
    button.textContent = text;
    return button;
  }

  function getCurrentPageMeta(features) {
    const featureIds = features.map((feature) => feature.id);

    if (featureIds.includes('comment-auto-reply')) {
      return {
        title: 'PAGE SECTION',
        subtitle: '评论页面功能'
      };
    }

    if (featureIds.includes('promotion-goods-delete')) {
      return {
        title: 'PAGE SECTION',
        subtitle: '推广页面功能'
      };
    }

    return {
      title: 'PAGE SECTION',
      subtitle: '视频页面功能'
    };
  }

  function createSection(title, subtitle) {
    const section = document.createElement('section');
    section.style.display = 'flex';
    section.style.flexDirection = 'column';
    section.style.gap = '6px';

    const header = document.createElement('div');
    header.style.display = 'flex';
    header.style.flexDirection = 'column';
    header.style.gap = '2px';

    const titleElement = document.createElement('div');
    titleElement.textContent = title;
    titleElement.style.fontSize = '11px';
    titleElement.style.fontWeight = '700';
    titleElement.style.lineHeight = '16px';
    titleElement.style.letterSpacing = '0.04em';
    titleElement.style.color = '#8c8c8c';

    const subtitleElement = document.createElement('div');
    subtitleElement.textContent = subtitle;
    subtitleElement.style.fontSize = '13px';
    subtitleElement.style.fontWeight = '600';
    subtitleElement.style.lineHeight = '18px';
    subtitleElement.style.color = '#262626';

    const list = document.createElement('div');
    list.style.display = 'flex';
    list.style.flexDirection = 'column';
    list.style.gap = '4px';

    header.appendChild(titleElement);
    header.appendChild(subtitleElement);
    section.appendChild(header);
    section.appendChild(list);

    return { section, list };
  }

  function createSectionItem(root, feature, onAction) {
    const item = createButton('pdd-extension-floating-menu__item', feature.title);
    item.dataset.featureId = feature.id;
    item.addEventListener('click', () => {
      root.classList.remove(OPEN_CLASS);
      onAction(feature);
    });
    return item;
  }

  function appendFeatures(list, root, features, onAction) {
    features.forEach((feature) => {
      list.appendChild(createSectionItem(root, feature, onAction));
    });
  }

  function renderEmptyState(list, text) {
    const empty = document.createElement('div');
    empty.textContent = text;
    empty.style.padding = '4px 10px 2px';
    empty.style.fontSize = '12px';
    empty.style.lineHeight = '18px';
    empty.style.color = '#b5b5b5';
    list.appendChild(empty);
  }

  async function openCleanModuleView() {
    const moduleApi = window.PddModules?.cleanModule;
    if (!moduleApi?.openView) {
      console.error('[PDD插件] cleanModule 模块不存在');
      return;
    }

    await Promise.resolve(moduleApi.openView());
  }

  function getAugmentedGlobalFeatures(features) {
    const globalFeatures = features.filter((feature) => GLOBAL_FEATURE_IDS.includes(feature.id));
    const hasWorkbench = globalFeatures.some((feature) => feature.id === 'video-workbench');

    if (!hasWorkbench) {
      return globalFeatures;
    }

    return globalFeatures.concat({
      id: 'video-workbench-clean',
      title: '批量删除',
      action: openCleanModuleView
    });
  }

  function renderMenu(root, features, onAction) {
    const panel = document.createElement('div');
    panel.className = 'pdd-extension-floating-menu';
    panel.style.minWidth = '260px';
    panel.style.padding = '12px';

    const panelContent = document.createElement('div');
    panelContent.style.display = 'flex';
    panelContent.style.flexDirection = 'column';
    panelContent.style.gap = '12px';

    const currentPageMeta = getCurrentPageMeta(features);
    const pageFeatures = features.filter((feature) => PAGE_FEATURE_IDS.includes(feature.id));
    const globalFeatures = getAugmentedGlobalFeatures(features);
    const conditionalFeatures = features.filter((feature) => CONDITIONAL_FEATURE_IDS.includes(feature.id));

    const pageSection = createSection(currentPageMeta.title, currentPageMeta.subtitle);
    appendFeatures(pageSection.list, root, pageFeatures, onAction);
    if (!pageFeatures.length) {
      renderEmptyState(pageSection.list, '当前页面暂无归属 PAGE SECTION 的功能');
    }

    const globalSection = createSection('GLOBAL SECTION', '全局功能');
    appendFeatures(globalSection.list, root, globalFeatures, onAction);
    if (!globalFeatures.length) {
      renderEmptyState(globalSection.list, '当前页面暂无可用全局功能');
    }

    const conditionalSection = createSection('CONDITIONAL SECTION', '条件功能');
    appendFeatures(conditionalSection.list, root, conditionalFeatures, onAction);
    if (!conditionalFeatures.length) {
      renderEmptyState(conditionalSection.list, '当前页面暂无触发的条件功能');
    }

    panelContent.appendChild(pageSection.section);
    panelContent.appendChild(globalSection.section);
    panelContent.appendChild(conditionalSection.section);
    panel.appendChild(panelContent);
    root.appendChild(panel);
  }

  function init(options) {
    const features = options.features || [];
    const onAction = options.onAction || function () {};

    const existingRoot = document.getElementById(ROOT_ID);
    if (existingRoot) {
      existingRoot.remove();
    }

    const root = document.createElement('div');
    root.id = ROOT_ID;
    root.className = 'pdd-extension-floating-root';

    const ball = createButton('pdd-extension-floating-ball', 'PDD');
    ball.setAttribute('aria-label', '打开 PDD 插件菜单');
    ball.addEventListener('click', () => {
      root.classList.toggle(OPEN_CLASS);
    });

    root.appendChild(ball);
    renderMenu(root, features, onAction);
    document.documentElement.appendChild(root);
  }

  window.PddFloatingBall = {
    init
  };
})();
