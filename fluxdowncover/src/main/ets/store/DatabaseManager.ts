import { relationalStore } from '@kit.ArkData';
import { logCollector } from '../utils/LogCollector';
import { common } from '@kit.AbilityKit';
import { BusinessError } from '@kit.BasicServicesKit';

const DB_NAME = 'fluxdown.db';
export const TABLE_NAME = 'download_tasks';

/**
 * Singleton wrapper around the relational (SQLite) store.
 * All download state is persisted here so downloads survive app restarts
 * (FluxDown Cover's "resume anywhere" guarantee).
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
        logCollector.error('Error', `FluxDown Cover DB init failed: ${err.code} ${err.message}`);
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
      verifyIntegrity INTEGER,
      category TEXT DEFAULT '默认',
      priority INTEGER DEFAULT 0,
      queueId TEXT DEFAULT '',
      speedLimit INTEGER DEFAULT 0,
      scheduledAt INTEGER DEFAULT 0,
      authHeader TEXT DEFAULT '',
      proxyUrl TEXT DEFAULT '',
      isDash INTEGER DEFAULT 0,
      uploadedBytes INTEGER DEFAULT 0,
      seedRatio REAL DEFAULT 0,
      seedingStatus TEXT DEFAULT 'none',
      seedStartedAt INTEGER DEFAULT 0,
      seedSeconds INTEGER DEFAULT 0,
      manifestInitUrl TEXT DEFAULT ''
    )`;
    this.rdbStore
      ?.executeSql(sql)
      .then(() => {
        // Migrate: add new columns if upgrading from old schema
        const migrations = [
          `ALTER TABLE ${TABLE_NAME} ADD COLUMN category TEXT DEFAULT '默认'`,
          `ALTER TABLE ${TABLE_NAME} ADD COLUMN priority INTEGER DEFAULT 0`,
          `ALTER TABLE ${TABLE_NAME} ADD COLUMN queueId TEXT DEFAULT ''`,
          `ALTER TABLE ${TABLE_NAME} ADD COLUMN speedLimit INTEGER DEFAULT 0`,
          `ALTER TABLE ${TABLE_NAME} ADD COLUMN scheduledAt INTEGER DEFAULT 0`,
          `ALTER TABLE ${TABLE_NAME} ADD COLUMN authHeader TEXT DEFAULT ''`,
          `ALTER TABLE ${TABLE_NAME} ADD COLUMN proxyUrl TEXT DEFAULT ''`,
          `ALTER TABLE ${TABLE_NAME} ADD COLUMN isDash INTEGER DEFAULT 0`,
          // ── BitTorrent / seeding fields ──
          `ALTER TABLE ${TABLE_NAME} ADD COLUMN uploadedBytes INTEGER DEFAULT 0`,
          `ALTER TABLE ${TABLE_NAME} ADD COLUMN seedRatio REAL DEFAULT 0`,
          `ALTER TABLE ${TABLE_NAME} ADD COLUMN seedingStatus TEXT DEFAULT 'none'`,
          `ALTER TABLE ${TABLE_NAME} ADD COLUMN seedStartedAt INTEGER DEFAULT 0`,
          `ALTER TABLE ${TABLE_NAME} ADD COLUMN seedSeconds INTEGER DEFAULT 0`,
          // ── HLS/DASH fMP4 初始化段（EXT-X-MAP / Initialization）─
          `ALTER TABLE ${TABLE_NAME} ADD COLUMN manifestInitUrl TEXT DEFAULT ''`,
        ];
        for (const m of migrations) {
          this.rdbStore?.executeSql(m).catch(() => { /* column already exists */ });
        }
        console.info('FluxDown Cover: tasks table ready');
      })
      .catch((err: BusinessError) => {
        logCollector.error('Error', `FluxDown Cover create table failed: ${err.code} ${err.message}`);
      });
  }

  getStore(): relationalStore.RdbStore | null {
    return this.rdbStore;
  }
}
