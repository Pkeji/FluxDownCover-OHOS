import { DownloadTask } from '../model/DownloadTask';
import { TaskStatus } from '../model/TaskStatus';
import { DownloadEngine } from '../engine/DownloadEngine';
import { EngineListener } from '../engine/types';
import { TaskRepository } from '../store/TaskRepository';
import { McpServer } from '../mcp/McpServer';
import { McpBackend } from '../mcp/McpBackend';
import { SettingsStore } from '../store/SettingsStore';
import { DownloadQueue } from '../model/DownloadQueue';
import { DownloadCategory } from '../model/DownloadCategory';
import { RssSubscription, RssItem } from '../model/RssSubscription';
import { QueueStore } from '../store/QueueStore';
import { CategoryStore } from '../store/CategoryStore';
import { BackgroundTaskManager } from '../util/BackgroundTaskManager';
import { NotificationHelper } from '../util/NotificationHelper';
import { matchesBuiltinCategory } from '../utils/common';
import { logCollector } from '../utils/LogCollector';
import { RssStore } from '../store/RssStore';
import { BtSettingsStore, BtSettings } from '../store/BtSettingsStore';
import { BtEngine } from '../engine/BtEngine';
import { StatsCalculator, DownloadStats } from '../utils/StatsCalculator';
import { SpeedLimiter } from '../utils/SpeedLimiter';
import { RssParser } from '../utils/RssParser';
import { genId, fileNameFromUrl } from '../utils/common';
import { common } from '@kit.AbilityKit';
import { pasteboard } from '@kit.BasicServicesKit';

/**
 * Single owner of the task list and app settings. The UI observes its @Trace
 * fields; the engine mutates the very DownloadTask objects held here, so changes
 * propagate to ArkUI automatically. Implements both EngineListener (persistence)
 * and McpBackend (AI-agent control).
 */
@ObservedV2
export class DownloadViewModel implements EngineListener, McpBackend {
  @Trace tasks: DownloadTask[] = [];
  @Trace refreshTick: number = 0; // 强制刷新计数器，任务变更时递增
  @Trace visibleTasks: DownloadTask[] = []; // 手动维护的可见任务列表，彻底绕开@Computed依赖追踪问题
  @Trace theme: 'light' | 'dark' = 'light';
  @Trace themeMode: 'light' | 'dark' | 'system' = 'light'; // follow-system support
  @Trace maxSegments: number = 8;
  @Trace verifyIntegrity: boolean = true;
  @Trace mcpEnabled: boolean = false;
  @Trace mcpToken: string = 'fluxdowncover-local';
  // ── Extended settings (FluxDown Cover feature parity) ──
  @Trace globalSpeedLimit: number = 0; // bytes/sec, 0 = unlimited
  @Trace proxyUrl: string = ''; // global proxy URL
  @Trace githubMirrorUrl: string = ''; // GitHub mirror prefix
  @Trace colorScheme: string = 'cyan'; // accent color scheme id
  @Trace clipboardMonitor: boolean = false; // auto-detect URLs from clipboard
  @Trace notifyOnComplete: boolean = true; // system notification when a task finishes
  private lastProgressNotify: Map<string, number> = new Map(); // 进度通知节流
  @Trace autoRetryCount: number = 0; // failed-download auto retry count (0 = disabled)
  @Trace autoRetryDelaySec: number = 5; // seconds between retries
  @Trace fileExistsBehavior: string = 'overwrite'; // overwrite | rename | skip
  @Trace fileMissingAction: string = 'keep'; // keep | remove (on recheck with missing file)
  @Trace useServerTime: boolean = false; // set file mtime from HTTP Last-Modified
  @Trace queues: DownloadQueue[] = [];
  @Trace categories: DownloadCategory[] = [];
  @Trace rssSubs: RssSubscription[] = [];
  @Trace btSettings: BtSettings | null = null; // BT engine settings (null until loaded)
  @Trace filterCategory: string = ''; // current category filter ('' = all)
  @Trace queueFilter: string = ''; // current queue filter ('' = all)
  @Trace sortBy: string = 'time'; // time | size | name | priority
  @Trace searchQuery: string = ''; // keyword search across name/url
  @Trace statusFilter: string = ''; // '' | 'downloading' | 'paused' | 'completed' | 'error'
  /** When non-null, the UI should show a duplicate-download dialog. */
  @Trace duplicatePrompt: { url: string } | null = null;

  private engine: DownloadEngine = DownloadEngine.getInstance();
  private mcp: McpServer = McpServer.getInstance();
  private context: common.UIAbilityContext | null = null;
  private repo: TaskRepository = new TaskRepository();
  private settings = SettingsStore.getInstance();
  private queueStore: QueueStore = new QueueStore();
  private categoryStore: CategoryStore = new CategoryStore();
  private rssStore: RssStore = new RssStore();
  private btSettingsStore: BtSettingsStore = BtSettingsStore.getInstance();
  private rssTimer: number = -1;
  private clipboardTimer: number = -1;
  private lastClipboardText: string = '';
  /** URLs currently being added (in-flight), to prevent concurrent duplicates. */
  private pendingUrls: Set<string> = new Set();
  /**
   * 初始化（含任务恢复 restore）的 Promise，仅执行一次。
   * 用于门控 addDownload：冷启动深链与 restore 并发时，restore 的
   * `this.tasks = ...` 会整体替换任务数组，导致 UI 持有另一个任务副本，
   * 引擎完成后 UI 副本仍停留在“下载中”。addDownload 必须等 restore 结束。
   */
  private initPromise: Promise<void> | null = null;

  init(context: common.UIAbilityContext): Promise<void> {
    if (this.initPromise === null) {
      this.initPromise = this.doInit(context);
    }
    return this.initPromise;
  }

