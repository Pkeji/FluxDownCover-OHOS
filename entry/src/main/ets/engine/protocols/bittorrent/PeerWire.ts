import { socket } from '@kit.NetworkKit';
import { BusinessError } from '@kit.BasicServicesKit';
import {
  asciiToBytes,
  concatBytes
} from './Bencode';

/**
 * Peer Wire Protocol implementation.
 *
 * Handshake:  <pstrlen><pstr><reserved><info_hash><peer_id>
 *   pstrlen   = 1 byte (19)
 *   pstr      = "BitTorrent protocol"
 *   reserved  = 8 bytes (all zero)
 *   info_hash = 20 bytes
 *   peer_id   = 20 bytes
 *
 * Messages:   <length><message id><payload>
 *   length    = 4 bytes (big-endian), not counting itself
 *   id        = 1 byte (0-8), or length=0 means keep-alive
 *
 * IDs: 0=choke 1=unchoke 2=interested 3=not_interested 4=have
 *      5=bitfield 6=request 7=piece 8=cancel
 */

export const MSG_CHOKE = 0;
export const MSG_UNCHOKE = 1;
export const MSG_INTERESTED = 2;
export const MSG_NOT_INTERESTED = 3;
export const MSG_HAVE = 4;
export const MSG_BITFIELD = 5;
export const MSG_REQUEST = 6;
export const MSG_PIECE = 7;
export const MSG_CANCEL = 8;

const PSTR = asciiToBytes('BitTorrent protocol');
const HANDSHAKE_PREFIX = concatBytes([new Uint8Array([19]), PSTR, new Uint8Array(8)]);

/** A received piece block. */
export interface PieceBlock {
  index: number;
  begin: number;
  data: Uint8Array;
}

/** Callback for incoming peer messages. */
export interface PeerMessageHandler {
  onUnchoke(): void;
  onChoke(): void;
  onHave(piece: number): void;
  onBitfield(bits: Uint8Array): void;
  onPiece(block: PieceBlock): void;
}

/**
 * Manages a single TCP connection to a BitTorrent peer.
 * Handles handshake, message framing, and provides send helpers.
 */
export class PeerConnection {
  private sock: socket.TCPSocket;
  private recvBuf: Uint8Array = new Uint8Array(0);
  private handshakeDone: boolean = false;
  private handler: PeerMessageHandler | null = null;
  private disposed: boolean = false;

  // Resolvers for async handshake
  private handshakeResolve: (() => void) | null = null;
  private handshakeReject: ((e: Error) => void) | null = null;

  constructor(
    public ip: string,
    public port: number,
    private infoHash: Uint8Array,
    private peerId: Uint8Array
  ) {
    this.sock = socket.constructTCPSocketInstance();
  }

  /** Connect and perform the BitTorrent handshake. */
  async connect(timeout: number): Promise<void> {
    this.sock.on('message', (msg: Object) => {
      this.handleData((msg as { message: ArrayBuffer }).message);
    });
    this.sock.on('error', (err: BusinessError) => {
      if (this.handshakeReject) {
        this.handshakeReject(new Error(`Peer ${this.ip}:${this.port} error: ${err.message}`));
        this.handshakeReject = null;
      }
    });
    this.sock.on('close', () => {
      this.disposed = true;
    });

    await this.sock.connect({ address: { address: this.ip, port: this.port }, timeout });

    // Send handshake
    const handshake = concatBytes([HANDSHAKE_PREFIX, this.infoHash, this.peerId]);
    await this.sock.send({ data: handshake.buffer.slice(handshake.byteOffset, handshake.byteOffset + handshake.byteLength) });

    // Wait for peer handshake
    await new Promise<void>((resolve, reject) => {
      this.handshakeResolve = resolve;
      this.handshakeReject = reject;
    });
  }

  /** Set the message handler for incoming messages (after handshake). */
  setMessageHandler(handler: PeerMessageHandler): void {
    this.handler = handler;
  }

  /** Send "interested" to the peer. */
  async sendInterested(): Promise<void> {
    await this.sendMessage(new Uint8Array([MSG_INTERESTED]));
  }

  /** Send "not interested" to the peer. */
  async sendNotInterested(): Promise<void> {
    await this.sendMessage(new Uint8Array([MSG_NOT_INTERESTED]));
  }

  /** Send a "request" for a block within a piece. */
  async sendRequest(index: number, begin: number, length: number): Promise<void> {
    const payload = new Uint8Array(13);
    payload[0] = MSG_REQUEST;
    writeUint32BE(payload, 1, index);
    writeUint32BE(payload, 5, begin);
    writeUint32BE(payload, 9, length);
    await this.sendMessage(payload);
  }

  /** Send a "cancel" for a pending request. */
  async sendCancel(index: number, begin: number, length: number): Promise<void> {
    const payload = new Uint8Array(13);
    payload[0] = MSG_CANCEL;
    writeUint32BE(payload, 1, index);
    writeUint32BE(payload, 5, begin);
    writeUint32BE(payload, 9, length);
    await this.sendMessage(payload);
  }

  /** Send a "have" message. */
  async sendHave(piece: number): Promise<void> {
    const payload = new Uint8Array(5);
    payload[0] = MSG_HAVE;
    writeUint32BE(payload, 1, piece);
    await this.sendMessage(payload);
  }

