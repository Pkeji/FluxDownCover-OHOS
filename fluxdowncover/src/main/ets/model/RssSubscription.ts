// ArkUI V2 状态装饰器：.ts 为独立模块、SDK 全局装饰器声明不注入，故在此做模块级类型声明（不污染全局）
declare const ObservedV2: ClassDecorator;
declare const Trace: PropertyDecorator;
/**
 * RSS subscription for auto-downloading.
 * Ported from FluxDown Cover's RSS feed polling system.
 * Polls an RSS/Atom feed at intervals and auto-adds matching items as downloads.
 */
@ObservedV2
export class RssSubscription {
  @Trace id: string;
  @Trace url: string; // feed URL
  @Trace name: string; // display name
  @Trace filter: string = ''; // include keyword filter (empty = match all)
  @Trace excludeFilter: string = ''; // exclude keywords (any hit → skip)
  @Trace intervalMin: number = 30; // poll interval in minutes
  @Trace autoDownload: boolean = true; // auto-add matching items
  @Trace sizeMinMB: number = 0; // minimum item size in MB (0 = no limit)
  @Trace sizeMaxMB: number = 0; // maximum item size in MB (0 = no limit)
  @Trace queueId: string = ''; // target queue id ('' = default queue)
  @Trace lastChecked: number = 0; // timestamp of last poll
  @Trace enabled: boolean = true;
  @Trace downloadedUrls: string[] = []; // already-seen item URLs (dedup)
  @Trace createdAt: number = Date.now();

  constructor(id: string, url: string, name: string) {
    this.id = id;
    this.url = url;
    this.name = name;
  }
}

/** A single item parsed from an RSS/Atom feed. */
export interface RssItem {
  title: string;
  link: string;
  description: string;
  pubDate: number;
  sizeBytes: number; // enclosure length when present (0 = unknown)
}