  private async doInit(context: common.UIAbilityContext): Promise<void> {
    // Load persisted settings before anything else
    await this.settings.init(context);
    // 并行加载所有设置项
    const [
      theme, themeMode, maxSegments, verifyIntegrity, mcpEnabled, mcpToken,
      globalSpeedLimit, proxyUrl, githubMirrorUrl, colorScheme, clipboardMonitor,
      notifyOnComplete, autoRetryCount, autoRetryDelaySec, fileExistsBehavior,
      fileMissingAction, useServerTime,
    ] = await Promise.all([
      this.settings.getString('theme', 'light'),
      this.settings.getString('themeMode', 'light'),
      this.settings.getNumber('maxSegments', 8),
      this.settings.getBoolean('verifyIntegrity', false),
      this.settings.getBoolean('mcpEnabled', false),
      this.settings.getString('mcpToken', 'fluxdowncover-local'),
      this.settings.getNumber('globalSpeedLimit', 0),
      this.settings.getString('proxyUrl', ''),
      this.settings.getString('githubMirrorUrl', ''),
      this.settings.getString('colorScheme', 'cyan'),
      this.settings.getBoolean('clipboardMonitor', false),
      this.settings.getBoolean('notifyOnComplete', true),
      this.settings.getNumber('autoRetryCount', 0),
      this.settings.getNumber('autoRetryDelaySec', 5),
      this.settings.getString('fileExistsBehavior', 'overwrite'),
      this.settings.getString('fileMissingAction', 'keep'),
      this.settings.getBoolean('useServerTime', false),
    ]);
    this.theme = theme as 'light' | 'dark';
    this.themeMode = themeMode as 'light' | 'dark' | 'system';
    this.maxSegments = maxSegments;
    this.verifyIntegrity = verifyIntegrity;
    this.mcpEnabled = mcpEnabled;
    this.mcpToken = mcpToken;
    this.globalSpeedLimit = globalSpeedLimit;
    this.proxyUrl = proxyUrl;
    this.githubMirrorUrl = githubMirrorUrl;
    this.colorScheme = colorScheme;
    this.clipboardMonitor = clipboardMonitor;
    this.notifyOnComplete = notifyOnComplete;
    this.autoRetryCount = autoRetryCount;
    this.autoRetryDelaySec = autoRetryDelaySec;
    this.fileExistsBehavior = fileExistsBehavior;
    this.fileMissingAction = fileMissingAction;
    this.useServerTime = useServerTime;
    NotificationHelper.getInstance().setEnabled(this.notifyOnComplete);
    this.context = context;

    this.engine.setListener(this);
    this.engine.setMaxSegments(this.maxSegments);
    this.engine.setGithubMirrorUrl(this.githubMirrorUrl);
    this.engine.setUseServerTime(this.useServerTime);

    // 并行：任务恢复 + 三个 store 初始化 + BT 设置加载
    const [restoredTasks, , , , btSettings] = await Promise.all([
      this.engine.restore(),
      this.queueStore.ensureTable().then(() => this.queueStore.queryAll()).then((r) => { this.queues = r; }),
      this.categoryStore.ensureTable().then(() => this.categoryStore.queryAll()).then((r) => { this.categories = r; }),
      this.rssStore.ensureTable().then(() => this.rssStore.queryAll()).then((r) => { this.rssSubs = r; }),
      this.btSettingsStore.init(context).then(() => this.btSettingsStore.load()),
    ]);
    this.tasks = restoredTasks;
    // Sort by priority (highest first)
    this.tasks.sort((a, b) => b.priority - a.priority);
    this.updateVisibleTasks();
    this.btSettings = btSettings;

    // Apply global speed limit
    SpeedLimiter.global().setLimit(this.globalSpeedLimit);

    // 后台服务延迟到首屏渲染后启动，不阻塞冷启动
    setTimeout(() => {
      // Start RSS polling
      this.startRssPolling();
      // Start clipboard monitor if enabled
      if (this.clipboardMonitor) {
        this.startClipboardMonitor();
      }
      // Daily queue schedule check + periodic tick
      this.startQueueScheduler();
      this.tickQueueSchedules();
    }, 300);
  }

  async addDownload(url: string, fileName?: string, hlsQualityIndex: number = -1, queueId: string = '', opts?: { dirPath?: string; segmentCount?: number; ua?: string; cookie?: string; referer?: string; headers?: string }, autoHandleDuplicate: boolean = false): Promise<'added' | 'duplicate' | 'pending' | 'skipped'> {
    if (!url || !url.trim()) {
      return 'pending';
    }
    const trimmed = url.trim();
    // Concurrent safety: same URL being added at the exact same moment
    // 必须在 await initPromise 之前加入，防止快速点击两次都通过检查
    if (this.pendingUrls.has(trimmed)) {
      return 'pending';
    }
    this.pendingUrls.add(trimmed);
    try {
      // 等待初始化（任务恢复）完成后再添加，避免冷启动深链与 restore 竞态
      if (this.initPromise !== null) {
        try {
          await this.initPromise;
        } catch (_) {
          // 初始化失败不阻塞添加，后续以内存态继续
        }
      }
      // Duplicate URL detected
      if (this.tasks.some(t => t.url === trimmed)) {
        // 根据设置自动处理：跳过/覆盖/重命名
        if (this.fileExistsBehavior === 'skip') {
          this.pendingUrls.delete(trimmed);
          return 'skipped';
        }
        if (this.fileExistsBehavior === 'overwrite') {
          // 覆盖：删除原任务（保留文件，新任务会覆盖原文件），然后继续添加
          const existing = this.tasks.find(t => t.url === trimmed);
          if (existing) {
            this.remove(existing, true);
          }
        }
        // overwrite 或 rename：继续添加，engine.addTask 会根据 fileExists 处理
      }
      const resolvedName = fileName || this.resolveFileName(trimmed);
      // Inherit queue-level defaults (save dir / UA / segment count) when targeting a queue.
      const q = queueId ? this.queues.find((x) => x.id === queueId) : undefined;
      const dirPath = q && q.saveDir ? q.saveDir : undefined;
      const ua = q && q.ua ? q.ua : undefined;
      const segmentCount = q && q.segments > 0 ? q.segments : undefined;
      const task = await this.engine.addTask(trimmed, {
        fileName: resolvedName, verify: this.verifyIntegrity, queueId: queueId,
        fileExists: this.fileExistsBehavior, dirPath: dirPath, ua: ua, segmentCount: segmentCount
      });
      // Auto-assign category by extension rules (may also override save dir).
      this.assignCategory(task);
      if (hlsQualityIndex >= 0) {
        task.hlsQualityIndex = hlsQualityIndex;
      }
      this.tasks.push(task);
      this.refreshTick++;
      this.updateVisibleTasks();
      // 不等待 engine.start 完成，让任务立即显示
      this.engine.start(task).catch((e) => logCollector.error('Download', `engine.start error: ${JSON.stringify(e)}`));
      return 'added';
    } finally {
      this.pendingUrls.delete(trimmed);
    }
  }

