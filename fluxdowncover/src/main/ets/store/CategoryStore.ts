import { relationalStore } from '@kit.ArkData';
import { DatabaseManager } from './DatabaseManager';
import { DownloadCategory } from '../model/DownloadCategory';
import { genId } from '../utils/common';

const CATEGORY_TABLE = 'download_categories';

/**
 * SQLite persistence for user-defined download categories.
 */
export class CategoryStore {
  private db = DatabaseManager.getInstance();

  private get store(): relationalStore.RdbStore | null {
    return this.db.getStore();
  }

  async ensureTable(): Promise<void> {
    const s = this.store;
    if (!s) return;
    const sql = `CREATE TABLE IF NOT EXISTS ${CATEGORY_TABLE} (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      extensions TEXT NOT NULL DEFAULT '',
      saveDir TEXT NOT NULL DEFAULT '',
      priority INTEGER NOT NULL DEFAULT 0,
      createdAt INTEGER NOT NULL DEFAULT 0
    )`;
    await s.executeSql(sql);
  }

  async insert(cat: DownloadCategory): Promise<void> {
    const s = this.store;
    if (!s) return;
    const values: relationalStore.ValuesBucket = {
      'id': cat.id,
      'name': cat.name,
      'extensions': cat.extensions,
      'saveDir': cat.saveDir,
      'priority': cat.priority,
      'createdAt': cat.createdAt,
    };
    await s.insert(CATEGORY_TABLE, values);
  }

  async update(cat: DownloadCategory): Promise<void> {
    const s = this.store;
    if (!s) return;
    const values: relationalStore.ValuesBucket = {
      'name': cat.name,
      'extensions': cat.extensions,
      'saveDir': cat.saveDir,
      'priority': cat.priority,
    };
    const pred = new relationalStore.RdbPredicates(CATEGORY_TABLE);
    pred.equalTo('id', cat.id);
    await s.update(values, pred);
  }

  async delete(id: string): Promise<void> {
    const s = this.store;
    if (!s) return;
    const pred = new relationalStore.RdbPredicates(CATEGORY_TABLE);
    pred.equalTo('id', id);
    await s.delete(pred);
  }

  async queryAll(): Promise<DownloadCategory[]> {
    const s = this.store;
    if (!s) return [];
    const pred = new relationalStore.RdbPredicates(CATEGORY_TABLE);
    pred.orderByDesc('priority');
    const rs = await s.query(pred, ['id', 'name', 'extensions', 'saveDir', 'priority', 'createdAt']);
    const list: DownloadCategory[] = [];
    while (rs.goToNextRow()) {
      const c = new DownloadCategory(rs.getString(rs.getColumnIndex('id')), rs.getString(rs.getColumnIndex('name')));
      c.extensions = rs.getString(rs.getColumnIndex('extensions'));
      c.saveDir = rs.getString(rs.getColumnIndex('saveDir'));
      c.priority = rs.getLong(rs.getColumnIndex('priority'));
      c.createdAt = rs.getLong(rs.getColumnIndex('createdAt'));
      list.push(c);
    }
    rs.close();
    return list;
  }
}

export { genId };
