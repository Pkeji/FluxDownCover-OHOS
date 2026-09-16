import { socket } from '@kit.NetworkKit';
import { logCollector } from '../../../utils/LogCollector';
import { BusinessError } from '@kit.BasicServicesKit';
import { PieceManager } from './PieceManager';
import { TorrentMeta } from './TorrentMeta';
import {
  MSG_CHOKE,
  MSG_UNCHOKE,
  MSG_INTERESTED,
  MSG_NOT_INTERESTED,
  MSG_BITFIELD,
  MSG_HAVE,
  MSG_REQUEST,
  MSG_PIECE,
  MSG_CANCEL,
  buildBitfield,
  readUint32BE,
  writeUint32BE
} from './PeerWire';
import { asciiToBytes, concatBytes } from './Bencode';

/**
 * Inbound BitTorrent peer server (enables *seeding* / uploading).
 *
 * The existing engine only ever opens *outbound* connections (PeerConnection).
 * To upload data we must also accept *inbound* connections on the listen port.
 * For each accepted socket we perform the server side of the handshake (the
 * remote peer sends its handshake first), then serve "piece" messages for any
 * blocks the peer requests — reading the bytes straight from the completed
 * output file via PieceManager.readPieceData.
 *
 * A single PeerServer instance is shared by all torrents currently being
 * seeded (BtEngine registers each torrent's info_hash → SeedLookup).
 */

const PSTR = asciiToBytes('BitTorrent protocol');
const RESERVED = new Uint8Array(8);
RESERVED[5] = 0x10; // BitTorrent extension protocol bit (kept for compatibility)

/** A torrent we can serve: piece storage + metadata. */
export interface SeedLookup {
  pieceManager: PieceManager;
  meta: TorrentMeta;
}

/** Resolves an incoming peer's info_hash to the torrent we can seed. */
export type SeedResolver = (infoHashHex: string) => SeedLookup | null;

export interface PeerServerOptions {
  /** Global upload rate limiter in bytes/sec (0 = unlimited). */
  uploadSpeedLimit?: number;
  /** Called whenever we upload bytes for a torrent (for seed-ratio stats). */
  onUpload?: (infoHashHex: string, bytes: number) => void;
}

/** Shared token-bucket upload limiter across all inbound peers. */
class UploadThrottle {
  private bucket: number;
  private lastRefill: number;
  constructor(private limit: number) {
    this.bucket = limit; // start full
    this.lastRefill = Date.now();
  }
  setLimit(limit: number): void {
    this.limit = limit;
    if (this.bucket > limit && limit > 0) {
      this.bucket = limit;
    }
  }
  /** Wait (if needed) so that `bytes` fits within the rate limit. */
  async wait(bytes: number): Promise<void> {
    if (this.limit <= 0) {
      return;
    }
    const now = Date.now();
    const elapsed = (now - this.lastRefill) / 1000;
    this.bucket = Math.min(this.limit, this.bucket + elapsed * this.limit);
    this.lastRefill = now;
    if (this.bucket >= bytes) {
      this.bucket -= bytes;
      return;
    }
    // Need to wait until enough credit accrues.
    const deficit = bytes - this.bucket;
    const waitMs = (deficit / this.limit) * 1000;
    await new Promise((r) => setTimeout(r, waitMs));
    this.bucket = 0;
    this.lastRefill = Date.now();
  }
}

export class PeerServer {
  private server: socket.TCPSocketServer | null = null;
  private listening = false;
  private peers: IncomingPeer[] = [];
  private peerId: Uint8Array;
  private resolver: SeedResolver;
  private throttle: UploadThrottle;
  private onUpload?: (infoHashHex: string, bytes: number) => void;

  constructor(peerId: Uint8Array, resolver: SeedResolver, opts?: PeerServerOptions) {
    this.peerId = peerId;
    this.resolver = resolver;
    this.throttle = new UploadThrottle(opts?.uploadSpeedLimit ?? 0);
    this.onUpload = opts?.onUpload;
  }

  setUploadSpeedLimit(limit: number): void {
    this.throttle.setLimit(limit);
  }

