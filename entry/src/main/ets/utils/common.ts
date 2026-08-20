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
  if (lower.startsWith('sftp://')) {
    return ProtocolType.SFTP;
  }
  if (lower.includes('.m3u8') || lower.includes('m3u8')) {
    return ProtocolType.HLS;
  }
  if (lower.startsWith('ed2k://')) {
    return ProtocolType.ED2K;
  }
  if (lower.startsWith('thunder://')) {
    return ProtocolType.THUNDER;
  }
  if (lower.startsWith('magnet:') || lower.startsWith('bt://') || lower.endsWith('.torrent')) {
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

/** Display metadata for each protocol, used by UI chips and badges. */
export interface ProtocolMeta {
  label: string;
  desc: string;
  color: string;
  implemented: boolean;
}

const PROTOCOL_META: Record<string, ProtocolMeta> = {
  [ProtocolType.HTTP]: { label: 'HTTP', desc: '网页直链', color: '#4CAF50', implemented: true },
  [ProtocolType.HTTPS]: { label: 'HTTPS', desc: '加密直链', color: '#2196F3', implemented: true },
  [ProtocolType.FTP]: { label: 'FTP', desc: '文件传输', color: '#FF9800', implemented: true },
  [ProtocolType.SFTP]: { label: 'SFTP', desc: 'SSH 文件传输', color: '#795548', implemented: false },
  [ProtocolType.HLS]: { label: 'HLS', desc: '流媒体 m3u8', color: '#9C27B0', implemented: true },
  [ProtocolType.BITTORRENT]: { label: 'BT', desc: 'P2P / 磁力', color: '#00BCD4', implemented: true },
  [ProtocolType.THUNDER]: { label: '迅雷', desc: 'thunder://', color: '#FF5722', implemented: false },
  [ProtocolType.ED2K]: { label: 'eD2K', desc: 'eDonkey 网络', color: '#607D8B', implemented: true },
};

export function protocolMeta(type: ProtocolType): ProtocolMeta {
  return PROTOCOL_META[type] ?? PROTOCOL_META[ProtocolType.HTTP];
}

/** All supported protocol types in display order. */
export const ALL_PROTOCOLS: ProtocolType[] = [
  ProtocolType.HTTP,
  ProtocolType.HTTPS,
  ProtocolType.FTP,
  ProtocolType.SFTP,
  ProtocolType.HLS,
  ProtocolType.BITTORRENT,
  ProtocolType.THUNDER,
  ProtocolType.ED2K,
];
