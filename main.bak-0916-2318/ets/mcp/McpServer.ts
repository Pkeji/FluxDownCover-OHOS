import { socket } from '@kit.NetworkKit';
import { logCollector } from '../utils/LogCollector';
import { BusinessError } from '@kit.BasicServicesKit';
import { McpBackend } from './McpBackend';
import { DownloadTask } from '../model/DownloadTask';

const MCP_PORT = 17800;
const LOCAL_API_VERSION = '1.2.0';

const TOOLS = [
  {
    name: 'addDownload',
    description: 'Add a new download (http/https/ftp/hls) by URL.',
    inputSchema: {
      type: 'object',
      properties: { url: { type: 'string', description: 'Download URL' } },
      required: ['url']
    }
  },
  {
    name: 'listDownloads',
    description: 'List all download tasks with id, name, status and progress.',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'pauseDownload',
    description: 'Pause a download by task id.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id']
    }
  },
  {
    name: 'resumeDownload',
    description: 'Resume a paused download by task id.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id']
    }
  },
  {
    name: 'removeDownload',
    description: 'Remove a download by task id.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id']
    }
  },
  {
    name: 'getDownload',
    description: 'Get details of a single download by task id.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id']
    }
  },
  {
    name: 'pauseAllDownloads',
    description: 'Pause all active downloads.',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'resumeAllDownloads',
    description: 'Resume all paused downloads.',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'batchAddDownloads',
    description: 'Add multiple downloads by URL list.',
    inputSchema: {
      type: 'object',
      properties: { urls: { type: 'array', items: { type: 'string' } } },
      required: ['urls']
    }
  },
  {
    name: 'listQueues',
    description: 'List all download queues.',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'startQueue',
    description: 'Start all tasks in a queue (respects maxConcurrent & priority).',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id']
    }
  },
  {
    name: 'pauseQueue',
    description: 'Pause all downloading tasks in a queue.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id']
    }
  },
  {
    name: 'listRss',
    description: 'List all RSS subscriptions.',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'addRss',
    description: 'Add an RSS subscription.',
    inputSchema: {
      type: 'object',
      properties: { url: { type: 'string' }, name: { type: 'string' }, filter: { type: 'string' } },
      required: ['url', 'name']
    }
  },
  {
    name: 'removeRss',
    description: 'Remove an RSS subscription by id.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id']
    }
  },
  {
    name: 'getStats',
    description: 'Get download statistics summary.',
    inputSchema: { type: 'object', properties: {} }
  }
];

/**
 * Minimal MCP (Model Context Protocol) server over a local HTTP endpoint.
 * Listens on 127.0.0.1:17800, speaks JSON-RPC 2.0, and exposes 5 tools so an
 * AI agent can drive FluxDown Cover. Bearer-token protected.
 *
 * Implemented with @ohos.net.socket (TCPSocket server). Validated structurally
 * against the official socket API; verify on-device with a real MCP client.
 */
export class McpServer {
  private static instance: McpServer | null = null;
  private server: socket.TCPSocket | null = null;
  private backend: McpBackend | null = null;
  private token: string = '';

  static getInstance(): McpServer {
    if (!McpServer.instance) {
      McpServer.instance = new McpServer();
    }
    return McpServer.instance;
  }

  async start(token: string, backend: McpBackend): Promise<void> {
    if (this.server) {
      return;
    }
    this.token = token;
    this.backend = backend;
    const server = socket.constructTCPSocketInstance();
    this.server = server;
    server.on('connect', (client: socket.TCPSocket) => {
      this.handleClient(client);
    });
    try {
      await server.bind({ address: '127.0.0.1', port: MCP_PORT });
      console.info(`FluxDown Cover MCP server listening on 127.0.0.1:${MCP_PORT}`);
    } catch (e) {
      logCollector.error('Error', `FluxDown Cover MCP bind failed: ${JSON.stringify(e)}`);
      this.server = null;
    }
  }

  stop(): void {
    if (this.server) {
      try {
        this.server.close();
      } catch (e) {
        // ignore
      }
      this.server = null;
    }
  }

