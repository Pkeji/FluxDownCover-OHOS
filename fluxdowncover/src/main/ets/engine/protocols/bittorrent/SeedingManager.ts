import { DownloadTask } from '../../../model/DownloadTask';
import { BtSettings, SeedLimits, SeedConditionOperator, SeedLimitsMode } from '../../../store/BtSettingsStore';

/**
 * Evaluates per-task seeding limits and drives the seeding status state
 * machine. The live counters (uploadedBytes / seedRatio / seedSeconds /
 * seedingStatus) live on the DownloadTask so they persist and drive the UI.
 *
 * Limit model (mirrors FluxDown 0.4.7):
 *   - ratioLimit       : stop when total uploaded/downloaded ≥ this ratio
 *   - postRatioLimit   : stop when ratio gained *since seeding started* ≥ this
 *   - timeLimitSec     : stop after this many accumulated seeding seconds
 *   - inactiveTimeSec  : stop after this many seconds with no uploads
 *   - operator         : AND (all must hold) / OR (any holds)
 *   - maxActive        : enforced by BtEngine (concurrent seed cap) — not here
 *
 * A limit value of 0 means "do not limit on this axis".
 */
export class SeedingManager {
  // Per-session bookkeeping (not persisted; derived from task fields on restart).
  private seedSecondsBase: Map<string, number> = new Map();
  private lastUploadAt: Map<string, number> = new Map();

  /** Begin a seeding session for a task. */
  startSeeding(task: DownloadTask): void {
    this.seedSecondsBase.set(task.id, task.seedSeconds);
    this.sessionBaseUploadMap.set(task.id, task.uploadedBytes);
    this.lastUploadAt.set(task.id, Date.now());
    task.seedStartedAt = Date.now();
    task.seedingStatus = 'seeding';
    this.recomputeRatio(task);
  }

  /** End a seeding session, folding the current session into the totals. */
  stopSeeding(task: DownloadTask, reason: string): void {
    const now = Date.now();
    this.foldSeconds(task, now);
    this.seedSecondsBase.delete(task.id);
    this.lastUploadAt.delete(task.id);
    task.seedStartedAt = 0;
    task.seedingStatus = reason;
  }

  /** Queue a task for seeding (waiting for an active slot from BtEngine). */
  queueSeeding(task: DownloadTask): void {
    if (task.seedingStatus === 'none' || task.seedingStatus === 'userStopped') {
      task.seedingStatus = 'queued';
    }
  }

  /** Record uploaded bytes from an inbound peer (updates ratio + inactive timer). */
  onUploaded(task: DownloadTask, bytes: number): void {
    task.uploadedBytes += bytes;
    this.lastUploadAt.set(task.id, Date.now());
    this.recomputeRatio(task);
  }

  /** Periodic tick: refresh live seconds + ratio and check whether to stop. */
  tick(task: DownloadTask, settings: BtSettings, now: number): { stop: boolean; reason: string } {
    if (task.seedingStatus !== 'seeding') {
      return { stop: false, reason: '' };
    }
    this.foldSeconds(task, now);
    this.recomputeRatio(task);
    return this.evaluate(task, settings.limits);
  }

  /** Recompute the share ratio from uploaded / downloaded. */
  recomputeRatio(task: DownloadTask): void {
    task.seedRatio = task.downloadedBytes > 0 ? task.uploadedBytes / task.downloadedBytes : 0;
  }

  /** Fold the in-progress session delta into the accumulated seedSeconds. */
  private foldSeconds(task: DownloadTask, now: number): void {
    const base = this.seedSecondsBase.get(task.id) ?? task.seedSeconds;
    if (task.seedStartedAt > 0) {
      const delta = Math.floor((now - task.seedStartedAt) / 1000);
      task.seedSeconds = base + Math.max(0, delta);
    } else {
      task.seedSeconds = base;
    }
  }

  /**
   * Evaluate the configured limits.
   * Returns { stop:true, reason } when a stop condition is met.
   */
  evaluate(task: DownloadTask, limits: SeedLimits): { stop: boolean; reason: string } {
    if (limits.mode === SeedLimitsMode.Unlimited) {
      return { stop: false, reason: '' };
    }
    // All-zero limits → effectively unlimited.
    const anyLimit =
      limits.ratioLimit > 0 ||
      limits.postRatioLimit > 0 ||
      limits.timeLimitSec > 0 ||
      limits.inactiveTimeSec > 0;
    if (!anyLimit) {
      return { stop: false, reason: '' };
    }

    const now = Date.now();
    const baseRatio = task.downloadedBytes > 0 ? task.uploadedBytes / task.downloadedBytes : 0;
    const postStartUploaded = task.uploadedBytes; // session-relative approximation
    const sessionBaseUpload = this.sessionBaseUpload(task.id);
    const postRatio = task.downloadedBytes > 0 ? (postStartUploaded - sessionBaseUpload) / task.downloadedBytes : 0;
    const inactiveSec = this.lastUploadAt.has(task.id) ? Math.floor((now - (this.lastUploadAt.get(task.id) as number)) / 1000) : 0;

    const conditions: { met: boolean; reason: string }[] = [];
    if (limits.ratioLimit > 0) {
      conditions.push({ met: baseRatio >= limits.ratioLimit, reason: 'ratioReached' });
    }
    if (limits.postRatioLimit > 0) {
      conditions.push({ met: postRatio >= limits.postRatioLimit, reason: 'ratioReached' });
    }
    if (limits.timeLimitSec > 0) {
      conditions.push({ met: task.seedSeconds >= limits.timeLimitSec, reason: 'timeReached' });
    }
    if (limits.inactiveTimeSec > 0) {
      conditions.push({ met: inactiveSec >= limits.inactiveTimeSec, reason: 'inactiveReached' });
    }

    if (conditions.length === 0) {
      return { stop: false, reason: '' };
    }
    if (limits.operator === SeedConditionOperator.AND) {
      const allMet = conditions.every((c) => c.met);
      if (allMet) {
        return { stop: true, reason: conditions[0].reason };
      }
    } else {
      const hit = conditions.find((c) => c.met);
      if (hit) {
        return { stop: true, reason: hit.reason };
      }
    }
    return { stop: false, reason: '' };
  }

  /** Track uploaded bytes at the moment seeding started (for postRatio). */
  private sessionBaseUploadMap: Map<string, number> = new Map();
  private sessionBaseUpload(taskId: string): number {
    return this.sessionBaseUploadMap.get(taskId) ?? 0;
  }
}
