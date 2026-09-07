import { http, connection } from '@kit.NetworkKit';
import { BusinessError } from '@kit.BasicServicesKit';
import { common } from '@kit.AbilityKit';
import { picker, fileUri } from '@kit.CoreFileKit';
import fs from '@ohos.file.fs';
import { DownloadTask, Segment } from '../model/DownloadTask';
import { TaskStatus } from '../model/TaskStatus';
import { ProtocolType } from '../model/ProtocolType';
import { genId, sanitizeFileName, fileNameFromUrl, detectProtocol, safePercentDecode } from '../utils/common';
import { logCollector } from '../utils/LogCollector';
import { TaskRepository } from '../store/TaskRepository';
import { EngineListener, Ctrl } from './types'
import { SpeedLimiter } from '../utils/SpeedLimiter';;
import { EngineHooks, ProxyConfig } from './EngineHooks';
import { hashFile } from './HashTask';
import { buildHlsSegments, downloadHls } from './protocols/HlsProtocol';
import { buildDashSegments, downloadDash } from './protocols/DashProtocol';
import { downloadFtp } from './protocols/FtpProtocol';
import { downloadBittorrent } from './protocols/BittorrentProtocol';
import { downloadEd2k } from './protocols/Ed2kProtocol';
import { decodeWrapperLink } from './protocols/ThunderProtocol';
import { BtEngine } from './BtEngine';

/**
 * Core download engine. Implements FluxDown Cover's headline features:
 *  - multi-threaded / multi-segment HTTP(S) download with dynamic segmentation
 *  - resumable transfers (per-segment progress persisted to SQLite)
 *  - HLS (m3u8) and FTP (passive) protocols
 *  - SHA-256 integrity verification off the UI thread (TaskPool)
 *
 * The engine mutates the very DownloadTask objects the UI holds, so @Trace field
 * changes flow straight into ArkUI. The ViewModel is notified only for persistence.
 */
export class DownloadEngine implements EngineHooks {
  private static instance: DownloadEngine | null = null;
  private context: common.Context | null = null;
  private defaultDirPath: string = '';
  private repo: TaskRepository = new TaskRepository();
  private listener: EngineListener | null = null;
  private useServerTime: boolean = false;

  private active: Set<DownloadTask> = new Set();
  private controls: Map<string, Ctrl> = new Map();
  private maxSegments: number = 8;
  private githubMirrorUrl: string = '';
  private ignoreTlsErrors: boolean = false;
  private proxyUrl: string = '';
  private ticker: number | null = null;
  private prevLive: Map<string, number> = new Map();
  private lastTick: Map<string, number> = new Map();
  private lastPersist: Map<string, number> = new Map();

  static getInstance(): DownloadEngine {
    if (!DownloadEngine.instance) {
      DownloadEngine.instance = new DownloadEngine();
    }
    return DownloadEngine.instance;
  }

  init(context: common.UIAbilityContext): void {
    this.context = context;
    this.defaultDirPath = `${context.filesDir}/downloads`;
    try {
      fs.mkdirSync(this.defaultDirPath);
    } catch (e) {
      // directory may already exist
    }
    // Bring up the BitTorrent engine (DHT / PeerServer / UPnP) and route its
    // per-task stat updates back into the UI via the engine listener.
    BtEngine.getInstance().setUiListener((task: DownloadTask) => {
      this.listener?.onTaskUpdated(task);
    });
    BtEngine.getInstance().init().catch((e) => {
      logCollector.warn('Warn', `FluxDown Cover BtEngine init failed: ${(e as Error).message}`);
    });
  }

  setListener(listener: EngineListener): void {
    this.listener = listener;
  }

  /** Per-task limiters cache (keyed by task id, recreated on limit change). */
  private taskLimiters: Map<string, SpeedLimiter> = new Map();

  private taskLimiter(taskId: string, limit: number): SpeedLimiter {
    let lim = this.taskLimiters.get(taskId);
    if (!lim) {
      lim = new SpeedLimiter(limit);
      this.taskLimiters.set(taskId, lim);
    } else if (lim.getLimit() !== limit) {
      lim.setLimit(limit);
    }
    return lim;
  }

  /** User-initiated seeding for a completed BT task. */
  startSeeding(task: DownloadTask): void {
    BtEngine.getInstance().startSeeding(task);
  }

  /** User-initiated stop seeding for a BT task. */
  stopSeeding(task: DownloadTask, reason: string = 'userStopped'): void {
    BtEngine.getInstance().stopSeeding(task, reason);
  }

  setMaxSegments(n: number): void {
    this.maxSegments = Math.max(1, Math.min(32, n | 0));
  }

  setGithubMirrorUrl(url: string): void {
    this.githubMirrorUrl = url.trim();
  }

  setUseServerTime(enabled: boolean): void {
    this.useServerTime = enabled;
  }

  setIgnoreTlsErrors(enabled: boolean): void {
    this.ignoreTlsErrors = enabled;
  }

  setProxyUrl(url: string): void {
    this.proxyUrl = (url || '').trim();
  }

  // ---- EngineHooks ----
  onChunk(task: DownloadTask, len: number): void {
    task.liveBytes += len;
  }

  defaultDir(): string {
    return this.defaultDirPath;
  }

  /** Whether TLS certificate validation errors should be skipped (self-signed / legacy HTTPS). */
  shouldIgnoreTlsErrors(): boolean {
    return this.ignoreTlsErrors;
  }

  /**
   * Throttle a whole fetched chunk against the global + per-task speed limits.
   * Used by HLS/DASH, which fetch one segment per request (the HTTP segmented
   * path instead throttles inside its streaming write loop).
   */
  async throttle(task: DownloadTask, len: number): Promise<void> {
    let waitMs = SpeedLimiter.global().waitTime(len);
    if (task.speedLimit > 0) {
      const tw = this.taskLimiter(task.id, task.speedLimit).waitTime(len);
      if (tw > waitMs) {
        waitMs = tw;
      }
    }
    if (waitMs > 0) {
      await new Promise<void>(resolve => setTimeout(resolve, waitMs));
    }
    if (SpeedLimiter.global().getLimit() > 0) {
      SpeedLimiter.global().tryConsume(len);
    }
    if (task.speedLimit > 0) {
      this.taskLimiter(task.id, task.speedLimit).tryConsume(len);
    }
  }