  private handleClient(client: socket.TCPSocket): void {
    let buf = '';
    let closed = false;
    const onMessage = (msg: Object) => {
      if (closed) {
        return;
      }
      buf += ab2str((msg as { message: ArrayBuffer }).message);
      const headerEnd = buf.indexOf('\r\n\r\n');
      if (headerEnd < 0) {
        return;
      }
      const headerText = buf.substring(0, headerEnd);
      const clMatch = /content-length:\s*(\d+)/i.exec(headerText);
      const cl = clMatch ? Number(clMatch[1]) : 0;
      const bodyStart = headerEnd + 4;
      if (buf.length - bodyStart < cl) {
        return; // wait for more body bytes
      }
      const body = buf.substring(bodyStart, bodyStart + cl);
      const result = this.processRequest(headerText, body);
      const resp = buildHttpResponse(result.status, result.json);
      client
        .send({ data: resp })
        .then(() => client.close())
        .catch(() => {
          try {
            client.close();
          } catch (e) {
            // ignore
          }
        });
      closed = true;
    };
    client.on('message', onMessage);
    client.on('close', () => {
      closed = true;
    });
    client.on('error', (err: BusinessError) => {
      logCollector.error('Error', `MCP client error: ${err.code} ${err.message}`);
      closed = true;
      try {
        client.close();
      } catch (e) {
        // ignore
      }
    });
  }

  /**
   * Single HTTP entry on 127.0.0.1:17800. Routes by method + path so the port
   * serves BOTH:
   *  - the FluxDown browser-extension compatible REST/takeover surface
   *    (GET /ping, GET /api/v1/info, GET /api/v1/tasks, POST /download[/batch]);
   *  - the original MCP JSON-RPC 2.0 surface (POST /mcp and legacy callers).
   */
  private processRequest(
    headerText: string,
    body: string
  ): { status: number; json: string } {
    const lines = headerText.split('\r\n');
    const requestLine = lines.length > 0 ? lines[0] : '';
    const reqParts = requestLine.split(' ');
    const method = reqParts.length >= 1 ? reqParts[0] : 'GET';
    const rawPath = reqParts.length >= 2 ? reqParts[1] : '/';
    const qIdx = rawPath.indexOf('?');
    const path = qIdx >= 0 ? rawPath.substring(0, qIdx) : rawPath;
    const headers = this.parseHeaders(lines);

    // CORS preflight (browser extension cross-origin fetch).
    if (method === 'OPTIONS') {
      return { status: 204, json: '' };
    }

    // Liveness probe — no auth. Official extension uses this to detect the app.
    if (method === 'GET' && path === '/ping') {
      return this.jsonOk({ success: true, app: 'FluxDown Cover', service: 'fluxdown-local', version: LOCAL_API_VERSION });
    }

    // App info.
    if (method === 'GET' && path === '/api/v1/info') {
      const auth = this.checkToken(headers);
      if (!auth.ok) {
        return this.jsonErr(auth.status, auth.message);
      }
      return this.jsonOk({
        success: true, name: 'FluxDown Cover', version: LOCAL_API_VERSION,
        platform: 'HarmonyOS', port: MCP_PORT
      });
    }

    // Task list WITH progress — our extension polls this to render progress,
    // since Native Messaging (the official desktop progress channel) is
    // unavailable on HarmonyOS Chrome.
    if (method === 'GET' && path === '/api/v1/tasks') {
      const auth = this.checkToken(headers);
      if (!auth.ok) {
        return this.jsonErr(auth.status, auth.message);
      }
      if (!this.backend) {
        return this.jsonErr(503, 'backend not ready');
      }
      const tasks = this.backend.listTasks().map((t: DownloadTask): Record<string, Object> => this.taskToJson(t));
      return this.jsonOk({ success: true, tasks });
    }

    // Browser takeover endpoints (official extension HTTP fallback channel).
    if (method === 'POST' && (path === '/download' || path === '/download/batch')) {
      // Anti-CSRF: an ordinary web page cannot set this custom header without a
      // successful CORS preflight, so its presence proves a privileged caller.
      const client = (headers['x-fluxdown-client'] ?? '').toLowerCase();
      if (client !== 'extension') {
        return this.jsonErr(403, 'missing X-FluxDown-Client header');
      }
      const auth = this.checkToken(headers);
      if (!auth.ok) {
        return this.jsonErr(auth.status, auth.message);
      }
      if (!this.backend) {
        return this.jsonErr(503, 'backend not ready');
      }
      const urls = this.parseDownloadUrls(body);
      if (urls.length === 0) {
        return this.jsonErr(400, 'no valid urls');
      }
      const backend = this.backend;
      urls.forEach((u: string) => {
        backend.addTask(u).catch((e: Object) => {
          logCollector.error('Error', `local API addTask failed: ${String(e)}`);
        });
      });
      return this.jsonOk({ success: true, accepted: urls.length });
    }

    // Fall through to MCP JSON-RPC 2.0 for everything else.
    return this.processMcpRequest(body, headers);
  }

