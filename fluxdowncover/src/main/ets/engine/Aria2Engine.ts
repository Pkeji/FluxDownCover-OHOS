
import aria2Native from 'libtorrent_napi.so';
import fs from '@ohos.file.fs';
import { DownloadTask } from '../model/DownloadTask';
import { TaskStatus } from '../model/TaskStatus';
import { EngineHooks } from './EngineHooks';
import { Ctrl } from './types';
import { logCollector } from '../utils/LogCollector';
import { common } from '@kit.AbilityKit';

const BT_TRACKERS = 'udp://tracker.opentrackr.org:1337/announce,udp://tracker.openbittorrent.com:6969/announce,udp://exodus.desync.com:6969/announce,udp://tracker.torrent.eu.org:451/announce,udp://tracker.moeking.me:6969/announce,udp://tracker.internetwarriors.net:1337/announce,udp://tracker.coppersurfer.tk:6969/announce,udp://p4p.arenabg.com:1337/announce,udp://tracker.dler.org:6969/announce,udp://tracker.zerobytes.xyz:1337/announce,udp://tracker.tiny-vps.com:6969/announce,udp://open.demonii.com:1337/announce,http://tracker.mywaifu.best:6969/announce,http://tracker.bt4g.com:2095/announce,http://open.acgnxtracker.com:80/announce,http://tracker1.bt.moack.co.kr:80/announce,udp://explodie.org:6969/announce,udp://open.stealth.si:80/announce';

interface TaskEntry {
  task: DownloadTask | null;
  hooks: EngineHooks | null;
  ctrl: Ctrl | null;
  gid: string;
  metadataWaited: boolean;
  parseMode: boolean;
  magnetUrl: string;
  savePath: string;
}

export class Aria2Engine {
  private static instance: Aria2Engine | null = null;
  static getInstance(): Aria2Engine {
    if (!Aria2Engine.instance) {
      Aria2Engine.instance = new Aria2Engine();
    }
    return Aria2Engine.instance;
  }

  private initialized = false;
  private pollTimer: number = 0;
  private ctx: common.Context | null = null;
  private tasks: Map<string, TaskEntry> = new Map();

  async init(context: common.Context): Promise<void> {
    if (this.initialized) return;
    try {
      this.ctx = context;
      const filesDir = context.filesDir;
      const saveDir = `${filesDir}/downloads`;
      if (!fs.accessSync(saveDir, 0)) {
        fs.mkdirSync(saveDir);
      }
      const proxy = '';
      aria2Native.nativeInit(saveDir, BT_TRACKERS, proxy, 128, 6881);
      this.initialized = true;
      console.info('[aria2] engine started (in-process C API)');
      this.startPolling();
    } catch (e) {
      logCollector.error('Error', `[aria2] init failed: ${(e as Error).message}`);
      throw e;
    }
  }

  /** Parse magnet in background without creating UI task. */
  async parseMagnet(magnetUrl: string, context: common.Context): Promise<void> {
    await this.init(context);
    const savePath = `${this.ctx!.filesDir}/downloads`;
    try {
      console.info(`[aria2] parsing magnet: ${magnetUrl.substring(0, 60)}...`);
      const gid: string = aria2Native.nativeAddMagnet(magnetUrl, savePath);
      this.tasks.set(gid, {
        task: null, hooks: null, ctrl: null, gid,
        metadataWaited: false, parseMode: true,
        magnetUrl: magnetUrl, savePath: savePath
      });
      console.info(`[aria2] parse started: ${gid}`);
    } catch (e) {
      throw new Error(`aria2 parseMagnet failed: ${(e as Error).message}`);
    }
  }

  /** After user selects files, attach task to the parsed aria2 entry. */
  attachTask(gid: string, task: DownloadTask, hooks: EngineHooks, ctrl: Ctrl): void {
    const entry = this.tasks.get(gid);
    if (entry) {
      entry.task = task;
      entry.hooks = hooks;
      entry.ctrl = ctrl;
      entry.parseMode = false;
      console.info(`[aria2] task attached to gid: ${gid}`);
    }
  }

  /** Find the gid of the completed parse (real files available). */
  getParsedGid(): string {
    for (const [gid, entry] of this.tasks) {
      if (!entry.parseMode) continue;
      try {
        const status = aria2Native.nativeGetStatus(gid);
        if (!status || !status.found) continue;
        const files = (status.files as Object[]) || [];
        const firstFile = files[0] as Record<string, Object>;
        const isMetadata = firstFile && (firstFile.path as string || '').startsWith('[METADATA]');
        if (!isMetadata && status.name) {
          return gid;
        }
      } catch (_) {}
    }
    return '';
  }

  /** Cancel parsing and remove aria2 task. */
  cancelParse(): void {
    for (const [gid, entry] of this.tasks) {
      if (entry.parseMode) {
        try { aria2Native.nativeRemove(gid, true); } catch (_) {}
        this.tasks.delete(gid);
      }
    }
  }

  async addMagnet(task: DownloadTask, ctrl: Ctrl, hooks: EngineHooks): Promise<void> {
    await this.init(hooks.getContext());
    const savePath = task.dirPath || hooks.getContext().filesDir + '/downloads';
    try {
      const gid: string = aria2Native.nativeAddMagnet(task.url, savePath);
      this.tasks.set(gid, {
        task, hooks, ctrl, gid,
        metadataWaited: false, parseMode: false,
        magnetUrl: task.url, savePath: savePath
      });
      console.info(`[aria2] magnet added: ${gid}`);
    } catch (e) {
      throw new Error(`aria2 addMagnet failed: ${(e as Error).message}`);
    }
  }

