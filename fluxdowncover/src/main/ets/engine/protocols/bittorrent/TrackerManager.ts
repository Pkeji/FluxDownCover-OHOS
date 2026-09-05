import { http } from '@kit.NetworkKit';
import { logCollector } from '../../../utils/LogCollector';
import { BtSettingsStore, DEFAULT_TRACKERS } from '../../../store/BtSettingsStore';
import { TorrentMeta } from './TorrentMeta';

/**
 * Manages the effective list of BitTorrent trackers used for announces.
 *
 * The effective list for a torrent is the union (de-duplicated) of:
 *   - the trackers embedded in the .torrent / magnet link, and
 *   - the global trackers configured in BtSettings (defaults + user custom),
 *     which may be periodically extended by fetching "tracker subscription"
 *     lists (plain-text, one announce URL per line).
 */
export class TrackerManager {
  private static instance: TrackerManager | null = null;
  private store: BtSettingsStore;

  static getInstance(): TrackerManager {
    if (!TrackerManager.instance) {
      TrackerManager.instance = new TrackerManager(BtSettingsStore.getInstance());
    }
    return TrackerManager.instance;
  }

  constructor(store: BtSettingsStore) {
    this.store = store;
  }

  /**
   * Effective tracker list for a torrent: meta.trackers ∪ global trackers,
   * de-duplicated and filtered to supported schemes.
   */
  async getTrackers(meta: TorrentMeta | null): Promise<string[]> {
    const settings = await this.store.load();
    const set = new Set<string>();
    const add = (url: string) => {
      const u = url.trim();
      if (u.length > 0 && this.isSupported(u)) {
        set.add(u);
      }
    };
    if (meta) {
      for (const t of meta.trackers) {
        add(t);
      }
    }
    for (const t of settings.trackers) {
      add(t);
    }
    // Fall back to built-in defaults if the union is somehow empty.
    if (set.size === 0) {
      for (const t of DEFAULT_TRACKERS) {
        add(t);
      }
    }
    return Array.from(set);
  }

  /**
   * Refresh the global tracker list by fetching each subscription URL and
   * merging the discovered announce URLs. Persists the merged list and the
   * update timestamp. Failures are tolerated (best-effort, non-fatal).
   */
  async refreshSubscriptions(): Promise<number> {
    const settings = await this.store.load();
    if (!settings.trackerSubscriptions || settings.trackerSubscriptions.length === 0) {
      return 0;
    }
    let added = 0;
    const merged = new Set<string>(settings.trackers);
    for (const sub of settings.trackerSubscriptions) {
      try {
        const list = await this.fetchList(sub);
        for (const url of list) {
          if (!merged.has(url)) {
            merged.add(url);
            added++;
          }
        }
      } catch (e) {
        logCollector.warn('Warn', `FluxDown Cover tracker subscription failed (${sub}): ${(e as Error).message}`);
      }
    }
    const updated: typeof settings = {
      ...settings,
      trackers: Array.from(merged)
    };
    await this.store.save(updated);
    await this.store.setSubscriptionUpdatedAt(Date.now());
    return added;
  }

  /** Fetch a plain-text tracker list (one URL per line) and extract announce URLs. */
  private async fetchList(url: string): Promise<string[]> {
    const req = http.createHttp();
    try {
      const resp = await req.request(url, {
        method: http.RequestMethod.GET,
        header: { Accept: '*/*', 'User-Agent': 'FluxDownCover/1.0' },
        connectTimeout: 10000,
        readTimeout: 10000
      });
      const text = (resp.result as string) ?? '';
      const out: string[] = [];
      for (const line of text.split(/\r?\n/)) {
        const u = line.trim();
        if (this.isSupported(u)) {
          out.push(u);
        }
      }
      return out;
    } finally {
      req.destroy();
    }
  }

  private isSupported(url: string): boolean {
    return url.startsWith('http://') || url.startsWith('https://') || url.startsWith('udp://');
  }
}
