(function () {
  'use strict';

  window.PddDownload = {
    async downloadFile(options) {
      return new Promise((resolve, reject) => {
        const filename = options.filename || options.name;

        chrome.runtime.sendMessage(
          {
            type: 'DOWNLOAD_FILE',
            payload: {
              url: options.url,
              filename,
              saveAs: options.saveAs
            }
          },
          (response) => {
            if (chrome.runtime.lastError) {
              if (typeof options.onerror === 'function') {
                options.onerror(chrome.runtime.lastError.message);
              }
              reject(new Error(chrome.runtime.lastError.message));
              return;
            }

            if (!response || !response.ok) {
              const error = response && response.error ? response.error : 'Download failed';
              if (typeof options.onerror === 'function') {
                options.onerror(error);
              }
              reject(new Error(error));
              return;
            }

            if (typeof options.onload === 'function') {
              options.onload(response.downloadId);
            }
            resolve(response.downloadId);
          }
        );
      });
    }
  };
})();
