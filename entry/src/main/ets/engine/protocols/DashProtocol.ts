import { http } from '@kit.NetworkKit';
import fs from '@ohos.file.fs';
import { DownloadTask, Segment } from '../../model/DownloadTask';
import { EngineHooks } from '../EngineHooks';
import { Ctrl } from '../types';

/**
 * DASH (Dynamic Adaptive Streaming over HTTP) protocol.
 * Ported from FluxDown's DASH support — parses MPD (Media Presentation Description)
 * XML to extract media segment URLs, then downloads them sequentially.
 * Similar to HLS but uses .mpd XML manifests instead of .m3u8 playlists.
 */

/** Resolve a possibly-relative URI against a base MPD URL. */
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

interface DashSegment {
  url: string;
  range?: string; // byte range "start-end"
}

/**
 * Parse a simple MPD XML to extract segment URLs.
 * Handles SegmentTemplate with $Number$ and SegmentList patterns.
 */
function parseMpd(xml: string, baseUrl: string): DashSegment[] {
  const segments: DashSegment[] = [];

  // Pattern 1: <SegmentList> with <SegmentURL media="..."/>
  const segUrlTags = extractAll(xml, '<SegmentURL', '/>');
  for (const tag of segUrlTags) {
    const mediaMatch = tag.match(/media="([^"]*)"/);
    if (mediaMatch) {
      segments.push({ url: resolveUri(baseUrl, mediaMatch[1]) });
    }
  }

  if (segments.length > 0) return segments;

  // Pattern 2: <SegmentTemplate media="...$Number$..." startNumber="1" endNumber="N"/>
  const templateMatch = xml.match(/<SegmentTemplate[^>]*media="([^"]*)"[^>]*>/);
  if (templateMatch) {
    const mediaTemplate = templateMatch[1];
    const startMatch = xml.match(/startNumber="(\d+)"/);
    const endMatch = xml.match(/endNumber="(\d+)"/);
    const durationMatch = xml.match(/duration="(\d+)"/);
    const timescaleMatch = xml.match(/timescale="(\d+)"/);
    const startNum = startMatch ? parseInt(startMatch[1]) : 1;
    const endNum = endMatch ? parseInt(endMatch[1]) : 0;

    if (endNum > 0) {
      for (let i = startNum; i <= endNum; i++) {
        const url = mediaTemplate.replace(/\$Number\$/g, String(i));
        segments.push({ url: resolveUri(baseUrl, url) });
      }
    } else if (durationMatch) {
      // Estimate segments from period duration
      const duration = parseInt(durationMatch[1]);
      const timescale = timescaleMatch ? parseInt(timescaleMatch[1]) : 1;
      const periodMatch = xml.match(/<Period[^>]*duration="PT(\d+\.?\d*)S"/);
      if (periodMatch) {
        const periodDuration = parseFloat(periodMatch[1]);
        const segDuration = duration / timescale;
        const count = Math.ceil(periodDuration / segDuration);
        for (let i = startNum; i < startNum + count; i++) {
          const url = mediaTemplate.replace(/\$Number\$/g, String(i));
          segments.push({ url: resolveUri(baseUrl, url) });
        }
      }
    }
  }

  // Pattern 3: <BaseURL>...</BaseURL> (single file)
  if (segments.length === 0) {
    const baseUrlMatch = xml.match(/<BaseURL>([^<]*)<\/BaseURL>/);
    if (baseUrlMatch) {
      segments.push({ url: resolveUri(baseUrl, baseUrlMatch[1].trim()) });
    }
  }

  return segments;
}

function extractAll(xml: string, startTag: string, endTag: string): string[] {
  const results: string[] = [];
  let pos = 0;
  while (true) {
    const start = xml.indexOf(startTag, pos);
    if (start < 0) break;
    const end = xml.indexOf(endTag, start);
    if (end < 0) break;
    results.push(xml.substring(start, end + endTag.length));
    pos = end + endTag.length;
  }
  return results;
}

/** Fetch MPD manifest and extract segment URLs. */
async function fetchDashSegments(mpdUrl: string): Promise<string[]> {
  const req = http.createHttp();
  try {
    const resp = await req.request(mpdUrl, {
      method: http.RequestMethod.GET,
      header: { Accept: '*/*' },
      expectDataType: http.HttpDataType.STRING,
      connectTimeout: 20000,
      readTimeout: 20000,
    });
    if (resp.responseCode >= 200 && resp.responseCode < 300) {
      const xml = resp.result as string;
      const segments = parseMpd(xml, mpdUrl);
      return segments.map(s => s.url);
    }
    return [];
  } catch (e) {
    return [];
  } finally {
    req.destroy();
  }
}

/** Build the per-segment list for a DASH task. */
export async function buildDashSegments(task: DownloadTask): Promise<void> {
  const segs = await fetchDashSegments(task.url);
  if (segs.length === 0) {
    throw new Error('DASH: 无法解析MPD清单（未找到媒体分片）');
  }
  task.segments = segs.map<Segment>((u, i) => ({
    index: i,
    url: u,
    start: 0,
    end: -1,
    downloaded: 0,
    done: false,
  }));
  if (!task.fileName || task.fileName === '') {
    task.fileName = 'dash_output.mp4';
  }
  task.isHls = true; // reuse HLS sequential-append path
}

/**
 * Download a DASH stream: fetch each segment in order and append to output file.
 * Reuses the same sequential-append logic as HLS.
 */
export async function downloadDash(task: DownloadTask, ctrl: Ctrl, hooks: EngineHooks): Promise<void> {
  const file = fs.openSync(task.filePath, fs.OpenMode.READ_WRITE | fs.OpenMode.CREATE | fs.OpenMode.APPEND);
  let writeChain: Promise<void> = Promise.resolve();
  let writeErr: Error | null = null;
  try {
    for (const seg of task.segments) {
      if (ctrl.aborted) break;
      if (seg.done) continue;
      const req = http.createHttp();
      let segResolve: () => void = () => {};
      let segReject: (e: Error) => void = () => {};
      const segDone = new Promise<void>((res, rej) => { segResolve = res; segReject = rej; });
      req.on('dataReceive', (chunk: ArrayBuffer) => {
        if (ctrl.aborted) return;
        writeChain = writeChain
          .then(() => fs.write(file.fd, chunk))
          .then((len: number) => { seg.downloaded += len; hooks.onChunk(task, len); })
          .catch((e) => { writeErr = e as Error; });
      });
      req.on('dataEnd', () => {
        if (writeErr) { req.destroy(); segReject(writeErr); return; }
        writeChain.then(() => { seg.done = true; req.destroy(); segResolve(); }).catch((e) => segReject(e as Error));
      });
      try {
        await req.requestInStream(seg.url ?? task.url, {
          method: http.RequestMethod.GET,
          header: { Accept: '*/*' },
          connectTimeout: 30000,
          readTimeout: 30000,
        });
      } catch (e) {
        req.destroy();
        if (ctrl.aborted) break;
        throw e as Error;
      }
      await segDone;
    }
    await writeChain;
  } finally {
    fs.closeSync(file);
  }
}
