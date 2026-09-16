import { BtSettingsStore, BtSettings } from '../store/BtSettingsStore';
import { logCollector } from '../utils/LogCollector';
import { DownloadTask } from '../model/DownloadTask';
import { TaskStatus } from '../model/TaskStatus';
import { ProtocolType } from '../model/ProtocolType';
import { TorrentMeta, generatePeerId } from './protocols/bittorrent/TorrentMeta';
import { PieceManager } from './protocols/bittorrent/PieceManager';
import { Dht } from './protocols/bittorrent/Dht';
import { UpnpPortMapper } from './protocols/bittorrent/UpnpPortMapper';
import { PeerServer, SeedLookup } from './protocols/bittorrent/PeerServer';
import { TrackerManager } from './protocols/bittorrent/TrackerManager';
import { SeedingManager } from './protocols/bittorrent/SeedingManager';
import { Peer, announceAny } from './protocols/bittorrent/Tracker';
import { Ctrl } from './types';

/**
 * Central orchestrator for all BitTorrent engine subsystems.
 *
 * Owns a single shared listen port (TCP for inbound peers + UDP for DHT),
 * the DHT client, the UPnP mapper, the inbound PeerServer, the tracker
 * manager, and the seeding manager. A download (BittorrentProtocol) asks the
 * BtEngine for peers and, once complete, hands the torrent off to the
 * BtEngine to seed in the background.
 *
 * This is a process-wide singleton — all torrents share one listen socket.
 */
export class BtEngine {
  private static instance: BtEngine | null = null;
  static getInstance(): BtEngine {
    if (!BtEngine.instance) {
      BtEngine.instance = new BtEngine();
    }
    return BtEngine.instance;
  }

  private settings: BtSettings | null = null;
  private peerId: Uint8Array = generatePeerId();
  private dht: Dht | null = null;
  private upnp: UpnpPortMapper | null = null;
  private peerServer: PeerServer | null = null;
  private trackerManager: TrackerManager = TrackerManager.getInstance();
  private seedingManager: SeedingManager = new SeedingManager();

  /** info_hash (hex) → torrent being actively served (status "seeding"). */
  private seeds: Map<string, SeedLookup> = new Map();
  /** taskId → task that has completed and may be seeded (lifecycle tracking). */
  private seedTasks: Map<string, DownloadTask> = new Map();
  /** info_hash (hex) → owning task (for upload accounting + UI refresh). */
  private seedTaskByHash: Map<string, DownloadTask> = new Map();
  /** last DHT announce timestamp per taskId. */
  private lastAnnounce: Map<string, number> = new Map();

  private listenPort = 0;
  private listenersReady = false;
  private tickTimer: number = 0;
  private uiListener: ((task: DownloadTask) => void) | null = null;

  setUiListener(cb: (task: DownloadTask) => void): void {
    this.uiListener = cb;
  }

  private notify(task: DownloadTask | null): void {
    if (task && this.uiListener) {
      this.uiListener(task);
    }
  }

  /** Load settings and bring up the shared listeners (DHT / UPnP / PeerServer). */
  async init(): Promise<void> {
    this.settings = await BtSettingsStore.getInstance().load();
    if (!this.tickTimer) {
      this.tickTimer = setInterval(() => this.tick(), 1000) as unknown as number;
    }
  }

  get port(): number {
    return this.listenPort;
  }

  /**
   * Apply updated settings. Seeding limits take effect on the next tick;
   * when the listen port range or DHT/UPnP toggles changed, the listeners
   * are torn down and re-bound so the new config is live.
   */
  async applySettings(s: BtSettings): Promise<void> {
    const s0 = this.settings;
    const portChanged = !!s0 && (s0.listenPortStart !== s.listenPortStart || s0.listenPortEnd !== s.listenPortEnd);
    const listenerChanged = !!s0 && (s0.enableDht !== s.enableDht || s0.enableUpnp !== s.enableUpnp);
    this.settings = s;
    if (this.listenersReady && (portChanged || listenerChanged)) {
      this.dht?.stop();
      this.peerServer?.stop();
      this.dht = null;
      this.peerServer = null;
      this.upnp = null;
      this.listenersReady = false;
      await this.ensureListeners();
    }
  }

