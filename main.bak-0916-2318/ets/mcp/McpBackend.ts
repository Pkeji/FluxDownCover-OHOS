import { DownloadTask } from '../model/DownloadTask';

/**
 * Backend the local MCP (Model Context Protocol) server talks to.
 * Lets an AI agent enumerate and control downloads over JSON-RPC.
 */
export interface McpBackend {
  listTasks(): DownloadTask[];
  getTask(id: string): DownloadTask | undefined;
  addTask(url: string): Promise<void>;
  pauseTask(id: string): void;
  resumeTask(id: string): Promise<void>;
  removeTask(id: string): void;
}
