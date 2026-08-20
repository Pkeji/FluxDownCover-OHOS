import { http } from '@kit.NetworkKit';
import fs from '@ohos.file.fs';
import { DownloadTask } from '../../model/DownloadTask';
import { EngineHooks } from '../EngineHooks';
import { Ctrl } from '../types';
import { sanitizeFileName } from '../../utils/common';
import {
  TorrentMeta,
  parseTorrentFile,
  parseTorrentBytes,
  generatePeerId
} from './bittorrent/TorrentMeta';
import { Peer, announceAny } from './bittorrent/Tracker';
import {
  PeerConnection,
  PeerMessageHandler,
  PieceBlock,
  buildBitfield,
  bitfieldHas
} from './bittorrent/PeerWire';
import { PieceManager } from './bittorrent/PieceManager';

const MAX_PEERS = 10;
const LISTEN_PORT = 6881; // reported to tracker (we don't actually listen)
const REANNOUNCE_INTERVAL = 30; // seconds

/**
 * BitTorrent download protocol.
 *
 * Flow:
 *   1. Parse .torrent file (from local path or HTTP URL)
 *   2. Compute info_hash, generate peer_id
 *   3. Announce to tracker → get peer list
 *   4. Connect to peers, exchange handshakes + bitfields
 *   5. Request blocks from unchoked peers
 *   6. Verify SHA-1 per piece, write to file
 *   7. Re-announce periodically for fresh peers
 *   8. Complete when all pieces verified
 *
 * @param task   the download task (task.url = .torrent file path or HTTP URL)
 * @param ctrl   abort flag
 * @param hooks  engine hooks for progress reporting
 */
export async function downloadBittorrent(
  task: DownloadTask,
  ctrl: Ctrl,
  hooks: EngineHooks
): Promise<void> {
  // ── 1. Parse .torrent file ──────────────────────────────────────────
  const meta = await loadTorrentMeta(task.url);

  task.totalBytes = meta.totalLength;
  // Always derive the output filename from the torrent metadata, not the URL.
  task.fileName = sanitizeFileName(meta.isMultiFile ? `${meta.name}.tar` : meta.name);
  if (!task.dirPath) {
    throw new Error('BitTorrent download failed: dirPath is empty. Ensure DownloadEngine sets a valid default directory.');
  }
  // Ensure the output directory exists.
  // NOTE: fs.accessSync returns boolean (false if not exist) — it does NOT throw.
  if (!fs.accessSync(task.dirPath)) {
    fs.mkdirSync(task.dirPath);
  }
  task.filePath = `${task.dirPath}/${task.fileName}`;

  // ── 2. Generate peer ID ─────────────────────────────────────────────
  const peerId = generatePeerId();

  // ── 3. Initialize piece manager ─────────────────────────────────────
  const pieceManager = new PieceManager(meta, (_pieceIndex, bytesWritten) => {
    hooks.onChunk(task, bytesWritten);
  });
  pieceManager.openFile(task.filePath);
  pieceManager.loadExistingProgress();

  if (pieceManager.isComplete()) {
    pieceManager.closeFile();
    return;
  }

  // ── 4. Announce to tracker ──────────────────────────────────────────
  const left = meta.totalLength - pieceManager.verifiedBytes;
  let announceResult = await announceAny(
    meta.trackers, meta, peerId, LISTEN_PORT,
    0, pieceManager.verifiedBytes, left
  );

  // ── 5. Connect to peers and download ────────────────────────────────
  let connections: PeerConnection[] = [];
  const activeRequests: Map<string, { piece: number; begin: number; length: number }> = new Map();

  let lastAnnounce = Date.now();
  let peerIdx = 0;

  // Main download loop
  while (!pieceManager.isComplete() && !ctrl.aborted) {
    // Re-announce if needed
    const now = Date.now();
    if (now - lastAnnounce > REANNOUNCE_INTERVAL * 1000 && peerIdx >= announceResult.peers.length) {
      try {
        announceResult = await announceAny(
          meta.trackers, meta, peerId, LISTEN_PORT,
          0, pieceManager.verifiedBytes, meta.totalLength - pieceManager.verifiedBytes
        );
        lastAnnounce = now;
        peerIdx = 0;
      } catch (e) {
        // re-announce failed, keep trying with existing peers
      }
    }

    // Connect to new peers if we have capacity
    while (
      connections.filter((c) => !c.isDisposed).length < MAX_PEERS &&
      peerIdx < announceResult.peers.length &&
      !ctrl.aborted
    ) {
      const peer = announceResult.peers[peerIdx++];
      try {
        const conn = await connectToPeer(peer, meta, peerId, pieceManager, task, ctrl, activeRequests);
        if (conn) {
          connections.push(conn);
        }
      } catch (e) {
        // peer connection failed, try next
      }
    }

    // Clean up disposed connections and remove from array
    for (const conn of connections) {
      if (conn.isDisposed) {
        conn.close();
      }
    }
    connections = connections.filter((c) => !c.isDisposed);

    // Wait a bit before checking again
    await sleep(500);
  }

  // ── 6. Cleanup ──────────────────────────────────────────────────────
  for (const conn of connections) {
    conn.close();
  }
  pieceManager.closeFile();

  if (ctrl.aborted) {
    return;
  }
  if (!pieceManager.isComplete()) {
    throw new Error('BitTorrent: 下载未完成（可能没有足够的 peers）');
  }
}