  /** Callback invoked after user makes a choice in the duplicate-download dialog. */
  async confirmDuplicateDownload(action: 'redownload' | 'skip'): Promise<void> {
    const info = this.duplicatePrompt;
    this.duplicatePrompt = null;
    if (!info) {
      return;
    }
    if (action === 'redownload') {
      // 防止重复点击
      if (this.pendingUrls.has(info.url)) {
        return;
      }
      this.pendingUrls.add(info.url);
      try {
        // 覆盖：删除原任务（保留文件，新任务会覆盖原文件），然后创建新任务
        const existing = this.tasks.find(t => t.url === info.url);
        if (existing) {
          this.remove(existing, true);
        }
        const resolvedName = this.resolveFileName(info.url);
        const task = await this.engine.addTask(info.url, {
          fileName: resolvedName, verify: this.verifyIntegrity, fileExists: this.fileExistsBehavior
        });
        this.assignCategory(task);
        this.tasks.push(task);
        this.refreshTick++;
      this.updateVisibleTasks();
        // 不等待 engine.start 完成，让任务立即显示
        this.engine.start(task).catch((e) => logCollector.error('Download', `confirmDuplicateDownload start error: ${JSON.stringify(e)}`));
      } catch (e) {
        logCollector.error('Download', `confirmDuplicateDownload error: ${JSON.stringify(e)}`);
      } finally {
        this.pendingUrls.delete(info.url);
      }
    }
  }

  /** If the auto-generated filePath collides with an existing task, append a suffix. */
  private resolveFileName(url: string): string | undefined {
    const baseName = fileNameFromUrl(url) || '';
    if (!baseName) {
      return undefined; // let engine use its fallback
    }
    // 只有设置为"重命名"时才自动添加后缀
    // 覆盖：不重命名，直接使用原文件名（引擎会覆盖原文件）
    // 跳过：不重命名，直接使用原文件名（addDownload 中会返回 skipped）
    if (this.fileExistsBehavior !== 'rename') {
      return undefined;
    }
    const dir = this.engine.defaultDir();
    const extIndex = baseName.lastIndexOf('.');
    const stem = extIndex > 0 ? baseName.slice(0, extIndex) : baseName;
    const ext = extIndex > 0 ? baseName.slice(extIndex) : '';
    // Collect filePaths already claimed by existing tasks
    const usedPaths = new Set(this.tasks.map(t => t.filePath));
    let candidate = `${dir}/${baseName}`;
    if (!usedPaths.has(candidate)) {
      return undefined; // no conflict, use original
    }
    // Find the first available suffix
    for (let i = 1; i < 100; i++) {
      candidate = `${dir}/${stem} (${i})${ext}`;
      if (!usedPaths.has(candidate)) {
        return `${stem} (${i})${ext}`;
      }
    }
    // Fallback: include task id
    return `${stem} (${genId().slice(0, 8)})${ext}`;
  }

  pause(task: DownloadTask): void {
    this.engine.pause(task);
  }

  resume(task: DownloadTask): void {
    this.engine.resume(task);
  }

  remove(task: DownloadTask, keepFile: boolean = false): void {
    this.engine.remove(task, keepFile);
    const i = this.tasks.indexOf(task);
    if (i >= 0) {
      this.tasks.splice(i, 1);
    }
    this.refreshTick++;
      this.updateVisibleTasks();
    this.updateBackgroundTask();
  }

  /** Remove multiple tasks by their ids. */
  removeTasks(ids: string[], keepFile: boolean = false): void {
    for (const id of ids) {
      const task = this.tasks.find(t => t.id === id);
      if (task) {
        this.engine.remove(task, keepFile);
        const i = this.tasks.indexOf(task);
        if (i >= 0) {
          this.tasks.splice(i, 1);
        }
      }
    }
    this.refreshTick++;
      this.updateVisibleTasks();
    this.updateBackgroundTask();
  }

  // ── Task operations (rename / move / recheck / cleanup) ──
  async renameTask(task: DownloadTask, newName: string): Promise<void> {
    await this.engine.renameTask(task, newName);
    // Refresh the list ordering if the task was sorted (no-op for name sort).
    this.repo.update(task).catch(() => {});
    this.refreshTick++;
      this.updateVisibleTasks();
  }

  async moveTask(task: DownloadTask, newDir: string): Promise<void> {
    await this.engine.moveTask(task, newDir);
    this.repo.update(task).catch(() => {});
  }

  async recheckTask(task: DownloadTask): Promise<void> {
    try {
      await this.engine.recheck(task);
    } catch (e) {
      const msg = (e as Error).message || String(e);
      // File-missing policy: keep record (default, already reset to Paused) or remove it.
      if (msg.includes('文件不存在') && this.fileMissingAction === 'remove') {
        this.engine.remove(task, false);
        this.tasks = this.tasks.filter(t => t.id !== task.id);
        this.refreshTick++;
      this.updateVisibleTasks();
        this.updateBackgroundTask();
        return;
      }
      throw e as Error;
    }
  }

