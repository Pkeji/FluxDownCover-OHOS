import { util } from '@kit.ArkTS';
import { http } from '@kit.NetworkKit';
import { cryptoFramework } from '@kit.CryptoArchitectureKit';
import fs from '@ohos.file.fs';
import { DownloadTask, Segment } from '../../model/DownloadTask';
import { EngineHooks, ProxyConfig } from '../EngineHooks';
import { Ctrl } from '../types';

/**
 * HLS (m3u8) protocol — ported from FluxDown Cover's hls_downloader.rs.
 *
 * Compared to the earlier simplified port this implements:
 *  - Master playlist parsing with BANDWIDTH/RESOLUTION; the auto pick is the
 *    HIGHEST bandwidth variant (not "last array element").
 *  - AES-128 segment decryption (#EXT-X-KEY:METHOD=AES-128) via
 *    @kit.CryptoArchitectureKit, with implicit IV = Media Sequence Number.
 *  - EXT-X-BYTERANGE sub-ranges (Range request must return 206).
 *  - EXT-X-MAP fMP4/CMAF init segment (fetched once, written before media
 *    segments so the output is actually decodable).
 */

/** Resolve a possibly-relative URI against a base playlist URL. */
function resolveUri(base: string, uri: string): string {
  if (/^https?:\/\//i.test(uri)) {
    return uri;
  }
  const idx = base.lastIndexOf('/');
  const dir = idx >= 0 ? base.substring(0, idx + 1) : '';
  let rest = uri;
  let d = dir;
  while (rest.startsWith('../')) {
    rest = rest.substring(3);
    const di = d.lastIndexOf('/', d.length - 2);
    d = di >= 0 ? d.substring(0, di + 1) : '';
  }
  return d + rest;
}

/** A variant stream from a master playlist. */
export interface HlsVariant {
  uri: string;
  bandwidth: number;
  resolution: string; // "WxH" or ''
  label: string;
}

/** A single media segment (possibly encrypted / byte-ranged). */
interface HlsMediaSegment {
  uri: string;
  keyUri: string; // resolved AES-128 key URI ('' = plaintext)
  keyIv: string; // 16-byte IV as 32 hex chars ('' = derive from media sequence)
  byteRange: string | null; // "start-end" (EXT-X-BYTERANGE)
}

interface MediaPlaylist {
  segments: HlsMediaSegment[];
  initUri: string; // EXT-X-MAP resolved URI ('' = none)
  mediaSequence: number; // EXT-X-MEDIA-SEQUENCE (for implicit IV)
}

/** Parse a master playlist into variants, sorted by bandwidth descending. */
function parseMaster(text: string, base: string): HlsVariant[] {
  const lines = text.split('\n').map((l) => l.trim());
  const variants: HlsVariant[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith('#EXT-X-STREAM-INF')) {
      const bwMatch = /BANDWIDTH=(\d+)/i.exec(line);
      const resMatch = /RESOLUTION=(\d+x\d+)/i.exec(line);
      const bandwidth = bwMatch ? parseInt(bwMatch[1], 10) : 0;
      const resolution = resMatch ? resMatch[1] : '';
      let j = i + 1;
      while (j < lines.length && (lines[j] === '' || lines[j].startsWith('#'))) {
        j++;
      }
      if (j < lines.length && lines[j]) {
        const uri = resolveUri(base, lines[j]);
        const label = resolution || (bandwidth > 0 ? `${Math.round(bandwidth / 1000)}k` : `变体 ${variants.length + 1}`);
        variants.push({ uri, bandwidth, resolution, label });
      }
    }
  }
  // 官方 select_variant 用 max_by_key(bandwidth)：默认取最高码率，故降序排序。
  variants.sort((a, b) => b.bandwidth - a.bandwidth);
  return variants;
}

