/**
 * Named download queue / task group.
 * Ported from FluxDown's queue system for organizing downloads into groups
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

  constructor(id: string, name: string) {
    this.id = id;
    this.name = name;
  }
}