  private parseHeaders(lines: string[]): Record<string, string> {
    const map: Record<string, string> = {};
    for (let i = 1; i < lines.length; i++) {
      const ci = lines[i].indexOf(':');
      if (ci > 0) {
        const key = lines[i].substring(0, ci).trim().toLowerCase();
        map[key] = lines[i].substring(ci + 1).trim();
      }
    }
    return map;
  }

  /** Local loopback: when no token is configured we allow; otherwise require X-FluxDown-Token or Bearer. */
  private checkToken(headers: Record<string, string>): { ok: boolean; status: number; message: string } {
    if (!this.token) {
      return { ok: true, status: 200, message: '' };
    }
    const xt = headers['x-fluxdown-token'] ?? '';
    const bearerMatch = /Bearer\s+(\S+)/i.exec(headers['authorization'] ?? '');
    const bearer = bearerMatch ? bearerMatch[1] : '';
    if (xt === this.token || bearer === this.token) {
      return { ok: true, status: 200, message: '' };
    }
    return { ok: false, status: 401, message: 'unauthorized' };
  }

  /** Accepts the official takeover bodies: {url}, {urls:[]} and {items:[{url}]}; urls may be newline joined. */
  private parseDownloadUrls(body: string): string[] {
    const collected: string[] = [];
    let v: Record<string, Object> = {};
    try {
      v = JSON.parse(body) as Record<string, Object>;
    } catch (e) {
      return collected;
    }
    const single = v['url'];
    if (typeof single === 'string') {
      this.splitJoinedUrls(single as string, collected);
    }
    const urls = v['urls'];
    if (Array.isArray(urls)) {
      (urls as Object[]).forEach((u: Object) => {
        if (typeof u === 'string') {
          this.splitJoinedUrls(u as string, collected);
        }
      });
    } else if (typeof urls === 'string') {
      this.splitJoinedUrls(urls as string, collected);
    }
    const items = v['items'];
    if (Array.isArray(items)) {
      (items as Object[]).forEach((it: Object) => {
        const rec = it as Record<string, Object>;
        const u = rec['url'];
        if (typeof u === 'string') {
          this.splitJoinedUrls(u as string, collected);
        }
      });
    }
    const seen: Record<string, boolean> = {};
    const uniq: string[] = [];
    collected.forEach((u: string) => {
      if (!seen[u]) {
        seen[u] = true;
        uniq.push(u);
      }
    });
    return uniq;
  }

  private splitJoinedUrls(joined: string, out: string[]): void {
    joined.split(/\r?\n/).forEach((raw: string) => {
      const t = raw.trim();
      if (t.length > 0) {
        out.push(t);
      }
    });
  }

  private taskToJson(t: DownloadTask): Record<string, Object> {
    return {
      id: t.id,
      name: t.fileName,
      fileName: t.fileName,
      url: t.url,
      protocol: t.protocol as Object,
      status: t.status as Object,
      state: t.status as Object,
      progress: t.percent,
      percent: t.percent,
      downloadedBytes: t.downloadedBytes,
      totalBytes: t.totalBytes,
      speed: t.speed,
      errorMessage: t.errorMessage,
      createdAt: t.createdAt,
      finishedAt: t.finishedAt
    };
  }

  private jsonOk(obj: Object): { status: number; json: string } {
    return { status: 200, json: JSON.stringify(obj) };
  }

  private jsonErr(status: number, message: string): { status: number; json: string } {
    return { status, json: JSON.stringify({ success: false, message }) };
  }

