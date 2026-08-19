import { socket } from '@kit.NetworkKit';
import { BusinessError } from '@kit.BasicServicesKit';
import { McpBackend } from './McpBackend';

const MCP_PORT = 17800;

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
  }
];

/**
 * Minimal MCP (Model Context Protocol) server over a local HTTP endpoint.
 * Listens on 127.0.0.1:17800, speaks JSON-RPC 2.0, and exposes 5 tools so an
 * AI agent can drive FluxDown. Bearer-token protected.
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
      console.info(`FluxDown MCP server listening on 127.0.0.1:${MCP_PORT}`);
    } catch (e) {
      console.error(`FluxDown MCP bind failed: ${JSON.stringify(e)}`);
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
      console.error(`MCP client error: ${err.code} ${err.message}`);
      closed = true;
      try {
        client.close();
      } catch (e) {
        // ignore
      }
    });
  }

  private processRequest(
    headerText: string,
    body: string
  ): { status: number; json: string } {
    const authMatch = /authorization:\s*Bearer\s+(\S+)/i.exec(headerText);
    if (this.token && (!authMatch || authMatch[1] !== this.token)) {
      return {
        status: 401,
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
        serverInfo: { name: 'FluxDown', version: '1.0.0' }
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

function buildHttpResponse(status: number, json: string): string {
  const body = json ?? '';
  const statusText = status === 200 ? 'OK' : status === 401 ? 'Unauthorized' : 'Bad Request';
  return (
    `HTTP/1.1 ${status} ${statusText}\r\n` +
    `Content-Type: application/json\r\n` +
    `Content-Length: ${body.length}\r\n` +
    `Access-Control-Allow-Origin: *\r\n` +
    `Connection: close\r\n\r\n` +
    body
  );
}

function ab2str(buf: ArrayBuffer): string {
  const u = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < u.length; i++) {
    s += String.fromCharCode(u[i]);
  }
  return s;
}
