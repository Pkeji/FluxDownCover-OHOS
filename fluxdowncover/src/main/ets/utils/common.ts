import Url from '@ohos.url';
import { util } from '@kit.ArkTS';
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

/** Human readable date/time from a unix timestamp (ms). */
export function formatDateTime(ts: number): string {
  if (!ts) {
    return '-';
  }
  const d = new Date(ts);
  const pad = (n: number) => n.toString().padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** Human readable duration from ms. e.g. 3723000 -> "1h 2m 3s". */
export function formatDuration(ms: number): string {
  if (ms < 0) {
    return '-';
  }
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  const parts: string[] = [];
  if (h > 0) {
    parts.push(`${h}h`);
  }
  if (m > 0) {
    parts.push(`${m}m`);
  }
  parts.push(`${s}s`);
  return parts.join(' ');
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

/** Base64 decode → UTF-8 string. */
function base64ToString(b64: string): string {
  const helper = new util.Base64Helper();
  const bytes = helper.decodeSync(b64);
  const decoder = util.TextDecoder.create('utf-8', { ignoreBOM: true });
  return decoder.decodeToString(bytes);
}

/**
 * Decode a wrapper-protocol URL (thunder://, flashget://, qqdl://) to its
 * underlying real URL. Returns null on failure.
 */
function decodeWrappedUrl(rawUrl: string): string | null {
  const lower = rawUrl.toLowerCase().trim();
  try {
    if (lower.startsWith('thunder://')) {
      const b64 = rawUrl.substring('thunder://'.length);
      const decoded = base64ToString(b64);
      // thunder:// wraps the real URL as: base64("AA" + realUrl + "ZZ")
      if (decoded.startsWith('AA') && decoded.endsWith('ZZ')) {
        return decoded.substring(2, decoded.length - 2);
      }
      return decoded;
    }
    if (lower.startsWith('flashget://')) {
      const b64 = rawUrl.substring('flashget://'.length);
      const decoded = base64ToString(b64);
      // flashget:// wraps as: base64("[FLASHGET]" + realUrl + "[FLASHGET]")
      const prefix = '[FLASHGET]';
      if (decoded.startsWith(prefix) && decoded.endsWith(prefix)) {
        return decoded.substring(prefix.length, decoded.length - prefix.length);
      }
      return decoded;
    }
    if (lower.startsWith('qqdl://')) {
      const b64 = rawUrl.substring('qqdl://'.length);
      return base64ToString(b64);
    }
  } catch (_) { }
  return null;
}

/** Best-effort file name extracted from a URL of any known protocol type. */
export function fileNameFromUrl(url: string): string {
  const trimmed = url.trim();
  const lower = trimmed.toLowerCase();

  // ── 1. Wrapper protocols (thunder://, flashget://, qqdl://) ─────────
  if (lower.startsWith('thunder://') || lower.startsWith('flashget://') || lower.startsWith('qqdl://')) {
    const realUrl = decodeWrappedUrl(trimmed);
    if (realUrl) {
      // Recurse on the decoded real URL to extract the actual file name
      return fileNameFromUrl(realUrl);
    }
    return '';
  }

  // ── 2. eD2K links ───────────────────────────────────────────────────
  // Format: ed2k://|file|<filename>|<size>|<MD4-hex>|/
  if (lower.startsWith('ed2k://')) {
    const parts = trimmed.split('|');
    // parts[0]="ed2k://", parts[1]="file", parts[2]=<filename>
    if (parts.length >= 4 && parts[1].toLowerCase() === 'file' && parts[2]) {
      return sanitizeFileName(decodeURIComponent(parts[2]));
    }
    return '';
  }

  // ── 3. Magnet links ─────────────────────────────────────────────────
  if (lower.startsWith('magnet:')) {
    const match = trimmed.match(/[?&]dn=([^&]+)/);
    if (match) {
      const dn = decodeURIComponent(match[1]);
      if (dn) {
        return sanitizeFileName(dn);
      }
    }
    return '';
  }

  // ── 4. Standard URLs (HTTP, HTTPS, FTP, HLS, DASH, SFTP …) ─────────
  try {
    const u = new Url.URL(trimmed);
    const raw = decodeURIComponent(u.pathname.split('/').pop() ?? '');
    if (raw && raw.includes('.')) {
      return sanitizeFileName(raw);
    }
  } catch (_) { }

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
  if (lower.includes('.mpd') || lower.includes('dash')) {
    return ProtocolType.DASH;
  }
  if (lower.startsWith('ed2k://')) {
    return ProtocolType.ED2K;
  }
  if (lower.startsWith('thunder://')) {
    return ProtocolType.THUNDER;
  }
  if (lower.startsWith('flashget://')) {
    return ProtocolType.FLASHGET;
  }
  if (lower.startsWith('qqdl://')) {
    return ProtocolType.QQDL;
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

/** Display metadata for each protocol, used by UI chips, badges, and About page. */
export interface ProtocolMeta {
  label: string;
  desc: string;
  color: string;
  implemented: boolean;
  /** Longer description for the About page. */
  fullDesc: string;
}

const PROTOCOL_META: Record<string, ProtocolMeta> = {
  [ProtocolType.HTTP]: { label: 'HTTP', desc: '网页直链', color: '#4CAF50', implemented: true, fullDesc: '网页直链下载，支持多线程分片与断点续传' },
  [ProtocolType.HTTPS]: { label: 'HTTPS', desc: '加密直链', color: '#2196F3', implemented: true, fullDesc: '加密直链下载，TLS 安全传输' },
  [ProtocolType.FTP]: { label: 'FTP', desc: '文件传输', color: '#FF9800', implemented: true, fullDesc: '文件传输协议，支持被动模式' },
  [ProtocolType.SFTP]: { label: 'SFTP', desc: 'SSH 文件传输', color: '#795548', implemented: false, fullDesc: 'SSH 加密文件传输，需要 SSH 传输层支持' },
  [ProtocolType.HLS]: { label: 'HLS', desc: '流媒体 m3u8', color: '#9C27B0', implemented: true, fullDesc: 'HTTP Live Streaming，m3u8 分段流媒体下载' },
  [ProtocolType.DASH]: { label: 'DASH', desc: '流媒体 mpd', color: '#AB47BC', implemented: true, fullDesc: 'Dynamic Adaptive Streaming，mpd 清单分段下载' },
  [ProtocolType.BITTORRENT]: { label: 'BT', desc: 'P2P / 磁力', color: '#00BCD4', implemented: true, fullDesc: 'P2P 下载，支持磁力链接与 .torrent 种子' },
  [ProtocolType.THUNDER]: { label: '迅雷', desc: 'thunder://', color: '#FF5722', implemented: true, fullDesc: '迅雷专用链接，自动解码并转发至真实协议' },
  [ProtocolType.FLASHGET]: { label: '快车', desc: 'flashget://', color: '#E91E63', implemented: true, fullDesc: '快车专用链接，自动解码并转发至真实协议' },
  [ProtocolType.QQDL]: { label: '旋风', desc: 'qqdl://', color: '#00C853', implemented: true, fullDesc: 'QQ 旋风专用链接，自动解码并转发至真实协议' },
  [ProtocolType.ED2K]: { label: 'eD2K', desc: 'eDonkey 网络', color: '#607D8B', implemented: true, fullDesc: 'eDonkey2000 网络，服务端 + 对等端协议' },
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
  ProtocolType.DASH,
  ProtocolType.BITTORRENT,
  ProtocolType.THUNDER,
  ProtocolType.FLASHGET,
  ProtocolType.QQDL,
  ProtocolType.ED2K,
];

/** Built-in file categories (matching FluxDown's FileCategory enum). */
export interface BuiltinCategory {
  id: string;
  name: string;
  icon: string;
  extensions: string[];
}

export const BUILTIN_CATEGORIES: BuiltinCategory[] = [
  { id: 'builtin_video', name: '视频', icon: 'film', extensions: ['.mp4', '.mkv', '.avi', '.mov', '.flv', '.wmv', '.webm', '.m4v', '.ts', '.rmvb'] },
  { id: 'builtin_audio', name: '音频', icon: 'music', extensions: ['.mp3', '.flac', '.wav', '.aac', '.ogg', '.m4a', '.wma', '.ape', '.opus'] },
  { id: 'builtin_image', name: '图片', icon: 'image', extensions: ['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp', '.svg', '.ico', '.tiff'] },
  { id: 'builtin_document', name: '文档', icon: 'file_text', extensions: ['.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.txt', '.epub', '.mobi', '.csv', '.md'] },
  { id: 'builtin_archive', name: '压缩包', icon: 'archive', extensions: ['.zip', '.rar', '.7z', '.tar', '.gz', '.bz2', '.xz', '.iso'] },
  { id: 'builtin_apk', name: '安装包', icon: 'package', extensions: ['.apk', '.aab', '.hap', '.app', '.ipa', '.dmg', '.exe', '.msi', '.deb', '.rpm', '.pkg'] },
];

/** Check if a filename matches a builtin category id. */
export function matchesBuiltinCategory(fileName: string, catId: string): boolean {
  const cat = BUILTIN_CATEGORIES.find(c => c.id === catId);
  if (!cat) return false;
  const lower = fileName.toLowerCase();
  return cat.extensions.some(ext => lower.endsWith(ext));
}

/** 文件类型图标和颜色 */
export interface FileTypeMeta {
  icon: string;
  color: string;
  label?: string; // 安装包类型显示格式缩写，如 HAP、DMG
}

/** 根据文件名返回文件类型图标、颜色和标签 */
export function fileTypeMeta(fileName: string): FileTypeMeta {
  const lower = fileName.toLowerCase();
  // 视频
  if (['.mp4', '.mkv', '.avi', '.mov', '.flv', '.wmv', '.webm', '.m4v', '.ts', '.rmvb', '.3gp', '.m2ts'].some(ext => lower.endsWith(ext))) {
    return { icon: 'file_video', color: '#FF6B6B' };
  }
  // 音频
  if (['.mp3', '.flac', '.wav', '.aac', '.ogg', '.m4a', '.wma', '.ape', '.opus', '.dsf'].some(ext => lower.endsWith(ext))) {
    return { icon: 'file_audio', color: '#4ECDC4' };
  }
  // 图片
  if (['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp', '.svg', '.ico', '.tiff', '.heic', '.raw'].some(ext => lower.endsWith(ext))) {
    return { icon: 'file_image', color: '#FFD93D' };
  }
  // 文档
  if (['.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.txt', '.epub', '.mobi', '.csv', '.md', '.rtf'].some(ext => lower.endsWith(ext))) {
    return { icon: 'file_text', color: '#54A0FF' };
  }
  // 压缩包
  if (['.zip', '.rar', '.7z', '.tar', '.gz', '.bz2', '.xz', '.iso', '.zst'].some(ext => lower.endsWith(ext))) {
    return { icon: 'file_archive', color: '#FF9F43' };
  }
  // 安装包 - 显示格式缩写
  const pkgExts: { ext: string; label: string }[] = [
    { ext: '.hap', label: 'HAP' },
    { ext: '.apk', label: 'APK' },
    { ext: '.aab', label: 'AAB' },
    { ext: '.app', label: 'APP' },
    { ext: '.ipa', label: 'IPA' },
    { ext: '.dmg', label: 'DMG' },
    { ext: '.exe', label: 'EXE' },
    { ext: '.msi', label: 'MSI' },
    { ext: '.deb', label: 'DEB' },
    { ext: '.rpm', label: 'RPM' },
    { ext: '.pkg', label: 'PKG' },
  ];
  for (const p of pkgExts) {
    if (lower.endsWith(p.ext)) {
      return { icon: 'package', color: '#5F27CD', label: p.label };
    }
  }
  // 代码
  if (['.js', '.ts', '.py', '.java', '.c', '.cpp', '.h', '.go', '.rs', '.html', '.css', '.json', '.xml', '.yaml', '.yml', '.sh'].some(ext => lower.endsWith(ext))) {
    return { icon: 'file_code', color: '#00D2D3' };
  }
  // 种子
  if (lower.endsWith('.torrent')) {
    return { icon: 'file_type', color: '#FF6B6B', label: 'BT' };
  }
  // 其他
  return { icon: 'file_type', color: '#A1A1A6' };
}
