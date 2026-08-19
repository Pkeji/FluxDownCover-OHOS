import { common } from '@kit.AbilityKit';
import { DownloadTask } from '../model/DownloadTask';

/**
 * Hooks the engine exposes to protocol implementations (FTP, etc.) so they can
 * report progress and resolve the app storage directory without importing the
 * engine directly (avoids an import cycle).
 */
export interface EngineHooks {
  onChunk(task: DownloadTask, len: number): void;
  defaultDir(): string;
  getContext(): common.Context;
}
