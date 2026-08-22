import fs from '@ohos.file.fs';
import cryptoFramework from '@ohos.security.cryptoFramework';
import {
  bdecode,
  bencode,
  bytesToAscii,
  bytesToHex,
  asciiToBytes,
  BencodeDict,
  BencodeList,
  dictGetBytes,
  dictGetString,
  dictGetInt,
  dictGetList,
  dictGetDict
} from './Bencode';

/**
 * Parsed .torrent metadata.
 *
 * infoHash     — 20-byte SHA-1 of the bencoded "info" dict (identifies the swarm)
 * pieceHashes  — array of 20-byte SHA-1 hashes, one per piece
 * pieceLength  — nominal bytes per piece (last piece may be shorter)
 * totalLength  — total content size in bytes
 * name         — suggested file/directory name
 * trackers     — flat list of tracker URLs (from "announce" + "announce-list")
 * files        — for multi-file torrents: [{path, length}, ...]; empty for single-file
 */

export interface TorrentFile {
  path: string;
  length: number;
}

export class TorrentMeta {
  infoHash: Uint8Array = new Uint8Array(20);
  infoHashHex: string = '';
  pieceHashes: Uint8Array[] = [];
  pieceLength: number = 0;
  totalLength: number = 0;
  name: string = 'torrent';
  trackers: string[] = [];
  files: TorrentFile[] = [];
  isMultiFile: boolean = false;

  get pieceCount(): number {
    return this.pieceHashes.length;
  }

  pieceSize(i: number): number {
    if (i < this.pieceCount - 1) {
      return this.pieceLength;
    }
    const remainder = this.totalLength % this.pieceLength;
    return remainder === 0 ? this.pieceLength : remainder;
  }
}

/** Parse a .torrent file from the local filesystem. */
export async function parseTorrentFile(filePath: string): Promise<TorrentMeta> {
  const file = fs.openSync(filePath, fs.OpenMode.READ_ONLY);
  try {
    const stat = fs.statSync(file.fd);
    const buf = new ArrayBuffer(stat.size);
    fs.readSync(file.fd, buf);
    const data = new Uint8Array(buf);
    return parseTorrentBytes(data);
  } finally {
    fs.closeSync(file.fd);
  }
}

/** Parse a .torrent from raw bytes. */
export function parseTorrentBytes(data: Uint8Array): TorrentMeta {
  const root = bdecode(data);
  if (!(root instanceof BencodeDict)) {
    throw new Error('Torrent: root is not a dict');
  }

  const meta = new TorrentMeta();

  // ── Trackers ──
  const announce = dictGetString(root, 'announce');
  if (announce) {
    meta.trackers.push(announce);
  }
  const announceList = dictGetList(root, 'announce-list');
  if (announceList) {
    for (const tier of announceList.items) {
      if (tier instanceof BencodeList) {
        for (const tracker of tier.items) {
          if (tracker instanceof Uint8Array) {
            meta.trackers.push(bytesToAscii(tracker));
          }
        }
      }
    }
  }

  // ── Info dict ──
  const info = dictGetDict(root, 'info');
  if (!info) {
    throw new Error('Torrent: missing "info" dict');
  }

  const infoEncoded = bencode(info);
  meta.infoHash = sha1Sync(infoEncoded);
  meta.infoHashHex = bytesToHex(meta.infoHash);

  // ── Piece hashes ──
  const pieces = dictGetBytes(info, 'pieces');
  if (!pieces || pieces.length % 20 !== 0) {
    throw new Error('Torrent: invalid pieces field');
  }
  const numPieces = pieces.length / 20;
  for (let i = 0; i < numPieces; i++) {
    meta.pieceHashes.push(pieces.subarray(i * 20, (i + 1) * 20));
  }

  meta.pieceLength = dictGetInt(info, 'piece length') ?? 0;
  if (meta.pieceLength <= 0) {
    throw new Error('Torrent: invalid piece length');
  }

  meta.name = dictGetString(info, 'name') ?? 'torrent';

  // ── Single-file vs multi-file ──
  const filesList = dictGetList(info, 'files');
  if (filesList && filesList.items.length > 0) {
    meta.isMultiFile = true;
    let total = 0;
    for (const f of filesList.items) {
      if (!(f instanceof BencodeDict)) {
        continue;
      }
      const length = dictGetInt(f, 'length') ?? 0;
      const pathList = dictGetList(f, 'path');
      const pathSegments: string[] = [];
      if (pathList) {
        for (const p of pathList.items) {
          if (p instanceof Uint8Array) {
            pathSegments.push(bytesToAscii(p));
          }
        }
      }
      meta.files.push({ path: pathSegments.join('/'), length });
      total += length;
    }
    meta.totalLength = total;
  } else {
    meta.totalLength = dictGetInt(info, 'length') ?? 0;
  }

  if (meta.totalLength <= 0) {
    throw new Error('Torrent: invalid total length');
  }

  return meta;
}

/** Generate a 20-byte random peer ID with FluxDown Cover prefix. */
export function generatePeerId(): Uint8Array {
  const prefix = asciiToBytes('-FD100-');
  const id = new Uint8Array(20);
  id.set(prefix, 0);
  for (let i = 7; i < 20; i++) {
    id[i] = Math.floor(Math.random() * 256);
  }
  return id;
}

// ── SHA-1 helpers ──

export function sha1Sync(data: Uint8Array): Uint8Array {
  const md: cryptoFramework.Md = cryptoFramework.createMd('SHA1');
  md.updateSync({ data: data });
  const digest: cryptoFramework.DataBlob = md.digestSync();
  return new Uint8Array(digest.data);
}

export function sha1FileRegion(fd: number, offset: number, length: number): Uint8Array {
  const md: cryptoFramework.Md = cryptoFramework.createMd('SHA1');
  const chunkSize = 256 * 1024;
  let remaining = length;
  let pos = offset;
  while (remaining > 0) {
    const readLen = Math.min(chunkSize, remaining);
    const buf = new ArrayBuffer(readLen);
    const bytesRead = fs.readSync(fd, buf, { offset: pos });
    if (bytesRead <= 0) {
      break;
    }
    const view = new Uint8Array(buf, 0, bytesRead);
    md.updateSync({ data: view });
    pos += bytesRead;
    remaining -= bytesRead;
  }
  const digest: cryptoFramework.DataBlob = md.digestSync();
  return new Uint8Array(digest.data);
}

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) {
    return false;
  }
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) {
      return false;
    }
  }
  return true;
}
