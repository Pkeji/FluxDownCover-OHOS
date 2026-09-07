import { common } from '@kit.AbilityKit';
import { DownloadTask } from '../model/DownloadTask';

/** Minimal proxy descriptor (structurally compatible with net.http HttpProxy). */
export interface ProxyConfig {
  host: string;
  port: number;
  exclusionList: Array<string>;
  username?: string;
  password?: string;
}

/**
 * Hooks the engine exposes to protocol implementations (FTP, etc.) so they can
 * report progress and resolve the app storage directory without importing the
 * engine directly (avoids an import cycle).
 */
export interface EngineHooks {
  onChunk(task: DownloadTask, len: number): void;
  defaultDir(): string;
  getContext(): common.Context;
  /** True when the user enabled "ignore TLS certificate errors" for self-signed / legacy HTTPS sources. */
  shouldIgnoreTlsErrors(): boolean;
  /** Throttle a whole fetched chunk against the global + per-task speed limits (HLS/DASH segments). */
  throttle(task: DownloadTask, len: number): Promise<void>;
  /** Resolve the user-configured HTTP proxy, or undefined for a direct connection. */
  proxyOption(): ProxyConfig | undefined;
}
