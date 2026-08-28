import { http } from '@kit.NetworkKit';
import { BusinessError } from '@kit.BasicServicesKit';
import fs from '@ohos.file.fs';
import { DownloadTask } from '../../model/DownloadTask';
import { Segment } from '../../model/DownloadTask';
import { EngineHooks } from '../EngineHooks';
import { Ctrl } from '../types';

/** Resolve a possibly-relative URI against a base playlist URL. */
function resolveUri(base: string, uri: string): string {
  if (/^https?:\/\//i.test(uri)) {
    return uri;
  }
  const idx = base.lastIndexOf('/');
  const dir = idx >= 0 ? base.substring(0, idx + 1) : '';
  // minimal "../" handling
  let rest = uri;
  let d = dir;
  while (rest.startsWith('../')) {
    rest = rest.substring(3);
    const di = d.lastIndexOf('/', d.length - 2);
    d = di >= 0 ? d.substring(0, di + 1) : '';
  }
  return d + rest;
}

interface ParsedPlaylist {
  isMaster: boolean;
  variants: string[];
  variantLabels: string[];
  segments: string[];
}

function parsePlaylist(text: string, base: string): ParsedPlaylist {
  const lines = text.split('\n').map((l) => l.trim());
  const variants: string[] = [];
  const variantLabels: string[] = [];
  const segments: string[] = [];
  let isMaster = false;
  let pendingLabel = '';
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith('#EXTM3U') || line.startsWith('#EXT-X-')) {
      if (line.startsWith('#EXT-X-STREAM-INF')) {
        isMaster = true;
        // Capture a human-readable label (BANDWIDTH + RESOLUTION) for the picker.
        const bw = /BANDWIDTH=(\d+)/i.exec(line);
        const res = /RESOLUTION=(\d+x\d+)/i.exec(line);
        pendingLabel = res ? res[1] : (bw ? `${Math.round(Number(bw[1]) / 1000)}k` : `变体 ${variants.length + 1}`);
        // the following non-comment line is the variant URI
        let j = i + 1;
        while (j < lines.length && lines[j].startsWith('#')) {
          j++;
        }
        if (j < lines.length && lines[j]) {
          variants.push(resolveUri(base, lines[j]));
          variantLabels.push(pendingLabel);
        }
      }
      continue;
    }
    if (line === '' || line.startsWith('#')) {
      continue;
    }
    // a media segment URI (typically follows an #EXTINF line)
    segments.push(resolveUri(base, line));
  }
  return { isMaster, variants, variantLabels, segments };
}

/** Probe a master playlist and return selectable variants (URL + label). */
export async function probeHlsVariants(m3u8Url: string): Promise<{ urls: string[]; labels: string[] }> {
  const req = http.createHttp();
  try {
    const resp = await req.request(m3u8Url, {
      method: http.RequestMethod.GET,
      header: { Accept: '*/*' },
      expectDataType: http.HttpDataType.STRING,
      connectTimeout: 20000,
      readTimeout: 20000
    });
    const parsed = parsePlaylist(resp.result as string, m3u8Url);
    if (parsed.isMaster && parsed.variants.length > 0) {
      return { urls: parsed.variants, labels: parsed.variantLabels };
    }
    return { urls: [], labels: [] };
  } finally {
    req.destroy();
  }
}

/** Fetch playlist text. Follows one level of master->variant indirection. */
async function fetchMediaSegments(m3u8Url: string, qualityIndex: number = -1): Promise<string[]> {
  let url = m3u8Url;
  for (let guard = 0; guard < 6; guard++) {
    const req = http.createHttp();
    try {
      const resp = await req.request(url, {
        method: http.RequestMethod.GET,
        header: { Accept: '*/*' },
        expectDataType: http.HttpDataType.STRING,
        connectTimeout: 20000,
        readTimeout: 20000
      });
      const text = resp.result as string;
      const parsed = parsePlaylist(text, url);
      if (parsed.isMaster && parsed.variants.length > 0) {
        // Select the user-chosen variant; otherwise the last (highest) one.
        const idx = qualityIndex >= 0 && qualityIndex < parsed.variants.length ? qualityIndex : parsed.variants.length - 1;
        url = parsed.variants[idx];
        continue;
      }
      return parsed.segments;
    } finally {
      req.destroy();
    }
  }
  return [];
}

/** Build the per-segment list (each carries its own media URL) for an HLS task. */
export async function buildHlsSegments(task: DownloadTask, qualityIndex: number = -1): Promise<void> {
  const segs = await fetchMediaSegments(task.url, qualityIndex);
  if (segs.length === 0) {
    throw new Error('HLS: 无法解析播放列表（未找到媒体分片）');
  }
  task.segments = segs.map<Segment>((u, i) => ({
    index: i,
    url: u,
    start: 0,
    end: -1,
    downloaded: 0,
    done: false
  }));
  if (!task.fileName || task.fileName === '') {
    task.fileName = 'playlist.ts';
  }
  task.isHls = true;
}

/**
 * Download an HLS playlist: fetch each .ts segment in order and append it to the
 * output file. Resume support: already-completed segments are skipped.
 */
export async function downloadHls(task: DownloadTask, ctrl: Ctrl, hooks: EngineHooks): Promise<void> {
  const file = fs.openSync(task.filePath, fs.OpenMode.READ_WRITE | fs.OpenMode.CREATE | fs.OpenMode.APPEND);
  let writeChain: Promise<void> = Promise.resolve();
  let writeErr: Error | null = null;
  try {
    for (const seg of task.segments) {
      if (ctrl.aborted) {
        break;
      }
      if (seg.done) {
        continue;
      }
      const req = http.createHttp();
      let segResolve: () => void = () => {};
      let segReject: (e: Error) => void = () => {};
      const segDone = new Promise<void>((res, rej) => {
        segResolve = res;
        segReject = rej;
      });
      req.on('dataReceive', (chunk: ArrayBuffer) => {
        if (ctrl.aborted) {
          return;
        }
        writeChain = writeChain
          .then(() => fs.write(file.fd, chunk))
          .then((len: number) => {
            seg.downloaded += len;
            hooks.onChunk(task, len);
          })
          .catch((e: BusinessError) => {
            writeErr = e as Error;
          });
      });
      req.on('dataEnd', () => {
        if (writeErr) {
          req.destroy();
          segReject(writeErr);
          return;
        }
        writeChain
          .then(() => {
            seg.done = true;
            req.destroy();
            segResolve();
          })
          .catch((e) => segReject(e as Error));
      });
      try {
        await req.requestInStream(seg.url ?? task.url, {
          method: http.RequestMethod.GET,
          header: { Accept: '*/*' },
          connectTimeout: 30000,
          readTimeout: 30000
        });
      } catch (e) {
        req.destroy();
        if (ctrl.aborted) {
          break;
        }
        throw e as Error;
      }
      await segDone;
    }
    await writeChain;
  } finally {
    fs.closeSync(file);
  }
}