  /** Parse the user's proxy URL ("http://[user:pass@]host:port") into an HttpProxy descriptor. */
  proxyOption(): ProxyConfig | undefined {
    let rest = (this.proxyUrl || '').trim();
    if (!rest) {
      return undefined;
    }
    const schemeIdx = rest.indexOf('://');
    if (schemeIdx >= 0) {
      rest = rest.substring(schemeIdx + 3);
    }
    const slash = rest.indexOf('/');
    if (slash >= 0) {
      rest = rest.substring(0, slash);
    }
    let username: string | undefined;
    let password: string | undefined;
    const at = rest.lastIndexOf('@'); // split optional userinfo
    if (at >= 0) {
      const userinfo = rest.substring(0, at);
      rest = rest.substring(at + 1);
      const ci = userinfo.indexOf(':');
      if (ci >= 0) {
        username = userinfo.substring(0, ci);
        password = userinfo.substring(ci + 1);
      } else {
        username = userinfo;
      }
    }
    const colon = rest.lastIndexOf(':');
    if (colon < 0) {
      return undefined;
    }
    const host = rest.substring(0, colon);
    const port = parseInt(rest.substring(colon + 1), 10);
    if (!host || !isFinite(port) || port <= 0 || port > 65535) {
      return undefined;
    }
    const cfg: ProxyConfig = { host, port, exclusionList: [] };
    if (username) {
      cfg.username = username;
    }
    if (password) {
      cfg.password = password;
    }
    return cfg;
  }

  /** Merge per-task UA / Cookie / Referer / custom headers with base headers. */
  private buildHttpHeaders(task: DownloadTask, base: Record<string, string>): Record<string, string> {
    const h: Record<string, string> = { ...base };
    h['User-Agent'] = task.ua || 'FluxDownCover/1.0';
    if (task.cookie.length > 0) {
      h['Cookie'] = task.cookie;
    }
    if (task.referer.length > 0) {
      h['Referer'] = task.referer;
    }
    if (task.customHeaders.length > 0) {
      for (const line of task.customHeaders.split('\n')) {
        const idx = line.indexOf(':');
        if (idx > 0) {
          const k = line.substring(0, idx).trim();
          const v = line.substring(idx + 1).trim();
          if (k.length > 0) {
            h[k] = v;
          }
        }
      }
    }
    return h;
  }

  getContext(): common.Context {
    return this.context as common.Context;
  }

  /**
   * 对 GitHub release 链接自动添加镜像前缀（如 ghproxy.net），
   * 使国内用户可直接下载。
   * 同时将 URL 中的非 ASCII 字符（如中文）进行百分号编码。
   * 用户未配置镜像时，默认使用公共镜像加速境外下载。
   */
  private applyMirror(url: string): string {
    // 1. URL-encode 非 ASCII 字符（如中文标签「最新发行版」），避免 HTTP 库解析失败
    url = this.safeEncodeUrl(url);

    // 2. 非 GitHub 链接不做镜像处理（境内直链正常多线程下载）
    if (!url.includes('github.com')) {
      return url;
    }

    // 3. 已经是镜像URL（包含已知镜像域名），不重复添加前缀
    const knownMirrors = ['gh-proxy.com', 'mirror.ghproxy.com', 'ghproxy.com', 'ghfast.top', 'gh.api.99988866.xyz'];
    for (const m of knownMirrors) {
      if (url.includes(m)) {
        return url;
      }
    }

    // 4. 用户配置了镜像则用用户的，否则用默认公共镜像加速境外下载
    const mirror = this.githubMirrorUrl || 'https://gh-proxy.com/';

    // 避免重复添加镜像前缀
    const normalizedMirror = mirror.endsWith('/') ? mirror : mirror + '/';
    if (url.startsWith(normalizedMirror)) {
      return url;
    }
    return normalizedMirror + url;
  }

  /** 仅对非 ASCII 字符进行百分号编码，避免对已编码的 URL 重复编码 */
  private safeEncodeUrl(url: string): string {
    try {
      return url.replace(/[^\x00-\x7F]/g, (ch: string) => encodeURIComponent(ch));
    } catch (_) {
      return url;
    }
  }

  // ---- Task lifecycle ----

  async addTask(
    url: string,
    opts?: { fileName?: string; dirPath?: string; protocol?: ProtocolType; verify?: boolean; queueId?: string; fileExists?: string; ua?: string; segmentCount?: number; cookie?: string; referer?: string; headers?: string }
  ): Promise<DownloadTask> {
    const task = new DownloadTask();
    task.id = genId();
    task.url = url.trim();
    task.protocol = detectProtocol(task.url, opts?.protocol);
    task.fileName = sanitizeFileName(opts?.fileName || fileNameFromUrl(task.url) || `file_${task.id}`);
    task.dirPath = opts?.dirPath || this.defaultDir();
    task.filePath = `${task.dirPath}/${task.fileName}`;
    task.queueId = opts?.queueId || '';
    task.ua = opts?.ua || '';
    task.segmentCount = opts?.segmentCount || 0;
    task.cookie = opts?.cookie || '';
    task.referer = opts?.referer || '';
    task.customHeaders = opts?.headers || '';
    // File-exists policy: skip (mark completed), rename (append suffix), overwrite (default).
    // Official default is auto-rename — overwrite would silently destroy an
    // existing file on a duplicate download.
    const policy = opts?.fileExists || 'rename';
    if (policy !== 'overwrite') {
      try {
        if (fs.accessSync(task.filePath)) {
          if (policy === 'skip') {
            const st = fs.statSync(task.filePath);
            task.totalBytes = st.size;
            task.downloadedBytes = st.size;
            task.liveBytes = st.size;
            task.status = TaskStatus.Completed;
            task.finishedAt = Date.now();
          } else if (policy === 'rename') {
            task.fileName = this.uniqueFileName(task.dirPath, task.fileName);
            task.filePath = `${task.dirPath}/${task.fileName}`;
          }
        }
      } catch (e) {
        // access/stat failed → treat as missing, continue normally
      }
    }
    task.createdAt = Date.now();
    task.status = TaskStatus.Queued;
    task.verifyIntegrity = opts?.verify ?? true;
    await this.repo.insert(task);
    return task;
  }

  /** Load persisted tasks on startup; interrupted downloads are reset to Paused. */
  async restore(): Promise<DownloadTask[]> {
    const tasks = await this.repo.queryAll();
    for (const t of tasks) {
      if (t.status === TaskStatus.Downloading || t.status === TaskStatus.Verifying) {
        t.status = TaskStatus.Paused;
      }
    }
    return tasks;
  }

