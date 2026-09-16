import { DownloadTask } from '../model/DownloadTask';

/** Engine -> UI/viewmodel notifications. */
export interface EngineListener {
  onTaskUpdated(task: DownloadTask): void;
  onTaskCompleted(task: DownloadTask): void;
  onTaskError(task: DownloadTask, error: string): void;
}

/** Lightweight abort flag (ArkTS has no guaranteed global AbortController). */
export interface Ctrl {
  aborted: boolean;
}
