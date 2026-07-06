(function () {
  'use strict';

  function rejectLastError(reject) {
    if (chrome.runtime.lastError) {
      reject(new Error(chrome.runtime.lastError.message));
      return true;
    }
    return false;
  }

  window.PddStorage = {
    async get(key, defaultValue) {
      return new Promise((resolve, reject) => {
        chrome.storage.local.get([key], (result) => {
          if (rejectLastError(reject)) return;
          if (Object.prototype.hasOwnProperty.call(result, key)) {
            resolve(result[key]);
            return;
          }
          resolve(defaultValue);
        });
      });
    },

    async set(key, value) {
      return new Promise((resolve, reject) => {
        chrome.storage.local.set({ [key]: value }, () => {
          if (rejectLastError(reject)) return;
          resolve();
        });
      });
    },

    async remove(key) {
      return new Promise((resolve, reject) => {
        chrome.storage.local.remove(key, () => {
          if (rejectLastError(reject)) return;
          resolve();
        });
      });
    },

    async clear() {
      return new Promise((resolve, reject) => {
        chrome.storage.local.clear(() => {
          if (rejectLastError(reject)) return;
          resolve();
        });
      });
    }
  };
})();
