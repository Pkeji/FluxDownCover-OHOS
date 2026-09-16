/**
 * Named download queue / task group.
 * Ported from FluxDown Cover's queue system for organizing downloads into groups
 * with priority and concurrent-limit settings.
 */
@ObservedV2
export class DownloadQueue {
  @Trace id: string;
  @Trace name: string;
  @Trace taskIds: string[] = [];
  @Trace maxConcurrent: number = 2; // max simultaneous downloads in this queue
  @Trace priority: number = 0; // higher = started first
  @Trace autoStart: boolean = true; // auto-start queued tasks when slots free
  @Trace createdAt: number = Date.now();
  // ── Queue-level enhancements (FluxDown 0.4.7 "队列设置") ──
  @Trace speedLimit: number = 0; // per-queue download speed cap, bytes/sec (0 = unlimited)
  @Trace startAt: number = 0; // daily auto-start time, minutes since midnight (-1 = disabled)
  @Trace stopAt: number = 0; // daily auto-stop time, minutes since midnight (-1 = disabled)
  @Trace scheduledEnabled: boolean = false; // master switch for daily schedule
  @Trace segments: number = 0; // default segment/thread count for tasks in this queue (0 = global)
  @Trace ua: string = ''; // User-Agent override for this queue ('' = global)
  @Trace saveDir: string = ''; // save directory override for this queue ('' = default)

  constructor(id: string, name: string) {
    this.id = id;
    this.name = name;
  }
}
