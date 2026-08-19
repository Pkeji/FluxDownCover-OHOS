import { relationalStore } from '@kit.ArkData';
import { common } from '@kit.AbilityKit';
import { BusinessError } from '@kit.BasicServicesKit';

const DB_NAME = 'fluxdown.db';
export const TABLE_NAME = 'download_tasks';

/**
 * Singleton wrapper around the relational (SQLite) store.
 * All download state is persisted here so downloads survive app restarts
 * (FluxDown's "resume anywhere" guarantee).
 */
export class DatabaseManager {
  private static instance: DatabaseManager | null = null;
  private rdbStore: relationalStore.RdbStore | null = null;

  static getInstance(): DatabaseManager {
    if (!DatabaseManager.instance) {
      DatabaseManager.instance = new DatabaseManager();
    }
    return DatabaseManager.instance;
  }

  init(context: common.UIAbilityContext): void {
    const config: relationalStore.StoreConfig = {
      name: DB_NAME,
      securityLevel: relationalStore.SecurityLevel.S1
    };
    relationalStore
      .getRdbStore(context, config)
      .then((store: relationalStore.RdbStore) => {
        this.rdbStore = store;
        this.createTable();
      })
      .catch((err: BusinessError) => {
        console.error(`FluxDown DB init failed: ${err.code} ${err.message}`);
      });
  }

  private createTable(): void {
    const sql = `CREATE TABLE IF NOT EXISTS ${TABLE_NAME} (
      id TEXT PRIMARY KEY,
      url TEXT,
      fileName TEXT,
      dirPath TEXT,
      filePath TEXT,
      protocol TEXT,
      totalBytes INTEGER,
      downloadedBytes INTEGER,
      status TEXT,
      segments TEXT,
      createdAt INTEGER,
      finishedAt INTEGER,
      errorMessage TEXT,
      sha256 TEXT,
      isHls INTEGER,
      verifyIntegrity INTEGER
    )`;
    this.rdbStore
      ?.executeSql(sql)
      .then(() => {
        console.info('FluxDown: tasks table ready');
      })
      .catch((err: BusinessError) => {
        console.error(`FluxDown create table failed: ${err.code} ${err.message}`);
      });
  }

  getStore(): relationalStore.RdbStore | null {
    return this.rdbStore;
  }
}
