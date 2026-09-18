import libtorrentBt from 'libtorrent_bt.so';
import { hilog } from '@kit.PerformanceAnalysisKit';

const TAG = 'LibTorrentEngine';

export class LibTorrentEngine {
  private static instance: LibTorrentEngine | null = null;
  private initialized = false;
  private torrentIds: Map<string, string> = new Map();

  static getInstance(): LibTorrentEngine {
    if (!LibTorrentEngine.instance) {
      LibTorrentEngine.instance = new LibTorrentEngine();
    }
    return LibTorrentEngine.instance;
  }

  init(saveDir: string): boolean {
    if (this.initialized) return true;
    try {
      const result = libtorrentBt.initSession();
      hilog.info(0x0000, TAG, 'initSession result: ' + result);
      this.initialized = true;
      return result;
    } catch (e) {
      hilog.error(0x0000, TAG, 'init failed: ' + e);
      return false;
    }
  }

  addMagnet(magnet: string, saveDir: string): string | null {
    try {
      const id = libtorrentBt.addMagnet(magnet, saveDir);
      hilog.info(0x0000, TAG, 'addMagnet id: ' + id);
      this.torrentIds.set(magnet, id);
      return id;
    } catch (e) {
      hilog.error(0x0000, TAG, 'addMagnet failed: ' + e);
      return null;
    }
  }

  getStatus(id: string): any {
    try {
      return libtorrentBt.getStatus(id);
    } catch (e) {
      return { found: false };
    }
  }

  pause(id: string): boolean {
    try {
      return libtorrentBt.pause(id);
    } catch (e) {
      return false;
    }
  }

  resume(id: string): boolean {
    try {
      return libtorrentBt.resume(id);
    } catch (e) {
      return false;
    }
  }

  remove(id: string): boolean {
    try {
      return libtorrentBt.remove(id);
    } catch (e) {
      return false;
    }
  }
}
