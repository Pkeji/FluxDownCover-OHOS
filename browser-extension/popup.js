/**
 * FluxDown Cover browser extension — popup.
 * Sends the current tab over the local HTTP API (fallback: fluxdown:// deep link)
 * and polls GET /api/v1/tasks every 1.5s to render live progress.
 */

const urlBox = document.getElementById('currentUrl');
const sendBtn = document.getElementById('sendBtn');
const copyBtn = document.getElementById('copyBtn');
const statusEl = document.getElementById('status');
const connDot = document.getElementById('connDot');
const connText = document.getElementById('connText');
const taskList = document.getElementById('taskList');
const taskCount = document.getElementById('taskCount');

let currentUrl = '';
let connected = false;

const STATUS_CN = {
  pending: '排队', queued: '排队', downloading: '下载中', paused: '已暂停',
  verifying: '校验中', completed: '已完成', error: '错误'
};
const ACTIVE = new Set(['pending', 'queued', 'downloading', 'verifying']);

function showStatus(msg, type) {
  statusEl.textContent = msg;
  statusEl.className = 'status ' + (type || '');
}

function formatBytes(n) {
  if (!n || n <= 0) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return v.toFixed(v >= 100 || i === 0 ? 0 : 1) + ' ' + u[i];
}

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function setConn(on, text) {
  connected = on;
  connDot.className = 'dot ' + (on ? 'on' : 'off');
  connText.textContent = text;
}

async function refresh() {
  if (!window.FluxLocalApi) { return; }
  const r = await window.FluxLocalApi.listTasks();
  if (r && r.success) {
    setConn(true, '已连接');
    renderTasks(Array.isArray(r.tasks) ? r.tasks : []);
  } else {
    setConn(false, '未连接 App');
    renderTasks(null);
  }
}

function renderTasks(tasks) {
  if (tasks === null) {
    taskList.innerHTML = '<div class="empty">未连接到 App（127.0.0.1:17800）</div>';
    taskCount.textContent = '';
    return;
  }
  if (!tasks.length) {
    taskList.innerHTML = '<div class="empty">暂无任务</div>';
    taskCount.textContent = '';
    return;
  }
  // active first, then newest first
  const sorted = tasks.slice().sort((a, b) => {
    const aa = ACTIVE.has(a.status) ? 0 : 1;
    const bb = ACTIVE.has(b.status) ? 0 : 1;
    if (aa !== bb) return aa - bb;
    return (b.createdAt || 0) - (a.createdAt || 0);
  }).slice(0, 20);

  taskCount.textContent = tasks.length + ' 个任务';
  taskList.innerHTML = sorted.map((t) => {
    const pct = Math.max(0, Math.min(100, Number(t.progress ?? t.percent ?? 0)));
    const st = t.status || 'pending';
    const stCn = STATUS_CN[st] || st;
    const name = esc(t.name || t.fileName || t.url || t.id || '任务');
    const subRight = ACTIVE.has(st) && t.speed > 0 ? formatBytes(t.speed) + '/s' : stCn;
    const size = (t.totalBytes > 0) ? formatBytes(t.downloadedBytes) + ' / ' + formatBytes(t.totalBytes) : formatBytes(t.downloadedBytes);
    return (
      '<div class="task">' +
        '<div class="row1">' +
          '<span class="name" title="' + name + '">' + name + '</span>' +
          '<span class="pct">' + (st === 'completed' ? '100' : pct) + '%</span>' +
        '</div>' +
        '<div class="bar"><i style="width:' + (st === 'completed' ? 100 : pct) + '%"></i></div>' +
        '<div class="row2">' +
          '<span><span class="st ' + esc(st) + '">' + esc(stCn) + '</span> &nbsp;' + size + '</span>' +
          '<span>' + esc(subRight) + '</span>' +
        '</div>' +
        (st === 'error' && t.errorMessage ? '<div class="row2" style="color:#c62828;margin-top:4px">' + esc(t.errorMessage) + '</div>' : '') +
      '</div>'
    );
  }).join('');
}

// Send: local HTTP first, deep-link fallback.
sendBtn.addEventListener('click', async () => {
  if (!currentUrl) {
    showStatus('请先在网页中打开扩展', 'error');
    return;
  }
  if (window.FluxLocalApi) {
    try {
      const r = await window.FluxLocalApi.sendDownloads(currentUrl);
      if (r && r.success) {
        showStatus('已通过本机服务发送 ✓（可看进度）', 'success');
        refresh();
        return;
      }
    } catch (e) { /* fall through */ }
  }
  const link = `fluxdown://download?url=${encodeURIComponent(currentUrl)}`;
  chrome.tabs.create({ url: link, active: false }, (tab) => {
    if (tab && tab.id) setTimeout(() => chrome.tabs.remove(tab.id), 800);
  });
  showStatus('App 未响应，已改用深度链接唤起', 'error');
});

copyBtn.addEventListener('click', () => {
  if (!currentUrl) {
    showStatus('请先在网页中打开扩展', 'error');
    return;
  }
  const link = `fluxdown://download?url=${encodeURIComponent(currentUrl)}`;
  navigator.clipboard.writeText(link).then(() => {
    showStatus('深度链接已复制', 'success');
  }).catch(() => showStatus('复制失败', 'error'));
});

// Current tab URL
chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
  if (tabs[0] && tabs[0].url) {
    currentUrl = tabs[0].url;
    urlBox.textContent = currentUrl;
  } else {
    urlBox.textContent = '请在网页中打开扩展（无法获取 chrome:// 页面地址）';
  }
});

// Initial + periodic refresh (stops automatically when the popup closes).
refresh();
const pollTimer = setInterval(refresh, 1500);
window.addEventListener('unload', () => clearInterval(pollTimer));
