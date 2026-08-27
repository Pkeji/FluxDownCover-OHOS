/**
 * BEP-9 Metadata Exchange (ut_metadata) implementation.
 *
 * Allows downloading the .torrent metadata from peers given only the info_hash
 * (e.g., from a magnet link). The metadata is split into 16 KiB pieces and
 * requested via the extension protocol.
 *
 * Flow for a single peer:
 *   1. Connect, handshake, wait for extended handshake
 *   2. Send our extended handshake listing ut_metadata support
 *   3. If peer supports ut_metadata and metadata_size is known, request pieces
 *   4. Reassemble pieces into the complete bencoded info dict
 */
import { socket } from '@kit.NetworkKit';
import { BusinessError } from '@kit.BasicServicesKit';
import {
  bdecode,
  bencode,
  concatBytes,
  BencodeDict,
  dictGetInt,
  dictGetDict
} from './Bencode';
import { PeerConnection, PeerMessageHandler } from './PeerWire';
import { TorrentMeta, parseTorrentBytes } from './TorrentMeta';
import { Peer } from './Tracker';

const METADATA_PIECE_SIZE = 16384; // 16 KiB standard
const PEER_TIMEOUT = 20000; // 20 seconds per peer

/**
 * Result of a metadata download attempt from a single peer.
 */
export interface MetadataResult {
  /** The raw bencoded info dict bytes. */
  rawInfo: Uint8Array;
  /** Total size of the metadata in bytes. */
  totalSize: number;
}

/**
 * Download the torrent metadata (info dict) from a peer using BEP-9.
 *
 * @param peer    The peer to connect to
 * @param infoHash 20-byte info hash
 * @param peerId   20-byte local peer ID
 * @param metadataSize  Known metadata size (0 if unknown, will be learned from handshake)
 * @returns The raw bencoded info dict bytes, or null on failure
 */
