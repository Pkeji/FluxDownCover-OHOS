import { relationalStore } from '@kit.ArkData';
import { DatabaseManager } from './DatabaseManager';
import { RssSubscription } from '../model/RssSubscription';

const RSS_TABLE = 'rss_subscriptions';

/**
 * SQLite persistence for RSS subscriptions.
 * Supports progressive schema migration: new columns added in later
 * versions are appended via ALTER TABLE when missing.
 * 所有数据库调用均在方法内显式消化异常（满足 ArkTS 异常处理规范），失败不致应用崩溃。
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
    try {
      await s.executeSql(sql);
    } catch (e) {
      console.warn(`[RssStore] create table failed: ${(e as Error)?.message ?? e}`);
    }
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
    let rs: relationalStore.ResultSet | null = null;
    try {
      rs = await s.querySql(`PRAGMA table_info(${RSS_TABLE})`);
      while (rs.goToNextRow()) {
        const i = rs.getColumnIndex('name');
        if (i >= 0) {
          names.push(rs.getString(i));
        }
      }
    } catch (e) {
      // table may not exist yet
    } finally {
      try { rs?.close(); } catch (_e) { }
    }
    return names;
  }

  async insert(sub: RssSubscription): Promise<void> {
    const s = this.store;
    if (!s) return;
    try {
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
    } catch (e) {
      console.warn(`[RssStore] insert failed: ${(e as Error)?.message ?? e}`);
    }
  }

  async update(sub: RssSubscription): Promise<void> {
    const s = this.store;
    if (!s) return;
    try {
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
    } catch (e) {
      console.warn(`[RssStore] update failed: ${(e as Error)?.message ?? e}`);
    }
  }

  async delete(id: string): Promise<void> {
    const s = this.store;
    if (!s) return;
    try {
      const pred = new relationalStore.RdbPredicates(RSS_TABLE);
      pred.equalTo('id', id);
      await s.delete(pred);
    } catch (e) {
      console.warn(`[RssStore] delete failed: ${(e as Error)?.message ?? e}`);
    }
  }

  async queryAll(): Promise<RssSubscription[]> {
    const s = this.store;
    if (!s) return [];
    let rs: relationalStore.ResultSet | null = null;
    try {
      const pred = new relationalStore.RdbPredicates(RSS_TABLE);
      pred.orderByDesc('createdAt');
      rs = await s.query(pred,
        ['id', 'url', 'name', 'filter', 'excludeFilter', 'sizeMinMB', 'sizeMaxMB', 'queueId',
          'intervalMin', 'autoDownload', 'lastChecked', 'enabled', 'downloadedUrls', 'createdAt']);
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
      const subs: RssSubscription[] = [];
      while (rs.goToNextRow()) {
        const sub = new RssSubscription(str('id'), str('url'), str('name'));
        sub.filter = str('filter');
        sub.excludeFilter = str('excludeFilter');
        sub.sizeMinMB = lng('sizeMinMB');
        sub.sizeMaxMB = lng('sizeMaxMB');
        sub.queueId = str('queueId');
        sub.intervalMin = lng('intervalMin', 30);
        sub.autoDownload = lng('autoDownload', 1) === 1;
        sub.lastChecked = lng('lastChecked');
        sub.enabled = lng('enabled', 1) === 1;
        try {
          sub.downloadedUrls = JSON.parse(str('downloadedUrls', '[]')) as string[];
        } catch (_e) {
          sub.downloadedUrls = [];
        }
        sub.createdAt = lng('createdAt');
        subs.push(sub);
      }
      return subs;
    } catch (e) {
      console.warn(`[RssStore] queryAll failed: ${(e as Error)?.message ?? e}`);
      return [];
    } finally {
      try { rs?.close(); } catch (_e) { }
    }
  }
}
