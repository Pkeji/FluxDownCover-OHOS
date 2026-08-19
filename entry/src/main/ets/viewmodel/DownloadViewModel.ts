import { DownloadTask } from '../model/DownloadTask';
import { TaskStatus } from '../model/TaskStatus';
import { DownloadEngine } from '../engine/DownloadEngine';
import { EngineListener } from '../engine/types';
import { TaskRepository } from '../store/TaskRepository';
import { McpServer } from '../mcp/McpServer';
import { McpBackend } from '../mcp/McpBackend';

/**
 * Single owner of the task list and app settings. The UI observes its @Trace
 * fields; the engine mutates the very DownloadTask objects held here, so changes
 * propagate to ArkUI automatically. Implements both EngineListener (persistence)
 * and McpBackend (AI-agent control).
 */
@ObservedV2
export class DownloadViewModel implements EngineListener, McpBackend {
  @Trace tasks: DownloadTask[] = [];
  @Trace theme: 'light' | 'dark' = 'light';
  @Trace maxSegments: number = 8;
  @Trace verifyIntegrity: boolean = true;
  @Trace mcpEnabled: boolean = false;
  @Trace mcpToken: string = 'fluxdown-local';
  @Trace autoExport: boolean = false;

  private engine: DownloadEngine = DownloadEngine.getInstance();
  private mcp: McpServer = McpServer.getInstance();
  private repo: TaskRepository = new TaskRepository();

  async init(): Promise<void> {
    this.engine.setListener(this);
    this.engine.setMaxSegments(this.maxSegments);
    this.tasks = await this.engine.restore();
  }

  async addDownload(url: string, fileName?: string): Promise<void> {
    if (!url || !url.trim()) {
      return;
    }
    const task = await this.engine.addTask(url, { fileName, verify: this.verifyIntegrity });
    this.tasks.push(task);
    await this.engine.start(task);
  }

  pause(task: DownloadTask): void {
    this.engine.pause(task);
  }

  resume(task: DownloadTask): void {
    this.engine.resume(task);
  }

  remove(task: DownloadTask): void {
    this.engine.remove(task);
    const i = this.tasks.indexOf(task);
    if (i >= 0) {
      this.tasks.splice(i, 1);
    }
  }

  async exportToDownload(task: DownloadTask): Promise<string> {
    return this.engine.exportToPublicDownload(task);
  }

  setAutoExport(enabled: boolean): void {
    this.autoExport = enabled;
  }

  async startAll(): Promise<void> {
    for (const t of this.tasks) {
      if (t.status === TaskStatus.Paused || t.status === TaskStatus.Queued || t.status === TaskStatus.Error) {
        if (t.status === TaskStatus.Error) {
          t.status = TaskStatus.Paused;
          t.errorMessage = '';
        }
        await this.engine.start(t);
      }
    }
  }

  pauseAll(): void {
    for (const t of this.tasks) {
      if (t.status === TaskStatus.Downloading) {
        this.engine.pause(t);
      }
    }
  }

  setMaxSegments(n: number): void {
    this.maxSegments = n;
    this.engine.setMaxSegments(n);
  }

  setVerify(v: boolean): void {
    this.verifyIntegrity = v;
  }

  setTheme(t: 'light' | 'dark'): void {
    this.theme = t;
  }

  async setMcp(enabled: boolean, token?: string): Promise<void> {
    this.mcpEnabled = enabled;
    if (token) {
      this.mcpToken = token;
    }
    if (enabled) {
      await this.mcp.start(this.mcpToken, this);
    } else {
      this.mcp.stop();
    }
  }

  // ---- EngineListener ----
  onTaskUpdated(task: DownloadTask): void {
    this.repo.update(task).catch(() => {});
  }

  onTaskCompleted(task: DownloadTask): void {
    this.repo.update(task).catch(() => {});
    if (this.autoExport) {
      // Best-effort: push the finished file into the public Download directory.
      // This fires while the app is in the foreground; on devices that enforce an
      // explicit user gesture for the picker it may be rejected — the manual
      // "导出" button stays the reliable fallback.
      this.exportToDownload(task).catch((e: Error) => {
        console.error(`FluxDown auto-export failed: ${JSON.stringify(e)}`);
      });
    }
  }

  onTaskError(task: DownloadTask, error: string): void {
    this.repo.update(task).catch(() => {});
  }

  // ---- McpBackend ----
  listTasks(): DownloadTask[] {
    return this.tasks;
  }

  getTask(id: string): DownloadTask | undefined {
    return this.tasks.find((t) => t.id === id);
  }

  async addTask(url: string): Promise<void> {
    await this.addDownload(url);
  }

  pauseTask(id: string): void {
    const t = this.getTask(id);
    if (t) {
      this.engine.pause(t);
    }
  }

  resumeTask(id: string): Promise<void> {
    const t = this.getTask(id);
    if (t) {
      return this.engine.resume(t);
    }
    return Promise.resolve();
  }

  removeTask(id: string): void {
    const t = this.getTask(id);
    if (t) {
      this.remove(t);
    }
  }
}
