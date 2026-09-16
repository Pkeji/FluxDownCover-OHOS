import { relationalStore } from '@kit.ArkData';
import { DatabaseManager } from './DatabaseManager';
import { DownloadQueue } from '../model/DownloadQueue';
import { genId } from '../utils/common';

const QUEUE_TABLE = 'download_queues';

/**
 * SQLite persistence for download queues.
 * Stores queue metadata and associated task IDs as JSON.
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
    await s.executeSql(sql);
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
  }

  async update(queue: DownloadQueue): Promise<void> {
    const s = this.store;
    if (!s) return;
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
  }

  async delete(id: string): Promise<void> {
    const s = this.store;
    if (!s) return;
    const pred = new relationalStore.RdbPredicates(QUEUE_TABLE);
    pred.equalTo('id', id);
    await s.delete(pred);
  }

  async queryAll(): Promise<DownloadQueue[]> {
    const s = this.store;
    if (!s) return [];
    const pred = new relationalStore.RdbPredicates(QUEUE_TABLE);
    pred.orderByDesc('priority');
    const rs = await s.query(pred, ['id', 'name', 'taskIds', 'maxConcurrent', 'priority', 'autoStart', 'createdAt', 'speedLimit', 'startAt', 'stopAt', 'scheduledEnabled', 'segments', 'ua', 'saveDir']);
    const queues: DownloadQueue[] = [];
    while (rs.goToNextRow()) {
      const q = new DownloadQueue(rs.getString(rs.getColumnIndex('id')), rs.getString(rs.getColumnIndex('name')));
      q.taskIds = JSON.parse(rs.getString(rs.getColumnIndex('taskIds'))) as string[];
      q.maxConcurrent = rs.getLong(rs.getColumnIndex('maxConcurrent'));
      q.priority = rs.getLong(rs.getColumnIndex('priority'));
      q.autoStart = rs.getLong(rs.getColumnIndex('autoStart')) === 1;
      q.createdAt = rs.getLong(rs.getColumnIndex('createdAt'));
      q.speedLimit = rs.getLong(rs.getColumnIndex('speedLimit'));
      q.startAt = rs.getLong(rs.getColumnIndex('startAt'));
      q.stopAt = rs.getLong(rs.getColumnIndex('stopAt'));
      q.scheduledEnabled = rs.getLong(rs.getColumnIndex('scheduledEnabled')) === 1;
      q.segments = rs.getLong(rs.getColumnIndex('segments'));
      q.ua = rs.getString(rs.getColumnIndex('ua'));
      q.saveDir = rs.getString(rs.getColumnIndex('saveDir'));
      queues.push(q);
    }
    rs.close();
    return queues;
  }
}
