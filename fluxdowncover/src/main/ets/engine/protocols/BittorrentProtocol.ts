import { http } from '@kit.NetworkKit';
import { logCollector } from '../../utils/LogCollector';
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
import { parseMagnetLink } from './bittorrent/MagnetLink';
import { downloadMetadata } from './bittorrent/MetadataExchange';
import { BtEngine } from '../BtEngine';
import { Aria2Engine } from "../Aria2Engine";

const MAX_PEERS = 10;
const DEFAULT_LISTEN_PORT = 6881; // fallback if BtEngine hasn't bound yet
const REANNOUNCE_INTERVAL = 30; // seconds

/** The actual shared listen port chosen by BtEngine (TCP+UDP). */
function listenPort(): number {
  return BtEngine.getInstance().port || DEFAULT_LISTEN_PORT;
}

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
  // Use libtorrent C++ engine for magnet links (more robust DHT/tracker)
  if (task.url.toLowerCase().startsWith("magnet:")) {
    await Aria2Engine.getInstance().addMagnet(task, ctrl, hooks);
    return;
  }

  // ── 1. Parse .torrent file ──────────────────────────────────────────
  const meta = await loadTorrentMeta(task.url);

  task.totalBytes = meta.totalLength;
  // Always derive the output filename from the torrent metadata, not the URL.
  task.fileName = sanitizeFileName(meta.isMultiFile ? `${meta.name}.tar` : meta.name);
  if (!task.dirPath) {
    throw new Error('BitTorrent download failed: dirPath is empty. Ensure DownloadEngine sets a valid default directory.');
  }
  // Ensure the output directory exists.
  // NOTE: fs.accessSync returns boolean (false if not exist); both it and mkdirSync are @throws,
  // and mkdirSync may throw when the directory already exists, so the ensure step is non-fatal here.
  try {
    if (!fs.accessSync(task.dirPath)) {
      fs.mkdirSync(task.dirPath);
    }
  } catch (_e) {
    // 目录已存在或访问异常时忽略；若确实不可写，后续 openSync 会抛出真实错误
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

  // Bring up shared BT listeners (DHT / PeerServer / UPnP) and register this
  // torrent so the seeding tick can find it later.
  await BtEngine.getInstance().ensureListeners();
  BtEngine.getInstance().registerTaskMeta(task.id, meta, pieceManager);

  // ── 4. Discover peers (trackers + DHT) ──────────────────────────────
  let peers: Peer[] = await BtEngine.getInstance().discoverPeers(meta, ctrl);
  task.totalPeers = peers.length;
  if (peers.length === 0) {
    logCollector.warn('Warn', `FluxDown Cover: no peers found for ${meta.name}`);
  }

  // ── 5. Connect to peers and download ────────────────────────────────
  let connections: PeerConnection[] = [];
  const activeRequests: Map<string, { piece: number; begin: number; length: number }> = new Map();

  let lastAnnounce = Date.now();
  let peerIdx = 0;

  // Main download loop
  while (!pieceManager.isComplete() && !ctrl.aborted) {
    // Re-announce if needed
    const now = Date.now();
    if (now - lastAnnounce > REANNOUNCE_INTERVAL * 1000 && peerIdx >= peers.length) {
      try {
        const more = await BtEngine.getInstance().discoverPeers(meta, ctrl);
        for (const p of more) {
          if (!peers.some((ex) => ex.ip === p.ip && ex.port === p.port)) {
            peers.push(p);
          }
        }
        task.totalPeers = peers.length;
        lastAnnounce = now;
        peerIdx = 0;
      } catch (e) {
        // re-announce failed, keep trying with existing peers
      }
    }

    // Connect to new peers if we have capacity
    while (
      connections.filter((c) => !c.isDisposed).length < MAX_PEERS &&
      peerIdx < peers.length &&
      !ctrl.aborted
    ) {
      const peer = peers[peerIdx++];
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

  if (ctrl.aborted) {
    pieceManager.closeFile();
    return;
  }
  if (!pieceManager.isComplete()) {
    pieceManager.closeFile();
    throw new Error('BitTorrent: 下载未完成（可能没有足够的 peers）');
  }

  // Download finished. Hand the torrent to the BtEngine to seed in the
  // background (keeps the file open so inbound peers can be served). If
  // seeding is disabled, close the file now.
  const bt = BtEngine.getInstance();
  await bt.onDownloadComplete(task, meta, pieceManager);
  if (task.seedingStatus === 'userStopped' || task.seedingStatus === 'none') {
    // Seeding disabled — nothing more to do.
    pieceManager.closeFile();
  }
}

/**
 * Load torrent metadata from a URL or local file path.
 * Supports: http://, https://, magnet:, or local filesystem path.
 */
async function loadTorrentMeta(url: string): Promise<TorrentMeta> {
  // ── Magnet link ─────────────────────────────────────────────────────
  if (url.toLowerCase().startsWith('magnet:')) {
    return resolveMagnetLink(url);
  }

  // ── HTTP(S) .torrent file ────────────────────────────────────────────
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
    } catch (e) {
      // 种子下载/解析失败向上传播
      throw e as Error;
    } finally {
      try {
        req.destroy();
      } catch (_e) {
        // ignore destroy error
      }
    }
  }

  // ── Local file — strip file:// or content:// prefix if present. ─────
  let filePath = url;
  if (filePath.startsWith('file://')) {
    filePath = filePath.substring('file://'.length);
  }
  // For content:// URIs (from file picker), pass directly to fs.openSync
  if (url.startsWith('content://')) {
    return parseTorrentFile(url);
  }
  let accessible = false;
  try {
    accessible = fs.accessSync(filePath);
  } catch (_e) {
    accessible = false;
  }
  if (!accessible) {
    throw new Error(`无法访问 .torrent 文件: ${filePath}（文件不存在或应用无权限访问）`);
  }
  return parseTorrentFile(filePath);
}

