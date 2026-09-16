import { relationalStore } from '@kit.ArkData';
import { DatabaseManager } from './DatabaseManager';
import { DownloadQueue } from '../model/DownloadQueue';

const QUEUE_TABLE = 'download_queues';

/**
 * SQLite persistence for download queues.
 * Stores queue metadata and associated task IDs as JSON.
 * 所有数据库调用均在方法内显式消化异常（满足 ArkTS 异常处理规范），失败不致应用崩溃。
 */
export class QueueStore {
  private db = DatabaseManager.getInstance();

  private get store(): relationalStore.RdbStore | null {
    return this.db.getStore();
  }

  async ensureTable(): Promise<void> {
    const s = this.store;
    if (!s) return;
    const sql = `CREATE TABLE IF NOT EXISTS ${QUEUE_TABLE} (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      taskIds TEXT NOT NULL DEFAULT '[]',
      maxConcurrent INTEGER NOT NULL DEFAULT 2,
      priority INTEGER NOT NULL DEFAULT 0,
      autoStart INTEGER NOT NULL DEFAULT 1,
      createdAt INTEGER NOT NULL DEFAULT 0,
      speedLimit INTEGER NOT NULL DEFAULT 0,
      startAt INTEGER NOT NULL DEFAULT 0,
      stopAt INTEGER NOT NULL DEFAULT 0,
      scheduledEnabled INTEGER NOT NULL DEFAULT 0
    )`;
    try {
      await s.executeSql(sql);
    } catch (e) {
      console.warn(`[QueueStore] create table failed: ${(e as Error)?.message ?? e}`);
    }
    // Migrate older tables (add columns if missing).
    const migrations = [
      `ALTER TABLE ${QUEUE_TABLE} ADD COLUMN speedLimit INTEGER NOT NULL DEFAULT 0`,
      `ALTER TABLE ${QUEUE_TABLE} ADD COLUMN startAt INTEGER NOT NULL DEFAULT 0`,
      `ALTER TABLE ${QUEUE_TABLE} ADD COLUMN stopAt INTEGER NOT NULL DEFAULT 0`,
      `ALTER TABLE ${QUEUE_TABLE} ADD COLUMN scheduledEnabled INTEGER NOT NULL DEFAULT 0`,
      `ALTER TABLE ${QUEUE_TABLE} ADD COLUMN segments INTEGER NOT NULL DEFAULT 0`,
      `ALTER TABLE ${QUEUE_TABLE} ADD COLUMN ua TEXT NOT NULL DEFAULT ''`,
      `ALTER TABLE ${QUEUE_TABLE} ADD COLUMN saveDir TEXT NOT NULL DEFAULT ''`,
    ];
    for (const m of migrations) {
      await s.executeSql(m).catch(() => { /* column already exists */ });
    }
  }

  async insert(queue: DownloadQueue): Promise<void> {
    const s = this.store;
    if (!s) return;
    try {
      const values: relationalStore.ValuesBucket = {
        'id': queue.id,
        'name': queue.name,
        'taskIds': JSON.stringify(queue.taskIds),
        'maxConcurrent': queue.maxConcurrent,
        'priority': queue.priority,
        'autoStart': queue.autoStart ? 1 : 0,
        'createdAt': queue.createdAt,
        'speedLimit': queue.speedLimit,
        'startAt': queue.startAt,
        'stopAt': queue.stopAt,
        'scheduledEnabled': queue.scheduledEnabled ? 1 : 0,
        'segments': queue.segments,
        'ua': queue.ua,
        'saveDir': queue.saveDir,
      };
      await s.insert(QUEUE_TABLE, values);
    } catch (e) {
      console.warn(`[QueueStore] insert failed: ${(e as Error)?.message ?? e}`);
    }
  }

  async update(queue: DownloadQueue): Promise<void> {
    const s = this.store;
    if (!s) return;
    try {
      const values: relationalStore.ValuesBucket = {
        'name': queue.name,
        'taskIds': JSON.stringify(queue.taskIds),
        'maxConcurrent': queue.maxConcurrent,
        'priority': queue.priority,
        'autoStart': queue.autoStart ? 1 : 0,
        'speedLimit': queue.speedLimit,
        'startAt': queue.startAt,
        'stopAt': queue.stopAt,
        'scheduledEnabled': queue.scheduledEnabled ? 1 : 0,
        'segments': queue.segments,
        'ua': queue.ua,
        'saveDir': queue.saveDir,
      };
      const pred = new relationalStore.RdbPredicates(QUEUE_TABLE);
      pred.equalTo('id', queue.id);
      await s.update(values, pred);
    } catch (e) {
      console.warn(`[QueueStore] update failed: ${(e as Error)?.message ?? e}`);
    }
  }

  async delete(id: string): Promise<void> {
    const s = this.store;
    if (!s) return;
    try {
      const pred = new relationalStore.RdbPredicates(QUEUE_TABLE);
      pred.equalTo('id', id);
      await s.delete(pred);
    } catch (e) {
      console.warn(`[QueueStore] delete failed: ${(e as Error)?.message ?? e}`);
    }
  }

  async queryAll(): Promise<DownloadQueue[]> {
    const s = this.store;
    if (!s) return [];
    let rs: relationalStore.ResultSet | null = null;
    try {
      const pred = new relationalStore.RdbPredicates(QUEUE_TABLE);
      pred.orderByDesc('priority');
      rs = await s.query(pred, ['id', 'name', 'taskIds', 'maxConcurrent', 'priority', 'autoStart', 'createdAt', 'speedLimit', 'startAt', 'stopAt', 'scheduledEnabled', 'segments', 'ua', 'saveDir']);
      // 安全读取 helper：缺列/坏数据不崩，且内部消化异常
      const idx = (name: string): number => {
        try {
          return rs!.getColumnIndex(name);
        } catch (_e) {
          return -1;
        }
      };
      const str = (name: string, dft: string = ''): string => {
        try {
          const i = idx(name);
          return i >= 0 ? rs!.getString(i) : dft;
        } catch (_e) {
          return dft;
        }
      };
      const lng = (name: string, dft: number = 0): number => {
        try {
          const i = idx(name);
          return i >= 0 ? rs!.getLong(i) : dft;
        } catch (_e) {
          return dft;
        }
      };
      const queues: DownloadQueue[] = [];
      while (rs.goToNextRow()) {
        const q = new DownloadQueue(str('id'), str('name'));
        try {
          q.taskIds = JSON.parse(str('taskIds', '[]')) as string[];
        } catch (_e) {
          q.taskIds = [];
        }
        q.maxConcurrent = lng('maxConcurrent', 2);
        q.priority = lng('priority');
        q.autoStart = lng('autoStart', 1) === 1;
        q.createdAt = lng('createdAt');
        q.speedLimit = lng('speedLimit');
        q.startAt = lng('startAt');
        q.stopAt = lng('stopAt');
        q.scheduledEnabled = lng('scheduledEnabled') === 1;
        q.segments = lng('segments');
        q.ua = str('ua');
        q.saveDir = str('saveDir');
        queues.push(q);
      }
      return queues;
    } catch (e) {
      console.warn(`[QueueStore] queryAll failed: ${(e as Error)?.message ?? e}`);
      return [];
    } finally {
      try { rs?.close(); } catch (_e) { }
    }
  }
}
