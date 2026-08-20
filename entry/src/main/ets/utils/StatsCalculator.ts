import { DownloadTask } from '../model/DownloadTask';
import { TaskStatus } from '../model/TaskStatus';
import { formatBytes, formatSpeed } from './common';

/**
 * Download statistics aggregator.
 * Ported from FluxDown's analytics dashboard — computes summary metrics
 * across all tasks for display in the Stats tab.
 */
export interface DownloadStats {
  totalTasks: number;
  activeCount: number;
  completedCount: number;
  pausedCount: number;
  errorCount: number;
  totalDownloaded: number; // bytes
  totalSize: number; // bytes
  currentSpeed: number; // bytes/sec (sum of active)
  avgSpeed: number; // bytes/sec (historical average)
  completionRate: number; // 0-100
  estimatedTimeRemaining: number; // seconds (-1 if unknown)
}

export class StatsCalculator {
  static compute(tasks: DownloadTask[]): DownloadStats {
    let activeCount = 0;
    let completedCount = 0;
    let pausedCount = 0;
    let errorCount = 0;
    let totalDownloaded = 0;
    let totalSize = 0;
    let currentSpeed = 0;
    let speedSum = 0;
    let speedCount = 0;

    for (const t of tasks) {
      totalDownloaded += t.downloadedBytes;
      totalSize += t.totalBytes;
      switch (t.status) {
        case TaskStatus.Downloading:
          activeCount++;
          currentSpeed += t.speed;
          if (t.speed > 0) { speedSum += t.speed; speedCount++; }
          break;
        case TaskStatus.Completed:
          completedCount++;
          break;
        case TaskStatus.Paused:
          pausedCount++;
          break;
        case TaskStatus.Error:
          errorCount++;
          break;
        default:
          break;
      }
    }

    const avgSpeed = speedCount > 0 ? speedSum / speedCount : 0;
    const completionRate = totalSize > 0 ? (totalDownloaded / totalSize) * 100 : 0;
    const remaining = totalSize - totalDownloaded;
    const estimatedTimeRemaining = currentSpeed > 0 && remaining > 0 ? remaining / currentSpeed : -1;

    return {
      totalTasks: tasks.length,
      activeCount,
      completedCount,
      pausedCount,
      errorCount,
      totalDownloaded,
      totalSize,
      currentSpeed,
      avgSpeed,
      completionRate,
      estimatedTimeRemaining,
    };
  }

  static formatStats(stats: DownloadStats): Record<string, string> {
    return {
      '总任务数': `${stats.totalTasks}`,
      '下载中': `${stats.activeCount}`,
      '已完成': `${stats.completedCount}`,
      '已暂停': `${stats.pausedCount}`,
      '错误': `${stats.errorCount}`,
      '已下载': formatBytes(stats.totalDownloaded),
      '总大小': formatBytes(stats.totalSize),
      '当前速度': formatSpeed(stats.currentSpeed),
      '平均速度': formatSpeed(stats.avgSpeed),
      '完成率': `${stats.completionRate.toFixed(1)}%`,
      '预计剩余': stats.estimatedTimeRemaining > 0 ? `${Math.ceil(stats.estimatedTimeRemaining)}秒` : '未知',
    };
  }
}
