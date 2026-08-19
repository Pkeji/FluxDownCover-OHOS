import { relationalStore } from '@kit.ArkData';
import { BusinessError } from '@kit.BasicServicesKit';
import { DatabaseManager, TABLE_NAME } from './DatabaseManager';
import { DownloadTask } from '../model/DownloadTask';
import { TaskStatus } from '../model/TaskStatus';
import { ProtocolType } from '../model/ProtocolType';

/**
 * CRUD mapping between DownloadTask objects and the relational store.
 * Segment progress is stored as JSON so per-segment resume works.
 */
export class TaskRepository {
  private db = DatabaseManager.getInstance();

  private get store(): relationalStore.RdbStore | null {
    return this.db.getStore();
  }

  private columns(): string[] {
    return [
      'id', 'url', 'fileName', 'dirPath', 'filePath', 'protocol', 'totalBytes',
      'downloadedBytes', 'status', 'segments', 'createdAt', 'finishedAt',
      'errorMessage', 'sha256', 'isHls', 'verifyIntegrity'
    ];
  }

  async insert(task: DownloadTask): Promise<void> {
    const s = this.store;
    if (!s) {
      return;
    }
    await s.insert(TABLE_NAME, this.toValues(task));
  }

  async update(task: DownloadTask): Promise<void> {
    const s = this.store;
    if (!s) {
      return;
    }
    const pred = new relationalStore.RdbPredicates(TABLE_NAME);
    pred.equalTo('id', task.id);
    await s.update(this.toValues(task), pred);
  }

  async delete(id: string): Promise<void> {
    const s = this.store;
    if (!s) {
      return;
    }
    const pred = new relationalStore.RdbPredicates(TABLE_NAME);
    pred.equalTo('id', id);
    await s.delete(pred);
  }

  async queryAll(): Promise<DownloadTask[]> {
    const s = this.store;
    if (!s) {
      return [];
    }
    const pred = new relationalStore.RdbPredicates(TABLE_NAME);
    const rs = await s.query(pred, this.columns());
    const list: DownloadTask[] = [];
    while (rs.goToNextRow()) {
      list.push(this.fromRow(rs));
    }
    rs.close();
    return list;
  }

  private toValues(task: DownloadTask): relationalStore.ValuesBucket {
    return {
      id: task.id,
      url: task.url,
      fileName: task.fileName,
      dirPath: task.dirPath,
      filePath: task.filePath,
      protocol: task.protocol,
      totalBytes: task.totalBytes,
      downloadedBytes: task.downloadedBytes,
      status: task.status,
      segments: JSON.stringify(task.segments),
      createdAt: task.createdAt,
      finishedAt: task.finishedAt,
      errorMessage: task.errorMessage,
      sha256: task.sha256,
      isHls: task.isHls ? 1 : 0,
      verifyIntegrity: task.verifyIntegrity ? 1 : 0
    };
  }

  private fromRow(rs: relationalStore.ResultSet): DownloadTask {
    const col = (name: string): number => rs.getColumnIndex(name);
    const task = new DownloadTask();
    task.id = rs.getString(col('id'));
    task.url = rs.getString(col('url'));
    task.fileName = rs.getString(col('fileName'));
    task.dirPath = rs.getString(col('dirPath'));
    task.filePath = rs.getString(col('filePath'));
    task.protocol = rs.getString(col('protocol')) as ProtocolType;
    task.totalBytes = rs.getLong(col('totalBytes'));
    task.downloadedBytes = rs.getLong(col('downloadedBytes'));
    task.status = rs.getString(col('status')) as TaskStatus;
    task.segments = JSON.parse(rs.getString(col('segments')) || '[]');
    task.createdAt = rs.getLong(col('createdAt'));
    task.finishedAt = rs.getLong(col('finishedAt'));
    task.errorMessage = rs.getString(col('errorMessage'));
    task.sha256 = rs.getString(col('sha256'));
    task.isHls = rs.getLong(col('isHls')) === 1;
    task.verifyIntegrity = rs.getLong(col('verifyIntegrity')) === 1;
    task.liveBytes = task.downloadedBytes;
    return task;
  }
}