  /** Send a bitfield message (which pieces we already have). */
  async sendBitfield(bits: Uint8Array): Promise<void> {
    const payload = new Uint8Array(1 + bits.length);
    payload[0] = MSG_BITFIELD;
    payload.set(bits, 1);
    await this.sendMessage(payload);
  }

  /** Send a keep-alive message. */
  async sendKeepAlive(): Promise<void> {
    const zero = new Uint8Array(4);
    await this.sock.send({ data: zero.buffer });
  }

  /** Close the connection. */
  close(): void {
    this.disposed = true;
    try {
      this.sock.close();
    } catch (e) {
      // ignore
    }
  }

  get isDisposed(): boolean {
    return this.disposed;
  }

  // ── Internal ────────────────────────────────────────────────────────

  private async sendMessage(payload: Uint8Array): Promise<void> {
    if (this.disposed) {
      return;
    }
    const frame = new Uint8Array(4 + payload.length);
    writeUint32BE(frame, 0, payload.length);
    frame.set(payload, 4);
    await this.sock.send({ data: frame.buffer.slice(frame.byteOffset, frame.byteOffset + frame.byteLength) });
  }

  private handleData(data: ArrayBuffer): void {
    const incoming = new Uint8Array(data);
    this.recvBuf = concatBytes([this.recvBuf, incoming]);
    this.processBuffer();
  }

  private processBuffer(): void {
    if (!this.handshakeDone) {
      // Handshake is 68 bytes
      if (this.recvBuf.length < 68) {
        return;
      }
      // Verify handshake
      if (this.recvBuf[0] !== 19) {
        this.handshakeReject?.(new Error(`Peer ${this.ip}: invalid handshake`));
        this.handshakeReject = null;
        return;
      }
      // Verify "BitTorrent protocol"
      for (let i = 0; i < 19; i++) {
        if (this.recvBuf[1 + i] !== PSTR[i]) {
          this.handshakeReject?.(new Error(`Peer ${this.ip}: invalid protocol string`));
          this.handshakeReject = null;
          return;
        }
      }
      // Verify info_hash (bytes 28-48)
      for (let i = 0; i < 20; i++) {
        if (this.recvBuf[28 + i] !== this.infoHash[i]) {
          this.handshakeReject?.(new Error(`Peer ${this.ip}: info_hash mismatch`));
          this.handshakeReject = null;
          return;
        }
      }
      this.handshakeDone = true;
      this.recvBuf = this.recvBuf.subarray(68);
      this.handshakeResolve?.();
      this.handshakeResolve = null;
    }

    // Process messages
    while (this.recvBuf.length >= 4) {
      const msgLen = readUint32BE(this.recvBuf, 0);
      if (msgLen === 0) {
        // keep-alive
        this.recvBuf = this.recvBuf.subarray(4);
        continue;
      }
      if (this.recvBuf.length < 4 + msgLen) {
        return; // wait for more data
      }
      const msgBody = this.recvBuf.subarray(4, 4 + msgLen);
      this.recvBuf = this.recvBuf.subarray(4 + msgLen);
      this.handleMessage(msgBody);
    }
  }

  private handleMessage(body: Uint8Array): void {
    if (body.length === 0) {
      return;
    }
    const id = body[0];
    const payload = body.subarray(1);
    const h = this.handler;
    if (!h) {
      return;
    }

    switch (id) {
      case MSG_CHOKE:
        h.onChoke();
        break;
      case MSG_UNCHOKE:
        h.onUnchoke();
        break;
      case MSG_HAVE:
        if (payload.length >= 4) {
          h.onHave(readUint32BE(payload, 0));
        }
        break;
      case MSG_BITFIELD:
        h.onBitfield(payload);
        break;
      case MSG_PIECE:
        if (payload.length >= 8) {
          const index = readUint32BE(payload, 0);
          const begin = readUint32BE(payload, 4);
          const blockData = payload.subarray(8);
          h.onPiece({ index, begin, data: blockData });
        }
        break;
      default:
        // ignore unknown messages (extended, port, etc.)
        break;
    }
  }
}

// ── Bit helpers ───────────────────────────────────────────────────────────

/** Write a big-endian uint32 at offset in a Uint8Array. */
export function writeUint32BE(arr: Uint8Array, offset: number, val: number): void {
  arr[offset] = (val >>> 24) & 0xff;
  arr[offset + 1] = (val >>> 16) & 0xff;
  arr[offset + 2] = (val >>> 8) & 0xff;
  arr[offset + 3] = val & 0xff;
}

/** Read a big-endian uint32 at offset from a Uint8Array. */
export function readUint32BE(arr: Uint8Array, offset: number): number {
  return ((arr[offset] << 24) | (arr[offset + 1] << 16) | (arr[offset + 2] << 8) | arr[offset + 3]) >>> 0;
}

/** Build a bitfield from a boolean array of piece completion. */
export function buildBitfield(havePieces: boolean[], pieceCount: number): Uint8Array {
  const byteLen = Math.ceil(pieceCount / 8);
  const bits = new Uint8Array(byteLen);
  for (let i = 0; i < pieceCount; i++) {
    if (i < havePieces.length && havePieces[i]) {
      bits[Math.floor(i / 8)] |= (0x80 >> (i % 8));
    }
  }
  return bits;
}

/** Check if bit *i* is set in a bitfield. */
export function bitfieldHas(bits: Uint8Array, i: number): boolean {
  return (bits[Math.floor(i / 8)] & (0x80 >> (i % 8))) !== 0;
}
