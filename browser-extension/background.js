/**
 * FluxDown Cover browser extension — background service worker.
 *
 * Delivery order for a captured URL:
 *   1. Local HTTP  POST http://127.0.0.1:17800/download/batch  (carries progress channel)
 *   2. Deep link   fluxdown://download?url=...                  (fallback, launch only)
 */

try {
  importScripts('local-api.js');
} catch (e) {
  // self.FluxLocalApi unavailable -> every send falls back to the deep link.
  console.warn('[FluxDown Cover] local-api.js failed to load:', e);
}

// Create context menu on install
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: 'fluxdown-send-link',
    title: '发送到 FluxDown Cover 下载',
    contexts: ['link']
  });
  chrome.contextMenus.create({
    id: 'fluxdown-send-page',
    title: '发送本页到 FluxDown Cover 下载',
    contexts: ['page']
  });
});

// Handle context menu clicks
chrome.contextMenus.onClicked.addListener((info, tab) => {
  let url = '';
  if (info.menuItemId === 'fluxdown-send-link') {
    url = info.linkUrl;
  } else if (info.menuItemId === 'fluxdown-send-page') {
    url = info.pageUrl || (tab && tab.url) || '';
  }
  if (url) {
    sendToApp(url);
  }
});

// Handle messages from content script and popup (async response via `return true`).
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === 'sendToFluxDown' && msg.url) {
    sendToApp(msg.url).then(sendResponse);
    return true;
  }
});

/** Try the local HTTP API first; on any failure fall back to the deep link. */
async function sendToApp(url) {
  if (self.FluxLocalApi) {
    try {
      const r = await self.FluxLocalApi.sendDownloads(url);
      if (r && r.success) {
        return { ok: true, channel: 'http' };
      }
    } catch (e) {
      // fall through to deep link
    }
  }
  const deepOk = await sendViaDeepLink(url);
  return { ok: deepOk, channel: 'deeplink' };
}

/** Open the custom scheme in a throwaway tab so the OS dispatches it to the app. */
function sendViaDeepLink(url) {
  return new Promise((resolve) => {
    const link = `fluxdown://download?url=${encodeURIComponent(url)}`;
    chrome.tabs.create({ url: link, active: false }, (tab) => {
      if (tab && tab.id) {
        setTimeout(() => {
          chrome.tabs.remove(tab.id, () => {
            if (chrome.runtime.lastError) { /* tab already closed */ }
          });
        }, 800);
      }
      resolve(true);
    });
  });
}