  /** Clean up Error tasks; optionally keep files. Returns count removed. */
  async cleanupFailed(keepFile: boolean = false): Promise<number> {
    const failed = this.tasks.filter(t => t.status === TaskStatus.Error);
    const removed = await this.engine.cleanupFailedTasks(failed, keepFile);
    if (removed > 0) {
      this.tasks = this.tasks.filter(t => t.status !== TaskStatus.Error);
      this.refreshTick++;
      this.updateVisibleTasks();
      this.updateBackgroundTask();
    }
    return removed;
  }

  // ── Seeding control (BT) ──
  startSeeding(task: DownloadTask): void {
    this.engine.startSeeding(task);
  }

  stopSeeding(task: DownloadTask): void {
    this.engine.stopSeeding(task, 'userStopped');
  }

  async exportToDownload(task: DownloadTask): Promise<string> {
    const path = await this.engine.exportToPublicDownload(task);
    task.publicPath = path;
    return path;
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
      if (t.status === TaskStatus.Downloading || t.status === TaskStatus.Queued || t.status === TaskStatus.Verifying || t.status === TaskStatus.Pending) {
        this.engine.pause(t);
        NotificationHelper.getInstance().cancelProgress(t.id);
      }
    }
    this.refreshTick++;
    this.updateVisibleTasks();
  }

  setMaxSegments(n: number): void {
    this.maxSegments = n;
    this.engine.setMaxSegments(n);
    this.settings.put('maxSegments', n);
  }

  setVerify(v: boolean): void {
    this.verifyIntegrity = v;
    this.settings.put('verifyIntegrity', v);
  }

  setTheme(t: 'light' | 'dark'): void {
    this.theme = t;
    this.settings.put('theme', t);
  }

  setThemeMode(mode: 'light' | 'dark' | 'system'): void {
    this.themeMode = mode;
    this.settings.put('themeMode', mode);
  }

  async setMcp(enabled: boolean, token?: string): Promise<void> {
    this.mcpEnabled = enabled;
    if (token) {
      this.mcpToken = token;
    }
    this.settings.put('mcpEnabled', enabled);
    if (token) {
      this.settings.put('mcpToken', token);
    }
    if (enabled) {
      await this.mcp.start(this.mcpToken, this);
    } else {
      this.mcp.stop();
    }
  }

  setMcpToken(token: string): void {
    this.mcpToken = token;
    this.settings.put('mcpToken', token);
  }

  // ---- Background task management ----

  /** Count active downloads and start/stop the continuous background task accordingly. */
  private updateBackgroundTask(): void {
    const activeCount = this.tasks.filter(t => t.status === TaskStatus.Downloading).length;
    BackgroundTaskManager.getInstance().update(activeCount).catch(() => {});
  }

  // ---- EngineListener ----
  onTaskUpdated(task: DownloadTask): void {
    this.repo.update(task).catch(() => {});
    this.updateBackgroundTask();
    // 触发数组引用变化，确保 @Computed groupedTasks / visibleTasks 重新计算
    // ArkUI V2 中数组内 @ObservedV2 对象的属性变化可能不触发数组级 @Computed 重算
    this.refreshTick++;
      this.updateVisibleTasks();
    // 进度通知+实况窗（节流：每1秒最多更新一次，避免通知栏闪烁）
    if (this.notifyOnComplete && this.context && task.status === TaskStatus.Downloading && task.totalBytes > 0) {
      const now = Date.now();
      const last = this.lastProgressNotify.get(task.id) ?? 0;
      if (now - last > 1000) {
        this.lastProgressNotify.set(task.id, now);
        const progress = task.downloadedBytes / task.totalBytes;
        const speedStr = this.formatSpeed(task.speed);
        NotificationHelper.getInstance().notifyDownloadProgress(this.context, task.id, task.fileName, progress, speedStr).catch(() => {});
      }
    }
  }

  private formatSpeed(bytesPerSec: number): string {
    if (bytesPerSec <= 0) return '0 B/s';
    if (bytesPerSec < 1024) return `${bytesPerSec.toFixed(0)} B/s`;
    if (bytesPerSec < 1024 * 1024) return `${(bytesPerSec / 1024).toFixed(1)} KB/s`;
    return `${(bytesPerSec / (1024 * 1024)).toFixed(2)} MB/s`;
  }

  onTaskCompleted(task: DownloadTask): void {
    this.repo.update(task).catch(() => {});
    // 触发数组引用变化
    this.refreshTick++;
      this.updateVisibleTasks();
    // 任务完成后同步后台长时任务状态（否则最后一批任务完成后通知不消失）
    this.updateBackgroundTask();
    // Completion notification (toggleable in settings)
    if (this.notifyOnComplete && this.context) {
      const ctx = this.context;
      NotificationHelper.getInstance().notifyDownloadComplete(ctx, task.id, task.fileName).catch(() => {});
    }
    // Best-effort: push the finished file into the public Download directory.
    this.exportToDownload(task).catch((e: Error) => {
      logCollector.error('Download', `auto-export failed: ${JSON.stringify(e)}`);
    });
    // Queue auto-start: when a task in a queue finishes, start the next pending one
    if (task.queueId) {
      const q = this.queues.find(qq => qq.id === task.queueId);
      if (q && q.autoStart) {
        this.scheduleQueue(task.queueId).catch(() => {});
      }
    }
  }

  onTaskError(task: DownloadTask, error: string): void {
    this.repo.update(task).catch(() => {});
    // Auto-retry: transparently requeue failed tasks when enabled and not exhausted.
    if (this.autoRetryCount > 0 &&
        task.retryCount < this.autoRetryCount &&
        task.status === TaskStatus.Error &&
        !error.includes('网络不可用') &&
        !error.includes('暂不支持') &&
        !error.includes('解析失败')) {
      task.retryCount++;
      task.status = TaskStatus.Queued;
      task.errorMessage = '';
      this.repo.update(task).catch(() => {});
      setTimeout(() => {
        if (task.status === TaskStatus.Queued || task.status === TaskStatus.Paused) {
          this.engine.start(task).catch(() => {});
        }
      }, Math.max(1, this.autoRetryDelaySec) * 1000);
      return;
    }
    task.retryCount = 0;
    this.updateBackgroundTask();
    // 触发数组引用变化
    this.refreshTick++;
      this.updateVisibleTasks();
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
      NotificationHelper.getInstance().cancelProgress(id);
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
      NotificationHelper.getInstance().cancelProgress(id);
    }
  }

  // ── Extended MCP backend methods ──
  pauseAllTasks(): void {
    for (const t of this.tasks) {
      if (t.status === TaskStatus.Downloading || t.status === TaskStatus.Pending || t.status === TaskStatus.Queued) {
        this.engine.pause(t);
      }
    }
  }

  async resumeAllTasks(): Promise<void> {
    const paused = this.tasks.filter((t: DownloadTask) => t.status === TaskStatus.Paused);
    // 并行恢复所有任务，不用await串行
    await Promise.all(paused.map((t: DownloadTask) => this.engine.resume(t)));
    this.refreshTick++;
    this.updateVisibleTasks();
  }

  // ── Queue management ──
  async createQueue(name: string, maxConcurrent: number = 2): Promise<DownloadQueue> {
    const q = new DownloadQueue(genId(), name);
    q.maxConcurrent = maxConcurrent;
    this.queues.push(q);
    await this.queueStore.insert(q);
    return q;
  }

  async deleteQueue(id: string): Promise<void> {
    await this.queueStore.delete(id);
    this.queues = this.queues.filter(q => q.id !== id);
  }

  async addTaskToQueue(taskId: string, queueId: string): Promise<void> {
    const q = this.queues.find(qq => qq.id === queueId);
    const t = this.getTask(taskId);
    if (q && t) {
      if (!q.taskIds.includes(taskId)) q.taskIds.push(taskId);
      t.queueId = queueId;
      await this.queueStore.update(q);
      this.repo.update(t).catch(() => {});
      // Auto-start if queue allows and task is pending
      if (q.autoStart && (t.status === TaskStatus.Pending || t.status === TaskStatus.Queued)) {
        await this.scheduleQueue(queueId);
      }
    }
  }

  async removeTaskFromQueue(taskId: string, queueId: string): Promise<void> {
    const q = this.queues.find(qq => qq.id === queueId);
    const t = this.getTask(taskId);
    if (q) {
      q.taskIds = q.taskIds.filter(id => id !== taskId);
      await this.queueStore.update(q);
    }
    if (t) {
      t.queueId = '';
      this.repo.update(t).catch(() => {});
    }
  }

  /** Persist queue metadata changes (name / autoStart / maxConcurrent). */
  async queueStoreUpdate(q: DownloadQueue): Promise<void> {
    await this.queueStore.update(q);
  }

  /** Reorder a queue up (-1) or down (+1) by swapping priorities. */
  async moveQueue(id: string, delta: number): Promise<void> {
    const idx = this.queues.findIndex(q => q.id === id);
    const target = idx + delta;
    if (idx < 0 || target < 0 || target >= this.queues.length) {
      return;
    }
    const a = this.queues[idx];
    const b = this.queues[target];
    const pa = a.priority;
    a.priority = b.priority;
    b.priority = pa;
    // Re-sort by priority (desc) to reflect the new order.
    this.queues = [...this.queues].sort((x, y) => y.priority - x.priority);
    await this.queueStore.update(a);
    await this.queueStore.update(b);
  }

  listQueues(): DownloadQueue[] {
    return this.queues;
  }

  // ── Queue scheduling (enforces maxConcurrent, priority, autoStart) ──

  /** Count how many tasks in the queue are currently downloading. */
  private countActiveInQueue(queueId: string): number {
    return this.tasks.filter(
      t => t.queueId === queueId && t.status === TaskStatus.Downloading
    ).length;
  }

  /**
   * Core scheduler: starts pending tasks in a queue up to maxConcurrent,
   * ordered by priority (higher first).
   */
  async scheduleQueue(queueId: string): Promise<void> {
    const q = this.queues.find(qq => qq.id === queueId);
    if (!q) return;

    const active = this.countActiveInQueue(queueId);
    const slots = q.maxConcurrent - active;
    if (slots <= 0) return;

    // Gather pending/paused tasks in this queue, sorted by priority desc
    const candidates = this.tasks
      .filter(t =>
        t.queueId === queueId &&
        (t.status === TaskStatus.Pending || t.status === TaskStatus.Queued || t.status === TaskStatus.Paused)
      )
      .sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));

    for (let i = 0; i < Math.min(slots, candidates.length); i++) {
      await this.engine.start(candidates[i]);
    }
  }

  /** Start all tasks in a queue (respects maxConcurrent via scheduler). */
  async startQueue(queueId: string): Promise<void> {
    const q = this.queues.find(qq => qq.id === queueId);
    if (!q) return;
    // Set all paused/error tasks in queue to Pending so scheduler picks them up
    for (const t of this.tasks) {
      if (t.queueId === queueId &&
          (t.status === TaskStatus.Paused || t.status === TaskStatus.Error)) {
        t.status = TaskStatus.Pending;
        this.repo.update(t).catch(() => {});
      }
    }
    await this.scheduleQueue(queueId);
  }

  /** Pause all downloading tasks in a queue. */
  pauseQueue(queueId: string): void {
    for (const t of this.tasks) {
      if (t.queueId === queueId && t.status === TaskStatus.Downloading) {
        this.engine.pause(t);
      }
    }
  }

  // ── Queue-level rate limit & daily schedule ──

  /** Apply a per-queue download speed cap to every task in the queue. */
  setQueueSpeedLimit(queueId: string, bytesPerSec: number): void {
    const q = this.queues.find(qq => qq.id === queueId);
    if (!q) return;
    q.speedLimit = Math.max(0, bytesPerSec | 0);
    for (const t of this.tasks) {
      if (t.queueId === queueId) {
        t.speedLimit = q.speedLimit;
        this.repo.update(t).catch(() => {});
      }
    }
    this.queueStore.update(q).catch(() => {});
  }

  /** Configure a queue's daily start/stop window (minutes since midnight). */
  setQueueSchedule(queueId: string, enabled: boolean, startMin: number, stopMin: number): void {
    const q = this.queues.find(qq => qq.id === queueId);
    if (!q) return;
    q.scheduledEnabled = enabled;
    q.startAt = startMin;
    q.stopAt = stopMin;
    this.queueStore.update(q).catch(() => {});
    if (enabled) {
      this.tickQueueSchedules();
    }
  }

  /**
   * Check all queues against their daily schedule and start/stop accordingly.
   * Called on init, on schedule change, and by a 60s timer.
   */
  tickQueueSchedules(): void {
    const now = new Date();
    const minutes = now.getHours() * 60 + now.getMinutes();
    for (const q of this.queues) {
      if (!q.scheduledEnabled || q.taskIds.length === 0) {
        continue;
      }
      const inWindow = this.inScheduleWindow(minutes, q.startAt, q.stopAt);
      if (inWindow) {
        // Start paused/pending tasks up to maxConcurrent (only if any is queued).
        const hasPending = this.tasks.some(t =>
          t.queueId === q.id && (t.status === TaskStatus.Paused || t.status === TaskStatus.Pending || t.status === TaskStatus.Queued));
        if (hasPending) {
          this.scheduleQueue(q.id).catch(() => {});
        }
      } else {
        // Outside window → pause downloading tasks.
        for (const t of this.tasks) {
          if (t.queueId === q.id && t.status === TaskStatus.Downloading) {
            this.engine.pause(t);
          }
        }
      }
    }
  }

  /** True when `min` falls inside [start, stop] handling midnight wrap. */
  private inScheduleWindow(min: number, start: number, stop: number): boolean {
    if (start === stop) {
      return true; // disabled effectively (or 24h window)
    }
    if (start < stop) {
      return min >= start && min < stop;
    }
    // overnight window (e.g. 23:00 → 07:00)
    return min >= start || min < stop;
  }

  private queueTimer: number = -1;

  private startQueueScheduler(): void {
    if (this.queueTimer !== -1) return;
    this.queueTimer = setInterval(() => {
      this.tickQueueSchedules();
    }, 60 * 1000);
  }

  // ── RSS management ──
  async addRss(url: string, name: string, filter: string = ''): Promise<RssSubscription> {
    const sub = new RssSubscription(genId(), url, name);
    sub.filter = filter;
    this.rssSubs.push(sub);
    await this.rssStore.insert(sub);
    return sub;
  }

  /** Persist edits made to an existing subscription (fields are mutated in place). */
  async updateRss(sub: RssSubscription): Promise<void> {
    await this.rssStore.update(sub);
  }

  async removeRss(id: string): Promise<void> {
    await this.rssStore.delete(id);
    this.rssSubs = this.rssSubs.filter(s => s.id !== id);
  }

  async toggleRss(id: string, enabled: boolean): Promise<void> {
    const sub = this.rssSubs.find(s => s.id === id);
    if (sub) {
      sub.enabled = enabled;
      await this.rssStore.update(sub);
    }
  }

  listRss(): RssSubscription[] {
    return this.rssSubs;
  }

  /** Poll all enabled RSS feeds and auto-download matching items. */
  async pollRss(): Promise<number> {
    let added = 0;
    for (const sub of this.rssSubs) {
      if (!sub.enabled) continue;
      const now = Date.now();
      if (now - sub.lastChecked < sub.intervalMin * 60 * 1000) continue;
      const items = await RssParser.fetchAndParse(sub.url);
      sub.lastChecked = now;
      if (sub.autoDownload) {
        for (const item of items) {
          if (sub.downloadedUrls.includes(item.link)) continue;
          if (!RssParser.matchesFilter(item, sub.filter, sub.excludeFilter)) continue;
          if (!RssParser.matchesSize(item, sub.sizeMinMB, sub.sizeMaxMB)) continue;
          if (item.link && /^https?:\/\//i.test(item.link)) {
            await this.addDownload(item.link, undefined, -1, sub.queueId);
            sub.downloadedUrls.push(item.link);
            added++;
          }
        }
      }
      await this.rssStore.update(sub);
    }
    return added;
  }

  private startRssPolling(): void {
    if (this.rssTimer !== -1) return;
    this.rssTimer = setInterval(() => {
      this.pollRss().catch(() => {});
    }, 5 * 60 * 1000); // check every 5 min
  }

  // ── Statistics ──
  getStats(): DownloadStats {
    return StatsCalculator.compute(this.tasks);
  }

  // ── Batch download ──
  async addBatchDownloads(urls: string[]): Promise<number> {
    let added = 0;
    for (const url of urls) {
      const trimmed = url.trim();
      if (trimmed.length === 0) {
        continue;
      }
      // 批量下载：自动处理重复，根据设置里的覆盖/重命名/跳过逻辑
      const result = await this.addDownload(trimmed, undefined, -1, '', undefined, true);
      if (result === 'added') {
        added++;
      }
    }
    return added;
  }

  // ── Category management ──
  setCategoryFilter(category: string): void {
    this.filterCategory = category;
    this.updateVisibleTasks();
  }

  // ── User-defined category CRUD ──
  async createCategory(name: string, extensions: string = '', saveDir: string = '', priority: number = 0): Promise<DownloadCategory> {
    const cat = new DownloadCategory(genId(), name);
    cat.extensions = extensions;
    cat.saveDir = saveDir;
    cat.priority = priority;
    this.categories.push(cat);
    this.categories.sort((a, b) => b.priority - a.priority);
    await this.categoryStore.insert(cat);
    return cat;
  }

  async updateCategory(cat: DownloadCategory, patch: { name?: string; extensions?: string; saveDir?: string; priority?: number }): Promise<void> {
    if (patch.name !== undefined) cat.name = patch.name;
    if (patch.extensions !== undefined) cat.extensions = patch.extensions;
    if (patch.saveDir !== undefined) cat.saveDir = patch.saveDir;
    if (patch.priority !== undefined) cat.priority = patch.priority;
    this.categories.sort((a, b) => b.priority - a.priority);
    await this.categoryStore.update(cat);
  }

  async deleteCategory(id: string): Promise<void> {
    await this.categoryStore.delete(id);
    this.categories = this.categories.filter(c => c.id !== id);
    // Reset the filter if it pointed at the deleted category.
    if (this.filterCategory === id) {
      this.filterCategory = '';
    }
  }

  /** Auto-assign a category to a task based on extension rules (first match wins). */
  assignCategory(task: DownloadTask): void {
    const match = this.categories.find(c => c.matches(task.fileName));
    if (match) {
      task.category = match.name;
      if (match.saveDir) {
        task.dirPath = match.saveDir;
        task.filePath = `${match.saveDir}/${task.fileName}`;
      }
    }
  }

  setSearchQuery(q: string): void {
    this.searchQuery = q;
    this.updateVisibleTasks();
  }

  setStatusFilter(s: string): void {
    this.statusFilter = s;
    this.updateVisibleTasks();
  }

  getCategories(): string[] {
    const cats = new Set<string>();
    for (const t of this.tasks) {
      cats.add(t.category);
    }
    return Array.from(cats).sort();
  }

  /**
   * Apply status / category / keyword filters. Combined with AND semantics:
   *   statusFilter  → by lifecycle state
   *   filterCategory → exact category match
   *   searchQuery    → case-insensitive match against fileName / url
   */
  @Computed
  get filteredTasks(): DownloadTask[] {
    // 强制依赖 refreshTick，确保任务变更时 @Computed 能重新计算
    const tick = this.refreshTick;
    // 总是创建副本，避免 sort/filter 修改原数组导致响应式异常
    let result = this.tasks.filter(() => tick >= 0);
    if (this.statusFilter && this.statusFilter.length > 0) {
      result = result.filter(t => {
        switch (this.statusFilter) {
          case 'queued':
            return t.status === TaskStatus.Queued;
          case 'active':
            return t.status === TaskStatus.Queued || t.status === TaskStatus.Downloading || t.status === TaskStatus.Verifying;
          case 'downloading':
            return t.status === TaskStatus.Downloading || t.status === TaskStatus.Verifying || t.status === TaskStatus.Queued;
          case 'paused':
            return t.status === TaskStatus.Paused;
          case 'completed':
            return t.status === TaskStatus.Completed;
          case 'error':
            return t.status === TaskStatus.Error;
          case 'seeding':
            return t.seedingStatus !== 'none' && t.seedingStatus !== undefined && t.seedingStatus !== null;
          default:
            return true;
        }
      });
    }
    if (this.filterCategory && this.filterCategory.length > 0) {
      if (this.filterCategory.startsWith('builtin_')) {
        result = result.filter(t => matchesBuiltinCategory(t.fileName, this.filterCategory));
      } else {
        result = result.filter(t => t.category === this.filterCategory);
      }
    }
    if (this.queueFilter && this.queueFilter.length > 0) {
      result = result.filter(t => t.queueId === this.queueFilter);
    }
    if (this.searchQuery && this.searchQuery.trim().length > 0) {
      const q = this.searchQuery.trim().toLowerCase();
      result = result.filter(t =>
        t.fileName.toLowerCase().includes(q) || t.url.toLowerCase().includes(q));
    }
    switch (this.sortBy) {
      case 'size':
        return result.sort((a, b) => b.totalBytes - a.totalBytes);
      case 'name':
        return result.sort((a, b) => a.fileName.localeCompare(b.fileName));
      case 'priority':
        return result.sort((a, b) => b.priority - a.priority);
      case 'time':
      default:
        return result.sort((a, b) => b.createdAt - a.createdAt);
    }
  }

  /** 手动更新可见任务列表，彻底绕开@Computed依赖追踪问题 */
  updateVisibleTasks(): void {
    let result = [...this.tasks];
    if (this.statusFilter && this.statusFilter.length > 0) {
      result = result.filter(t => {
        switch (this.statusFilter) {
          case 'queued':
            return t.status === TaskStatus.Queued;
          case 'active':
            return t.status === TaskStatus.Queued || t.status === TaskStatus.Downloading || t.status === TaskStatus.Verifying;
          case 'downloading':
            return t.status === TaskStatus.Downloading || t.status === TaskStatus.Verifying || t.status === TaskStatus.Queued;
          case 'paused':
            return t.status === TaskStatus.Paused;
          case 'completed':
            return t.status === TaskStatus.Completed;
          case 'error':
            return t.status === TaskStatus.Error;
          case 'seeding':
            return t.seedingStatus !== 'none' && t.seedingStatus !== undefined && t.seedingStatus !== null;
          default:
            return true;
        }
      });
    }
    if (this.filterCategory && this.filterCategory.length > 0) {
      if (this.filterCategory.startsWith('builtin_')) {
        result = result.filter(t => matchesBuiltinCategory(t.fileName, this.filterCategory));
      } else {
        result = result.filter(t => t.category === this.filterCategory);
      }
    }
    if (this.queueFilter && this.queueFilter.length > 0) {
      result = result.filter(t => t.queueId === this.queueFilter);
    }
    if (this.searchQuery && this.searchQuery.trim().length > 0) {
      const q = this.searchQuery.trim().toLowerCase();
      result = result.filter(t =>
        t.fileName.toLowerCase().includes(q) || t.url.toLowerCase().includes(q));
    }
    switch (this.sortBy) {
      case 'size':
        result.sort((a, b) => b.totalBytes - a.totalBytes);
        break;
      case 'name':
        result.sort((a, b) => a.fileName.localeCompare(b.fileName));
        break;
      case 'priority':
        result.sort((a, b) => b.priority - a.priority);
        break;
      case 'time':
      default:
        result.sort((a, b) => b.createdAt - a.createdAt);
        break;
    }
    this.visibleTasks = result;
  }

  setQueueFilter(q: string): void {
    this.queueFilter = q;
    this.updateVisibleTasks();
  }

  setSortBy(s: string): void {
    this.sortBy = s;
    this.updateVisibleTasks();
  }

  setTaskCategory(taskId: string, category: string): void {
    const t = this.getTask(taskId);
    if (t) {
      t.category = category;
      this.repo.update(t).catch(() => {});
    }
  }

  setTaskPriority(taskId: string, priority: number): void {
    const t = this.getTask(taskId);
    if (t) {
      t.priority = priority;
      this.tasks.sort((a, b) => b.priority - a.priority);
      this.repo.update(t).catch(() => {});
    }
  }

  setTaskSpeedLimit(taskId: string, bytesPerSec: number): void {
    const t = this.getTask(taskId);
    if (t) {
      t.speedLimit = bytesPerSec;
      this.repo.update(t).catch(() => {});
    }
  }

  async setTaskScheduled(taskId: string, timestamp: number): Promise<void> {
    const t = this.getTask(taskId);
    if (t) {
      t.scheduledAt = timestamp;
      this.repo.update(t).catch(() => {});
      if (timestamp > Date.now()) {
        const delay = timestamp - Date.now();
        setTimeout(() => {
          if (t.status === TaskStatus.Pending || t.status === TaskStatus.Queued) {
            this.engine.resume(t).catch(() => {});
          }
        }, delay);
      }
    }
  }

  setTaskAuth(taskId: string, authHeader: string): void {
    const t = this.getTask(taskId);
    if (t) {
      t.authHeader = authHeader;
      this.repo.update(t).catch(() => {});
    }
  }

  // ── Extended settings ──
  setGlobalSpeedLimit(bytesPerSec: number): void {
    this.globalSpeedLimit = bytesPerSec;
    SpeedLimiter.global().setLimit(bytesPerSec);
    this.settings.put('globalSpeedLimit', bytesPerSec);
  }

  setProxyUrl(url: string): void {
    this.proxyUrl = url;
    this.settings.put('proxyUrl', url);
  }

  setGithubMirrorUrl(url: string): void {
    this.githubMirrorUrl = url;
    this.settings.put('githubMirrorUrl', url);
    this.engine.setGithubMirrorUrl(url);
  }

  setColorScheme(scheme: string): void {
    this.colorScheme = scheme;
    this.settings.put('colorScheme', scheme);
  }

  setClipboardMonitor(enabled: boolean): void {
    this.clipboardMonitor = enabled;
    this.settings.put('clipboardMonitor', enabled);
    if (enabled) {
      this.startClipboardMonitor();
    } else {
      this.stopClipboardMonitor();
    }
  }

  setNotifyOnComplete(on: boolean): void {
    this.notifyOnComplete = on;
    this.settings.put('notifyOnComplete', on);
    NotificationHelper.getInstance().setEnabled(on);
  }

  setAutoRetry(count: number, delaySec: number): void {
    this.autoRetryCount = Math.max(0, Math.min(10, Math.floor(count)));
    this.autoRetryDelaySec = Math.max(1, Math.min(600, Math.floor(delaySec)));
    this.settings.put('autoRetryCount', this.autoRetryCount);
    this.settings.put('autoRetryDelaySec', this.autoRetryDelaySec);
  }

  setFileExistsBehavior(behavior: string): void {
    this.fileExistsBehavior = behavior;
    this.settings.put('fileExistsBehavior', behavior);
  }

  setFileMissingAction(action: string): void {
    this.fileMissingAction = action;
    this.settings.put('fileMissingAction', action);
  }

  setUseServerTime(enabled: boolean): void {
    this.useServerTime = enabled;
    this.settings.put('useServerTime', enabled);
  }

  /** Persist the full BT settings object (mutated in place by the settings UI). */
  async saveBtSettings(): Promise<void> {
    if (this.btSettings) {
      await this.btSettingsStore.save(this.btSettings);
      // Re-apply to the live BT engine so changes take effect immediately.
      BtEngine.getInstance().applySettings(this.btSettings);
    }
  }

  /** Start polling the system clipboard for downloadable URLs. */
  private startClipboardMonitor(): void {
    if (this.clipboardTimer >= 0) {
      return;
    }
    this.clipboardTimer = setInterval(() => {
      this.checkClipboard();
    }, 1000);
  }

  /** Stop clipboard polling. */
  private stopClipboardMonitor(): void {
    if (this.clipboardTimer >= 0) {
      clearInterval(this.clipboardTimer);
      this.clipboardTimer = -1;
    }
  }

  /** Read clipboard; if it contains a new URL, auto-add as download. */
  private checkClipboard(): void {
    try {
      const pasteData = pasteboard.getSystemPasteboard().getDataSync();
      if (!pasteData || pasteData.getRecordCount() === 0) {
        return;
      }
      const record = pasteData.getPrimaryText();
      if (!record || record === this.lastClipboardText) {
        return;
      }
      this.lastClipboardText = record;
      const trimmed = record.trim();
      // Only process if it looks like a downloadable URL
      const lower = trimmed.toLowerCase();
      const isUrl = lower.startsWith('http://') || lower.startsWith('https://') ||
        lower.startsWith('ftp://') || lower.startsWith('sftp://') ||
        lower.startsWith('ed2k://') || lower.startsWith('magnet:') ||
        lower.startsWith('thunder://') || lower.startsWith('flashget://') ||
        lower.startsWith('qqdl://') || lower.startsWith('bt://') ||
        lower.endsWith('.torrent');
      if (!isUrl) {
        return;
      }
      // Avoid duplicates: skip if already in task list
      const exists = this.tasks.some(t => t.url === trimmed);
      if (exists) {
        return;
      }
      this.addDownload(trimmed).catch(() => {});
    } catch (_e) {
      // Clipboard read may fail silently
    }
  }
}
