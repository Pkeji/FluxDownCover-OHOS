import { http } from '@kit.NetworkKit';
import { BusinessError } from '@kit.BasicServicesKit';
import { common } from '@kit.AbilityKit';
import { picker, fileUri } from '@kit.CoreFileKit';
import fs from '@ohos.file.fs';
import { DownloadTask, Segment } from '../model/DownloadTask';
import { TaskStatus } from '../model/TaskStatus';
import { ProtocolType } from '../model/ProtocolType';
import { genId, sanitizeFileName, fileNameFromUrl, detectProtocol } from '../utils/common';
import { TaskRepository } from '../store/TaskRepository';
import { EngineListener, Ctrl } from './types'
import { SpeedLimiter } from '../utils/SpeedLimiter';;
import { EngineHooks } from './EngineHooks';
import { hashFile } from './HashTask';
import { buildHlsSegments, downloadHls } from './protocols/HlsProtocol';
import { buildDashSegments, downloadDash } from './protocols/DashProtocol';
import { downloadFtp } from './protocols/FtpProtocol';
import { downloadBittorrent } from './protocols/BittorrentProtocol';
import { downloadEd2k } from './protocols/Ed2kProtocol';
import { decodeWrapperLink } from './protocols/ThunderProtocol';

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

  private active: Set<DownloadTask> = new Set();
  private controls: Map<string, Ctrl> = new Map();
  private maxSegments: number = 8;
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
  }

  setListener(listener: EngineListener): void {
    this.listener = listener;
  }

  setMaxSegments(n: number): void {
    this.maxSegments = Math.max(1, Math.min(32, n | 0));
  }

  // ---- EngineHooks ----
  onChunk(task: DownloadTask, len: number): void {
    task.liveBytes += len;
  }

  defaultDir(): string {
    return this.defaultDirPath;
  }

  getContext(): common.Context {
    return this.context as common.Context;
  }

  // ---- Task lifecycle ----

  async addTask(
    url: string,
    opts?: { fileName?: string; dirPath?: string; protocol?: ProtocolType; verify?: boolean }
  ): Promise<DownloadTask> {
    const task = new DownloadTask();
    task.id = genId();
    task.url = url.trim();
    task.protocol = detectProtocol(task.url, opts?.protocol);
    task.fileName = sanitizeFileName(opts?.fileName || fileNameFromUrl(task.url) || `file_${task.id}`);
    task.dirPath = opts?.dirPath || this.defaultDir();
    task.filePath = `${task.dirPath}/${task.fileName}`;
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

    if (task.protocol === ProtocolType.HLS) {
      if (task.segments.length === 0) {
        await buildHlsSegments(task);
      }
    } else if (task.protocol === ProtocolType.DASH) {
      if (task.segments.length === 0) {
        await buildDashSegments(task);
      }
    } else if (task.protocol === ProtocolType.FTP) {
      // handled entirely by downloadFtp
    } else if (task.protocol === ProtocolType.BITTORRENT) {
      // handled entirely by downloadBittorrent
    } else {
      if (task.totalBytes === 0 && task.segments.length === 0) {
        const info = await this.probe(task);
        if (info.name && (!task.fileName || task.fileName === '')) {
          task.fileName = info.name;
        }
        this.ensureFile(task);
        this.buildSegments(task, info.total, info.acceptRanges);
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
      } else {
        const pending = task.segments.filter((s) => !s.done);
        if (pending.length === 0) {
          this.finalizeCompleted(task);
          return;
        }
        await this.runPool(pending.map((s) => () => this.downloadSegment(task, s, ctrl)), this.maxSegments);
      }

      if (ctrl.aborted) {
        task.status = TaskStatus.Paused;
      } else {
        task.status = TaskStatus.Verifying;
        this.listener?.onTaskUpdated(task);
        await this.verify(task);
        this.finalizeCompleted(task);
      }
    } catch (e) {
      task.status = TaskStatus.Error;
      task.errorMessage = (e as Error)?.message || String(e);
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
  }

  resume(task: DownloadTask): Promise<void> {
    return this.start(task);
  }

  remove(task: DownloadTask): void {
    const ctrl = this.controls.get(task.id);
    if (ctrl) {
      ctrl.aborted = true;
    }
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
    this.repo.delete(task.id).catch(() => {});
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

  private finalizeCompleted(task: DownloadTask): void {
    task.downloadedBytes = task.liveBytes;
    if (task.totalBytes > 0) {
      task.downloadedBytes = task.totalBytes;
    }
    task.speed = 0;
    task.status = TaskStatus.Completed;
    task.finishedAt = Date.now();
    this.listener?.onTaskCompleted(task);
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
  ): Promise< { total: number; acceptRanges: boolean; name: string }> {
    const req = http.createHttp();
    try {
      const resp = await req.request(task.url, {
        method: http.RequestMethod.GET,
        header: { Range: 'bytes=0-0', Accept: '*/*' },
        expectDataType: http.HttpDataType.ARRAY_BUFFER,
        connectTimeout: 20000,
        readTimeout: 20000
      });
      const code = resp.responseCode as number;
      const headers = resp.header as Record<string, string>;
      const lower: Record<string, string> = {};
      for (const k of Object.keys(headers)) {
        lower[k.toLowerCase()] = String(headers[k]);
      }
      let total = 0;
      let acceptRanges = false;
      if (code === 206) {
        const cr = lower['content-range'] || '';
        const m = /bytes\s+\d+-\d+\/(\d+)/i.exec(cr);
        if (m) {
          total = Number(m[1]);
          acceptRanges = true;
        } else {
          total = Number(lower['content-length']) || 0;
        }
      } else if (code === 200) {
        total = Number(lower['content-length']) || 0;
        acceptRanges = (lower['accept-ranges'] || '').includes('bytes');
      }
      const name = this.extractName(task.url, lower);
      return { total, acceptRanges, name };
    } finally {
      req.destroy();
    }
  }

  private extractName(url: string, headers: Record<string, string>): string {
    const cd = headers['content-disposition'] || '';
    const m = /filename\*?=(?:UTF-8'')?["']?([^"';]+)/i.exec(cd);
    if (m) {
      return sanitizeFileName(decodeURIComponent(m[1].trim()));
    }
    return fileNameFromUrl(url);
  }

  private buildSegments(task: DownloadTask, total: number, acceptRanges: boolean): void {
    if (!acceptRanges || total <= 0) {
      task.totalBytes = total;
      task.segments = [
        { index: 0, start: 0, end: total > 0 ? total - 1 : -1, downloaded: 0, done: false }
      ];
      return;
    }
    const n = Math.min(this.maxSegments, Math.max(1, Math.floor(total / (256 * 1024))));
    const size = Math.floor(total / n);
    const segs: Segment[] = [];
    for (let i = 0; i < n; i++) {
      const start = i * size;
      const end = i === n - 1 ? total - 1 : start + size - 1;
      segs.push({ index: i, start, end, downloaded: 0, done: false });
    }
    task.totalBytes = total;
    task.segments = segs;
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

    // Write buffering: collect chunks and flush at 64KB to reduce I/O syscalls
    const WRITE_BUF_THRESHOLD = 256 * 1024;
    const bufQueue: Array<{ data: ArrayBuffer; offset: number }> = [];
    let bufSize = 0;

    const flushBuf = async (): Promise<number> => {
      if (bufQueue.length === 0) return 0;
      const batch = bufQueue.splice(0);
      bufSize = 0;
      // Apply global speed limit before writing
      const totalBytes = batch.reduce((s, item) => s + item.data.byteLength, 0);
      const waitMs = SpeedLimiter.global().waitTime(totalBytes);
      if (waitMs > 0) {
        await new Promise(r => setTimeout(r, waitMs));
      }
      SpeedLimiter.global().tryConsume(totalBytes);
      const results = await Promise.all(
        batch.map(item => fs.write(file.fd, item.data, { offset: item.offset }))
      );
      return results.reduce((a, b) => a + b, 0);
    };

    req.on('dataReceive', (chunk: ArrayBuffer) => {
      if (ctrl.aborted) {
        req.destroy();
        segResolve();
        return;
      }
      const cur = offset;
      offset += chunk.byteLength;
      bufQueue.push({ data: chunk, offset: cur });
      bufSize += chunk.byteLength;

      if (bufSize >= WRITE_BUF_THRESHOLD) {
        writeChain = writeChain
          .then(() => flushBuf())
          .then((len: number) => {
            seg.downloaded += len;
            this.onChunk(task, len);
          })
          .catch((e: BusinessError) => {
            writeErr = e as Error;
          });
      }
    });
    req.on('dataEnd', () => {
      writeChain = writeChain
        .then(() => flushBuf())
        .then((len: number) => {
          seg.downloaded += len;
          this.onChunk(task, len);
          if (writeErr) {
            req.destroy();
            segReject(writeErr);
            return;
          }
          seg.done = true;
          req.destroy();
          segResolve();
        })
        .catch((e) => {
          req.destroy();
          segReject(e as Error);
        });
    });

    const range = seg.end >= 0 ? `bytes=${offset}-${seg.end}` : `bytes=${offset}-`;
    try {
      const reqPromise = req
        .requestInStream(seg.url ?? task.url, {
          method: http.RequestMethod.GET,
          header: { Range: range, Accept: '*/*' },
          connectTimeout: 30000,
          readTimeout: 30000
        })
        .catch((e: BusinessError) => {
          if (!ctrl.aborted) {
            segReject(e as Error);
          }
        });
      await segDone;
      await reqPromise;
    } catch (e) {
      req.destroy();
      if (ctrl.aborted) {
        segResolve();
      } else {
        segReject(e as Error);
      }
    } finally {
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
      task.sha256 = await hashFile(task.filePath);
    } catch (e) {
      console.error(`FluxDown Cover hash failed: ${JSON.stringify(e)}`);
      task.sha256 = '';
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
