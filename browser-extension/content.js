/**
 * FluxDown Cover browser extension — content script.
 *
 * Injects a floating "发送到 FluxDown" button on pages with direct download links.
 * The button appears when the user hovers over a link that looks like a downloadable
 * file (based on file extension).
 */

const DOWNLOAD_EXTENSIONS = [
  '.zip', '.rar', '.7z', '.tar', '.gz', '.bz2',
  '.exe', '.msi', '.dmg', '.pkg', '.deb', '.rpm', '.apk',
  '.hap', '.hsp', '.har', // HarmonyOS 包格式
  '.mp4', '.mkv', '.avi', '.mov', '.wmv', '.flv',
  '.mp3', '.flac', '.wav', '.aac', '.ogg',
  '.iso', '.img', '.bin',
  '.pdf', '.doc', '.docx', '.xls', '.xlsx',
  '.torrent'
];

function isDownloadableLink(href) {
  if (!href) return false;
  const lower = href.toLowerCase().split('?')[0].split('#')[0];
  return DOWNLOAD_EXTENSIONS.some(ext => lower.endsWith(ext));
}

// Add hover button for downloadable links
document.addEventListener('mouseover', (e) => {
  const link = e.target.closest('a');
  if (!link || !link.href) return;
  if (!isDownloadableLink(link.href)) return;
  if (link.dataset.fluxdownBtn) return;

  link.dataset.fluxdownBtn = '1';
  const btn = document.createElement('div');
  btn.textContent = '⬇ FluxDown Cover';
  btn.style.cssText = `
    position: fixed;
    z-index: 2147483647;
    background: linear-gradient(135deg, #00BCD4, #006064);
    color: #fff;
    padding: 6px 12px;
    border-radius: 6px;
    font-size: 13px;
    font-family: sans-serif;
    cursor: pointer;
    box-shadow: 0 2px 8px rgba(0,0,0,0.3);
    user-select: none;
    transition: opacity 0.2s;
  `;

  // position: fixed → coordinates are viewport-relative, no scroll offset needed
  const rect = link.getBoundingClientRect();
  const btnLeft = Math.min(rect.right - 100, window.innerWidth - 110);
  const btnTop = Math.max(rect.top - 30, 4);
  btn.style.left = btnLeft + 'px';
  btn.style.top = btnTop + 'px';

  let hideTimer = null;
  const hideDelay = 2000;

  function startHideTimer() {
    cancelHideTimer();
    hideTimer = setTimeout(() => {
      btn.style.opacity = '0';
      setTimeout(() => {
        btn.remove();
        delete link.dataset.fluxdownBtn;
      }, 200);
    }, hideDelay);
  }

  function cancelHideTimer() {
    if (hideTimer) {
      clearTimeout(hideTimer);
      hideTimer = null;
    }
  }

  // Keep button alive while mouse is over it
  btn.addEventListener('mouseenter', cancelHideTimer);
  btn.addEventListener('mouseleave', startHideTimer);

  btn.addEventListener('click', (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    chrome.runtime.sendMessage({ action: 'sendToFluxDown', url: link.href });
    btn.textContent = '✓ 已发送';
    cancelHideTimer();
    setTimeout(() => {
      btn.style.opacity = '0';
      setTimeout(() => {
        btn.remove();
        delete link.dataset.fluxdownBtn;
      }, 200);
    }, 1500);
  });

  document.body.appendChild(btn);

  // Start hide timer when mouse leaves the link
  link.addEventListener('mouseleave', () => {
    startHideTimer();
  }, { once: true });
});
