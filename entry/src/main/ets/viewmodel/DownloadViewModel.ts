import { DownloadTask } from '../model/DownloadTask';
import { TaskStatus } from '../model/TaskStatus';
import { DownloadEngine } from '../engine/DownloadEngine';
import { EngineListener } from '../engine/types';
import { TaskRepository } from '../store/TaskRepository';
import { McpServer } from '../mcp/McpServer';
import { McpBackend } from '../mcp/McpBackend';
import { SettingsStore } from '../store/SettingsStore';
import { DownloadQueue } from '../model/DownloadQueue';
import { RssSubscription, RssItem } from '../model/RssSubscription';
import { QueueStore } from '../store/QueueStore';
import { BackgroundTaskManager } from '../util/BackgroundTaskManager';
import { RssStore } from '../store/RssStore';
import { StatsCalculator, DownloadStats } from '../utils/StatsCalculator';
import { SpeedLimiter } from '../utils/SpeedLimiter';
import { RssParser } from '../utils/RssParser';
import { genId } from '../utils/common';
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
  @Trace theme: 'light' | 'dark' = 'light';
  @Trace maxSegments: number = 8;
  @Trace verifyIntegrity: boolean = true;
  @Trace mcpEnabled: boolean = false;
  @Trace mcpToken: string = 'fluxdowncover-local';
  // ── Extended settings (FluxDown Cover feature parity) ──
  @Trace globalSpeedLimit: number = 0; // bytes/sec, 0 = unlimited
  @Trace proxyUrl: string = ''; // global proxy URL
  @Trace colorScheme: string = 'cyan'; // accent color scheme id
  @Trace clipboardMonitor: boolean = false; // auto-detect URLs from clipboard
  @Trace queues: DownloadQueue[] = [];
  @Trace rssSubs: RssSubscription[] = [];
  @Trace filterCategory: string = ''; // current category filter ('' = all)

  private engine: DownloadEngine = DownloadEngine.getInstance();
  private mcp: McpServer = McpServer.getInstance();
  private repo: TaskRepository = new TaskRepository();
  private settings = SettingsStore.getInstance();
  private queueStore: QueueStore = new QueueStore();
  private rssStore: RssStore = new RssStore();
  private rssTimer: number = -1;
  private clipboardTimer: number = -1;
  private lastClipboardText: string = '';

  async init(context: common.UIAbilityContext): Promise<void> {
    // Load persisted settings before anything else
    await this.settings.init(context);
    this.theme = await this.settings.getString('theme', 'light') as 'light' | 'dark';
    this.maxSegments = await this.settings.getNumber('maxSegments', 8);
    this.verifyIntegrity = await this.settings.getBoolean('verifyIntegrity', false);
    this.mcpEnabled = await this.settings.getBoolean('mcpEnabled', false);
    this.mcpToken = await this.settings.getString('mcpToken', 'fluxdowncover-local');
    // Load extended settings
    this.globalSpeedLimit = await this.settings.getNumber('globalSpeedLimit', 0);
    this.proxyUrl = await this.settings.getString('proxyUrl', '');
    this.colorScheme = await this.settings.getString('colorScheme', 'cyan');
    this.clipboardMonitor = await this.settings.getBoolean('clipboardMonitor', false);

    this.engine.setListener(this);
    this.engine.setMaxSegments(this.maxSegments);
    this.tasks = await this.engine.restore();
    // Sort by priority (highest first)
    this.tasks.sort((a, b) => b.priority - a.priority);

    // Initialize extended stores
    await this.queueStore.ensureTable();
    await this.rssStore.ensureTable();
    this.queues = await this.queueStore.queryAll();
    this.rssSubs = await this.rssStore.queryAll();

    // Apply global speed limit
    SpeedLimiter.global().setLimit(this.globalSpeedLimit);

    // Start RSS polling
    this.startRssPolling();

    // Start clipboard monitor if enabled
    if (this.clipboardMonitor) {
      this.startClipboardMonitor();
    }
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
    this.updateBackgroundTask();
  }

  /** Remove multiple tasks by their ids. */
  removeTasks(ids: string[]): void {
    for (const id of ids) {
      const task = this.tasks.find(t => t.id === id);
      if (task) {
        this.engine.remove(task);
        const i = this.tasks.indexOf(task);
        if (i >= 0) {
          this.tasks.splice(i, 1);
        }
      }
    }
    this.updateBackgroundTask();
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
      if (t.status === TaskStatus.Downloading) {
        this.engine.pause(t);
      }
    }
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
  }

  onTaskCompleted(task: DownloadTask): void {
    this.repo.update(task).catch(() => {});
    // Best-effort: push the finished file into the public Download directory.
    this.exportToDownload(task).catch((e: Error) => {
      console.error(`FluxDown Cover auto-export failed: ${JSON.stringify(e)}`);
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
    this.updateBackgroundTask();
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

  // ── Extended MCP backend methods ──
  pauseAllTasks(): void {
    for (const t of this.tasks) {
      if (t.status === TaskStatus.Downloading || t.status === TaskStatus.Pending || t.status === TaskStatus.Queued) {
        this.engine.pause(t);
      }
    }
  }

  async resumeAllTasks(): Promise<void> {
    for (const t of this.tasks) {
      if (t.status === TaskStatus.Paused) {
        await this.engine.resume(t);
      }
    }
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

  // ── RSS management ──
  async addRss(url: string, name: string, filter: string = ''): Promise<RssSubscription> {
    const sub = new RssSubscription(genId(), url, name);
    sub.filter = filter;
    this.rssSubs.push(sub);
    await this.rssStore.insert(sub);
    return sub;
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
          if (!RssParser.matchesFilter(item, sub.filter)) continue;
          if (item.link && /^https?:\/\//i.test(item.link)) {
            await this.addDownload(item.link);
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
      if (trimmed.length > 0 && /^https?:\/\//i.test(trimmed)) {
        await this.addDownload(trimmed);
        added++;
      }
    }
    return added;
  }

  // ── Category management ──
  setCategoryFilter(category: string): void {
    this.filterCategory = category;
  }

  getCategories(): string[] {
    const cats = new Set<string>();
    for (const t of this.tasks) {
      cats.add(t.category);
    }
    return Array.from(cats).sort();
  }

  getFilteredTasks(): DownloadTask[] {
    let result = this.tasks;
    if (this.filterCategory && this.filterCategory.length > 0) {
      result = result.filter(t => t.category === this.filterCategory);
    }
    return result.sort((a, b) => b.priority - a.priority);
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
