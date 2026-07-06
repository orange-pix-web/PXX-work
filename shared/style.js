(function () {
  'use strict';

  window.PddSharedStyle = {
    addStyle(cssText) {
      const style = document.createElement('style');
      style.type = 'text/css';
      style.textContent = cssText;
      document.documentElement.appendChild(style);
      return style;
    }
  };
})();
