/**
 * eD2K binary packet encoding / decoding.
 *
 * Wire format (eDonkey protocol, marker 0xE3):
 *   ┌──────────┬───────────────┬────────┬──────────┐
 *   │ 0xE3 (1) │ length (4 LE) │ op (1) │ payload  │
 *   └──────────┴───────────────┴────────┴──────────┘
 *
 * "length" is the number of bytes AFTER the 5-byte header (op + payload).
 */

// ── Protocol marker ────────────────────────────────────────────────
export const PROTO_MARKER = 0xE3;

// ── Server opcodes (Client → Server) ───────────────────────────────
export const OP_LOGIN = 0x01;
export const OP_GETSOURCES = 0x16;
export const OP_DISCONNECT = 0x0E;

// ── Server opcodes (Server → Client) ───────────────────────────────
export const OP_SERVERMESSAGE = 0x41;
export const OP_SERVERSTATUS = 0x34;
export const OP_SERVERIDENT = 0x33;
export const OP_FOUNDSOURCES = 0x42;

// ── Peer opcodes ───────────────────────────────────────────────────
export const OP_HELLO = 0x01;
export const OP_HELLOANSWER = 0x02;
export const OP_HASHSETREQUEST = 0x4B;
export const OP_HASHSETANSWER = 0x4C;
export const OP_FILESTATUSREQ = 0x4F;
export const OP_FILESTATUS = 0x50;
export const OP_BLOCKREQUEST = 0x47;
export const OP_BLOCKDATA = 0x47; // same opcode, peer sends data
export const OP_QUEUERANK = 0x55;
export const OP_ACCEPTUPLOADREQ = 0x59;
export const OP_STARTUPLOADREQ = 0x54;
export const OP_CANCELUPLOAD = 0x5C;

// ── eD2K constants ─────────────────────────────────────────────────
export const CHUNK_SIZE = 9728000;   // 9.28 MB — eDonkey "part"
export const BLOCK_SIZE = 184320;     // 180 KB  — sub-block for transfer
export const CLIENT_PORT = 4662;      // default eD2K client port

// ── Utility ────────────────────────────────────────────────────────

/** Write a 4-byte little-endian uint32 into a DataView at given offset. */
function writeU32LE(view: DataView, offset: number, val: number): void {
  view.setUint8(offset, val & 0xFF);
  view.setUint8(offset + 1, (val >>> 8) & 0xFF);
  view.setUint8(offset + 2, (val >>> 16) & 0xFF);
  view.setUint8(offset + 3, (val >>> 24) & 0xFF);
}

/** Read a 4-byte little-endian uint32 from a Uint8Array at given offset. */
export function readU32LE(buf: Uint8Array, offset: number): number {
  return (buf[offset] |
    (buf[offset + 1] << 8) |
    (buf[offset + 2] << 16) |
    (buf[offset + 3] << 24)) >>> 0;
}

/** Read a 2-byte little-endian uint16. */
export function readU16LE(buf: Uint8Array, offset: number): number {
  return (buf[offset] | (buf[offset + 1] << 8)) & 0xFFFF;
}

/** Encode an IPv4 string (e.g. "192.168.1.1") to 4 bytes. */
export function ipToBytes(ip: string): Uint8Array {
  const parts = ip.split('.');
  const out = new Uint8Array(4);
  for (let i = 0; i < 4; i++) {
    out[i] = parseInt(parts[i], 10) & 0xFF;
  }
  return out;
}

/** Decode 4 bytes to IPv4 string. */
export function bytesToIp(buf: Uint8Array, offset: number): string {
  return `${buf[offset]}.${buf[offset + 1]}.${buf[offset + 2]}.${buf[offset + 3]}`;
}

// ── Packet builder ─────────────────────────────────────────────────

/** Build a complete eD2K packet (marker + length + op + payload). */
export function buildPacket(op: number, payload: Uint8Array): Uint8Array {
  const totalLen = 1 + 4 + 1 + payload.length; // marker + len + op + payload
  const out = new Uint8Array(totalLen);
  const view = new DataView(out.buffer);
  out[0] = PROTO_MARKER;
  writeU32LE(view, 1, 1 + payload.length); // op + payload length
  out[5] = op;
  out.set(payload, 6);
  return out;
}