  get isReady(): boolean {
    return this.listenersReady;
  }

  get dhtNodeCount(): number {
    return this.dht?.nodeCount ?? 0;
  }

  /** Start DHT + PeerServer + UPnP on an available port from the settings range. */
  async ensureListeners(): Promise<void> {
    if (this.listenersReady) {
      return;
    }
    const s = this.settings ?? (await BtSettingsStore.getInstance().load());
    this.settings = s;
    const start = s.listenPortStart;
    const end = Math.max(s.listenPortEnd, s.listenPortStart);
    for (let port = start; port <= end; port++) {
      const ok = await this.tryBind(port, s);
      if (ok) {
        this.listenPort = port;
        this.listenersReady = true;
        // UPnP is best-effort; ignore failures.
        if (s.enableUpnp) {
          this.upnp = new UpnpPortMapper();
          this.upnp.mapPort(port).catch(() => {});
        }
        console.info(`FluxDown Cover BtEngine listening on port ${port} (DHT=${s.enableDht}, UPnP=${s.enableUpnp})`);
        return;
      }
    }
    logCollector.warn('Warn', 'FluxDown Cover BtEngine: could not bind any listen port; BT seeding disabled');
  }

  private async tryBind(port: number, s: BtSettings): Promise<boolean> {
    // PeerServer (TCP inbound)
    const peerServer = new PeerServer(this.peerId, (hex) => this.seeds.get(hex) ?? null, {
      uploadSpeedLimit: s.limits.uploadLimit,
      onUpload: (hex, bytes) => this.onUploaded(hex, bytes)
    });
    const tcpOk = await peerServer.start(port);
    if (!tcpOk) {
      return false;
    }
    this.peerServer = peerServer;

    // DHT (UDP) — shares the same port number.
    if (s.enableDht) {
      try {
        this.dht = new Dht();
        await this.dht.start(port);
      } catch (e) {
        logCollector.warn('Warn', `FluxDown Cover DHT failed to start: ${(e as Error).message}`);
        this.dht = null;
      }
    }
    return true;
  }

  /** Discover peers via trackers and (if enabled) the DHT. */
  async discoverPeers(meta: TorrentMeta, ctrl: Ctrl, onPeer?: (p: Peer) => void): Promise<Peer[]> {
    await this.ensureListeners();
    const all: Map<string, Peer> = new Map();
    const add = (p: Peer) => {
      const key = `${p.ip}:${p.port}`;
      if (p.port > 0 && !all.has(key)) {
        all.set(key, p);
        onPeer?.(p);
      }
    };

    // Trackers (merged global + torrent-embedded list)
    const trackerUrls = await this.trackerManager.getTrackers(meta);
    const left = meta.totalLength;
    const trackerPromise = (async () => {
      try {
        const result = await announceAny(trackerUrls, meta, this.peerId, this.listenPort || 6881, 0, 0, left);
        for (const p of result.peers) {
          add(p);
        }
      } catch (_) {
        // no tracker peers — fine
      }
    })();

    // DHT
    const dhtPromise = (async () => {
      if (this.dht && !ctrl.aborted) {
        try {
          await this.dht.getPeers(meta.infoHash, add, ctrl);
        } catch (_) {
          // DHT failed
        }
      }
    })();

    await Promise.allSettled([trackerPromise, dhtPromise]);
    return Array.from(all.values());
  }

