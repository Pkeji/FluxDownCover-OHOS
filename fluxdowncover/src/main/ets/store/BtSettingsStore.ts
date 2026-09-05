import dataPreferences from '@ohos.data.preferences';
import { common } from '@kit.AbilityKit';

/**
 * BT 种做条件组合方式：满足所有条件 / 满足任一条件。
 * 对应 FluxDown 0.4.7 的 `btSeedOperatorAnd` / `btSeedOperatorOr`。
 */
export enum SeedConditionOperator {
  AND = 'and',
  OR = 'or'
}

/** 做种限制模式：跟随全局 / 自定义 / 不限制。 */
export enum SeedLimitsMode {
  Global = 'global',
  Custom = 'custom',
  Unlimited = 'unlimited'
}

/**
 * 做种限制配置。
 * 各字段 0 表示「不限制该项」。
 */
@ObservedV2
export class SeedLimits {
  @Trace mode: SeedLimitsMode = SeedLimitsMode.Global; // 跟随全局 / 自定义 / 不限制
  @Trace ratioLimit: number = 0; // 总分享率达到该值后停止（0 = 不限制）
  @Trace postRatioLimit: number = 0; // 做种开始后新增分享率达到该值后停止（0 = 不限制）
  @Trace timeLimitSec: number = 0; // 累计做种时长达到后停止（0 = 不限制）
  @Trace inactiveTimeSec: number = 0; // 不活跃（无上传）时长达到后停止（0 = 不限制）
  @Trace maxActive: number = 0; // 同时做种的任务数上限（0 = 不限制）
  @Trace uploadLimit: number = 0; // 上传限速 bytes/sec（0 = 不限制）
  @Trace operator: SeedConditionOperator = SeedConditionOperator.OR; // 多条件的组合方式
}

/** 全局 BT 设置。 */
@ObservedV2
export class BtSettings {
  @Trace enableDht: boolean = true; // 启用 DHT（无 Tracker 也能发现 peers）
  @Trace enableUpnp: boolean = true; // 启用 UPnP 端口映射
  @Trace listenPortStart: number = 6881; // 监听端口范围起始
  @Trace listenPortEnd: number = 6891; // 监听端口范围结束
  @Trace seedEnabled: boolean = true; // 下载完成后自动做种
  @Trace autoReseed: boolean = true; // 启动时自动为已完成任务继续做种
  @Trace trackers: string[] = []; // 自定义 Tracker 列表
  @Trace trackerSubscriptions: string[] = []; // Tracker 订阅地址
  @Trace limits: SeedLimits = new SeedLimits(); // 全局做种限制
}

export const DEFAULT_TRACKERS: string[] = [
  'udp://tracker.opentrackr.org:1337/announce',
  'udp://tracker.openbittorrent.com:6969/announce',
  'udp://tracker.torrent.eu.org:451/announce',
  'udp://exodus.desync.com:6969/announce',
  'https://tracker.bt4g.com:2095/announce',
  'udp://tracker.coppersurfer.tk:6969/announce',
];

export const DEFAULT_TRACKER_SUBSCRIPTIONS: string[] = [
  'https://trackerslist.com/best.txt',
  'https://ngosang.github.io/trackerslist/trackers_best.txt',
];

export function defaultBtSettings(): BtSettings {
  const s = new BtSettings();
  s.enableDht = true;
  s.enableUpnp = true;
  s.listenPortStart = 6881;
  s.listenPortEnd = 6891;
  s.seedEnabled = true;
  s.autoReseed = true;
  s.trackers = [...DEFAULT_TRACKERS];
  s.trackerSubscriptions = [...DEFAULT_TRACKER_SUBSCRIPTIONS];
  s.limits = new SeedLimits();
  return s;
}

const K_ENABLE_DHT = 'bt_enableDht';
const K_ENABLE_UPNP = 'bt_enableUpnp';
const K_PORT_START = 'bt_listenPortStart';
const K_PORT_END = 'bt_listenPortEnd';
const K_SEED_ENABLED = 'bt_seedEnabled';
const K_AUTO_RESEED = 'bt_autoReseed';
const K_TRACKERS = 'bt_trackers';
const K_TRACKER_SUBS = 'bt_trackerSubscriptions';
const K_LIMITS = 'bt_limits';
const K_TRACKER_SUB_UPDATED_AT = 'bt_trackerSubUpdatedAt';

/**
 * BT 相关设置的持久化。与 SettingsStore 分开存放，避免 BT 配置（尤其是
 * Tracker 列表与做种限制这类结构化数据）污染通用设置的 key 空间。
 */
export class BtSettingsStore {
  private static instance: BtSettingsStore | null = null;
  private prefs: dataPreferences.Preferences | null = null;
  private readonly STORE_NAME = 'fluxdown_bt_settings';
  private cached: BtSettings | null = null;

