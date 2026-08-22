/**
 * FluxDown Cover browser extension — popup script.
 *
 * Sends the current tab URL to FluxDown via deep link:
 *   fluxdown://download?url=<encoded>
 *
 * The HarmonyOS app registers this custom URI scheme and handles it
 * in EntryAbility.onNewWant / onCreate.
 */

const urlBox = document.getElementById('currentUrl');
const sendBtn = document.getElementById('sendBtn');
const copyBtn = document.getElementById('copyBtn');
const statusEl = document.getElementById('status');

let currentUrl = '';

function showStatus(msg, type) {
  statusEl.textContent = msg;
  statusEl.className = 'status ' + (type || '');
}

// Send to FluxDown via deep link
sendBtn.addEventListener('click', () => {
  if (!currentUrl) {
    showStatus('请先在网页中打开扩展', 'error');
    return;
  }
  const link = `fluxdown://download?url=${encodeURIComponent(currentUrl)}`;
  // chrome.tabs.create triggers OS custom protocol handler
  chrome.tabs.create({ url: link, active: false }, (tab) => {
    if (tab && tab.id) {
      setTimeout(() => chrome.tabs.remove(tab.id), 800);
    }
  });
  showStatus('已发送到 FluxDown Cover ✓', 'success');
});

// Copy deep link URL
copyBtn.addEventListener('click', () => {
  if (!currentUrl) {
    showStatus('请先在网页中打开扩展', 'error');
    return;
  }
  const link = `fluxdown://download?url=${encodeURIComponent(currentUrl)}`;
  navigator.clipboard.writeText(link).then(() => {
    showStatus('深度链接已复制到剪贴板', 'success');
  }).catch(() => {
    showStatus('复制失败', 'error');
  });
});

// Get current tab URL
chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
  if (tabs[0] && tabs[0].url) {
    currentUrl = tabs[0].url;
    urlBox.textContent = currentUrl;
  } else {
    urlBox.textContent = '请在网页中打开扩展（无法获取 chrome:// 页面地址）';
  }
});
