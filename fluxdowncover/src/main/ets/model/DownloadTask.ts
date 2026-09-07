import { TaskStatus } from './TaskStatus';
import { ProtocolType } from './ProtocolType';

/**
 * A single download segment (a byte range of the file).
 * For HLS, each segment carries its own media `url` and is appended sequentially.
 */
export interface Segment {
  index: number;
  url?: string; // per-segment URL (HLS); falls back to task.url when undefined
  start: number; // inclusive start offset (also the append offset for HLS)
  end: number; // inclusive end offset; -1 means "until the server ends"
  downloaded: number; // bytes already received within this segment
  done: boolean;
  /** HLS: resolved AES-128 key URI ('' = plaintext segment). */
  keyUri?: string;
  /** HLS: 16-byte IV as hex ('' = derive from media sequence + segment index). */
  keyIv?: string;
  /** Byte sub-range "start-end" within `url` (HLS EXT-X-BYTERANGE / DASH SegmentURL range). */
  byteRange?: string;
}

/**
 * Observable download task. @Trace fields drive ArkUI re-renders automatically.
 * High-frequency counters (liveBytes) are intentionally NOT @Trace to avoid
 * re-rendering on every network chunk; the engine syncs them into the @Trace
 * fields via a throttled ticker.
 */
@ObservedV2
export class DownloadTask {
  @Trace id: string = '';
  @Trace url: string = '';
  @Trace fileName: string = '';
  @Trace dirPath: string = '';
  @Trace filePath: string = '';
  @Trace protocol: ProtocolType = ProtocolType.HTTP;
  @Trace totalBytes: number = 0;
  @Trace downloadedBytes: number = 0;
  @Trace status: TaskStatus = TaskStatus.Pending;
  @Trace speed: number = 0; // bytes/sec (computed)
  @Trace peakSpeed: number = 0; // highest recorded speed
  @Trace publicPath: string = ''; // path after export to public Download
  @Trace errorMessage: string = '';
  @Trace sha256: string = '';
  @Trace finishedAt: number = 0;
  @Trace createdAt: number = 0;

  // ── Extended fields (FluxDown Cover feature parity) ──
  @Trace category: string = '默认'; // task category/tag for grouping & filtering
  @Trace priority: number = 0; // higher = started first (0 = normal)
  @Trace queueId: string = ''; // associated named-queue ID (empty = none)
  @Trace speedLimit: number = 0; // per-task speed limit in bytes/sec (0 = unlimited)
  @Trace scheduledAt: number = 0; // scheduled start timestamp (0 = immediate)
  @Trace authHeader: string = ''; // HTTP Authorization header for protected downloads
  @Trace proxyUrl: string = ''; // per-task proxy URL (empty = use global)

  // ── BitTorrent / seeding fields (FluxDown 0.4.7 parity) ──
  @Trace uploadedBytes: number = 0; // bytes uploaded to peers (BT only)
  @Trace seedRatio: number = 0; // uploaded / downloaded ratio (BT only)
  @Trace seedingStatus: string = 'none'; // none|queued|seeding|ratioReached|timeReached|inactiveReached|userStopped|deleted|sessionReleased
  @Trace seedStartedAt: number = 0; // timestamp when current seeding session began (0 = not seeding)
  @Trace seedSeconds: number = 0; // accumulated seeding seconds across sessions
  @Trace connectedPeers: number = 0; // currently connected peer count (BT only)
  @Trace totalPeers: number = 0; // known/available peer count (BT only)

  // Non-observed state
  segments: Segment[] = [];
  isHls: boolean = false;
  isDash: boolean = false; // DASH (MPD) streaming flag
  liveBytes: number = 0; // high-frequency accumulator updated per chunk
  verifyIntegrity: boolean = true;
  hlsQualityIndex: number = -1; // selected master-playlist variant (-1 = auto/highest)
  retryCount: number = 0; // consecutive auto-retry attempts for this task (in-memory)
  serverMtime: number = 0; // Last-Modified from server probe (ms epoch, 0 = unknown)
  ua: string = ''; // per-task User-Agent override ('' = engine default)
  segmentCount: number = 0; // per-task segment count (0 = engine default)
  cookie: string = ''; // per-task Cookie header value
  referer: string = ''; // per-task Referer header value
  customHeaders: string = ''; // per-task custom headers, one "Key: Value" per line
  manifestInitUrl: string = ''; // HLS EXT-X-MAP / DASH Initialization segment URL (persisted)

  get percent(): number {
    if (this.totalBytes <= 0) {
      return this.status === TaskStatus.Completed ? 100 : 0;
    }
    return Math.min(100, Math.floor((this.downloadedBytes / this.totalBytes) * 100));
  }
}