  async start(port: number): Promise<boolean> {
    if (this.listening) {
      return true;
    }
    const server = socket.constructTCPSocketServerInstance();
    this.server = server;
    server.on('connect', (client: socket.TCPSocketConnection) => {
      const peer = new IncomingPeer(client, this);
      this.peers.push(peer);
      peer.run().catch(() => { /* removed below on close */ });
    });
    return new Promise<boolean>((resolve) => {
      server.listen({ address: '0.0.0.0', port, allowHalfOpen: false } as socket.TCPListenOptions, (err: BusinessError) => {
        if (err) {
          logCollector.error('Error', `FluxDown Cover PeerServer listen failed on :${port}: ${err.message}`);
          this.listening = false;
          resolve(false);
        } else {
          this.listening = true;
          resolve(true);
        }
      });
    });
  }

  stop(): void {
    this.listening = false;
    for (const peer of this.peers) {
      peer.dispose();
    }
    this.peers = [];
    if (this.server) {
      try {
        this.server.off('connect');
        this.server.close();
      } catch (_) { /* ignore */ }
      this.server = null;
    }
  }

  get isListening(): boolean {
    return this.listening;
  }

  // Accessors used by IncomingPeer
  get myPeerId(): Uint8Array {
    return this.peerId;
  }
  resolveSeed(infoHashHex: string): SeedLookup | null {
    return this.resolver(infoHashHex);
  }
  throttleWait(bytes: number): Promise<void> {
    return this.throttle.wait(bytes);
  }
  reportUpload(infoHashHex: string, bytes: number): void {
    this.onUpload?.(infoHashHex, bytes);
  }
  unregister(peer: IncomingPeer): void {
    const idx = this.peers.indexOf(peer);
    if (idx >= 0) {
      this.peers.splice(idx, 1);
    }
  }
}

/**
 * Handles a single inbound peer connection (server side of the protocol).
 * Seeding only: we never request blocks, we only respond to the peer's
 * requests with piece messages.
 */
class IncomingPeer {
  private disposed = false;
  private buf: Uint8Array = new Uint8Array(0);
  private infoHash: Uint8Array | null = null;
  private infoHashHex = '';
  private seed: SeedLookup | null = null;
  private choked = true; // we start choked; unchoke interested peers
  private keepAliveTimer: number = 0;

  constructor(
    private client: socket.TCPSocketConnection,
    private server: PeerServer
  ) {}

  async run(): Promise<void> {
    this.client.on('message', (msg: Object) => {
      const data = (msg as { message: ArrayBuffer }).message;
      const incoming = data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data as ArrayBuffer);
      this.buf = concatBytes([this.buf, incoming]);
      this.process();
    });
    this.client.on('close', () => this.dispose());
    this.client.on('error', (err: BusinessError) => {
      // peer dropped — clean up
      this.dispose();
    });

