import { relationalStore } from '@kit.ArkData';
import { DatabaseManager } from './DatabaseManager';
import { RssSubscription } from '../model/RssSubscription';

const RSS_TABLE = 'rss_subscriptions';

/**
 * SQLite persistence for RSS subscriptions.
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
  }

  async insert(sub: RssSubscription): Promise<void> {
    const s = this.store;
    if (!s) return;
    const values: relationalStore.ValuesBucket = {
      'id': sub.id,
      'url': sub.url,
      'name': sub.name,
      'filter': sub.filter,
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
    const rs = await s.query(pred, ['id', 'url', 'name', 'filter', 'intervalMin', 'autoDownload', 'lastChecked', 'enabled', 'downloadedUrls', 'createdAt']);
    const subs: RssSubscription[] = [];
    while (rs.goToNextRow()) {
      const sub = new RssSubscription(
        rs.getString(rs.getColumnIndex('id')),
        rs.getString(rs.getColumnIndex('url')),
        rs.getString(rs.getColumnIndex('name')),
      );
      sub.filter = rs.getString(rs.getColumnIndex('filter'));
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
