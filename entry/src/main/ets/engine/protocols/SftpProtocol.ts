import { DownloadTask } from '../../model/DownloadTask';
import { EngineHooks } from '../EngineHooks';
import { Ctrl } from '../types';

/**
 * SFTP (SSH File Transfer Protocol) download — URL parser and placeholder.
 *
 * SFTP runs over SSH (port 22 by default) and requires the full SSH transport
 * stack: key exchange, encryption, MAC, user authentication, and the SFTP
 * subsystem. This is not feasible to implement from scratch in pure ArkTS
 * without a native SSH library.
 *
 * This module provides URL parsing so the engine can extract host/port/path/user
 * for future use and display meaningful error messages to the user.
 */
export interface SftpUrlInfo {
  host: string;
  port: number;
  user: string;
  password: string;
  path: string;
}

/** Parse an sftp:// URL into host, port, user, password, path. */
export function parseSftpUrl(url: string): SftpUrlInfo {
  // sftp://[user[:password]@]host[:port]/path
  const m = /^sftp:\/\/(?:([^:@]+)(?::([^@]*))?@)?([^:/]+)(?::(\d+))?(?:\/(.*))?$/.exec(url);
  if (!m) {
    throw new Error(`Invalid SFTP URL: ${url}`);
  }
  return {
    user: m[1] ?? '',
    password: m[2] ?? '',
    host: m[3],
    port: m[4] ? Number(m[4]) : 22,
    path: m[5] ? `/${m[5]}` : '/'
  };
}

/**
 * SFTP download entry point — currently not supported.
 * Parses the URL for validation, then returns a descriptive error.
 */
export async function downloadSftp(task: DownloadTask, ctrl: Ctrl, hooks: EngineHooks): Promise<void> {
  let info: SftpUrlInfo;
  try {
    info = parseSftpUrl(task.url);
  } catch (e) {
    throw new Error(`SFTP 链接格式无效：${task.url}`);
  }
  throw new Error(
    `SFTP 协议（${info.host}:${info.port}）暂不支持。` +
    `SFTP 需要 SSH 加密传输层，目前无法在纯 ArkTS 环境中实现。` +
    `建议使用 FTP 协议或将文件转为 HTTP 直链下载。`
  );
}