    this.keepAliveTimer = setInterval(() => {
      if (!this.disposed) {
        this.sendKeepAlive().catch(() => {});
      }
    }, 110000) as unknown as number;
  }

  private process(): void {
    if (this.disposed) {
      return;
    }
    // Phase 1: handshake (68 bytes)
    if (!this.infoHash) {
      if (this.buf.length < 68) {
        return;
      }
      if (this.buf[0] !== 19) {
        this.dispose();
        return;
      }
      for (let i = 0; i < 19; i++) {
        if (this.buf[1 + i] !== PSTR[i]) {
          this.dispose();
          return;
        }
      }
      this.infoHash = this.buf.subarray(28, 48);
      this.infoHashHex = bytesToHexLocal(this.infoHash);
      this.seed = this.server.resolveSeed(this.infoHashHex);
      if (!this.seed) {
        // We don't have this torrent → reject.
        this.dispose();
        return;
      }
      this.buf = this.buf.subarray(68);
      this.sendHandshake().catch(() => this.dispose());
      this.sendBitfield().catch(() => this.dispose());
      // Continue processing any pipelined messages.
    }

    // Phase 2: messages
    while (this.buf.length >= 4) {
      const len = readUint32BE(this.buf, 0);
      if (len === 0) {
        // keep-alive
        this.buf = this.buf.subarray(4);
        continue;
      }
      if (this.buf.length < 4 + len) {
        return; // wait for more
      }
      const body = this.buf.subarray(4, 4 + len);
      this.buf = this.buf.subarray(4 + len);
      this.handleMessage(body);
      if (this.disposed) {
        return;
      }
    }
  }

  private handleMessage(body: Uint8Array): void {
    if (body.length === 0 || !this.seed) {
      return;
    }
    const id = body[0];
    const payload = body.subarray(1);
    switch (id) {
      case MSG_INTERESTED:
        // Peer wants data → unchoke it so it can request.
        this.choked = false;
        this.sendUnchoke().catch(() => this.dispose());
        break;
      case MSG_NOT_INTERESTED:
        this.choked = true;
        break;
      case MSG_REQUEST:
        if (payload.length >= 12 && !this.choked) {
          const index = readUint32BE(payload, 0);
          const begin = readUint32BE(payload, 4);
          const length = readUint32BE(payload, 8);
          this.serveRequest(index, begin, length).catch(() => this.dispose());
        }
        break;
      case MSG_CANCEL:
        // Nothing to cancel (we send immediately); ignore.
        break;
      case MSG_BITFIELD:
      case MSG_CHOKE:
      case MSG_UNCHOKE:
      case MSG_HAVE:
        // As a pure seed these are not relevant; ignore.
        break;
      default:
        break;
    }
  }

  private async serveRequest(index: number, begin: number, length: number): Promise<void> {
    if (!this.seed) {
      return;
    }
    const data = this.seed.pieceManager.readPieceData(index, begin, length);
    if (data.length === 0) {
      return; // piece not available (shouldn't happen for a seed)
    }
    await this.server.throttleWait(data.length);
    await this.sendPiece(index, begin, data);
    this.server.reportUpload(this.infoHashHex, data.length);
  }

  // ── Senders ─────────────────────────────────────────────────────────────

  private async sendHandshake(): Promise<void> {
    const frame = concatBytes([new Uint8Array([19]), PSTR, RESERVED, this.infoHash!, this.server.myPeerId]);
    await this.client.send({ data: frame.buffer.slice(frame.byteOffset, frame.byteOffset + frame.byteLength) });
  }

  private async sendBitfield(): Promise<void> {
    if (!this.seed) {
      return;
    }
    const bits = buildBitfield(this.seed.pieceManager.getHavePieces(), this.seed.meta.pieceCount);
    const payload = new Uint8Array(1 + bits.length);
    payload[0] = MSG_BITFIELD;
    payload.set(bits, 1);
    await this.sendMessage(payload);
  }

  private async sendUnchoke(): Promise<void> {
    await this.sendMessage(new Uint8Array([MSG_UNCHOKE]));
  }

  private async sendPiece(index: number, begin: number, data: Uint8Array): Promise<void> {
    const payload = new Uint8Array(1 + 12 + data.length);
    payload[0] = MSG_PIECE;
    writeUint32BE(payload, 1, index);
    writeUint32BE(payload, 5, begin);
    writeUint32BE(payload, 9, data.length);
    payload.set(data, 13);
    await this.sendMessage(payload);
  }

  private async sendKeepAlive(): Promise<void> {
    const zero = new Uint8Array(4);
    await this.client.send({ data: zero.buffer });
  }

  private async sendMessage(payload: Uint8Array): Promise<void> {
    if (this.disposed) {
      return;
    }
    const frame = new Uint8Array(4 + payload.length);
    writeUint32BE(frame, 0, payload.length);
    frame.set(payload, 4);
    await this.client.send({ data: frame.buffer.slice(frame.byteOffset, frame.byteOffset + frame.byteLength) });
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    if (this.keepAliveTimer) {
      clearInterval(this.keepAliveTimer);
      this.keepAliveTimer = 0;
    }
    try {
      this.client.close();
    } catch (_) { /* ignore */ }
    this.server.unregister(this);
  }
}

/** Local hex helper (avoids an extra import cycle). */
function bytesToHexLocal(bytes: Uint8Array): string {
  let hex = '';
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i].toString(16).padStart(2, '0');
  }
  return hex;
}