  /** Called by BittorrentProtocol after a download completes. */
  async onDownloadComplete(task: DownloadTask, meta: TorrentMeta, pieceManager: PieceManager): Promise<void> {
    if (!this.settings) {
      this.settings = await BtSettingsStore.getInstance().load();
    }
    // Ensure the piece manager reports all pieces as complete (so we can serve).
    pieceManager.loadExistingProgress();
    this.seedTasks.set(task.id, task);
    this.seedTaskByHash.set(meta.infoHashHex, task);
    this.registerTaskMeta(task.id, meta, pieceManager);

    if (!this.settings.seedEnabled) {
      task.seedingStatus = 'userStopped';
      this.notify(task);
      return;
    }
    // Enforce maxActive: count already-seeding tasks.
    const active = this.countSeeding();
    if (this.settings.limits.maxActive > 0 && active >= this.settings.limits.maxActive) {
      this.seedingManager.queueSeeding(task);
      this.notify(task);
      return;
    }
    this.beginSeeding(task, meta, pieceManager);
  }

  /** Begin actively seeding a completed torrent. */
  beginSeeding(task: DownloadTask, meta: TorrentMeta, pieceManager: PieceManager): void {
    this.seeds.set(meta.infoHashHex, { meta, pieceManager });
    this.seedingManager.startSeeding(task);
    this.lastAnnounce.set(task.id, Date.now());
    // Announce our presence to the DHT so others can find us.
    if (this.dht) {
      this.dht.announce(meta.infoHash, this.listenPort, undefined).catch(() => {});
    }
    this.notify(task);
    console.info(`FluxDown Cover: started seeding ${meta.name} (${meta.infoHashHex.substring(0, 8)})`);
  }

  /**
   * User-initiated seeding for a completed BT task whose meta/pieces are
   * already registered (e.g. resumed after "停止做种" or a re-seed request).
   */
  startSeeding(task: DownloadTask): void {
    if (task.protocol !== ProtocolType.BITTORRENT || task.status !== TaskStatus.Completed) {
      return;
    }
    const resolved = this.resolveMetaForTask(task);
    if (!resolved) {
      return;
    }
    this.seedTasks.set(task.id, task);
    this.seedTaskByHash.set(resolved.meta.infoHashHex, task);
    this.registerTaskMeta(task.id, resolved.meta, resolved.pieceManager);
    this.beginSeeding(task, resolved.meta, resolved.pieceManager);
  }

  /** Resolve stored meta + piece manager for a task, if still available. */
  private resolveMetaForTask(task: DownloadTask): { meta: TorrentMeta; pieceManager: PieceManager } | null {
    const meta = this.findMetaForTask(task.id);
    const pm = this.pieceManagerByTask.get(task.id);
    if (meta && pm) {
      return { meta, pieceManager: pm };
    }
    return null;
  }

  /** Stop seeding a task (user pause / limit reached / removal). */
  stopSeeding(task: DownloadTask, reason: string = 'userStopped'): void {
    const meta = this.findMetaForTask(task.id);
    if (meta) {
      this.seeds.delete(meta.infoHashHex);
    }
    if (task.seedingStatus === 'seeding' || task.seedingStatus === 'queued') {
      this.seedingManager.stopSeeding(task, reason);
    }
    this.lastAnnounce.delete(task.id);
    this.notify(task);
  }

  /** Fully remove a seed (on task deletion): unregister + close the piece file. */
  removeSeed(task: DownloadTask): void {
    const meta = this.findMetaForTask(task.id);
    if (meta) {
      this.seeds.delete(meta.infoHashHex);
      this.seedTaskByHash.delete(meta.infoHashHex);
    }
    this.seedingManager.stopSeeding(task, 'deleted');
    const pm = this.pieceManagerByTask.get(task.id);
    if (pm) {
      try {
        pm.closeFile();
      } catch (_) {
        // already closed
      }
    }
    this.seedTasks.delete(task.id);
    this.metaByTask.delete(task.id);
    this.pieceManagerByTask.delete(task.id);
    this.lastAnnounce.delete(task.id);
    this.notify(task);
  }

