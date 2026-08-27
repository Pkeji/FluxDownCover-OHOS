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
      createdAt INTEGER NOT NULL DEFAULT 0
    )`;
    await s.executeSql(sql);
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
    const rs = await s.query(pred, ['id', 'name', 'taskIds', 'maxConcurrent', 'priority', 'autoStart', 'createdAt']);
    const queues: DownloadQueue[] = [];
    while (rs.goToNextRow()) {
      const q = new DownloadQueue(rs.getString(rs.getColumnIndex('id')), rs.getString(rs.getColumnIndex('name')));
      q.taskIds = JSON.parse(rs.getString(rs.getColumnIndex('taskIds'))) as string[];
      q.maxConcurrent = rs.getLong(rs.getColumnIndex('maxConcurrent'));
      q.priority = rs.getLong(rs.getColumnIndex('priority'));
      q.autoStart = rs.getLong(rs.getColumnIndex('autoStart')) === 1;
      q.createdAt = rs.getLong(rs.getColumnIndex('createdAt'));
      queues.push(q);
    }
    rs.close();
    return queues;
  }
}