export async function downloadMetadata(
  peer: Peer,
  infoHash: Uint8Array,
  peerId: Uint8Array,
  metadataSize: number
): Promise<MetadataResult | null> {
  const conn = new PeerConnection(peer.ip, peer.port, infoHash, peerId);

  let utMetadataId = -1; // sub-type for ut_metadata messages
  let totalSize = metadataSize;
  const pieces: Map<number, Uint8Array> = new Map();
  let numPieces = 0;
  let handshakeResolve: (() => void) | null = null;
  let handshakeReject: ((e: Error) => void) | null = null;
  let timeoutId: number | null = null;

  const handler: PeerMessageHandler = {
    onChoke() { /* ignore */ },
    onUnchoke() { /* ignore */ },
    onHave(_p: number) { /* ignore */ },
    onBitfield(_bits: Uint8Array) { /* ignore */ },
    onPiece(_block: { index: number; begin: number; data: Uint8Array }) { /* ignore */ },

    onExtendedHandshake(data: Record<string, Object>) {
      // Parse the 'm' dict to find ut_metadata sub-type
      const m = data['m'] as Record<string, Object> | undefined;
      if (m) {
        const v = m['ut_metadata'];
        if (typeof v === 'number') {
          utMetadataId = v;
        }
      }
      // Get metadata_size if not already known
      if (totalSize <= 0) {
        const ms = data['metadata_size'];
        if (typeof ms === 'number') {
          totalSize = ms;
        }
      }

      if (utMetadataId < 0 || totalSize <= 0) {
        handshakeReject?.(new Error('Peer does not support ut_metadata'));
        return;
      }

      numPieces = Math.ceil(totalSize / METADATA_PIECE_SIZE);

      // Send our extended handshake back
      conn.sendExtendedHandshake({ ut_metadata: 1 }, 0).catch(() => {});

      // Request all metadata pieces
      requestAllPieces().catch((e) => handshakeReject?.(e as Error));
      handshakeResolve?.();
    },

    onExtendedMessage(subType: number, payload: Uint8Array) {
      if (subType !== utMetadataId) {
        return;
      }
      // Parse bencoded dict header (msg_type, piece)
      try {
        // The payload is: <bencoded dict><binary data>
        // Find the end of the bencoded dict (look for 'e' after 'd')
        const bencodedEnd = findBencodeEnd(payload);
        if (bencodedEnd < 0) {
          return;
        }
        const dictBytes = payload.subarray(0, bencodedEnd);
        const binaryData = payload.subarray(bencodedEnd);

        const decoded = bdecode(dictBytes);
        if (!(decoded instanceof BencodeDict)) {
          return;
        }
        const msgType = dictGetInt(decoded, 'msg_type');
        const pieceIdx = dictGetInt(decoded, 'piece');

        if (msgType === 1 && pieceIdx >= 0) {
          // metadata_data
          pieces.set(pieceIdx, binaryData);
          // Check if we have all pieces
          if (pieces.size >= numPieces) {
            assembleMetadata();
          }
        }
        // msg_type 0 = request (we don't serve metadata), 2 = reject (ignore)
      } catch (_) { /* ignore malformed messages */ }
    }
  };

  try {
    await conn.connect(PEER_TIMEOUT);
    conn.setMessageHandler(handler);

    // Wait for extended handshake or timeout
    await new Promise<void>((resolve, reject) => {
      handshakeResolve = resolve;
      handshakeReject = reject;
      timeoutId = setTimeout(() => {
        reject(new Error('Timeout waiting for extended handshake'));
      }, PEER_TIMEOUT);
    });

    // Wait for metadata to be assembled
    await new Promise<void>((resolve, reject) => {
      const checkInterval = setInterval(() => {
        if (pieces.size >= numPieces) {
          clearInterval(checkInterval);
          resolve();
        }
      }, 200);
      // Timeout after 30 seconds
      setTimeout(() => {
        clearInterval(checkInterval);
        if (pieces.size < numPieces) {
          reject(new Error('Timeout downloading metadata'));
        }
      }, 30000);
    });

    conn.close();

    // Assemble metadata
    const assembled = assembleMetadataRaw();
    if (assembled) {
      return { rawInfo: assembled, totalSize };
    }
    return null;
  } catch (_) {
    conn.close();
    return null;
  } finally {
    if (timeoutId !== null) {
      clearTimeout(timeoutId);
    }
  }

  /** Request all metadata pieces from the peer. */
  async function requestAllPieces(): Promise<void> {
    for (let i = 0; i < numPieces; i++) {
      if (utMetadataId < 0) {
        break;
      }
      const reqDict = new BencodeDict(new Map());
      reqDict.entries.set('msg_type', 0); // request
      reqDict.entries.set('piece', i);
      const reqBytes = bencode(reqDict);
      await conn.sendExtended(utMetadataId, new Uint8Array(reqBytes));
    }
  }

  /** Assemble all received pieces into the complete metadata. */
  function assembleMetadata(): void {
    const assembled = assembleMetadataRaw();
    if (assembled) {
      conn.close();
    }
  }

  function assembleMetadataRaw(): Uint8Array | null {
    if (pieces.size < numPieces) {
      return null;
    }
    const chunks: Uint8Array[] = [];
    for (let i = 0; i < numPieces; i++) {
      const chunk = pieces.get(i);
      if (!chunk) {
        return null;
      }
      chunks.push(chunk);
    }
    return concatBytes(chunks);
  }
}

/**
 * Find the end position of a bencoded dict at the start of a buffer.
 * Returns the index after the terminating 'e', or -1 if not found.
 */
function findBencodeEnd(data: Uint8Array): number {
  if (data.length < 2 || data[0] !== 0x64 /* 'd' */) {
    return -1;
  }
  let depth = 0;
  let inString = false;
  let stringLen = 0;
  let colonFound = false;
  let lenBuf = 0;

  for (let i = 0; i < data.length; i++) {
    const ch = data[i];
    if (inString) {
      if (stringLen > 0) {
        stringLen--;
        continue;
      }
      inString = false;
      continue;
    }
    if (colonFound) {
      // Reading the length digits
      if (ch >= 0x30 && ch <= 0x39) {
        lenBuf = lenBuf * 10 + (ch - 0x30);
        continue;
      }
      if (ch === 0x3a /* ':' */) {
        stringLen = lenBuf;
        inString = true;
        colonFound = false;
        lenBuf = 0;
        continue;
      }
      // Unexpected - reset
      colonFound = false;
      lenBuf = 0;
    }
    if (ch === 0x64 /* 'd' */ || ch === 0x6c /* 'l' */ || ch === 0x69 /* 'i' */) {
      depth++;
      if (ch === 0x69) {
        // Integer: skip to 'e'
        let j = i + 1;
        while (j < data.length && data[j] !== 0x65) {
          j++;
        }
        i = j;
        depth--; // integer consumes its own e
      }
      continue;
    }
    if (ch >= 0x30 && ch <= 0x39) {
      // Start of a string length
      colonFound = true;
      lenBuf = ch - 0x30;
      continue;
    }
    if (ch === 0x65 /* 'e' */) {
      depth--;
      if (depth === 0) {
        return i + 1;
      }
      continue;
    }
  }
  return -1;
}