/** Parse a media playlist into segments + optional EXT-X-MAP init URI. */
function parseMedia(text: string, base: string): MediaPlaylist {
  const lines = text.split('\n').map((l) => l.trim());
  const segments: HlsMediaSegment[] = [];
  let initUri = '';
  let mediaSequence = 0;
  let currentKeyUri = '';
  let currentKeyIv = '';
  let pendingRange: { length: number; offset?: number } | null = null;
  // EXT-X-BYTERANGE without @offset: offset = end of previous sub-range for the
  // same URI + 1 (per RFC 8216), accumulated in appearance order.
  const byterangeNext: Map<string, number> = new Map();

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) {
      const v = parseInt(line.substring('#EXT-X-MEDIA-SEQUENCE:'.length), 10);
      if (!isNaN(v)) {
        mediaSequence = v;
      }
      continue;
    }
    if (line.startsWith('#EXT-X-KEY:')) {
      const method = /METHOD=([^,\s]+)/i.exec(line);
      if (method && method[1].toUpperCase() === 'NONE') {
        currentKeyUri = '';
        currentKeyIv = '';
      } else if (method && method[1].toUpperCase() === 'AES-128') {
        const uriMatch = /URI="?([^",\s]+)"?/i.exec(line);
        currentKeyUri = uriMatch ? resolveUri(base, uriMatch[1]) : '';
        const ivMatch = /IV=0x([0-9a-fA-F]{32})/i.exec(line);
        currentKeyIv = ivMatch ? ivMatch[1].toLowerCase() : '';
      } else if (method && method[1].length > 0 && method[1].toUpperCase() !== 'AES-128') {
        // 官方对非 AES-128（如 SAMPLE-AES）报错，而非静默产出不可播文件。
        throw new Error(`HLS: 不支持的加密方式 ${method[1]}（仅支持 AES-128）`);
      }
      continue;
    }
    if (line.startsWith('#EXT-X-MAP:')) {
      const uriMatch = /URI="?([^",]+)"?/i.exec(line);
      if (uriMatch) {
        initUri = resolveUri(base, uriMatch[1]);
      }
      continue;
    }
    if (line.startsWith('#EXT-X-BYTERANGE:')) {
      const body = line.substring('#EXT-X-BYTERANGE:'.length);
      const m = /(\d+)(?:@(\d+))?/.exec(body);
      if (m) {
        pendingRange = { length: parseInt(m[1], 10), offset: m[2] ? parseInt(m[2], 10) : undefined };
      }
      continue;
    }
    if (line === '' || line.startsWith('#')) {
      continue;
    }
    // A media segment URI
    const uri = resolveUri(base, line);
    let byteRange: string | null = null;
    if (pendingRange) {
      const offset = pendingRange.offset !== undefined ? pendingRange.offset : (byterangeNext.get(uri) ?? 0);
      const end = offset + pendingRange.length - 1;
      byteRange = `${offset}-${end}`;
      byterangeNext.set(uri, end + 1);
      pendingRange = null;
    }
    segments.push({ uri, keyUri: currentKeyUri, keyIv: currentKeyIv, byteRange });
  }
  return { segments, initUri, mediaSequence };
}

/** Fetch a URL and return its body as an ArrayBuffer (playlist / key / init). */
async function fetchBytes(url: string, ignoreTls: boolean, proxy?: ProxyConfig): Promise<ArrayBuffer> {
  const req = http.createHttp();
  try {
    const resp = await req.request(url, {
      method: http.RequestMethod.GET,
      header: { Accept: '*/*' },
      expectDataType: http.HttpDataType.ARRAY_BUFFER,
      connectTimeout: 20000,
      readTimeout: 60000,
      remoteValidation: ignoreTls ? 'skip' : 'system',
      usingProxy: proxy
    });
    const code = resp.responseCode as number;
    if (code < 200 || code >= 300) {
      throw new Error(`HLS: HTTP ${code} ${url}`);
    }
    const result = resp.result;
    return result instanceof ArrayBuffer ? result : new ArrayBuffer(0);
  } finally {
    req.destroy();
  }
}

async function fetchPlaylistText(url: string, ignoreTls: boolean, proxy?: ProxyConfig): Promise<string> {
  const bytes = await fetchBytes(url, ignoreTls, proxy);
  return util.TextDecoder.create('utf-8').decodeToString(new Uint8Array(bytes));
}

/** Probe a master playlist and return selectable variants (URL + label), highest bandwidth first. */
export async function probeHlsVariants(m3u8Url: string, proxy?: ProxyConfig): Promise<{ urls: string[]; labels: string[] }> {
  const text = await fetchPlaylistText(m3u8Url, false, proxy);
  const variants = parseMaster(text, m3u8Url);
  if (variants.length > 0) {
    return { urls: variants.map((v) => v.uri), labels: variants.map((v) => v.label) };
  }
  return { urls: [], labels: [] };
}

