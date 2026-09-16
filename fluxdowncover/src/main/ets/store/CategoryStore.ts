import { relationalStore } from '@kit.ArkData';
import { DatabaseManager } from './DatabaseManager';
import { DownloadCategory } from '../model/DownloadCategory';
import { genId } from '../utils/common';

const CATEGORY_TABLE = 'download_categories';

/**
 * SQLite persistence for user-defined download categories.
 * 所有数据库调用均在方法内显式消化异常（满足 ArkTS 异常处理规范），失败不致应用崩溃。
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
    try {
      await s.executeSql(sql);
    } catch (e) {
      console.warn(`[CategoryStore] create table failed: ${(e as Error)?.message ?? e}`);
    }
  }

  async insert(cat: DownloadCategory): Promise<void> {
    const s = this.store;
    if (!s) return;
    try {
      const values: relationalStore.ValuesBucket = {
        'id': cat.id,
        'name': cat.name,
        'extensions': cat.extensions,
        'saveDir': cat.saveDir,
        'priority': cat.priority,
        'createdAt': cat.createdAt,
      };
      await s.insert(CATEGORY_TABLE, values);
    } catch (e) {
      console.warn(`[CategoryStore] insert failed: ${(e as Error)?.message ?? e}`);
    }
  }

  async update(cat: DownloadCategory): Promise<void> {
    const s = this.store;
    if (!s) return;
    try {
      const values: relationalStore.ValuesBucket = {
        'name': cat.name,
        'extensions': cat.extensions,
        'saveDir': cat.saveDir,
        'priority': cat.priority,
      };
      const pred = new relationalStore.RdbPredicates(CATEGORY_TABLE);
      pred.equalTo('id', cat.id);
      await s.update(values, pred);
    } catch (e) {
      console.warn(`[CategoryStore] update failed: ${(e as Error)?.message ?? e}`);
    }
  }

  async delete(id: string): Promise<void> {
    const s = this.store;
    if (!s) return;
    try {
      const pred = new relationalStore.RdbPredicates(CATEGORY_TABLE);
      pred.equalTo('id', id);
      await s.delete(pred);
    } catch (e) {
      console.warn(`[CategoryStore] delete failed: ${(e as Error)?.message ?? e}`);
    }
  }

  async queryAll(): Promise<DownloadCategory[]> {
    const s = this.store;
    if (!s) return [];
    let rs: relationalStore.ResultSet | null = null;
    try {
      const pred = new relationalStore.RdbPredicates(CATEGORY_TABLE);
      pred.orderByDesc('priority');
      rs = await s.query(pred, ['id', 'name', 'extensions', 'saveDir', 'priority', 'createdAt']);
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
      const list: DownloadCategory[] = [];
      while (rs.goToNextRow()) {
        const c = new DownloadCategory(str('id'), str('name'));
        c.extensions = str('extensions');
        c.saveDir = str('saveDir');
        c.priority = lng('priority');
        c.createdAt = lng('createdAt');
        list.push(c);
      }
      return list;
    } catch (e) {
      console.warn(`[CategoryStore] queryAll failed: ${(e as Error)?.message ?? e}`);
      return [];
    } finally {
      try { rs?.close(); } catch (_e) { }
    }
  }
}

export { genId };
