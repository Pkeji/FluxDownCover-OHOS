import { http } from '@kit.NetworkKit';
import { logCollector } from './LogCollector';
import { BusinessError } from '@kit.BasicServicesKit';

/**
 * HTTP connection pool for reusing http.Request objects across segments.
 *
 * HarmonyOS `http.createHttp()` creates a new HttpRequest each time. By
 * pooling these objects keyed by host (extracted from URL), we allow the
 * underlying TCP connection to be reused across segments downloading from
 * the same server, reducing TLS handshake and connection setup overhead.
 *
 * Pool size is limited per host (default 4) to balance reuse vs parallelism.
 */
export class ConnectionPool {
  private static instance: ConnectionPool | null = null;

  static getInstance(): ConnectionPool {
    if (!ConnectionPool.instance) {
      ConnectionPool.instance = new ConnectionPool();
    }
    return ConnectionPool.instance;
  }

  /** Pool entries keyed by host:port. */
  private pool: Map<string, http.HttpRequest[]> = new Map();

  /** Borrow a request for the given URL. Creates one if pool exhausted. */
  borrow(url: string): http.HttpRequest {
    const host = this.extractHost(url);
    const pool = this.pool.get(host);
    if (pool && pool.length > 0) {
      return pool.pop()!;
    }
    // Create new connection
    return http.createHttp();
  }

  /** Return a request to the pool for reuse. */
  release(host: string, req: http.HttpRequest | null): void {
    if (!req) {
      return;
    }
    let pool = this.pool.get(host);
    if (!pool) {
      pool = [];
      this.pool.set(host, pool);
    }
    // Limit pool size per host to prevent resource leaks
    if (pool.length < 4) {
      // Reset event listeners before pooling
      try {
        req.off('headersReceive');
        req.off('dataReceive');
        req.off('dataEnd');
      } catch {
        // ignore if already destroyed
      }
      pool.push(req);
    } else {
      // Pool full, destroy
      this.destroy(req);
    }
  }

  /** Destroy all pooled connections. */
  clear(): void {
    this.pool.forEach((requests) => {
      requests.forEach((req) => this.destroy(req));
    });
    this.pool.clear();
  }

  /** Remove and destroy all connections for a specific host. */
  clearHost(host: string): void {
    const pool = this.pool.get(host);
    if (pool) {
      pool.forEach((req) => this.destroy(req));
      this.pool.delete(host);
    }
  }

  /** Stats for monitoring. */
  stats(): Record<string, number> {
    let total = 0;
    this.pool.forEach((requests, host) => {
      total += requests.length;
    });
    return { pooled: total, hosts: this.pool.size };
  }

  /** Extract host:port from a URL for pooling key. */
  extractHost(url: string): string {
    try {
      const m = /https?:\/\/([^\/:]+)(?::(\d+))?/.exec(url);
      if (m) {
        const host = m[1];
        const port = m[2] ?? (url.startsWith('https') ? '443' : '80');
        return `${host}:${port}`;
      }
    } catch {
      // fallback
    }
    return 'default';
  }

  private destroy(req: http.HttpRequest): void {
    try {
      req.destroy();
    } catch (e) {
      logCollector.warn('ConnectionPool', `destroy failed: ${String(e)}`);
    }
  }
}

/**
 * Write buffer for coalescing small disk writes into larger sequential ones.
 * Reduces fs.write() syscall overhead for high-throughput downloads.
 */
export class WriteBuffer {
  private buf: Uint8Array;
  private offset: number = 0;
  private readonly capacity: number;

  constructor(capacity: number = 256 * 1024) {
    this.capacity = capacity;
    this.buf = new Uint8Array(capacity);
  }

  /** Append data. Returns a chunk to flush if buffer is full, else null. */
  append(data: ArrayBuffer): Uint8Array | null {
    const src = new Uint8Array(data);
    const remaining = this.capacity - this.offset;
    if (src.length <= remaining) {
      this.buf.set(src, this.offset);
      this.offset += src.length;
      return null;
    }
    // Fill current buffer, return it as a flush candidate
    const flushLen = this.offset;
    const flush = new Uint8Array(flushLen + src.length);
    flush.set(this.buf.subarray(0, flushLen), 0);
    flush.set(src, flushLen);
    this.offset = 0;
    return flush;
  }

  /** Flush remaining data (returns null if empty). */
  flush(): Uint8Array | null {
    if (this.offset === 0) {
      return null;
    }
    const data = this.buf.subarray(0, this.offset);
    this.offset = 0;
    return data;
  }

  /** Current buffered bytes. */
  get length(): number {
    return this.offset;
  }

  /** Reset buffer. */
  clear(): void {
    this.offset = 0;
  }
}