/**
 * Follow master → variant (one level) and return the final media playlist.
 * `qualityIndex` selects a variant from the bandwidth-descending list;
 * -1 = auto (highest bandwidth, index 0).
 */
async function fetchMediaPlaylist(m3u8Url: string, qualityIndex: number, ignoreTls: boolean, proxy?: ProxyConfig): Promise<MediaPlaylist> {
  let url = m3u8Url;
  for (let guard = 0; guard < 6; guard++) {
    const text = await fetchPlaylistText(url, ignoreTls, proxy);
    const variants = parseMaster(text, url);
    if (variants.length > 0) {
      const idx = qualityIndex >= 0 && qualityIndex < variants.length ? qualityIndex : 0;
      url = variants[idx].uri;
      continue;
    }
    return parseMedia(text, url);
  }
  throw new Error('HLS: 无法解析播放列表（嵌套层级过深）');
}

/** Build the per-segment list (each carries its own media URL) for an HLS task. */
export async function buildHlsSegments(task: DownloadTask, qualityIndex: number = -1, hooks?: EngineHooks): Promise<void> {
  const ignoreTls = hooks ? hooks.shouldIgnoreTlsErrors() : false;
  const proxy = hooks ? hooks.proxyOption() : undefined;
  const playlist = await fetchMediaPlaylist(task.url, qualityIndex, ignoreTls, proxy);
  if (playlist.segments.length === 0) {
    throw new Error('HLS: 无法解析播放列表（未找到媒体分片）');
  }
  // Bake the AES-128 IV into each segment now: without an explicit IV it is
  // the big-endian Media Sequence Number (RFC 8216). Persisting the computed IV
  // keeps resume IV-correct even if the server rewrites EXT-X-MEDIA-SEQUENCE.
  task.segments = playlist.segments.map<Segment>((s, i) => ({
    index: i,
    url: s.uri,
    start: 0,
    end: -1,
    downloaded: 0,
    done: false,
    keyUri: s.keyUri,
    keyIv: s.keyIv || (s.keyUri ? defaultIvHex(playlist.mediaSequence, i) : ''),
    byteRange: s.byteRange ?? undefined
  }));
  task.manifestInitUrl = playlist.initUri;
  if (!task.fileName || task.fileName === '') {
    task.fileName = 'playlist.ts';
  }
  task.isHls = true;
}

/** RFC 8216 implicit IV: 16 bytes, lower 8 = big-endian (media_sequence + index). */
function defaultIvHex(mediaSequence: number, index: number): string {
  const seq = (mediaSequence + index) >>> 0;
  // 16 字节 IV：前 12 字节为 0，后 4 字节为 32 位大端 (media_sequence + index)。
  // 对常规序号与官方（8 字节大端 u64，高位为 0）完全一致。
  let hex = '000000000000000000000000';
  for (let i = 24; i >= 0; i -= 8) {
    hex += ((seq >>> i) & 0xff).toString(16).padStart(2, '0');
  }
  return hex;
}