  private startPolling(): void {
    if (this.pollTimer) return;
    this.pollTimer = setInterval(() => this.poll(), 2000) as unknown as number;
  }

  private poll(): void {
    for (const [gid, entry] of this.tasks) {
      try {
        const status = aria2Native.nativeGetStatus(gid);
        if (!status || !status.found) continue;
        const files = (status.files as Object[]) || [];
        const firstFile = files[0] as Record<string, Object>;
        const isMetadata = firstFile && (firstFile.path as string || '').startsWith('[METADATA]');

        // Parse mode: only track metadata completion, no UI updates
        if (entry.parseMode) {
          // metadata download complete: path=[METADATA], status=3, totalLength>0
          if (isMetadata && status.status === 3 && status.totalLength > 0 && !entry.metadataWaited) {
            entry.metadataWaited = true;
            console.info(`[aria2] metadata complete in parse mode, loading .torrent...`);
            const hashMatch = entry.magnetUrl.match(/btih:([a-fA-F0-9]+)/);
            if (hashMatch) {
              const infohash = hashMatch[1].toLowerCase();
              const torrentPath = `${entry.savePath}/${infohash}.torrent`;
              try {
                aria2Native.nativeRemove(gid, true);
                const newGid = aria2Native.nativeAddTorrent(torrentPath, entry.savePath, '');
                entry.gid = newGid;
                this.tasks.delete(gid);
                this.tasks.set(newGid, entry);
                console.info(`[aria2] .torrent loaded as gid: ${newGid}`);
              } catch (e) {
                console.error(`[aria2] load .torrent failed: ${(e as Error).message}`);
              }
            }
          }
          continue;
        }

        // Normal mode: update UI task
        if (!entry.task || !entry.hooks) continue;
        const { task, hooks } = entry;
        task.downloadedBytes = status.completedLength || 0;
        task.totalBytes = status.totalLength || 0;
        task.speed = status.downloadSpeed || 0;
        console.info(`[aria2] poll: gid=${gid} status=${status.status} total=${task.totalBytes} done=${task.downloadedBytes} conn=${status.connections||0} name=${status.name} files=${files.length} err=${status.errorCode}`);
        if (status.name) task.fileName = status.name;

        if (status.status === 3 && status.totalLength > 0 && !isMetadata) {
          task.status = TaskStatus.Completed;
          task.speed = 0;
          hooks.onChunk(task, 0);
          console.info(`[aria2] complete: ${task.fileName}`);
          try { aria2Native.nativeRemove(gid, true); } catch (_) {}
          this.tasks.delete(gid);
        } else if (status.status === 4 || status.status === 5) {
          task.status = TaskStatus.Error;
          task.speed = 0;
          hooks.onChunk(task, 0);
          console.error(`[aria2] failed: status=${status.status} code=${status.errorCode}`);
          try { aria2Native.nativeRemove(gid, true); } catch (_) {}
          this.tasks.delete(gid);
        } else {
          task.status = TaskStatus.Downloading;
          hooks.onChunk(task, 0);
        }
      } catch (e) {}
    }
  }

  pause(taskId: string): void {
    for (const [gid, entry] of this.tasks) {
      if (entry.task && entry.task.id === taskId) { aria2Native.nativePause(gid); return; }
    }
  }
  resume(taskId: string): void {
    for (const [gid, entry] of this.tasks) {
      if (entry.task && entry.task.id === taskId) { aria2Native.nativeResume(gid); return; }
    }
  }
  remove(taskId: string): void {
    for (const [gid, entry] of this.tasks) {
      if (entry.task && entry.task.id === taskId) { aria2Native.nativeRemove(gid, true); this.tasks.delete(gid); return; }
    }
  }

  setSelectedFiles(taskId: string, indices: string): void {
    for (const [gid, entry] of this.tasks) {
      if (entry.task && entry.task.id === taskId) {
        try { aria2Native.nativeSetSelectFiles(gid, indices); } catch (_) {}
        return;
      }
    }
  }

  /** Get live peer/connection stats for parsing UI. */
  getParsingStatus(): { connections: number; numSeeders: number; totalLength: number; name: string; files: Object[]; done: boolean; gid: string } {
    let bestConn = 0;
    for (const [gid, entry] of this.tasks) {
      if (!entry.parseMode) continue;
      try {
        const status = aria2Native.nativeGetStatus(gid);
        if (!status || !status.found) continue;
        const files = (status.files as Object[]) || [];
        const firstFile = files[0] as Record<string, Object>;
        const isMetadata = firstFile && (firstFile.path as string || '').startsWith('[METADATA]');
        bestConn = Math.max(bestConn, status.connections || 0);
        if (!isMetadata && status.name) {
          return {
            connections: status.connections || 0,
            numSeeders: 0,
            totalLength: status.totalLength || 0,
            name: status.name || '',
            files: files,
            done: true,
            gid: gid
          };
        }
      } catch (_) {}
    }
    return { connections: bestConn, numSeeders: 0, totalLength: 0, name: '', files: [], done: false, gid: '' };
  }
}
