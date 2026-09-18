
import aria2Native from 'libtorrent_napi.so';
import fs from '@ohos.file.fs';
import { DownloadTask } from '../model/DownloadTask';
import { TaskStatus } from '../model/TaskStatus';
import { EngineHooks } from './EngineHooks';
import { Ctrl } from './types';
import { logCollector } from '../utils/LogCollector';
import { common } from '@kit.AbilityKit';

const BT_TRACKERS = 'http://1337.abcvg.info:80/announce,http://bt1.archive.org:6969/announce,http://bt2.archive.org:6969/announce,http://ipv4announce.sktorrent.eu:6969/announce,http://nyaa.tracker.wf:7777/announce,http://torrentsmd.com:8080/announce,http://tracker.dhitechnical.com:6969/announce,http://tracker.dler.com:6969/announce,http://tracker.dler.org:6969/announce,http://tracker.mywaifu.best:6969/announce,http://tracker.renfei.net:8080/announce,http://tracker.waaa.moe:6969/announce,http://tracker.xn--djrq4gl4hvoi.top:80/announce,http://tracker.zhuqiy.dgj055.icu:80/announce,http://tracker2.dler.org:80/announce,http://www.wareztorrent.com:80/announce,https://004430.xyz:443/announce,https://1.tracker.eu.org:443/announce,https://1337.abcvg.info:443/announce,https://t.213891.xyz:443/announce,https://tr.abiir.top:443/announce,https://tr.burnabyhighstar.com:443/announce,https://tracker.7471.top:443/announce,https://tracker.foreverpirates.co:443/announce,https://tracker.kuroy.me:443/announce,https://tracker.nekomi.cn:443/announce,https://tracker.onetracker.net:443/announce,https://tracker.zhuqiy.com:443/announce,https://tracker1.520.jp:443/announce,udp://anime-tracker.aruku.kro.kr:8081/announce,udp://bittorrent-tracker.e-n-c-r-y-p-t.net:1337/announce,udp://evan.im:6969/announce,udp://explodie.org:6969/announce,udp://ipv6.govt.hu:6969/announce,udp://mail.segso.net:6969/announce,udp://martin-gebhardt.eu:25/announce,udp://ns575949.ip-51-222-82.net:6969/announce,udp://open.demonii.com:1337/announce,udp://open.ftorrent.com:443/announce,udp://open.stealth.si:80/announce,udp://open.tracker.ink:6969/announce,udp://opentor.org:2710/announce,udp://p4p.arenabg.com:1337/announce,udp://retracker.hotplug.ru:2710/announce,udp://t.overflow.biz:6969/announce,udp://torrent.tracker.durukanbal.com:6969/announce,udp://tr4ck3r.duckdns.org:6969/announce,udp://tracker-udp.gbitt.info:80/announce,udp://tracker.0x7c0.com:6969/announce,udp://tracker.aruku.ovh:8081/announce,udp://tracker.bittor.pw:1337/announce,udp://tracker.breizh.pm:6969/announce,udp://tracker.cn.nyaa.net:6969/announce,udp://tracker.corpscorp.online:80/announce,udp://tracker.dler.com:6969/announce,udp://tracker.ducks.party:1984/announce,udp://tracker.farted.net:6969/announce,udp://tracker.gmi.gd:6969/announce,udp://tracker.govt.hu:6969/announce,udp://tracker.ilibr.org:6969/announce,udp://tracker.k.vu:6969/announce,udp://tracker.nexusstream.eu:6969/announce,udp://tracker.nyaa.net:6969/announce,udp://tracker.nyaa.vc:6969/announce,udp://tracker.opentrackr.com:6969/announce,udp://tracker.opentrackr.org:1337/announce,udp://tracker.peerfect.org:6969/announce,udp://tracker.qu.ax:6969/announce,udp://tracker.skyts.net:6969/announce,udp://tracker.teambelgium.net:6969/announce,udp://tracker.theoks.net:6969/announce,udp://tracker.torrent.eu.org:451/announce,wss://tracker.openwebtorrent.com:443/announce,udp://34.66.57.33:6969/announce,udp://34.66.57.33:2710/announce,udp://34.66.57.33:80/announce,udp://34.66.57.33:11450/announce,udp://135.125.198.235:2710/announce,udp://135.125.198.235:6969/announce,udp://37.60.249.217:6969/announce,udp://207.211.184.229:6969/announce,udp://95.216.3.28:6969/announce,udp://95.216.3.28:80/announce,udp://93.158.213.92:1337/announce,udp://router.bittorrent.com:6881/announce,udp://router.utorrent.com:6881/announce,udp://dht.transmissionbt.com:6881/announce,udp://dht.libtorrent.org:25401/announce,udp://router.bitcomet.com:6881/announce,udp://213.193.255.2:22333/announce,udp://119.237.109.164:54321/announce,udp://183.178.239.118:63049/announce,udp://31.200.249.237:31760/announce,udp://112.87.174.5:1500/announce,udp://112.87.174.19:1500/announce,udp://112.87.174.103:1500/announce,udp://112.87.174.165:1500/announce,udp://112.87.174.207:1500/announce,udp://116.207.169.41:1712/announce,udp://116.207.169.49:1712/announce,udp://116.207.169.50:1712/announce,udp://116.207.169.52:1712/announce,udp://116.207.169.54:1712/announce,udp://116.207.169.64:1712/announce,udp://116.207.169.68:1712/announce,udp://116.207.169.71:1712/announce,udp://116.207.169.72:1712/announce,udp://116.207.169.73:1712/announce';

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