/** Convert a 32-hex IV string to 16 bytes. */
function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.substring(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/**
 * AES-128-CBC decrypt. Mirrors the official engine's decrypt_segment:
 * block-aligned data is decrypted with PKCS7 (the HLS spec case); non-aligned
 * data (non-conforming source) is decrypted with NoPadding on the aligned
 * prefix, dropping the trailing remainder bytes.
 */
async function aes128DecryptCbc(data: ArrayBuffer, key: Uint8Array, iv: Uint8Array): Promise<ArrayBuffer> {
  if (data.byteLength === 0) {
    return new ArrayBuffer(0);
  }
  const generator = cryptoFramework.createSymKeyGenerator('AES128');
  const symKey = await generator.convertKey({ data: key });
  const aligned = Math.floor(data.byteLength / 16) * 16;
  const padding = aligned === data.byteLength ? 'PKCS7' : 'NOPADDING';
  const cipher = cryptoFramework.createCipher(`AES128|CBC|${padding}`);
  const params: cryptoFramework.IvParamsSpec = { algName: 'IvParamsSpec', iv: { data: iv } };
  await cipher.init(cryptoFramework.CryptoMode.DECRYPT_MODE, symKey, params);
  const out = await cipher.doFinal({ data: new Uint8Array(data.slice(0, aligned)) });
  return out.data.slice(0, out.data.byteLength).buffer as ArrayBuffer;
}

/** Fetch a media segment (optionally a byte sub-range); returns its raw body. */
async function fetchSegmentBytes(url: string, byteRange: string | undefined, hooks: EngineHooks): Promise<ArrayBuffer> {
  const req = http.createHttp();
  try {
    const headers: Record<string, string> = { Accept: '*/*' };
    if (byteRange) {
      headers['Range'] = `bytes=${byteRange}`;
    }
    const resp = await req.request(url, {
      method: http.RequestMethod.GET,
      header: headers,
      expectDataType: http.HttpDataType.ARRAY_BUFFER,
      connectTimeout: 30000,
      readTimeout: 60000,
      remoteValidation: hooks.shouldIgnoreTlsErrors() ? 'skip' : 'system',
      usingProxy: hooks.proxyOption()
    });
    const code = resp.responseCode as number;
    if (code < 200 || code >= 300) {
      throw new Error(`HLS: HTTP ${code} 获取分片失败`);
    }
    if (byteRange && code !== 206) {
      // EXT-X-BYTERANGE 必须得到 206，否则每段会各自下载整个文件。
      throw new Error('HLS: EXT-X-BYTERANGE 请求未返回 206 Partial Content');
    }
    const result = resp.result;
    const body = result instanceof ArrayBuffer ? result : new ArrayBuffer(0);
    if (byteRange) {
      const dash = byteRange.indexOf('-');
      const start = parseInt(byteRange.substring(0, dash), 10);
      const end = parseInt(byteRange.substring(dash + 1), 10);
      const expected = end - start + 1;
      if (body.byteLength !== expected) {
        throw new Error(`HLS: 分片长度不匹配（预期 ${expected}，实际 ${body.byteLength}）`);
      }
    }
    return body;
  } finally {
    req.destroy();
  }
}

/**
 * Download an HLS playlist: fetch each segment in order (decrypting when
 * encrypted) and append it to the output file. An EXT-X-MAP init segment is
 * written first when the output file is empty (persisted manifestInitUrl
 * guarantees it is also re-fetched on resume after an interrupted init fetch).
 */
export async function downloadHls(task: DownloadTask, ctrl: Ctrl, hooks: EngineHooks): Promise<void> {
  const file = fs.openSync(task.filePath, fs.OpenMode.READ_WRITE | fs.OpenMode.CREATE);
  const keyCache: Map<string, Uint8Array> = new Map();
  try {
    let writeOffset = fs.statSync(task.filePath).size;
    // fMP4/CMAF 初始化段（EXT-X-MAP）：先写 init，媒体分片才能解码。
    if (task.manifestInitUrl && writeOffset === 0) {
      const init = await fetchSegmentBytes(task.manifestInitUrl, undefined, hooks);
      fs.writeSync(file.fd, init, { offset: writeOffset });
      writeOffset += init.byteLength;
    }
    for (const seg of task.segments) {
      if (ctrl.aborted) {
        break;
      }
      if (seg.done) {
        continue;
      }
      let data = await fetchSegmentBytes(seg.url ?? task.url, seg.byteRange, hooks);
      if (seg.keyUri && seg.keyUri.length > 0) {
        let key = keyCache.get(seg.keyUri);
        if (!key) {
          const keyBytes = await fetchSegmentBytes(seg.keyUri, undefined, hooks);
          key = new Uint8Array(keyBytes);
          keyCache.set(seg.keyUri, key);
        }
        const iv = hexToBytes(seg.keyIv || '');
        data = await aes128DecryptCbc(data, key, iv);
      }
      // 全局/单任务限速（HLS 按整段节流）
      await hooks.throttle(task, data.byteLength);
      fs.writeSync(file.fd, data, { offset: writeOffset });
      writeOffset += data.byteLength;
      seg.downloaded = data.byteLength;
      seg.done = true;
      hooks.onChunk(task, data.byteLength);
    }
    if (!ctrl.aborted) {
      fs.fsyncSync(file.fd);
    }
  } finally {
    fs.closeSync(file);
  }
}