/**
 * Resolve a magnet: URI to a full TorrentMeta by:
 *   1. Parsing the magnet link to get info_hash + trackers
 *   2. Announcing to trackers to find peers
 *   3. Downloading metadata from peers using BEP-9 ut_metadata
 */
async function resolveMagnetLink(uri: string): Promise<TorrentMeta> {
  const magnet = parseMagnetLink(uri);
  if (!magnet) {
    throw new Error(`无效的磁力链接: ${uri}`);
  }

  // 确保BtEngine监听端口和DHT已启动
  await BtEngine.getInstance().ensureListeners();
  console.info(`[BT] BtEngine已启动, 监听端口: ${BtEngine.getInstance().port}`);

  const peerId = generatePeerId();
  const displayName = magnet.displayName || `magnet_${magnet.infoHashHex.substring(0, 8)}`;

  // If no trackers in magnet link, use public trackers as fallback
  if (magnet.trackers.length === 0) {
    magnet.trackers.push(
      'udp://tracker.opentrackr.org:1337/announce',
      'udp://tracker.openbittorrent.com:6969/announce',
      'udp://tracker.torrent.eu.org:451/announce',
      'udp://opentracker.i2p.rocks:6969/announce',
      'udp://exodus.desync.com:6969/announce',
      'https://tracker.bt4g.com:2095/announce',
      'udp://tracker.coppersurfer.tk:6969/announce',
      // 国内常用 tracker
      'https://tr.burnabyhighstar.com:443/announce',
      'http://tracker.dler.org:6969/announce',
      'udp://tracker.dler.org:6969/announce',
      'https://tracker.lilithraws.cf:443/announce',
      'udp://open.demonii.com:1337/announce',
      'udp://tracker.moeking.me:6969/announce',
    );
  }

  // 并行 announce 所有 tracker，收集 peers
  const partialMeta = new TorrentMeta();
  partialMeta.infoHash = magnet.infoHash;
  partialMeta.infoHashHex = magnet.infoHashHex;
  partialMeta.trackers = magnet.trackers;
  partialMeta.name = displayName;

  const announcePromises = magnet.trackers.map(async (trackerUrl) => {
    try {
      return await announceAny([trackerUrl], partialMeta, peerId, listenPort(), 0, 0, 1);
    } catch (_e) {
      return null;
    }
  });

  const results = await Promise.all(announcePromises);

  const allPeers: Peer[] = [];
  let okTrackerCount = 0;
  for (const result of results) {
    if (!result) continue;
    okTrackerCount++;
    for (const p of result.peers) {
      if (!allPeers.some(ex => ex.ip === p.ip && ex.port === p.port)) {
        allPeers.push(p);
      }
    }
  }
  console.info(`[BT] tracker完成: ${okTrackerCount}/${magnet.trackers.length}个成功, 获取到${allPeers.length}个peers`);

  // 通过DHT网络找peers（等15秒）
  try {
    const dhtPeers = await BtEngine.getInstance().findPeersViaDht(magnet.infoHash, 15000);
    for (const p of dhtPeers) {
      if (!allPeers.some(ex => ex.ip === p.ip && ex.port === p.port)) {
        allPeers.push(p);
      }
    }
    console.info(`[BT] 加入DHT peers后共${allPeers.length}个peers`);
  } catch (e) {
    console.info(`[BT] DHT找peers失败: ${(e as Error).message}`);
  }

  if (allPeers.length === 0) {
    throw new Error(`无法从 tracker/DHT 获取到 peers，请检查网络或磁力链接: ${displayName}`);
  }

  // 最多试5个peer下载metadata
  const peersToTry = allPeers.slice(0, 5);
  console.info(`[BT] 尝试从${peersToTry.length}个peer下载metadata`);
  for (const peer of peersToTry) {
    console.info(`[BT] 连接peer ${peer.ip}:${peer.port}...`);
    try {
      const metaResult = await downloadMetadata(peer, magnet.infoHash, peerId, 0);
      if (metaResult) {
        const meta = parseTorrentBytes(metaResult.rawInfo);
        meta.trackers = magnet.trackers;
        console.info(`[BT] metadata下载成功: ${meta.name}`);
        return meta;
      }
      console.info(`[BT] peer ${peer.ip}:${peer.port} 不支持metadata或下载失败`);
    } catch (e) {
      console.info(`[BT] peer ${peer.ip}:${peer.port} 连接失败: ${(e as Error).message}`);
    }
  }

  throw new Error(`无法从 peers 下载元数据（已尝试${peersToTry.length}个节点）: ${displayName}`);
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
