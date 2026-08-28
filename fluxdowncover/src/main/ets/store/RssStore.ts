import { relationalStore } from '@kit.ArkData';
import { DatabaseManager } from './DatabaseManager';
import { RssSubscription } from '../model/RssSubscription';

const RSS_TABLE = 'rss_subscriptions';

/**
 * SQLite persistence for RSS subscriptions.
 * Supports progressive schema migration: new columns added in later
 * versions are appended via ALTER TABLE when missing.
 */
export class RssStore {
  private db = DatabaseManager.getInstance();

  private get store(): relationalStore.RdbStore | null {
    return this.db.getStore();
  }

  async ensureTable(): Promise<void> {
    const s = this.store;
    if (!s) return;
    const sql = `CREATE TABLE IF NOT EXISTS ${RSS_TABLE} (
      id TEXT PRIMARY KEY,
      url TEXT NOT NULL,
      name TEXT NOT NULL,
      filter TEXT NOT NULL DEFAULT '',
      intervalMin INTEGER NOT NULL DEFAULT 30,
      autoDownload INTEGER NOT NULL DEFAULT 1,
      lastChecked INTEGER NOT NULL DEFAULT 0,
      enabled INTEGER NOT NULL DEFAULT 1,
      downloadedUrls TEXT NOT NULL DEFAULT '[]',
      createdAt INTEGER NOT NULL DEFAULT 0
    )`;
    await s.executeSql(sql);
    // Migrate older databases: append columns added after the initial schema.
    const cols = await this.columnNames(s);
    const migrations: Array<[string, string]> = [
      ['excludeFilter', 'TEXT NOT NULL DEFAULT \'\''],
      ['sizeMinMB', 'INTEGER NOT NULL DEFAULT 0'],
      ['sizeMaxMB', 'INTEGER NOT NULL DEFAULT 0'],
      ['queueId', 'TEXT NOT NULL DEFAULT \'\''],
    ];
    for (const [col, def] of migrations) {
      if (!cols.includes(col)) {
        try {
          await s.executeSql(`ALTER TABLE ${RSS_TABLE} ADD COLUMN ${col} ${def}`);
        } catch (e) {
          // column already exists (race or duplicate) — ignore
        }
      }
    }
  }

  private async columnNames(s: relationalStore.RdbStore): Promise<string[]> {
    const names: string[] = [];
    try {
      const rs = await s.querySql(`PRAGMA table_info(${RSS_TABLE})`);
      while (rs.goToNextRow()) {
        const idx = rs.getColumnIndex('name');
        if (idx >= 0) {
          names.push(rs.getString(idx));
        }
      }
      rs.close();
    } catch (e) {
      // table may not exist yet
    }
    return names;
  }

  async insert(sub: RssSubscription): Promise<void> {
    const s = this.store;
    if (!s) return;
    const values: relationalStore.ValuesBucket = {
      'id': sub.id,
      'url': sub.url,
      'name': sub.name,
      'filter': sub.filter,
      'excludeFilter': sub.excludeFilter,
      'sizeMinMB': sub.sizeMinMB,
      'sizeMaxMB': sub.sizeMaxMB,
      'queueId': sub.queueId,
      'intervalMin': sub.intervalMin,
      'autoDownload': sub.autoDownload ? 1 : 0,
      'lastChecked': sub.lastChecked,
      'enabled': sub.enabled ? 1 : 0,
      'downloadedUrls': JSON.stringify(sub.downloadedUrls),
      'createdAt': sub.createdAt,
    };
    await s.insert(RSS_TABLE, values);
  }

  async update(sub: RssSubscription): Promise<void> {
    const s = this.store;
    if (!s) return;
    const values: relationalStore.ValuesBucket = {
      'url': sub.url,
      'name': sub.name,
      'filter': sub.filter,
      'excludeFilter': sub.excludeFilter,
      'sizeMinMB': sub.sizeMinMB,
      'sizeMaxMB': sub.sizeMaxMB,
      'queueId': sub.queueId,
      'intervalMin': sub.intervalMin,
      'autoDownload': sub.autoDownload ? 1 : 0,
      'lastChecked': sub.lastChecked,
      'enabled': sub.enabled ? 1 : 0,
      'downloadedUrls': JSON.stringify(sub.downloadedUrls),
    };
    const pred = new relationalStore.RdbPredicates(RSS_TABLE);
    pred.equalTo('id', sub.id);
    await s.update(values, pred);
  }

  async delete(id: string): Promise<void> {
    const s = this.store;
    if (!s) return;
    const pred = new relationalStore.RdbPredicates(RSS_TABLE);
    pred.equalTo('id', id);
    await s.delete(pred);
  }

  async queryAll(): Promise<RssSubscription[]> {
    const s = this.store;
    if (!s) return [];
    const pred = new relationalStore.RdbPredicates(RSS_TABLE);
    pred.orderByDesc('createdAt');
    const rs = await s.query(pred,
      ['id', 'url', 'name', 'filter', 'excludeFilter', 'sizeMinMB', 'sizeMaxMB', 'queueId',
        'intervalMin', 'autoDownload', 'lastChecked', 'enabled', 'downloadedUrls', 'createdAt']);
    const subs: RssSubscription[] = [];
    while (rs.goToNextRow()) {
      const sub = new RssSubscription(
        rs.getString(rs.getColumnIndex('id')),
        rs.getString(rs.getColumnIndex('url')),
        rs.getString(rs.getColumnIndex('name')),
      );
      sub.filter = rs.getString(rs.getColumnIndex('filter'));
      sub.excludeFilter = rs.getString(rs.getColumnIndex('excludeFilter'));
      sub.sizeMinMB = rs.getLong(rs.getColumnIndex('sizeMinMB'));
      sub.sizeMaxMB = rs.getLong(rs.getColumnIndex('sizeMaxMB'));
      sub.queueId = rs.getString(rs.getColumnIndex('queueId'));
      sub.intervalMin = rs.getLong(rs.getColumnIndex('intervalMin'));
      sub.autoDownload = rs.getLong(rs.getColumnIndex('autoDownload')) === 1;
      sub.lastChecked = rs.getLong(rs.getColumnIndex('lastChecked'));
      sub.enabled = rs.getLong(rs.getColumnIndex('enabled')) === 1;
      sub.downloadedUrls = JSON.parse(rs.getString(rs.getColumnIndex('downloadedUrls'))) as string[];
      sub.createdAt = rs.getLong(rs.getColumnIndex('createdAt'));
      subs.push(sub);
    }
    rs.close();
    return subs;
  }
}