  static getInstance(): BtSettingsStore {
    if (!BtSettingsStore.instance) {
      BtSettingsStore.instance = new BtSettingsStore();
    }
    return BtSettingsStore.instance;
  }

  async init(context: common.UIAbilityContext): Promise<void> {
    this.prefs = await dataPreferences.getPreferences(context, this.STORE_NAME);
  }

  /** 读取全部 BT 设置（首次读取后缓存，save() 时更新缓存）。 */
  async load(): Promise<BtSettings> {
    if (this.cached) {
      return this.cached;
    }
    const def = defaultBtSettings();
    if (!this.prefs) {
      this.cached = def;
      return def;
    }
    const limitsRaw = await this.prefs.get(K_LIMITS, '') as string;
    let limits = def.limits;
    if (limitsRaw) {
      try {
        const parsed = JSON.parse(limitsRaw) as SeedLimits;
        limits = new SeedLimits();
        limits.mode = parsed.mode ?? def.limits.mode;
        limits.ratioLimit = parsed.ratioLimit ?? def.limits.ratioLimit;
        limits.postRatioLimit = parsed.postRatioLimit ?? def.limits.postRatioLimit;
        limits.timeLimitSec = parsed.timeLimitSec ?? def.limits.timeLimitSec;
        limits.inactiveTimeSec = parsed.inactiveTimeSec ?? def.limits.inactiveTimeSec;
        limits.maxActive = parsed.maxActive ?? def.limits.maxActive;
        limits.uploadLimit = parsed.uploadLimit ?? def.limits.uploadLimit;
        limits.operator = parsed.operator ?? def.limits.operator;
      } catch (_) {
        // 损坏的 JSON → 回退默认值
      }
    }
    const settings = new BtSettings();
    settings.enableDht = await this.prefs.get(K_ENABLE_DHT, def.enableDht) as boolean;
    settings.enableUpnp = await this.prefs.get(K_ENABLE_UPNP, def.enableUpnp) as boolean;
    settings.listenPortStart = await this.prefs.get(K_PORT_START, def.listenPortStart) as number;
    settings.listenPortEnd = await this.prefs.get(K_PORT_END, def.listenPortEnd) as number;
    settings.seedEnabled = await this.prefs.get(K_SEED_ENABLED, def.seedEnabled) as boolean;
    settings.autoReseed = await this.prefs.get(K_AUTO_RESEED, def.autoReseed) as boolean;
    settings.trackers = this.parseList(await this.prefs.get(K_TRACKERS, '') as string, def.trackers);
    settings.trackerSubscriptions = this.parseList(
      await this.prefs.get(K_TRACKER_SUBS, '') as string, def.trackerSubscriptions
    );
    settings.limits = limits;
    this.cached = settings;
    return settings;
  }

  /** 保存并刷新缓存。 */
  async save(settings: BtSettings): Promise<void> {
    this.cached = settings;
    if (!this.prefs) {
      return;
    }
    await this.prefs.put(K_ENABLE_DHT, settings.enableDht);
    await this.prefs.put(K_ENABLE_UPNP, settings.enableUpnp);
    await this.prefs.put(K_PORT_START, settings.listenPortStart);
    await this.prefs.put(K_PORT_END, settings.listenPortEnd);
    await this.prefs.put(K_SEED_ENABLED, settings.seedEnabled);
    await this.prefs.put(K_AUTO_RESEED, settings.autoReseed);
    await this.prefs.put(K_TRACKERS, settings.trackers.join('\n'));
    await this.prefs.put(K_TRACKER_SUBS, settings.trackerSubscriptions.join('\n'));
    await this.prefs.put(K_LIMITS, JSON.stringify(settings.limits));
    await this.prefs.flush();
  }

  /** Tracker 订阅最近一次成功更新的时间戳（0 = 从未更新）。 */
  async getSubscriptionUpdatedAt(): Promise<number> {
    if (!this.prefs) {
      return 0;
    }
    return await this.prefs.get(K_TRACKER_SUB_UPDATED_AT, 0) as number;
  }

  async setSubscriptionUpdatedAt(ts: number): Promise<void> {
    if (!this.prefs) {
      return;
    }
    await this.prefs.put(K_TRACKER_SUB_UPDATED_AT, ts);
    await this.prefs.flush();
  }

  /** 换行分隔的字符串 → 数组；空内容回退默认值。 */
  private parseList(raw: string, fallback: string[]): string[] {
    if (!raw || raw.trim().length === 0) {
      return [...fallback];
    }
    const list = raw.split('\n').map(s => s.trim()).filter(s => s.length > 0);
    return list.length > 0 ? list : [...fallback];
  }
}
