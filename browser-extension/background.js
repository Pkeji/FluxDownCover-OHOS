/**
 * FluxDown Cover browser extension — background service worker.
 *
 * Registers a context menu item so the user can right-click any link
 * on any page and send it directly to FluxDown.
 */

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
    sendViaDeepLink(url);
  }
});

// Handle messages from content script
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === 'sendToFluxDown' && msg.url) {
    sendViaDeepLink(msg.url);
    sendResponse({ ok: true });
  }
  return true;
});

function sendViaDeepLink(url) {
  const link = `fluxdown://download?url=${encodeURIComponent(url)}`;
  chrome.tabs.create({ url: link, active: false }, (tab) => {
    // Close the temporary tab after 800ms — OS should have dispatched the deep link by then
    if (tab && tab.id) {
      setTimeout(() => {
        chrome.tabs.remove(tab.id, () => {
          // Tab closed (ignore errors if already gone)
          if (chrome.runtime.lastError) { /* tab already closed */ }
        });
      }, 800);
    }
  });
}
