/**
 * FluxDown Cover — local HTTP API client.
 *
 * Talks to the HarmonyOS app's local server on 127.0.0.1:17800.
 * Endpoints (implemented in McpServer.ts):
 *   GET  /ping                 liveness probe (no auth)
 *   GET  /api/v1/info          app info
 *   GET  /api/v1/tasks         task list WITH live progress
 *   POST /download/batch       create tasks, body { items:[{url}, ...] }
 *
 * Shared by the background service worker (importScripts) and popup (<script>).
 * The official desktop extension gets progress through Native Messaging, which
 * HarmonyOS Chrome does not support; this HTTP channel replaces it.
 */
(function (root) {
  const DEFAULT_BASE = 'http://127.0.0.1:17800';
  // Must match the app's default local-server token (DownloadViewModel.mcpToken).
  const DEFAULTS = { baseUrl: DEFAULT_BASE, token: 'fluxdowncover-local' };
  const TIMEOUT_MS = 4000;

  function loadConfig() {
    return new Promise((resolve) => {
      try {
        chrome.storage.local.get(DEFAULTS, (cfg) => resolve(cfg || Object.assign({}, DEFAULTS)));
      } catch (e) {
        resolve(Object.assign({}, DEFAULTS));
      }
    });
  }

  function saveConfig(cfg) {
    return new Promise((resolve) => {
      try {
        chrome.storage.local.set(cfg, () => resolve());
      } catch (e) {
        resolve();
      }
    });
  }

  async function request(path, options) {
    const opts = options || {};
    const method = opts.method || 'GET';
    const cfg = await loadConfig();
    const headers = { 'X-FluxDown-Client': 'extension' };
    if (cfg.token) {
      headers['X-FluxDown-Token'] = cfg.token;
    }
    if (opts.body !== undefined) {
      headers['Content-Type'] = 'application/json';
    }
    const ctrl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
    const timer = ctrl ? setTimeout(() => ctrl.abort(), TIMEOUT_MS) : null;
    let resp;
    try {
      resp = await fetch(cfg.baseUrl.replace(/\/$/, '') + path, {
        method: method,
        headers: headers,
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
        signal: ctrl ? ctrl.signal : undefined
      });
    } catch (e) {
      if (timer) clearTimeout(timer);
      return { success: false, message: 'unreachable: ' + String(e) };
    }
    if (timer) clearTimeout(timer);

    let data = {};
    try {
      data = await resp.json();
    } catch (e) {
      data = {};
    }
    if (!resp.ok) {
      return { success: false, status: resp.status, message: data.message || ('HTTP ' + resp.status) };
    }
    data.success = data.success !== false;
    data.status = resp.status;
    return data;
  }

  function ping() {
    return request('/ping');
  }

  function info() {
    return request('/api/v1/info');
  }

  async function listTasks() {
    const r = await request('/api/v1/tasks');
    if (r.success && !Array.isArray(r.tasks)) {
      r.tasks = [];
    }
    return r;
  }

  /** Accepts a single url string or an array; mirrors the official /download/batch body. */
  function sendDownloads(urls) {
    const list = (Array.isArray(urls) ? urls : [urls]).filter(Boolean);
    return request('/download/batch', {
      method: 'POST',
      body: { items: list.map((u) => ({ url: u })) }
    });
  }

  const api = {
    DEFAULT_BASE: DEFAULT_BASE,
    loadConfig: loadConfig,
    saveConfig: saveConfig,
    request: request,
    ping: ping,
    info: info,
    listTasks: listTasks,
    sendDownloads: sendDownloads
  };

  root.FluxLocalApi = api;
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
})(typeof self !== 'undefined' ? self : globalThis);
