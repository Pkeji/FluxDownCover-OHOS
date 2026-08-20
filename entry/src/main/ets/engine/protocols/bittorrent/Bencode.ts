/**
 * Bencode encoder/decoder — the serialization format used by .torrent files.
 *
 * Grammar:
 *   string  → <len>:<bytes>          e.g. 4:spam
 *   integer → i<number>e             e.g. i42e, i-3e
 *   list    → l<item>…e              e.g. l4:spami42ee
 *   dict    → d<key><val>…e          keys are sorted strings
 *
 * Values are represented as:
 *   string  → Uint8Array (binary-safe; torrent hashes are raw bytes)
 *   integer → number
 *   list    → BencodeList (Array wrapper)
 *   dict    → BencodeDict (Map wrapper)
 *
 * ArkTS does not support recursive union type aliases, so we use a nominal
 * class hierarchy with runtime instanceof checks instead.
 */

/** A bencoded list. */
export class BencodeList {
  constructor(public items: BValue[]) {}
}

/** A bencoded dictionary (keys are strings, sorted in bencode). */
export class BencodeDict {
  constructor(public entries: Map<string, BValue>) {}
}

/** Base type for all bencoded values. */
export type BValue = Uint8Array | number | BencodeList | BencodeDict;

// ── Decoder ──────────────────────────────────────────────────────────────

class DecodeCursor {
  pos: number = 0;
  constructor(public data: Uint8Array) {}
}

/** Decode a bencoded byte array into a BValue. */
export function bdecode(data: Uint8Array): BValue {
  const cur = new DecodeCursor(data);
  return decodeOne(cur);
}

function decodeOne(cur: DecodeCursor): BValue {
  const c = cur.data[cur.pos];
  if (c === 0x69) {
    return decodeInt(cur);
  }
  if (c === 0x6c) {
    return decodeList(cur);
  }
  if (c === 0x64) {
    return decodeDict(cur);
  }
  if (c >= 0x30 && c <= 0x39) {
    return decodeString(cur);
  }
  throw new Error(`Bencode: unexpected byte 0x${c.toString(16)} at pos ${cur.pos}`);
}

function decodeInt(cur: DecodeCursor): number {
  cur.pos++;
  const start = cur.pos;
  while (cur.data[cur.pos] !== 0x65) {
    cur.pos++;
    if (cur.pos >= cur.data.length) {
      throw new Error('Bencode: unterminated integer');
    }
  }
  const str = bytesToAscii(cur.data.subarray(start, cur.pos));
  cur.pos++;
  return Number(str);
}

function decodeString(cur: DecodeCursor): Uint8Array {
  const start = cur.pos;
  while (cur.data[cur.pos] !== 0x3a) {
    cur.pos++;
    if (cur.pos >= cur.data.length) {
      throw new Error('Bencode: unterminated string length');
    }
  }
  const lenStr = bytesToAscii(cur.data.subarray(start, cur.pos));
  const len = Number(lenStr);
  cur.pos++;
  const str = cur.data.subarray(cur.pos, cur.pos + len);
  cur.pos += len;
  return str;
}

function decodeList(cur: DecodeCursor): BencodeList {
  cur.pos++;
  const list: BValue[] = [];
  while (cur.data[cur.pos] !== 0x65) {
    list.push(decodeOne(cur));
  }
  cur.pos++;
  return new BencodeList(list);
}

function decodeDict(cur: DecodeCursor): BencodeDict {
  cur.pos++;
  const dict = new Map<string, BValue>();
  while (cur.data[cur.pos] !== 0x65) {
    const keyBytes = decodeString(cur);
    const key = bytesToAscii(keyBytes);
    const val = decodeOne(cur);
    dict.set(key, val);
  }
  cur.pos++;
  return new BencodeDict(dict);
}

// ── Encoder ──────────────────────────────────────────────────────────────

/** Encode a BValue into a byte array. */
export function bencode(value: BValue): Uint8Array {
  const parts: Uint8Array[] = [];
  encodeOne(value, parts);
  return concatBytes(parts);
}

function encodeOne(value: BValue, parts: Uint8Array[]): void {
  if (value instanceof Uint8Array) {
    const lenStr = asciiToBytes(`${value.length}:`);
    parts.push(lenStr);
    parts.push(value);
  } else if (typeof value === 'number') {
    parts.push(asciiToBytes(`i${value}e`));
  } else if (value instanceof BencodeList) {
    parts.push(asciiToBytes('l'));
    for (const item of value.items) {
      encodeOne(item, parts);
    }
    parts.push(asciiToBytes('e'));
  } else if (value instanceof BencodeDict) {
    parts.push(asciiToBytes('d'));
    const sortedKeys = Array.from(value.entries.keys()).sort();
    for (const key of sortedKeys) {
      parts.push(asciiToBytes(`${key.length}:`));
      parts.push(asciiToBytes(key));
      encodeOne(value.entries.get(key)!, parts);
    }
    parts.push(asciiToBytes('e'));
  } else {
    throw new Error('Bencode: unsupported value type');
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────

export function bytesToAscii(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) {
    s += String.fromCharCode(bytes[i]);
  }
  return s;
}

export function asciiToBytes(s: string): Uint8Array {
  const u = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) {
    u[i] = s.charCodeAt(i) & 0xff;
  }
  return u;
}

export function concatBytes(parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const p of parts) {
    total += p.length;
  }
  const result = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    result.set(p, offset);
    offset += p.length;
  }
  return result;
}

/** Convert a Uint8Array to a lowercase hex string. */
export function bytesToHex(bytes: Uint8Array): string {
  let hex = '';
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i].toString(16).padStart(2, '0');
  }
  return hex;
}

// ── Dict accessors ────────────────────────────────────────────────────────

export function dictGetString(dict: BencodeDict, key: string): string | null {
  const v = dict.entries.get(key);
  if (v instanceof Uint8Array) {
    return bytesToAscii(v);
  }
  return null;
}

export function dictGetBytes(dict: BencodeDict, key: string): Uint8Array | null {
  const v = dict.entries.get(key);
  if (v instanceof Uint8Array) {
    return v;
  }
  return null;
}

export function dictGetInt(dict: BencodeDict, key: string): number | null {
  const v = dict.entries.get(key);
  if (typeof v === 'number') {
    return v;
  }
  return null;
}

export function dictGetList(dict: BencodeDict, key: string): BencodeList | null {
  const v = dict.entries.get(key);
  if (v instanceof BencodeList) {
    return v;
  }
  return null;
}

export function dictGetDict(dict: BencodeDict, key: string): BencodeDict | null {
  const v = dict.entries.get(key);
  if (v instanceof BencodeDict) {
    return v;
  }
  return null;
}