  private processMcpRequest(body: string, headers: Record<string, string>): { status: number; json: string } {
    const auth = this.checkToken(headers);
    if (!auth.ok) {
      return {
        status: auth.status,
        json: JSON.stringify({ jsonrpc: '2.0', error: { code: -32001, message: 'Unauthorized' } })
      };
    }
    let rpc: Record<string, Object> = {};
    try {
      rpc = JSON.parse(body);
    } catch (e) {
      return { status: 400, json: JSON.stringify({ jsonrpc: '2.0', error: { code: -32700, message: 'Parse error' } }) };
    }
    const id = (rpc['id'] as number) ?? null;
    const method = rpc['method'] as string;
    const params = (rpc['params'] as Record<string, Object>) ?? {};

    if (method === 'initialize') {
      return ok(id, {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'FluxDown Cover', version: '1.0.0' }
      });
    }
    if (method === 'notifications/initialized') {
      return { status: 200, json: '' };
    }
    if (method === 'tools/list') {
      return ok(id, { tools: TOOLS });
    }
    if (method === 'tools/call') {
      const name = params['name'] as string;
      const args = (params['arguments'] as Record<string, Object>) ?? {};
      try {
        const result = this.callTool(name, args);
        return ok(id, {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
          isError: false
        });
      } catch (e) {
        return ok(id, {
          content: [{ type: 'text', text: String((e as Error).message) }],
          isError: true
        });
      }
    }
    return ok(id, null);
  }

  private callTool(name: string, args: Record<string, Object>): Object {
    const b = this.backend;
    if (!b) {
      throw new Error('MCP backend not ready');
    }
    switch (name) {
      case 'addDownload':
        b.addTask(String(args['url'] ?? ''));
        return { ok: true };
      case 'listDownloads':
        return b.listTasks().map((t) => ({
          id: t.id,
          name: t.fileName,
          protocol: t.protocol,
          status: t.status,
          percent: t.percent,
          downloadedBytes: t.downloadedBytes,
          totalBytes: t.totalBytes
        }));
      case 'pauseDownload':
        b.pauseTask(String(args['id'] ?? ''));
        return { ok: true };
      case 'resumeDownload':
        b.resumeTask(String(args['id'] ?? ''));
        return { ok: true };
      case 'removeDownload':
        b.removeTask(String(args['id'] ?? ''));
        return { ok: true };
      case 'getDownload': {
        const t = b.getTask(String(args['id'] ?? ''));
        if (!t) return { error: 'Task not found' };
        return {
          id: t.id, name: t.fileName, url: t.url, protocol: t.protocol,
          status: t.status, percent: t.percent, speed: t.speed,
          downloadedBytes: t.downloadedBytes, totalBytes: t.totalBytes,
          category: t.category, priority: t.priority, queueId: t.queueId,
          errorMessage: t.errorMessage, createdAt: t.createdAt, finishedAt: t.finishedAt
        };
      }
      case 'pauseAllDownloads':
        (b as any).pauseAllTasks?.();
        return { ok: true };
      case 'resumeAllDownloads':
        (b as any).resumeAllTasks?.();
        return { ok: true };
      case 'batchAddDownloads': {
        const urls = args['urls'] as string[];
        (b as any).addBatchDownloads?.(urls);
        return { added: urls.length };
      }
      case 'listQueues':
        return (b as any).listQueues?.() ?? [];
      case 'startQueue':
        (b as any).startQueue?.(String(args['id'] ?? ''));
        return { ok: true };
      case 'pauseQueue':
        (b as any).pauseQueue?.(String(args['id'] ?? ''));
        return { ok: true };
      case 'listRss':
        return (b as any).listRss?.() ?? [];
      case 'addRss': {
        (b as any).addRss?.(
          String(args['url'] ?? ''), String(args['name'] ?? ''), String(args['filter'] ?? '')
        );
        return { ok: true };
      }
      case 'removeRss':
        (b as any).removeRss?.(String(args['id'] ?? ''));
        return { ok: true };
      case 'getStats':
        return (b as any).getStats?.() ?? {};
      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  }
}

function ok(id: number | null, result: Object | null): { status: number; json: string } {
  return {
    status: 200,
    json: JSON.stringify({ jsonrpc: '2.0', id, result: result ?? {} })
  };
}

const HTTP_STATUS_TEXT: Record<string, string> = {
  '200': 'OK',
  '204': 'No Content',
  '400': 'Bad Request',
  '401': 'Unauthorized',
  '403': 'Forbidden',
  '404': 'Not Found',
  '503': 'Service Unavailable'
};

function buildHttpResponse(status: number, json: string): string {
  const body = json ?? '';
  const statusText = HTTP_STATUS_TEXT[String(status)] ?? 'OK';
  return (
    `HTTP/1.1 ${status} ${statusText}\r\n` +
    `Content-Type: application/json; charset=utf-8\r\n` +
    `Content-Length: ${utf8ByteLength(body)}\r\n` +
    `Access-Control-Allow-Origin: *\r\n` +
    `Access-Control-Allow-Methods: GET, POST, PUT, DELETE, OPTIONS\r\n` +
    `Access-Control-Allow-Headers: Content-Type, Authorization, X-FluxDown-Client, X-FluxDown-Token\r\n` +
    `Connection: close\r\n\r\n` +
    body
  );
}

/** Byte length of a UTF-8 string (Content-Length must count bytes, not UTF-16 code units). */
function utf8ByteLength(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) {
      n += 1;
    } else if (c < 0x800) {
      n += 2;
    } else if (c >= 0xD800 && c <= 0xDBFF) {
      n += 4; // surrogate pair
      i++;
    } else {
      n += 3;
    }
  }
  return n;
}

function ab2str(buf: ArrayBuffer): string {
  const u = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < u.length; i++) {
    s += String.fromCharCode(u[i]);
  }
  return s;
}
