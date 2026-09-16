import { DownloadTask } from '../../model/DownloadTask';
import { EngineHooks } from '../EngineHooks';
import { Ctrl } from '../types';

/**
 * SFTP (SSH File Transfer Protocol) — URL parsing, SSH key auth support,
 * and actionable guidance for users.
 *
 * ## 当前限制
 * SFTP 运行在 SSH 加密传输层之上（端口 22），需要完整的 SSH 协议栈：
 * 密钥交换、加密、MAC、用户认证及 SFTP 子系统。纯 ArkTS 无法实现
 * 完整的 SSH 协议栈，需依赖原生 C++ NAPI 扩展（libssh2 / OpenSSL）。
 *
 * ## 已支持功能
 * - URL 解析（含用户名、密码、SSH 密钥路径参数）
 * - SSH 密钥认证信息提取（通过 URL query: `?key=/path/to/id_rsa`）
 * - 清晰的错误引导、替代方案建议
 *
 * ## 未来规划
 * - Phase 1: NAPI 封装 libssh2，实现 SFTP 下载（本占位符）
 * - Phase 2: 支持 SSH 代理跳板
 */
export interface SftpUrlInfo {
  host: string;
  port: number;
  user: string;
  password: string;
  path: string;
  /** SSH private key path (from ?key=... query param) */
  keyPath: string;
  /** SSH fingerprint to verify */
  fingerprint: string;
}

/**
 * Parse an sftp:// URL into structured info.
 *
 * Format: sftp://[user[:password]@]host[:port]/path[?key=/path/to/key&fingerprint=xx:xx:...]
 *
 * Examples:
 *   sftp://example.com/home/file.txt
 *   sftp://user@example.com:2222/home/file.txt
 *   sftp://user:pass@example.com/home/file.txt?key=/sdcard/.ssh/id_rsa
 */
export function parseSftpUrl(url: string): SftpUrlInfo {
  // Separate query string from main URL
  const qIdx = url.indexOf('?');
  let baseUrl = url;
  let queryStr = '';
  if (qIdx >= 0) {
    baseUrl = url.substring(0, qIdx);
    queryStr = url.substring(qIdx + 1);
  }

  // Parse query params
  const params = new Map<string, string>();
  if (queryStr) {
    queryStr.split('&').forEach((pair) => {
      const eqIdx = pair.indexOf('=');
      if (eqIdx > 0) {
        params.set(decodeURIComponent(pair.substring(0, eqIdx)),
          decodeURIComponent(pair.substring(eqIdx + 1)));
      }
    });
  }

  // sftp://[user[:password]@]host[:port]/path
  const m = /^sftp:\/\/(?:([^:@]+)(?::([^@]*))?@)?([^:/]+)(?::(\d+))?(?:\/(.*))?$/.exec(baseUrl);
  if (!m) {
    throw new Error(`Invalid SFTP URL: ${url}`);
  }
  return {
    user: m[1] ?? '',
    password: m[2] ?? '',
    host: m[3],
    port: m[4] ? Number(m[4]) : 22,
    path: m[5] ? `/${m[5]}` : '/',
    keyPath: params.get('key') ?? '',
    fingerprint: params.get('fingerprint') ?? ''
  };
}

/**
 * SFTP download entry point.
 *
 * Currently parses the URL and provides actionable guidance.
 * Throws an error with suggestions. When a native SSH NAPI module
 * becomes available, this function will invoke it.
 */
export async function downloadSftp(task: DownloadTask, ctrl: Ctrl, hooks: EngineHooks): Promise<void> {
  let info: SftpUrlInfo;
  try {
    info = parseSftpUrl(task.url);
  } catch (e) {
    throw new Error(`SFTP 链接格式无效：${task.url}。\n正确格式：sftp://[user[:password]@]host[:port]/path[?key=私钥路径]`);
  }

  // Build actionable error message
  const authMethod = info.keyPath
    ? `SSH 私钥（${info.keyPath}）`
    : info.password
      ? '密码认证'
      : '无认证信息';

  const suggestions: string[] = [];
  suggestions.push(`1) 使用 FTP 协议替代：ftp://${info.user ? info.user + '@' : ''}${info.host}:${info.port}${info.path}`);
  if (!info.keyPath) {
    suggestions.push('2) 添加 SSH 密钥参数：在 URL 末尾添加 ?key=/data/.ssh/id_rsa');
  }
  if (info.fingerprint) {
    suggestions.push(`3) 如需验证主机指纹，确保 fingerprint=${info.fingerprint} 正确`);
  }
  suggestions.push('4) 将文件托管为 HTTP 直链，使用 http/https 协议下载');

  throw new Error(
    `SFTP 协议暂不支持（${info.host}:${info.port}，${authMethod}）。\n` +
    `当前设备不支持纯 ArkTS 环境的 SSH 协议栈。\n` +
    `建议的替代方案：\n${suggestions.join('\n')}`
  );
}

/**
 * Validate whether an SFTP URL is syntactically correct.
 * Does NOT verify connectivity.
 */
export function isValidSftpUrl(url: string): boolean {
  try {
    parseSftpUrl(url);
    return true;
  } catch {
    return false;
  }
}