// ── Specific packet builders ───────────────────────────────────────

/** Build login packet for server. */
export function buildLoginPacket(userHash: Uint8Array, clientId: number, port: number): Uint8Array {
  // userHash(16) + clientId(4) + port(4) + tagCount(4) + tags...
  const payload = new Uint8Array(16 + 4 + 4 + 4 + 4 + 4 + 1 + 1 + 4); // simplified
  const view = new DataView(payload.buffer);
  payload.set(userHash, 0);
  writeU32LE(view, 16, clientId);
  writeU32LE(view, 20, port);
  writeU32LE(view, 24, 2); // tag count
  // Tag 1: name (string) — tag type 0x02, tag id 0x01, length 2, "xx"
  view.setUint8(28, 0x02); // string tag
  view.setUint8(29, 0x01); // tag name
  writeU32LE(view, 30, 2); // string length
  view.setUint8(34, 0x78); // 'x'
  view.setUint8(35, 0x78); // 'x'
  return buildPacket(OP_LOGIN, payload);
}

/** Build get-sources packet for a file hash. */
export function buildGetSourcesPacket(fileHash: Uint8Array, fileSize: number): Uint8Array {
  const payload = new Uint8Array(16 + 4);
  const view = new DataView(payload.buffer);
  payload.set(fileHash, 0);
  writeU32LE(view, 16, fileSize);
  return buildPacket(OP_GETSOURCES, payload);
}

/** Build peer hello packet. */
export function buildHelloPacket(userHash: Uint8Array, clientId: number, port: number): Uint8Array {
  const payload = new Uint8Array(16 + 4 + 4 + 4);
  const view = new DataView(payload.buffer);
  payload.set(userHash, 0);
  writeU32LE(view, 16, clientId);
  writeU32LE(view, 20, port);
  writeU32LE(view, 24, 0); // tag count = 0 (minimal)
  return buildPacket(OP_HELLO, payload);
}

/** Build file-status-request packet. */
export function buildFileStatusReqPacket(fileHash: Uint8Array): Uint8Array {
  return buildPacket(OP_FILESTATUSREQ, fileHash);
}

/** Build hash-set-request packet. */
export function buildHashSetReqPacket(fileHash: Uint8Array): Uint8Array {
  return buildPacket(OP_HASHSETREQUEST, fileHash);
}

/** Build block-request packet (request a range of the file). */
export function buildBlockRequestPacket(start: number, end: number): Uint8Array {
  const payload = new Uint8Array(8);
  const view = new DataView(payload.buffer);
  writeU32LE(view, 0, start);
  writeU32LE(view, 4, end);
  return buildPacket(OP_BLOCKREQUEST, payload);
}

// ── Packet parser ──────────────────────────────────────────────────

export interface Ed2kPacket {
  op: number;
  payload: Uint8Array;
}

/**
 * Read one complete packet from a TCP socket's receive buffer.
 * Returns null if not enough data yet.
 * @param buf accumulated receive buffer
 * @returns { packet, consumed } or null
 */
export function parsePacket(buf: Uint8Array): Ed2kPacket | null {
  if (buf.length < 6) {
    return null; // need at least marker + length + op
  }
  if (buf[0] !== PROTO_MARKER) {
    throw new Error(`Invalid eD2K marker: 0x${buf[0].toString(16)} (expected 0xE3)`);
  }
  const payloadLen = readU32LE(buf, 1) - 1; // subtract op byte
  const totalLen = 5 + 1 + payloadLen;
  if (buf.length < totalLen) {
    return null; // not enough data yet
  }
  const op = buf[5];
  const payload = buf.subarray(6, 6 + payloadLen);
  return { op, payload: new Uint8Array(payload) }; // copy out of receive buffer
}

/** How many bytes the next packet needs (or 0 if header not complete). */
export function nextPacketSize(buf: Uint8Array): number {
  if (buf.length < 5) {
    return 0;
  }
  const payloadLen = readU32LE(buf, 1) - 1;
  return 5 + 1 + payloadLen;
}