  /** Resume auto-seeding for already-completed BT tasks (called on app start). */
  resumeAllSeeds(tasks: DownloadTask[], resolveMeta: (task: DownloadTask) => { meta: TorrentMeta; pieceManager: PieceManager } | null): void {
    if (!this.settings?.seedEnabled || !this.settings.autoReseed) {
      return;
    }
    for (const task of tasks) {
      if (task.protocol !== ProtocolType.BITTORRENT) {
        continue;
      }
      const resolved = resolveMeta(task);
      if (!resolved) {
        continue;
      }
      // skip multi-file .tar handling differences; just serve the completed file
      this.seedTasks.set(task.id, task);
      this.seedTaskByHash.set(resolved.meta.infoHashHex, task);
      this.registerTaskMeta(task.id, resolved.meta, resolved.pieceManager);
      const active = this.countSeeding();
      if (this.settings.limits.maxActive > 0 && active >= this.settings.limits.maxActive) {
        this.seedingManager.queueSeeding(task);
      } else {
        this.beginSeeding(task, resolved.meta, resolved.pieceManager);
      }
    }
  }

  /** Apply a new upload speed limit to the live peer server. */
  applyUploadLimit(limit: number): void {
    this.peerServer?.setUploadSpeedLimit(limit);
  }

  // ── Internals ───────────────────────────────────────────────────────────

  private onUploaded(infoHashHex: string, bytes: number): void {
    const task = this.seedTaskByHash.get(infoHashHex);
    if (!task) {
      return;
    }
    this.seedingManager.onUploaded(task, bytes);
    this.notify(task);
  }

  private countSeeding(): number {
    let n = 0;
    for (const t of this.seedTasks.values()) {
      if (t.seedingStatus === 'seeding') {
        n++;
      }
    }
    return n;
  }

  private findMetaForTask(taskId: string): TorrentMeta | null {
    // Reverse lookup via seedTaskByHash is by hash; we keep a parallel map.
    const entry = this.metaByTask.get(taskId);
    return entry ?? null;
  }

  /** taskId → TorrentMeta (for stopSeeding reverse lookup). */
  private metaByTask: Map<string, TorrentMeta> = new Map();

  private tick(): void {
    if (!this.settings) {
      return;
    }
    const now = Date.now();
    const maxActive = this.settings.limits.maxActive;
    for (const task of Array.from(this.seedTasks.values())) {
      if (task.seedingStatus === 'seeding') {
        // Periodic DHT re-announce (every 30 min) to stay discoverable.
        const last = this.lastAnnounce.get(task.id) ?? 0;
        if (this.dht && now - last > 30 * 60 * 1000) {
          const meta = this.metaByTask.get(task.id);
          if (meta) {
            this.dht.announce(meta.infoHash, this.listenPort, undefined).catch(() => {});
            this.lastAnnounce.set(task.id, now);
          }
        }
        const verdict = this.seedingManager.tick(task, this.settings, now);
        if (verdict.stop) {
          const meta = this.metaByTask.get(task.id);
          if (meta) {
            this.seeds.delete(meta.infoHashHex);
          }
          this.seedingManager.stopSeeding(task, verdict.reason);
          this.lastAnnounce.delete(task.id);
          this.notify(task);
        }
      } else if (task.seedingStatus === 'queued') {
        // Promote to seeding if a slot is free.
        if (maxActive <= 0 || this.countSeeding() < maxActive) {
          const meta = this.metaByTask.get(task.id);
          const pm = this.pieceManagerByTask.get(task.id);
          if (meta && pm) {
            this.beginSeeding(task, meta, pm);
          }
        }
      }
    }
  }

  /** taskId → PieceManager (for re-announce + queued promotion). */
  private pieceManagerByTask: Map<string, PieceManager> = new Map();

  /** Register the meta+pieceManager for a task (so tick/reverse-lookup works). */
  registerTaskMeta(taskId: string, meta: TorrentMeta, pieceManager: PieceManager): void {
    this.metaByTask.set(taskId, meta);
    this.pieceManagerByTask.set(taskId, pieceManager);
  }

  /** Refresh tracker subscriptions (best-effort). */
  async refreshTrackers(): Promise<number> {
    return this.trackerManager.refreshSubscriptions();
  }
}
