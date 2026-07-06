chrome.runtime.onInstalled.addListener(() => {
  // MV3 service worker shell.
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || message.type !== 'DOWNLOAD_FILE') {
    return false;
  }

  const payload = message.payload || {};
  const downloadOptions = {
    url: payload.url,
    saveAs: Boolean(payload.saveAs)
  };

  if (payload.filename) {
    downloadOptions.filename = payload.filename;
  }

  chrome.downloads.download(downloadOptions, (downloadId) => {
    sendResponse({
      ok: !chrome.runtime.lastError,
      downloadId,
      error: chrome.runtime.lastError ? chrome.runtime.lastError.message : ''
    });
  });

  return true;
});
