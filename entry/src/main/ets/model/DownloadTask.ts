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
  @Trace errorMessage: string = '';
  @Trace sha256: string = '';
  @Trace finishedAt: number = 0;
  @Trace createdAt: number = 0;

  // ── Extended fields (FluxDown feature parity) ──
  @Trace category: string = '默认'; // task category/tag for grouping & filtering
  @Trace priority: number = 0; // higher = started first (0 = normal)
  @Trace queueId: string = ''; // associated named-queue ID (empty = none)
  @Trace speedLimit: number = 0; // per-task speed limit in bytes/sec (0 = unlimited)
  @Trace scheduledAt: number = 0; // scheduled start timestamp (0 = immediate)
  @Trace authHeader: string = ''; // HTTP Authorization header for protected downloads
  @Trace proxyUrl: string = ''; // per-task proxy URL (empty = use global)

  // Non-observed state
  segments: Segment[] = [];
  isHls: boolean = false;
  isDash: boolean = false; // DASH (MPD) streaming flag
  liveBytes: number = 0; // high-frequency accumulator updated per chunk
  verifyIntegrity: boolean = true;

  get percent(): number {
    if (this.totalBytes <= 0) {
      return this.status === TaskStatus.Completed ? 100 : 0;
    }
    return Math.min(100, Math.floor((this.downloadedBytes / this.totalBytes) * 100));
  }
}
