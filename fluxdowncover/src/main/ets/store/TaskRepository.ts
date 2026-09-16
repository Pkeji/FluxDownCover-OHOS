import { relationalStore } from '@kit.ArkData';
import { BusinessError } from '@kit.BasicServicesKit';
import { DatabaseManager, TABLE_NAME } from './DatabaseManager';
import { DownloadTask } from '../model/DownloadTask';
import { TaskStatus } from '../model/TaskStatus';
import { ProtocolType } from '../model/ProtocolType';

/**
 * CRUD mapping between DownloadTask objects and the relational store.
 * Segment progress is stored as JSON so per-segment resume works.
 */
export class TaskRepository {
  private db = DatabaseManager.getInstance();

  private get store(): relationalStore.RdbStore | null {
    return this.db.getStore();
  }

  private columns(): string[] {
    return [
      'id', 'url', 'fileName', 'dirPath', 'filePath', 'protocol', 'totalBytes',
      'downloadedBytes', 'status', 'segments', 'createdAt', 'finishedAt',
      'errorMessage', 'sha256', 'isHls', 'verifyIntegrity',
      'category', 'priority', 'queueId', 'speedLimit', 'scheduledAt', 'authHeader', 'proxyUrl', 'isDash',
      'uploadedBytes', 'seedRatio', 'seedingStatus', 'seedStartedAt', 'seedSeconds', 'manifestInitUrl'
    ];
  }

  async insert(task: DownloadTask): Promise<void> {
    const s = this.store;
    if (!s) {
      return;
    }
    try {
      await s.insert(TABLE_NAME, this.toValues(task));
    } catch (e) {
      console.warn(`[TaskRepository] insert failed: ${(e as Error)?.message ?? e}`);
    }
  }

  async update(task: DownloadTask): Promise<void> {
    const s = this.store;
    if (!s) {
      return;
    }
    try {
      const pred = new relationalStore.RdbPredicates(TABLE_NAME);
      pred.equalTo('id', task.id);
      await s.update(this.toValues(task), pred);
    } catch (e) {
      console.warn(`[TaskRepository] update failed: ${(e as Error)?.message ?? e}`);
    }
  }

  async delete(id: string): Promise<void> {
    const s = this.store;
    if (!s) {
      return;
    }
    try {
      const pred = new relationalStore.RdbPredicates(TABLE_NAME);
      pred.equalTo('id', id);
      await s.delete(pred);
    } catch (e) {
      console.warn(`[TaskRepository] delete failed: ${(e as Error)?.message ?? e}`);
    }
  }

  async queryAll(): Promise<DownloadTask[]> {
    const s = this.store;
    if (!s) {
      return [];
    }
    let rs: relationalStore.ResultSet | null = null;
    try {
      const pred = new relationalStore.RdbPredicates(TABLE_NAME);
      rs = await s.query(pred, this.columns());
      const list: DownloadTask[] = [];
      while (rs.goToNextRow()) {
        list.push(this.fromRow(rs));
      }
      return list;
    } catch (e) {
      console.warn(`[TaskRepository] queryAll failed: ${(e as Error)?.message ?? e}`);
      return [];
    } finally {
      try { rs?.close(); } catch (_e) { }
    }
  }

  private toValues(task: DownloadTask): relationalStore.ValuesBucket {
    return {
      id: task.id,
      url: task.url,
      fileName: task.fileName,
      dirPath: task.dirPath,
      filePath: task.filePath,
      protocol: task.protocol,
      totalBytes: task.totalBytes,
      downloadedBytes: task.downloadedBytes,
      status: task.status,
      segments: JSON.stringify(task.segments),
      createdAt: task.createdAt,
      finishedAt: task.finishedAt,
      errorMessage: task.errorMessage,
      sha256: task.sha256,
      isHls: task.isHls ? 1 : 0,
      verifyIntegrity: task.verifyIntegrity ? 1 : 0,
      category: task.category,
      priority: task.priority,
      queueId: task.queueId,
      speedLimit: task.speedLimit,
      scheduledAt: task.scheduledAt,
      authHeader: task.authHeader,
      proxyUrl: task.proxyUrl,
      isDash: task.isDash ? 1 : 0,
      uploadedBytes: task.uploadedBytes,
      seedRatio: task.seedRatio,
      seedingStatus: task.seedingStatus,
      seedStartedAt: task.seedStartedAt,
      seedSeconds: task.seedSeconds,
      manifestInitUrl: task.manifestInitUrl
    };
  }

  private fromRow(rs: relationalStore.ResultSet): DownloadTask {
    const task = new DownloadTask();
    // 安全读取：缺列/坏数据/迁移行都不致崩溃；helper 内部消化异常，调用处不再向上抛（满足 ArkTS 显式异常处理）
    const idx = (name: string): number => {
      try {
        return rs.getColumnIndex(name);
      } catch (_e) {
        return -1;
      }
    };
    const str = (name: string, dft: string = ''): string => {
      try {
        const i = idx(name);
        return i >= 0 ? rs.getString(i) : dft;
      } catch (_e) {
        return dft;
      }
    };
    const lng = (name: string, dft: number = 0): number => {
      try {
        const i = idx(name);
        return i >= 0 ? rs.getLong(i) : dft;
      } catch (_e) {
        return dft;
      }
    };
    const dbl = (name: string, dft: number = 0): number => {
      try {
        const i = idx(name);
        return i >= 0 ? rs.getDouble(i) : dft;
      } catch (_e) {
        return dft;
      }
    };
    task.id = str('id');
    task.url = str('url');
    task.fileName = str('fileName');
    task.dirPath = str('dirPath');
    task.filePath = str('filePath');
    task.protocol = str('protocol') as ProtocolType;
    task.totalBytes = lng('totalBytes');
    task.downloadedBytes = lng('downloadedBytes');
    task.status = str('status') as TaskStatus;
    try {
      task.segments = JSON.parse(str('segments', '[]') || '[]');
    } catch (_e) {
      task.segments = [];
    }
    task.createdAt = lng('createdAt');
    task.finishedAt = lng('finishedAt');
    task.errorMessage = str('errorMessage');
    task.sha256 = str('sha256');
    task.isHls = lng('isHls') === 1;
    task.verifyIntegrity = lng('verifyIntegrity') === 1;
    // 推断 Range 能力：buildSegments 对不支持 Range 的服务器只生成单段，
    // 因而恢复的多段任务必然支持 Range，可用于断点续传后的动态分块。
    task.supportsRanges = task.segments.length > 1;
    // Extended fields (safe-read for migrated rows)
    task.category = str('category', '默认');
    task.priority = lng('priority');
    task.queueId = str('queueId');
    task.speedLimit = lng('speedLimit');
    task.scheduledAt = lng('scheduledAt');
    task.authHeader = str('authHeader');
    task.proxyUrl = str('proxyUrl');
    task.isDash = lng('isDash') === 1;
    // BitTorrent / seeding fields (safe-read for migrated rows)
    task.uploadedBytes = lng('uploadedBytes');
    task.seedRatio = dbl('seedRatio');
    task.seedingStatus = str('seedingStatus', 'none');
    task.seedStartedAt = lng('seedStartedAt');
    task.seedSeconds = lng('seedSeconds');
    task.manifestInitUrl = str('manifestInitUrl');
    task.liveBytes = task.downloadedBytes;
    return task;
  }
}