  async start(task: DownloadTask): Promise<void> {
    if (task.status === TaskStatus.Downloading) {
      return;
    }
    if (task.status === TaskStatus.Completed) {
      // File already exists policy marked it done — nothing to download.
      this.listener?.onTaskCompleted(task);
      return;
    }
    if (task.protocol === ProtocolType.SFTP) {
      task.status = TaskStatus.Error;
      task.errorMessage =
        'SFTP 协议暂不支持。SFTP 需要 SSH 加密传输层，建议使用 FTP 或将文件转为 HTTP 直链下载。';
      this.listener?.onTaskError(task, task.errorMessage);
      return;
    }
    if (task.protocol === ProtocolType.THUNDER ||
        task.protocol === ProtocolType.FLASHGET ||
        task.protocol === ProtocolType.QQDL) {
      const decoded = decodeWrapperLink(task.url);
      if (!decoded) {
        task.status = TaskStatus.Error;
        task.errorMessage = `链接解析失败：无法解码 ${task.protocol}:// 链接，请检查链接是否完整。`;
        this.listener?.onTaskError(task, task.errorMessage);
        return;
      }
      if (decoded.protocol === ProtocolType.SFTP) {
        task.status = TaskStatus.Error;
        task.errorMessage = '解码后的链接为 SFTP 协议，暂不支持，敬请期待。';
        this.listener?.onTaskError(task, task.errorMessage);
        return;
      }
      // Update task with the real URL, keeping the original wrapper protocol for UI display.
      task.url = decoded.url;
      if (!task.fileName || task.fileName === '') {
        task.fileName = fileNameFromUrl(decoded.url);
      }
      // Do NOT overwrite task.protocol — keep THUNDER/FLASHGET/QQDL so the UI shows
      // the correct wrapper label. The dispatch section below will re-detect protocol
      // from the decoded URL to route to the correct handler.
    }

    // BitTorrent: skip ensureFile — the output filename comes from .torrent metadata,
    // not from the URL. downloadBittorrent will set filePath after parsing.
    // Ensure dirPath is valid (may be empty when restored from older DB records).
    task.dirPath = task.dirPath || this.defaultDir();
    if (task.protocol !== ProtocolType.BITTORRENT) {
      this.ensureFile(task);
    }

    // MUST set status BEFORE any I/O (probe / segment building) that could throw,
    // otherwise the task stays stuck in Queued forever.
    task.status = TaskStatus.Downloading;
    this.active.add(task);
    this.ensureTicker();
    this.listener?.onTaskUpdated(task);

    // 在网络 I/O 前检查连通性，避免无网络时长时间卡在"分析中"状态
    await this.checkNetwork(task);

    if (task.protocol === ProtocolType.HLS) {
      if (task.segments.length === 0) {
        await buildHlsSegments(task, task.hlsQualityIndex, this);
      }
    } else if (task.protocol === ProtocolType.DASH) {
      if (task.segments.length === 0) {
        await buildDashSegments(task, this);
      }
    } else if (task.protocol === ProtocolType.FTP) {
      // handled entirely by downloadFtp
    } else if (task.protocol === ProtocolType.BITTORRENT) {
      // handled entirely by downloadBittorrent
    } else {
      if (task.totalBytes === 0 && task.segments.length === 0) {
        const info = await this.probe(task);
        // 清除探测阶段可能残留的重试提示
        if (task.errorMessage?.startsWith('正在探测')) {
          task.errorMessage = '';
        }
        // 服务器返回的文件名（Content-Disposition / URL）优先于本地生成的占位名。
        // 修复：此前仅在 fileName 为空时才应用探测名，而 addTask 总会预填
        // `file_<id>` 占位名，条件永假 —— URL 中不含文件名的下载（如带查询串的
        // 动态链接）最终保存为 `file_fd_xxx`，原名丢失且无后缀。
        if (info.name && this.shouldUseProbedName(task.fileName, info.name)) {
          const oldPath = task.filePath;
          task.fileName = sanitizeFileName(info.name);
          const newPath = `${task.dirPath}/${task.fileName}`;
          if (oldPath && oldPath !== newPath) {
            // 删除此前以占位名预创建的空文件，避免残留
            try { fs.unlinkSync(oldPath); } catch (_) { }
          }
        }
        this.ensureFile(task);
        // 获取 CDN 直链地址：优先从探测响应头获取，失败则主动解析重定向
        let realUrl = info.realUrl;
        if (!realUrl) {
          realUrl = await this.resolveRedirectUrl(task.url, task);
        }
        this.buildSegments(task, info.total, info.acceptRanges, realUrl);
        // Pre-allocate file space to avoid on-demand extent growth during writes
        if (info.total > 0) {
          try { fs.truncateSync(task.filePath, info.total); } catch (_) {}
        }
      }
    }

    const ctrl: Ctrl = { aborted: false };
    this.controls.set(task.id, ctrl);

    // For wrapper protocols (thunder://, flashget://, qqdl://), the URL has been
    // decoded above; re-detect protocol from the actual URL for dispatching.
    const dispatchProtocol: ProtocolType =
      task.protocol === ProtocolType.THUNDER ||
      task.protocol === ProtocolType.FLASHGET ||
      task.protocol === ProtocolType.QQDL
        ? detectProtocol(task.url)
        : task.protocol;

    try {
      if (dispatchProtocol === ProtocolType.FTP) {
        await downloadFtp(task, ctrl, this);
      } else if (dispatchProtocol === ProtocolType.HLS) {
        await downloadHls(task, ctrl, this);
      } else if (dispatchProtocol === ProtocolType.DASH) {
        await downloadDash(task, ctrl, this);
      } else if (dispatchProtocol === ProtocolType.BITTORRENT) {
        await downloadBittorrent(task, ctrl, this);
      } else if (dispatchProtocol === ProtocolType.ED2K) {
        await downloadEd2k(task, ctrl, this);
      } else if (dispatchProtocol === ProtocolType.SFTP) {
        // SFTP 目前未实现：给出明确的兜底提示，而不是走 HTTP 通道报 URL 解析错。
        throw new Error('SFTP 协议暂未支持，请使用 HTTP/HTTPS 链接');
      } else {
        const pending = task.segments.filter((s) => !s.done);
        if (pending.length === 0) {
          this.finalizeCompleted(task);
          return;
        }
        // 每段独立重试（最多 3 次），避免单段超时导致整个任务失败
        const downloadWithRetry = async (seg: Segment): Promise<void> => {
          const MAX_RETRIES = 3;
          const originalUrl = seg.url ?? task.url;
          const isGithub = originalUrl.includes('github.com');
          for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
            try {
              if (isGithub) {
                // GitHub 链接：第一次就用镜像，不浪费时间试官方直连；重试时切换其他镜像
                const mirrors = ['https://gh-proxy.com/', 'https://mirror.ghproxy.com/', 'https://ghproxy.com/', 'https://ghfast.top/'];
                const mirror = this.githubMirrorUrl || mirrors[attempt % mirrors.length];
                const normalizedMirror = mirror.endsWith('/') ? mirror : mirror + '/';
                seg.url = normalizedMirror + this.safeEncodeUrl(originalUrl);
              } else {
                seg.url = originalUrl;
              }
              await this.downloadSegment(task, seg, ctrl);
              if (task.errorMessage?.startsWith('正在重试')) {
                task.errorMessage = ''; // 重试成功，清除临时提示
              }
              return;
            } catch (e) {
              if (ctrl.aborted || attempt >= MAX_RETRIES) {
                throw e;
              }
              // 推送重试提示到 UI，让用户知道任务还在进行而非卡死
              task.errorMessage = `正在重试 (${attempt + 1}/${MAX_RETRIES})...`;
              this.listener?.onTaskUpdated(task);
              // 指数退避：1s, 2s, 4s
              await new Promise(r => setTimeout(r, 1000 * Math.pow(2, attempt)));
            }
          }
        };
        await this.runPool(pending.map((s) => () => downloadWithRetry(s)), this.maxSegments);
      }

      if (ctrl.aborted) {
        task.status = TaskStatus.Paused;
      } else if (dispatchProtocol === ProtocolType.HLS || dispatchProtocol === ProtocolType.DASH) {
        // HLS/DASH：分片已在 downloadHls/downloadDash 内顺序拼装到目标文件。
        // 拼装完成即进入独立的"合并中"阶段（覆盖收尾/校验窗口），
        // 避免用户看到 100% 却仍显示"下载中"而产生卡死错觉（官方有独立中间态）。
        task.status = TaskStatus.Merging;
        this.listener?.onTaskUpdated(task);
        await this.verify(task);
        this.finalizeCompleted(task);
      } else {
        task.status = TaskStatus.Verifying;
        this.listener?.onTaskUpdated(task);
        await this.verify(task);
        this.finalizeCompleted(task);
      }
    } catch (e) {
      task.status = TaskStatus.Error;
      // verify() 已写入面向用户的“完整性校验失败”消息时予以保留，其余按网络错误翻译
      const keepMessage = task.errorMessage !== undefined && task.errorMessage.startsWith('完整性校验失败');
      if (!keepMessage) {
        task.errorMessage = this.translateNetworkError(e as Error | null);
      }
      this.listener?.onTaskError(task, task.errorMessage);
    } finally {
      this.active.delete(task);
      this.controls.delete(task.id);
    }
  }

  pause(task: DownloadTask): void {
    task.status = TaskStatus.Paused;
    const ctrl = this.controls.get(task.id);
    if (ctrl) {
      ctrl.aborted = true;
    }
    // 从 active 集合移除，停止 ticker 更新，避免探测完成后状态被改回
    this.active.delete(task);
    // If this is a BitTorrent task currently seeding, stop the seed too.
    if (task.protocol === ProtocolType.BITTORRENT &&
        (task.seedingStatus === 'seeding' || task.seedingStatus === 'queued')) {
      BtEngine.getInstance().stopSeeding(task, 'userStopped');
    }
    // 保存暂停状态到数据库
    this.repo.update(task).catch(() => {});
  }

  resume(task: DownloadTask): Promise<void> {
    return this.start(task);
  }

  remove(task: DownloadTask, keepFile: boolean = false): void {
    const ctrl = this.controls.get(task.id);
    if (ctrl) {
      ctrl.aborted = true;
    }
    // Stop + clean up any active seed for this task (closes the piece file).
    if (task.protocol === ProtocolType.BITTORRENT) {
      BtEngine.getInstance().removeSeed(task);
    }
    if (!keepFile) {
      // Delete sandbox file
      try {
        if (task.filePath) {
          fs.unlinkSync(task.filePath);
        }
      } catch (e) {
        // file may not exist yet
      }
      // Delete public export copy if one exists
      try {
        if (task.publicPath) {
          fs.unlinkSync(task.publicPath);
        }
      } catch (e) {
        // public file may not exist
      }
    }
    this.repo.delete(task.id).catch(() => {});
  }

  /**
   * Rename a task's output file on disk and update persistence.
   * Safe only when the task is not actively downloading.
   */
  async renameTask(task: DownloadTask, newName: string): Promise<void> {
    const name = sanitizeFileName(newName);
    if (!name || name === task.fileName) {
      return;
    }
    if (task.status === TaskStatus.Downloading || task.status === TaskStatus.Verifying) {
      throw new Error('任务正在下载，请先暂停后再重命名');
    }
    const oldPath = task.filePath;
    const newPath = `${task.dirPath}/${name}`;
    if (oldPath && fs.accessSync(oldPath)) {
      if (fs.accessSync(newPath)) {
        throw new Error('目标文件名已存在');
      }
      fs.renameSync(oldPath, newPath);
    }
    task.fileName = name;
    task.filePath = newPath;
    // If a public export copy exists, rename it too (best effort).
    if (task.publicPath) {
      try {
        const newPub = `${task.publicPath.substring(0, task.publicPath.lastIndexOf('/') + 1)}${name}`;
        fs.renameSync(task.publicPath, newPub);
        task.publicPath = newPub;
      } catch (_) {
        // public copy may not exist / not movable — keep old path
      }
    }
    await this.repo.update(task);
  }

  /**
   * Move a task's file to another directory (creates it if needed).
   * Safe only when the task is not actively downloading.
   */
  async moveTask(task: DownloadTask, newDir: string): Promise<void> {
    if (!newDir || newDir === task.dirPath) {
      return;
    }
    if (task.status === TaskStatus.Downloading || task.status === TaskStatus.Verifying) {
      throw new Error('任务正在下载，请先暂停后再移动');
    }
    if (!fs.accessSync(newDir)) {
      fs.mkdirSync(newDir);
    }
    const oldPath = task.filePath;
    const newPath = `${newDir}/${task.fileName}`;
    if (oldPath && fs.accessSync(oldPath)) {
      if (fs.accessSync(newPath)) {
        throw new Error('目标位置已存在同名文件');
      }
      fs.renameSync(oldPath, newPath);
    }
    task.dirPath = newDir;
    task.filePath = newPath;
    await this.repo.update(task);
  }

  /**
   * Re-check a task: recompute file size / SHA-256 for completed tasks, or reset
   * a paused/error task's progress and re-download it (existing bytes are
   * discarded because the server may have changed). Mirrors FluxDown's
   * "重新检查" action.
   */
  async recheck(task: DownloadTask): Promise<void> {
    if (task.status === TaskStatus.Downloading || task.status === TaskStatus.Verifying) {
      throw new Error('任务正在下载，无法重新检查');
    }
    if (task.protocol === ProtocolType.BITTORRENT) {
      // BT: hand the completed file back to the engine; progress comes from pieces.
      const err = 'BT 任务请在下载页重新开始以重新校验分片';
      task.errorMessage = err;
      throw new Error(err);
    }
    if (task.status === TaskStatus.Completed) {
      // Recompute hash + size on the existing file.
      try {
        if (!fs.accessSync(task.filePath)) {
          throw new Error('文件不存在，无法重新检查');
        }
        const stat = fs.statSync(task.filePath);
        task.totalBytes = stat.size;
        task.downloadedBytes = stat.size;
        task.liveBytes = stat.size;
        task.sha256 = await hashFile(task.filePath);
        await this.repo.update(task);
        return;
      } catch (e) {
        // file missing → fall through and re-download
        if ((e as Error).message.includes('文件不存在')) {
          task.status = TaskStatus.Paused;
          task.downloadedBytes = 0;
          task.liveBytes = 0;
          task.sha256 = '';
          task.segments = [];
          await this.repo.update(task);
          throw new Error('文件不存在，已重置任务，可重新开始下载');
        }
        throw e as Error;
      }
    }
    // Paused / error / queued: reset and re-download from scratch.
    task.status = TaskStatus.Paused;
    task.downloadedBytes = 0;
    task.liveBytes = 0;
    task.sha256 = '';
    task.errorMessage = '';
    task.segments = [];
    task.finishedAt = 0;
    // Remove the partial file so the probe starts fresh.
    try {
      if (task.filePath) {
        fs.unlinkSync(task.filePath);
      }
    } catch (_) {
      // file may not exist
    }
    await this.repo.update(task);
  }

  /**
   * Clean up "failed" tasks (Error status). Optionally keep the files on disk.
   * Returns the number of tasks removed.
   */
  async cleanupFailedTasks(tasks: DownloadTask[], keepFile: boolean = false): Promise<number> {
    let removed = 0;
    for (const t of tasks) {
      if (t.status === TaskStatus.Error || (t.status === TaskStatus.Paused && t.totalBytes > 0 && !fs.accessSync(t.filePath))) {
        this.remove(t, keepFile);
        removed++;
      }
    }
    return removed;
  }

  /**
   * Copy a completed download from the app sandbox into the device's public
   * Download directory.
   *
   * On phones (e.g. HUAWEI Mate 60 Pro) `Environment.getUserDownloadDir()`
   * returns error 801, so the device-correct path is the DocumentViewPicker in
   * DOWNLOAD mode. It writes straight to Download with no folder-picker UI and
   * needs NO extra permission — the save gesture authorizes the returned URI.
   *
   * Returns the public file path on success.
   */
  async exportToPublicDownload(task: DownloadTask): Promise<string> {
    if (!this.context) {
      throw new Error('引擎尚未初始化');
    }
    const documentViewPicker = new picker.DocumentViewPicker(this.context as common.UIAbilityContext);
    const opts = new picker.DocumentSaveOptions();
    opts.pickerMode = picker.DocumentPickerMode.DOWNLOAD;
    opts.newFileNames = [task.fileName];
    const result = await documentViewPicker.save(opts);
    if (!result || result.length === 0) {
      throw new Error('未获取到公共 Download 目录');
    }
    const pubPath = new fileUri.FileUri(result[0] + '/' + task.fileName).path;
    const src = fs.openSync(task.filePath, fs.OpenMode.READ_ONLY);
    const dst = fs.openSync(pubPath, fs.OpenMode.CREATE | fs.OpenMode.READ_WRITE);
    try {
      fs.copyFileSync(src.fd, dst.fd);
    } finally {
      fs.closeSync(src.fd);
      fs.closeSync(dst.fd);
    }
    return pubPath;
  }

  // ---- Internal ----

  /** Return a file name in `dir` that does not collide with an existing file. */
  private uniqueFileName(dir: string, name: string): string {
    const extIndex = name.lastIndexOf('.');
    const stem = extIndex > 0 ? name.slice(0, extIndex) : name;
    const ext = extIndex > 0 ? name.slice(extIndex) : '';
    let candidate = name;
    for (let i = 1; i < 100; i++) {
      candidate = `${stem} (${i})${ext}`;
      try {
        if (!fs.accessSync(`${dir}/${candidate}`)) {
          break;
        }
      } catch (e) {
        break; // access failed → path free
      }
    }
    return candidate;
  }

  private finalizeCompleted(task: DownloadTask): void {
    task.downloadedBytes = task.liveBytes;
    task.speed = 0;
    task.status = TaskStatus.Completed;
    task.finishedAt = Date.now();
    // Use server-provided Last-Modified as the file's mtime when enabled.
    if (this.useServerTime && task.serverMtime > 0 && task.filePath) {
      try {
        fs.utimes(task.filePath, task.serverMtime);
      } catch (e) {
        // mtime update is best-effort
      }
    }
    this.listener?.onTaskCompleted(task);
  }

  /**
   * 检查设备网络连通性，无网络时快速失败以避免长时间卡在"分析中"状态。
   * 使用 @ohos.net.connection.hasDefaultNet 判断是否存在默认网络。
   */
  private async checkNetwork(task: DownloadTask): Promise<void> {
    try {
      const hasNet: boolean = connection.hasDefaultNetSync();
      if (!hasNet) {
        task.status = TaskStatus.Error;
        task.errorMessage = '网络不可用，请检查网络连接后重试';
        this.listener?.onTaskError(task, task.errorMessage);
        throw new Error('NO_NETWORK');
      }
    } catch (e) {
      // 如果 hasDefaultNetSync API 不可用或抛异常，降级为放行（由后续 probe 超时兜底）
      if ((e as Error).message === 'NO_NETWORK') {
        throw e;
      }
      logCollector.warn('Warn', `FluxDown Cover checkNetwork API unavailable, skipping: ${JSON.stringify(e)}`);
    }
  }

  /**
   * 将网络错误转换为用户友好的中文提示。
   * HarmonyOS http 错误码常见值：28=超时, 6=DNS解析失败, 7=连接被拒绝
   */
  private translateNetworkError(e: Error | null): string {
    if (!e) {
      return '网络错误，请检查网络连接后重试';
    }
    const msg = e.message || '';
    // HarmonyOS http error codes embedded in message
    if (msg.includes('28') || msg.includes('timeout') || msg.includes('超时')) {
      return '连接超时，请检查网络或稍后重试';
    }
    if (msg.includes('6') || msg.includes('resolve') || msg.includes('DNS') || msg.includes('dns')) {
      return 'DNS 解析失败，请检查网络连接';
    }
    if (msg.includes('7') || msg.includes('refused') || msg.includes('拒绝')) {
      return '服务器拒绝连接，请确认地址是否正确';
    }
    if (msg.includes('network') || msg.includes('Network') || msg.includes('network')) {
      return '网络不可用，请检查网络连接';
    }
    return `网络错误: ${msg}`;
  }

  private ensureFile(task: DownloadTask): void {
    task.dirPath = task.dirPath || this.defaultDir();
    // Ensure the target directory exists (may be a custom dirPath).
    // NOTE: fs.accessSync returns boolean (false if not exist) — it does NOT throw.
    if (!fs.accessSync(task.dirPath)) {
      fs.mkdirSync(task.dirPath);
    }
    task.filePath = `${task.dirPath}/${task.fileName}`;
    if (!fs.accessSync(task.filePath)) {
      const f = fs.openSync(task.filePath, fs.OpenMode.READ_WRITE | fs.OpenMode.CREATE);
      fs.closeSync(f.fd);
    }
  }

  /** Probe content-length + range support via a 1-byte Range request. */
  private async probe(
    task: DownloadTask
  ): Promise< { total: number; acceptRanges: boolean; name: string; realUrl?: string }> {
    // 减少重试次数和超时时间，避免 GitHub 等慢速链路长时间卡在探测状态
    const MAX_RETRIES = 2;
    const RETRY_DELAY_MS = 1500;
    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      if (attempt > 0) {
        task.errorMessage = `正在探测文件信息 (${attempt}/${MAX_RETRIES})...`;
        this.listener?.onTaskUpdated(task);
        await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
      }
      const req = http.createHttp();
      try {
        // 使用 request() 发送探测（自动跟随重定向）；
        // GitHub 链接默认走镜像加速，重试时切换不同镜像
        let probeUrl = this.applyMirror(task.url);
        // GitHub 链接：重试时切换其他公共镜像
        if (attempt > 0 && task.url.includes('github.com')) {
          const mirrors = ['https://gh-proxy.com/', 'https://mirror.ghproxy.com/', 'https://ghproxy.com/', 'https://ghfast.top/'];
          probeUrl = mirrors[attempt % mirrors.length] + this.safeEncodeUrl(task.url);
        }

        // 通过 headersReceive 捕获中间重定向的 Location 头，
        // 从而获取 CDN 直链（如 GitHub → objects.cdn 的跳转）
        let redirectLocation = '';
        req.on('headersReceive', (header: object) => {
          const h = header as Record<string, string>;
          if (h.location && !redirectLocation) {
            redirectLocation = h.location;
          }
        });

        const resp = await req.request(probeUrl, {
          method: http.RequestMethod.GET,
          header: this.buildHttpHeaders(task, { Range: 'bytes=0-0', Accept: '*/*' }),
          expectDataType: http.HttpDataType.ARRAY_BUFFER,
          connectTimeout: 15000,
          readTimeout: 30000,
          remoteValidation: this.ignoreTlsErrors ? 'skip' : 'system',
          usingProxy: this.proxyOption(),
          maxLimit: 64 * 1024 // 64KB 足够用于探测；若 CDN 忽略 Range 返回完整文件，也不会浪费太多时间
        });
        const code = resp.responseCode as number;
        const headers = resp.header as Record<string, string>;
        const lower: Record<string, string> = {};
        for (const k of Object.keys(headers)) {
          lower[k.toLowerCase()] = String(headers[k]);
        }
        let total = 0;
        let acceptRanges = false;

        // 策略1：206 时从 Content-Range 精确获取总大小
        if (code === 206) {
          const cr = lower['content-range'] || '';
          const m = /bytes\s+\d+-\d+\/(\d+)/i.exec(cr);
          if (m) {
            total = Number(m[1]);
            acceptRanges = true;
          }
        }

        // 策略2：从 Content-Length 获取（适用于 200 或 206 但 Content-Range 解析失败）
        if (total === 0) {
          total = Number(lower['content-length']) || 0;
        }

        // 策略2b：很多 CDN 直链返回 200 但实际只发了 Range 请求的片段（body 远小于 Content-Length）
        // 说明服务器实际支持 Range，只是状态码用了 200 而非 206
        // 注意：maxLimit=1MB，忽略 Range 的服务器 body 可达 1MB，而尊重 Range 的 body ≈ 1 字节
        if (!acceptRanges && code === 200 && total > 0 && resp.result) {
          const bodyLen = (resp.result as ArrayBuffer).byteLength;
          // body 远小于 Content-Length 且最多几十 KB → 说明只返回了请求的 Range 片段
          if (bodyLen > 0 && bodyLen < Math.min(total, 10 * 1024)) {
            acceptRanges = true;
          }
        }

        // 策略3：如果 Range 头在重定向中丢失，CDN 返回了完整文件体，用实际接收到的字节数
        if (total === 0 && resp.result && (resp.result as ArrayBuffer).byteLength > 0) {
          total = (resp.result as ArrayBuffer).byteLength;
          acceptRanges = true; // 能正常下载即可支持断点续传
        }

        // 检测是否支持断点续传（仅当未通过 Content-Range 设置时）
        if (!acceptRanges) {
          acceptRanges = (lower['accept-ranges'] || '').includes('bytes');
        }

        const name = this.extractName(task.url, lower);
        // Remember server Last-Modified so the finished file can carry the server mtime.
        const lm = lower['last-modified'];
        if (lm) {
          const ts = Date.parse(lm);
          if (!isNaN(ts)) {
            task.serverMtime = ts;
          }
        }
        // 优先使用 headersReceive 捕获的重定向直链；若未触发重定向则返回 undefined
        const realUrl = redirectLocation || undefined;
        return { total, acceptRanges, name, realUrl };
      } catch (e) {
        lastError = e as Error;
        logCollector.warn('Warn', `FluxDown Cover probe attempt ${attempt + 1}/${MAX_RETRIES + 1} failed: ${JSON.stringify(e)}`);
        if (attempt < MAX_RETRIES) {
          req.destroy();
          continue;
        }
        // 所有重试失败，转换错误消息为用户友好的中文提示
        const msg = this.translateNetworkError(lastError);
        throw new Error(msg);
      } finally {
        req.destroy();
      }
    }
    throw new Error('探测失败'); // unreachable
  }

  /**
   * 探测到的服务器文件名是否应替换当前任务文件名。
   * - 当前名为空或为 addTask 生成的 `file_<id>` 占位名 → 替换；
   * - 当前名无后缀而服务器名有后缀（如 .hap）→ 替换以补全后缀；
   * - 其余情况（URL 已解析出带后缀的文件名）保持不变。
   */
  private shouldUseProbedName(current: string, probed: string): boolean {
    if (!current) {
      return true;
    }
    // addTask 在 URL 无法解析出文件名时生成 `file_<genId()>` 占位名，
    // genId() 返回 `fd_` 前缀，因此占位名一定以 `file_fd_` 开头。
    if (current.startsWith('file_fd_')) {
      return true;
    }
    const hasExt = (n: string): boolean => {
      const i = n.lastIndexOf('.');
      return i > 0 && i < n.length - 1;
    };
    return !hasExt(current) && hasExt(probed);
  }

  private extractName(url: string, headers: Record<string, string>): string {
    const cd = headers['content-disposition'] || '';
    // RFC 5987 扩展格式优先：filename*=UTF-8''<percent-encoded>
    const star = /filename\*\s*=\s*(?:utf-8)?''([^;]+)/i.exec(cd);
    if (star) {
      // 带 GBK 回退：老站点可能用 GBK 百分号编码文件名
      return sanitizeFileName(safePercentDecode(star[1].trim()));
    }
    const m = /filename\s*=\s*["']?([^"';]+)/i.exec(cd);
    if (m) {
      return sanitizeFileName(safePercentDecode(m[1].trim()));
    }
    return fileNameFromUrl(url);
  }

  /**
   * 解析 URL 的最终跳转目标（如 GitHub → CDN），返回 CDN 直链地址。
   * 使用 requestInStream + headersReceive 捕获 302 的 Location 头。
   */
  private async resolveRedirectUrl(url: string, task: DownloadTask): Promise<string> {
    const req = http.createHttp();
    try {
      // 使用 request()（自动跟随重定向）配合 headersReceive 捕获中间 302 Location
      let location = '';
      req.on('headersReceive', (header: object) => {
        const h = header as Record<string, string>;
        if (h.location) {
          location = h.location;
        }
      });
      const resp = await req.request(this.applyMirror(url), {
        method: http.RequestMethod.HEAD,
        header: this.buildHttpHeaders(task, { Accept: '*/*' }),
        expectDataType: http.HttpDataType.ARRAY_BUFFER,
        connectTimeout: 30000,
        readTimeout: 60000,
        remoteValidation: this.ignoreTlsErrors ? 'skip' : 'system',
        usingProxy: this.proxyOption()
      });
      if (location) {
        return location;
      }
      return url;
    } catch (e) {
      // HEAD 请求在某些 CDN（如 GitHub objects.githubusercontent.com）上可能超时或失败，
      // 此时返回原 URL，后续 GET 分段下载会自动跟随重定向，不影响下载。
      logCollector.warn('Download', `resolveRedirectUrl HEAD failed, fallback to original URL: ${JSON.stringify(e)}`);
      return url;
    } finally {
      req.destroy();
    }
  }

  private buildSegments(task: DownloadTask, total: number, acceptRanges: boolean, realUrl?: string): void {
    if (!acceptRanges || total <= 0) {
      task.totalBytes = total;
      task.segments = [
        { index: 0, start: 0, end: total > 0 ? total - 1 : -1, downloaded: 0, done: false, url: realUrl }
      ];
      return;
    }
    // 任务级显式分片数（segmentCount>0）优先：用户明确指定即按其取值。
    if (task.segmentCount > 0) {
      const n = Math.min(task.segmentCount, 64);
      task.totalBytes = total;
      task.segments = this.splitInto(task, n, total, realUrl);
      return;
    }
    // 官方 segment_advisor 语义：≤2MB 一律单分片（拆分无收益）；
    // 其余按 ~1MB/分片 由文件大小推导，上限为用户全局 maxSegments 设置。
    const SINGLE_SEGMENT_THRESHOLD = 2 * 1024 * 1024;
    if (total <= SINGLE_SEGMENT_THRESHOLD) {
      task.totalBytes = total;
      task.segments = [
        { index: 0, start: 0, end: total - 1, downloaded: 0, done: false, url: realUrl }
      ];
      return;
    }
    const bySize = Math.max(1, Math.floor(total / (1024 * 1024)));
    const n = Math.max(1, Math.min(bySize, this.maxSegments));
    task.totalBytes = total;
    task.segments = this.splitInto(task, n, total, realUrl);
  }

  /** Split `total` bytes into `n` contiguous byte-range segments. */
  private splitInto(task: DownloadTask, n: number, total: number, realUrl?: string): Segment[] {
    const size = Math.floor(total / n);
    const segs: Segment[] = [];
    for (let i = 0; i < n; i++) {
      const start = i * size;
      const end = i === n - 1 ? total - 1 : start + size - 1;
      segs.push({ index: i, start, end, downloaded: 0, done: false, url: realUrl });
    }
    return segs;
  }

  private async downloadSegment(task: DownloadTask, seg: Segment, ctrl: Ctrl): Promise<void> {
    const file = fs.openSync(task.filePath, fs.OpenMode.READ_WRITE | fs.OpenMode.CREATE);
    let offset = seg.start + seg.downloaded;
    const req = http.createHttp();
    let writeChain: Promise<void> = Promise.resolve();
    let writeErr: Error | null = null;
    let segResolve: () => void = () => {};
    let segReject: (e: Error) => void = () => {};
    const segDone = new Promise<void>((res, rej) => {
      segResolve = res;
      segReject = rej;
    });

    // Write buffering: collect chunks and flush at 512KB to reduce I/O syscalls
    const BUF_SIZE = 512 * 1024;
    let buf: ArrayBuffer | null = null;
    let bufView: Uint8Array | null = null;
    let bufOff = 0;
    // 预计算是否有限速，避免每次写入都查询
    const hasSpeedLimit = (): boolean => SpeedLimiter.global().getLimit() > 0 || task.speedLimit > 0;

    const flushBuf = (): void => {
      if (buf && bufOff > 0) {
        const data = buf.slice(0, bufOff);
        buf = null;
        bufView = null;
        bufOff = 0;
        if (!hasSpeedLimit()) {
          // 无速度限制：直接同步写入，减少 Promise 链开销
          try {
            fs.writeSync(file.fd, data, { offset });
            offset += data.byteLength;
            seg.downloaded += data.byteLength;
            this.onChunk(task, data.byteLength);
          } catch (e) {
            writeErr = e as Error;
          }
        } else {
          // 有速度限制：使用 Promise 链异步写入
          writeChain = writeChain.then(() => {
            if (writeErr) { return; }
            let waitMs = SpeedLimiter.global().waitTime(data.byteLength);
            if (task.speedLimit > 0) {
              const perTask = this.taskLimiter(task.id, task.speedLimit);
              const tw = perTask.waitTime(data.byteLength);
              if (tw > waitMs) { waitMs = tw; }
            }
            if (waitMs > 0) {
              return new Promise(r => setTimeout(r, waitMs));
            }
            return;
          }).then(() => {
            if (writeErr) { return; }
            if (SpeedLimiter.global().getLimit() > 0) {
              SpeedLimiter.global().tryConsume(data.byteLength);
            }
            if (task.speedLimit > 0) {
              this.taskLimiter(task.id, task.speedLimit).tryConsume(data.byteLength);
            }
            fs.writeSync(file.fd, data, { offset });
            offset += data.byteLength;
            seg.downloaded += data.byteLength;
            this.onChunk(task, data.byteLength);
          }).catch((e) => {
            writeErr = e as Error;
          });
        }
      }
    };

    let lastDataTime = Date.now(); // 用于数据静默超时检测
    let respCode = 0;
    let rangeIgnored = false;
    req.on('headersReceive', (header: object) => {
      const h = header as Record<string, string>;
      respCode = Number(h[':status'] || h['status'] || 0);
      // 如果服务器返回200而非206，说明忽略了Range请求，标记后由dataEnd处理
      if (respCode === 200 && seg.end >= 0) {
        rangeIgnored = true;
      }
    });
    req.on('dataReceive', (chunk: ArrayBuffer) => {
      lastDataTime = Date.now();
      if (ctrl.aborted || writeErr) {
        return;
      }
      // 使用 subarray 代替 slice，避免创建新的 ArrayBuffer，减少 GC 开销
      const chunkView = new Uint8Array(chunk);
      let chunkOff = 0;
      while (chunkOff < chunkView.length) {
        if (!buf) {
          buf = new ArrayBuffer(BUF_SIZE);
          bufView = new Uint8Array(buf);
          bufOff = 0;
        }
        const space = BUF_SIZE - bufOff;
        const copyLen = Math.min(chunkView.length - chunkOff, space);
        bufView!.set(chunkView.subarray(chunkOff, chunkOff + copyLen), bufOff);
        bufOff += copyLen;
        chunkOff += copyLen;
        if (bufOff >= BUF_SIZE) {
          flushBuf();
        }
      }
    });

    req.on('dataEnd', () => {
      flushBuf();
      writeChain.then(() => {
        if (writeErr) {
          segReject(writeErr);
        } else if (ctrl.aborted) {
          // 暂停时不标记分段完成，避免任务被错误标记为已完成
          segResolve();
        } else if (rangeIgnored && seg.index > 0) {
          // 服务器忽略Range请求且不是第一个分段，抛错让上层重新探测
          segReject(new Error('服务器忽略Range请求，重新探测'));
        } else {
          seg.done = true;
          segResolve();
        }
      }).catch((e) => segReject(e as Error));
    });

    try {
      const downloadUrl = this.applyMirror(seg.url ?? task.url);
      // 数据静默超时：30s 内无新数据到达视为断流，触发重试
      // 必须在请求之前启动，否则请求挂起时timer永远不会启动
      const IDLE_TIMEOUT_MS = 30000;
      const idleTimer = setInterval(() => {
        if (Date.now() - lastDataTime > IDLE_TIMEOUT_MS) {
          clearInterval(idleTimer);
          req.destroy();
          segReject(new Error(`分段 ${seg.index} 下载超时：超过 ${IDLE_TIMEOUT_MS / 1000}s 无数据`));
        }
      }, 2000);
      try {
        await req
          .requestInStream(downloadUrl, {
            method: http.RequestMethod.GET,
            header: this.buildHttpHeaders(task, { Range: `bytes=${offset}-${seg.end >= 0 ? seg.end : ''}`, Accept: '*/*' }),
            connectTimeout: 15000,
            readTimeout: 30000,
            remoteValidation: this.ignoreTlsErrors ? 'skip' : 'system',
            usingProxy: this.proxyOption()
          })
          .catch((e: BusinessError) => {
            if (!ctrl.aborted) {
              throw e;
            }
          });
        await segDone;
      } finally {
        clearInterval(idleTimer);
      }
      // 数据完整性校验：分段指定了 end 时，确保写入了足够的字节
      if (seg.end >= 0 && offset < seg.end + 1) {
        throw new Error(`分段 ${seg.index} 下载不完整（预期到 ${seg.end}，实际写到 ${offset - 1}）`);
      }
    } catch (e) {
      if (ctrl.aborted) {
        return;
      }
      throw e;
    } finally {
      req.destroy();
      fs.closeSync(file.fd);
    }
  }

  private async runPool(tasks: Array<() => Promise<void>>, limit: number): Promise<void> {
    let idx = 0;
    const workers = Array.from({ length: Math.min(limit, tasks.length) }, async () => {
      while (idx < tasks.length) {
        const cur = idx++;
        await tasks[cur]();
      }
    });
    await Promise.all(workers);
  }

  private async verify(task: DownloadTask): Promise<void> {
    if (!task.verifyIntegrity) {
      task.sha256 = '';
      return;
    }
    try {
      // 校验实际文件大小与预期的 totalBytes 一致，防止网络中断导致文件截断
      if (task.totalBytes > 0) {
        const stat = fs.statSync(task.filePath);
        if (stat.size !== task.totalBytes) {
          throw new Error(`文件大小不匹配: 预期 ${task.totalBytes} 字节, 实际 ${stat.size} 字节`);
        }
      }
      task.sha256 = await hashFile(task.filePath);
    } catch (e) {
      logCollector.error('Error', `FluxDown Cover verification failed: ${JSON.stringify(e)}`);
      task.status = TaskStatus.Error;
      task.errorMessage = `完整性校验失败: ${(e as Error).message}`;
      task.sha256 = '';
      // 不在此处回调 onTaskError：抛出后由 start() 的外层 catch 统一回调一次，
      // 否则先回调（把任务置为排队重试）再 throw 会被外层 catch 覆盖回错误态，自动重试被跳过。
      throw e;
    }
  }

  private ensureTicker(): void {
    if (this.ticker !== null) {
      return;
    }
    this.ticker = setInterval(() => {
      const now = Date.now();
      this.active.forEach((task) => {
        task.downloadedBytes = task.liveBytes;
        const prev = this.prevLive.get(task.id) ?? task.liveBytes;
        const lt = this.lastTick.get(task.id) ?? now;
        const dt = (now - lt) / 1000;
        if (dt > 0) {
          task.speed = Math.max(0, Math.floor((task.liveBytes - prev) / dt));
          if (task.speed > task.peakSpeed) {
            task.peakSpeed = task.speed;
          }
        }
        this.prevLive.set(task.id, task.liveBytes);
        this.lastTick.set(task.id, now);
        const lp = this.lastPersist.get(task.id) ?? 0;
        if (now - lp > 1000) {
          this.listener?.onTaskUpdated(task);
          this.lastPersist.set(task.id, now);
        }
      });
      if (this.active.size === 0) {
        clearInterval(this.ticker!);
        this.ticker = null;
      }
    }, 200) as number;
  }
}
