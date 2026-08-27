import fs from '@ohos.file.fs';
import { TorrentMeta, sha1FileRegion, bytesEqual } from './TorrentMeta';
import { concatBytes } from './Bencode';
import { SpeedLimiter } from '../../../utils/SpeedLimiter';

/**
 * Piece download manager.
 *
 * Tracks per-piece completion, manages block requests (16 KB default),
 * verifies SHA-1 hashes, and writes verified pieces to the output file.
 *
 * The file is pre-allocated to totalLength; pieces are written at their
 * correct offset (pieceIndex * pieceLength) so out-of-order arrival is fine.
 */

export const BLOCK_SIZE = 16384; // 16 KB — standard BitTorrent block size

/** State of a single piece. */
interface PieceState {
  index: number;
  received: number; // bytes received so far
  total: number; // total bytes in this piece
  blocks: Map<number, Uint8Array>; // begin → block data
  done: boolean;
}

/** Callback when a piece is verified and written. */
export type PieceVerifiedCallback = (pieceIndex: number, bytesWritten: number) => void;

export class PieceManager {
  private pieces: PieceState[] = [];
  private havePieces: boolean[] = [];
  private fileFd: number = -1;
  private onVerified: PieceVerifiedCallback;
  /** Pieces currently being downloaded by some peer (avoid duplicate work). */
  private downloading: Set<number> = new Set();

  /** Total bytes verified and written. */
  verifiedBytes: number = 0;

  constructor(
    private meta: TorrentMeta,
    onVerified: PieceVerifiedCallback
  ) {
    this.onVerified = onVerified;
    for (let i = 0; i < meta.pieceCount; i++) {
      const size = meta.pieceSize(i);
      this.pieces.push({
        index: i,
        received: 0,
        total: size,
        blocks: new Map<number, Uint8Array>(),
        done: false
      });
      this.havePieces.push(false);
    }
  }

  /** Open the output file for writing (pre-allocated to totalLength). */
  openFile(filePath: string): void {
    const file = fs.openSync(filePath, fs.OpenMode.READ_WRITE | fs.OpenMode.CREATE);
    this.fileFd = file.fd;
    // Pre-allocate by writing a single zero byte at the end offset
    try {
      const zeroBuf = new ArrayBuffer(1);
      fs.writeSync(this.fileFd, zeroBuf, { offset: this.meta.totalLength - 1 });
    } catch (e) {
      // pre-allocation may fail; pieces will still write at correct offsets
    }
  }

  /** Close the output file. */
  closeFile(): void {
    if (this.fileFd >= 0) {
      fs.closeSync(this.fileFd);
      this.fileFd = -1;
    }
  }

  /** Get the bitfield of completed pieces (for sending to peers). */
  getHavePieces(): boolean[] {
    return this.havePieces;
  }

  /** Check if all pieces are done. */
  isComplete(): boolean {
    return this.verifiedBytes >= this.meta.totalLength;
  }

  /** Number of pieces remaining. */
  remainingPieces(): number {
    let count = 0;
    for (const p of this.pieces) {
      if (!p.done) {
        count++;
      }
    }
    return count;
  }

  /**
   * Pick the next piece to download (rarest-first is ideal, but we use
   * sequential for simplicity and reliability).
   * @param availablePieces set of pieces the peer has (from bitfield/have)
   */
  pickPiece(availablePieces: Set<number>): number {
    for (let i = 0; i < this.pieces.length; i++) {
      if (!this.pieces[i].done && !this.downloading.has(i) && availablePieces.has(i)) {
        this.downloading.add(i);
        return i;
      }
    }
    return -1;
  }

  /** Release a piece from the downloading set (e.g. when a peer disconnects). */
  releasePiece(pieceIndex: number): void {
    if (pieceIndex >= 0 && !this.pieces[pieceIndex]?.done) {
      this.downloading.delete(pieceIndex);
    }
  }

  /**
   * Get the next block request within a piece.
   * Returns { begin, length } or null if all blocks are requested.
   */
  nextBlockRequest(pieceIndex: number): { begin: number; length: number } | null {
    const piece = this.pieces[pieceIndex];
    if (!piece || piece.done) {
      return null;
    }
    for (let begin = 0; begin < piece.total; begin += BLOCK_SIZE) {
      if (!piece.blocks.has(begin)) {
        const length = Math.min(BLOCK_SIZE, piece.total - begin);
        return { begin, length };
      }
    }
    return null;
  }

  /**
   * Store a received block. When all blocks of a piece are received,
   * verify the SHA-1 hash and write to file.
   * @returns true if the block was accepted, false if duplicate/invalid
   */
  storeBlock(pieceIndex: number, begin: number, data: Uint8Array): boolean {
    const piece = this.pieces[pieceIndex];
    if (!piece || piece.done) {
      return false;
    }
    if (piece.blocks.has(begin)) {
      return false; // duplicate
    }
    piece.blocks.set(begin, data);
    piece.received += data.length;

    if (piece.received >= piece.total) {
      this.verifyAndWrite(piece).catch(() => {
        // piece write/verify failed — file I/O or hash mismatch; next block will retry
      });
    }
    return true;
  }

  /** Verify a complete piece and write it to the file. */
  private async verifyAndWrite(piece: PieceState): Promise<void> {
    // Assemble piece data from blocks (sorted by begin offset)
    const sortedBegins = Array.from(piece.blocks.keys()).sort((a, b) => a - b);
    const parts: Uint8Array[] = [];
    for (const begin of sortedBegins) {
      parts.push(piece.blocks.get(begin)!);
    }
    const pieceData = concatBytes(parts);

    // Apply global speed limit before writing
    const n = pieceData.byteLength;
    const waitMs = SpeedLimiter.global().waitTime(n);
    if (waitMs > 0) {
      await new Promise(r => setTimeout(r, waitMs));
    }
    SpeedLimiter.global().tryConsume(n);

    // Write piece data to file first (at correct offset)
    const fileOffset = piece.index * this.meta.pieceLength;
    fs.writeSync(this.fileFd, pieceData.buffer.slice(pieceData.byteOffset, pieceData.byteOffset + pieceData.byteLength), { offset: fileOffset });

    // Verify SHA-1 by reading back from file
    const expectedHash = this.meta.pieceHashes[piece.index];
    const actualHash = sha1FileRegion(this.fileFd, fileOffset, piece.total);

    if (!bytesEqual(actualHash, expectedHash)) {
      // Hash mismatch — reset piece for re-download
      piece.received = 0;
      piece.blocks.clear();
      this.downloading.delete(piece.index);
      return;
    }

    piece.done = true;
    this.havePieces[piece.index] = true;
    this.verifiedBytes += piece.total;
    this.downloading.delete(piece.index);
    this.onVerified(piece.index, piece.total);
  }

  /** Load existing progress from the file (for resume). */
  loadExistingProgress(): void {
    if (this.fileFd < 0) {
      return;
    }
    for (let i = 0; i < this.pieces.length; i++) {
      const piece = this.pieces[i];
      if (piece.done) {
        continue;
      }
      const expectedHash = this.meta.pieceHashes[i];
      const actualHash = sha1FileRegion(this.fileFd, i * this.meta.pieceLength, piece.total);
      if (bytesEqual(actualHash, expectedHash)) {
        piece.done = true;
        piece.received = piece.total;
        this.havePieces[i] = true;
        this.verifiedBytes += piece.total;
      }
    }
  }
}