/**
 * Load torrent metadata from a URL or local file path.
 * Supports: http://, https://, or local filesystem path.
 */
async function loadTorrentMeta(url: string): Promise<TorrentMeta> {
  if (url.startsWith('http://') || url.startsWith('https://')) {
    const req = http.createHttp();
    try {
      const resp = await req.request(url, {
        method: http.RequestMethod.GET,
        header: { Accept: '*/*' },
        expectDataType: http.HttpDataType.ARRAY_BUFFER,
        connectTimeout: 20000,
        readTimeout: 20000
      });
      const data = new Uint8Array(resp.result as ArrayBuffer);
      return parseTorrentBytes(data);
    } finally {
      req.destroy();
    }
  }
  // Local file path — strip file:// prefix if present.
  let filePath = url;
  if (filePath.startsWith('file://')) {
    filePath = filePath.substring('file://'.length);
  }
  // Verify the .torrent file exists before opening.
  // NOTE: fs.accessSync returns boolean — it does NOT throw for non-existent files.
  if (!fs.accessSync(filePath)) {
    throw new Error(`无法访问 .torrent 文件: ${filePath}（文件不存在或应用无权限访问）`);
  }
  return parseTorrentFile(filePath);
}

/**
 * Connect to a single peer, perform handshake, and start downloading.
 */
async function connectToPeer(
  peer: Peer,
  meta: TorrentMeta,
  peerId: Uint8Array,
  pieceManager: PieceManager,
  task: DownloadTask,
  ctrl: Ctrl,
  activeRequests: Map<string, { piece: number; begin: number; length: number }>
): Promise<PeerConnection | null> {
  const conn = new PeerConnection(peer.ip, peer.port, meta.infoHash, peerId);

  // Track what pieces this peer has
  const peerPieces = new Set<number>();
  let unchoked = false;
  let currentPiece = -1; // track piece assigned to this peer for cleanup

  const handler: PeerMessageHandler = {
    onUnchoke() {
      unchoked = true;
      requestNextBlock();
    },
    onChoke() {
      unchoked = false;
    },
    onHave(piece: number) {
      peerPieces.add(piece);
      if (unchoked) {
        requestNextBlock();
      }
    },
    onBitfield(bits: Uint8Array) {
      for (let i = 0; i < meta.pieceCount; i++) {
        if (bitfieldHas(bits, i)) {
          peerPieces.add(i);
        }
      }
      if (unchoked) {
        requestNextBlock();
      }
    },
    onPiece(block: PieceBlock) {
      const key = `${peer.ip}:${peer.port}:${block.index}:${block.begin}`;
      activeRequests.delete(key);
      pieceManager.storeBlock(block.index, block.begin, block.data);
      if (unchoked && !ctrl.aborted) {
        requestNextBlock();
      }
    }
  };

  function requestNextBlock() {
    if (ctrl.aborted || !unchoked || conn.isDisposed) {
      return;
    }
    const pieceIdx = pieceManager.pickPiece(peerPieces);
    if (pieceIdx < 0) {
      return;
    }
    currentPiece = pieceIdx;
    const blockReq = pieceManager.nextBlockRequest(pieceIdx);
    if (!blockReq) {
      return;
    }
    const key = `${peer.ip}:${peer.port}:${pieceIdx}:${blockReq.begin}`;
    activeRequests.set(key, { piece: pieceIdx, begin: blockReq.begin, length: blockReq.length });
    conn.sendRequest(pieceIdx, blockReq.begin, blockReq.length).catch(() => {
      activeRequests.delete(key);
    });
  }

  try {
    await conn.connect(15000);
    conn.setMessageHandler(handler);

    // Release piece on disconnect
    conn.onDispose = () => {
      pieceManager.releasePiece(currentPiece);
    };

    // Send our bitfield
    const havePieces = pieceManager.getHavePieces();
    const bitfield = buildBitfield(havePieces, meta.pieceCount);
    if (bitfield.some((b) => b !== 0)) {
      await conn.sendBitfield(bitfield);
    }

    // Express interest
    await conn.sendInterested();

    return conn;
  } catch (e) {
    conn.close();
    pieceManager.releasePiece(currentPiece);
    return null;
  }
}

/** Helper: sleep for ms milliseconds. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Build HLS-like segments for a BitTorrent task (for persistence/progress display).
 * Each piece becomes a "segment" in the task model.
 */
export function buildBittorrentSegments(task: DownloadTask, meta: TorrentMeta): void {
  task.totalBytes = meta.totalLength;
  task.segments = [];
  for (let i = 0; i < meta.pieceCount; i++) {
    const start = i * meta.pieceLength;
    const end = Math.min(start + meta.pieceLength - 1, meta.totalLength - 1);
    task.segments.push({
      index: i,
      start,
      end,
      downloaded: 0,
      done: false
    });
  }
}
