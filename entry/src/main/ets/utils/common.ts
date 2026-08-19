import Url from '@ohos.url';
import { ProtocolType } from '../model/ProtocolType';


/** Human readable byte size, e.g. 1536 -> "1.50 KB". */
export function formatBytes(bytes: number): string {
  if (!bytes || bytes < 0) {
    return '0 B';
  }
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let n = bytes;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(i === 0 ? 0 : 2)} ${units[i]}`;
}

/** Human readable transfer speed, e.g. "1.50 MB/s". */
export function formatSpeed(bytesPerSec: number): string {
  if (!bytesPerSec || bytesPerSec <= 0) {
    return '0 B/s';
  }
  return `${formatBytes(bytesPerSec)}/s`;
}

/** Stable unique id for a task. */
export function genId(): string {
  return `fd_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6).toString(36)}`;
}

/** Strip filesystem-unsafe characters from a file name. */
export function sanitizeFileName(name: string): string {
  if (!name) {
    return 'download.bin';
  }
  const cleaned = name.replace(/[\\/:*?"<>|\r\n\t]/g, '_').trim();
  return cleaned || 'download.bin';
}

/** Best-effort file name extracted from a URL path. */
export function fileNameFromUrl(url: string): string {
  try {
    const u = new Url.URL(url);
    const raw = decodeURIComponent(u.pathname.split('/').pop() ?? '');
    if (raw && raw.includes('.')) {
      return sanitizeFileName(raw);
    }
  } catch (e) {
    // ignore parse errors
  }
  return '';
}

/** Infer the protocol from a URL, with an optional explicit override. */
export function detectProtocol(url: string, override?: ProtocolType): ProtocolType {
  if (override) {
    return override;
  }
  const lower = url.toLowerCase();
  if (lower.startsWith('ftp://')) {
    return ProtocolType.FTP;
  }
  if (lower.includes('.m3u8') || lower.includes('m3u8')) {
    return ProtocolType.HLS;
  }
  if (lower.startsWith('ed2k://')) {
    return ProtocolType.ED2K;
  }
  if (lower.startsWith('magnet:') || lower.startsWith('bt://')) {
    return ProtocolType.BITTORRENT;
  }
  return lower.startsWith('https://') ? ProtocolType.HTTPS : ProtocolType.HTTP;
}

/** Parse host/port/path out of an ftp:// URL. */
export function parseFtpUrl(url: string): { host: string; port: number; path: string } {
  const m = /^ftp:\/\/([^:/]+)(?::(\d+))?(?:\/(.*))?$/.exec(url);
  if (!m) {
    throw new Error(`Invalid FTP URL: ${url}`);
  }
  return {
    host: m[1],
    port: m[2] ? Number(m[2]) : 21,
    path: m[3] ? `/${m[3]}` : '/'
  };
}
