import { http } from '@kit.NetworkKit';
import fs from '@ohos.file.fs';
import { DownloadTask, Segment } from '../../model/DownloadTask';
import { EngineHooks, ProxyConfig } from '../EngineHooks';
import { Ctrl } from '../types';

/**
 * DASH (Dynamic Adaptive Streaming over HTTP) protocol.
 * Ported from FluxDown Cover's DASH support (dash_downloader.rs).
 *
 * Compared to the earlier simplified port this implements:
 *  - MPD XML hierarchy walk (BaseURL chain at MPD/Period/AdaptationSet/
 *    Representation level).
 *  - Video AdaptationSet + highest-bandwidth Representation selection.
 *  - SegmentTemplate with $RepresentationID$/$Bandwidth$/$Number$/$Time$
 *    substitution (incl. %0Nd width), SegmentTimeline expansion
 *    (`<S t d r>`), constant-duration fallback, and the `initialization`
 *    template (fMP4 init segment → manifestInitUrl).
 *  - SegmentList (SegmentURL + Initialization) and SegmentBase (single-file).
 *  - ContentProtection (DRM) detection → clear error instead of a broken file.
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

interface XmlTag {
  name: string;
  attrs: Map<string, string>;
  content: string; // inner XML ('' for self-closing)
}

/** Extract all direct children of `xml` with the given tag name. */
function findTags(xml: string, name: string): XmlTag[] {
  const out: XmlTag[] = [];
  const openRe = new RegExp(`<${name}(\\s[^>]*)?(/?)>`, 'g');
  let m: RegExpExecArray | null = openRe.exec(xml);
  while (m !== null) {
    const isSelfClosing = m[2] === '/';
    const attrs = new Map<string, string>();
    const attrText = m[1] ?? '';
    const attrRe = /([A-Za-z0-9_:-]+)="([^"]*)"/g;
    let am: RegExpExecArray | null = attrRe.exec(attrText);
    while (am !== null) {
      attrs.set(am[1], am[2]);
      am = attrRe.exec(attrText);
    }
    if (isSelfClosing) {
      out.push({ name, attrs, content: '' });
    } else {
      const closeRe = new RegExp(`</${name}>`);
      closeRe.lastIndex = openRe.lastIndex;
      const cm = closeRe.exec(xml);
      if (cm) {
        out.push({ name, attrs, content: xml.substring(openRe.lastIndex, cm.index) });
        openRe.lastIndex = cm.index + cm[0].length;
      }
    }
    m = openRe.exec(xml);
  }
  return out;
}

function firstText(xml: string, tagName: string): string {
  const tags = findTags(xml, tagName);
  if (tags.length === 0) {
    return '';
  }
  return tags[0].content.trim();
}

/** Period-less / AdaptationSet-less MPD: treat the container itself as one representation. */
function buildSingleRepresentation(
  container: string,
  mpdUrl: string,
  periodBase: string,
  periodTemplate: XmlTag | null,
  periodDuration: number,
  mediaPresentationDuration: number
): DashPlan {
  if (hasContentProtection(container)) {
    throw new Error('DASH: 流已加密 (ContentProtection/DRM)，暂不支持解密');
  }
  const rep: XmlTag = { name: 'Representation', attrs: new Map<string, string>(), content: container };
  return buildFromRepresentation(rep, container, mpdUrl, periodBase, periodTemplate, periodDuration, mediaPresentationDuration);
}

interface DashSegment {
  url: string;
  range?: string; // byte range "start-end"
}

interface DashPlan {
  segments: DashSegment[];
  initUrl: string; // '' = none
  fileNameHint: string;
}

/** ISO-8601 duration "PT...S" / "PT...M...S" → seconds (0 if unparsable). */
function isoDurationToSeconds(s: string): number {
  if (!s) {
    return 0;
  }
  const m = /PT(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?/.exec(s);
  if (!m) {
    return 0;
  }
  const h = m[1] ? parseFloat(m[1]) : 0;
  const min = m[2] ? parseFloat(m[2]) : 0;
  const sec = m[3] ? parseFloat(m[3]) : 0;
  return h * 3600 + min * 60 + sec;
}

/** Substitute DASH template tokens: $RepresentationID$, $Bandwidth$, $Number$, $Time$, $%0Nd$. */
function substituteTemplate(tpl: string, params: Record<string, string>): string {
  let result = '';
  let i = 0;
  const re = /\$([A-Za-z]+)(%0(\d+)d)?\$/g;
  let m: RegExpExecArray | null = re.exec(tpl);
  while (m !== null) {
    result += tpl.substring(i, m.index);
    const name = m[1];
    const direct = params[name];
    const lower = params[name.toLowerCase()];
    let val = direct !== undefined ? direct : (lower !== undefined ? lower : '');
    if (m[3]) {
      const pad = parseInt(m[3], 10);
      val = val.padStart(pad, '0');
    }
    result += val;
    i = m.index + m[0].length;
    m = re.exec(tpl);
  }
  result += tpl.substring(i);
  return result;
}

/** Does the XML fragment declare DRM (ContentProtection)? */
function hasContentProtection(xml: string): boolean {
  return /<ContentProtection[^>]*(schemeIdUri="[^"]*(cenc|cbcs|widevine|playready|fairplay|marlin|clearkey)[^"]*"|value="(cenc|cbcs)")/i.test(xml);
}

/** Parse an MPD document into a downloadable plan (best video representation). */
function parseMpd(xml: string, mpdUrl: string): DashPlan {
  const mpdTags = findTags(xml, 'MPD');
  const mpdRoot = mpdTags.length > 0 ? mpdTags[0].content : xml;
  const mpdDuration = mpdTags.length > 0
    ? isoDurationToSeconds(mpdTags[0].attrs.get('mediaPresentationDuration') ?? '')
    : 0;

  // BaseURL chain resolution: collect base URLs from root level and from each
  // nested element, the innermost taking precedence.
  const mpdBase = firstText(mpdRoot, 'BaseURL');
  const periods = findTags(mpdRoot, 'Period');
  if (periods.length === 0) {
    // Period-less MPD: treat the root as a single period.
    return buildFromContainer({ name: 'Period', attrs: new Map<string, string>(), content: mpdRoot }, mpdUrl, mpdBase, mpdDuration);
  }
  return buildFromContainer(periods[0], mpdUrl, mpdBase, mpdDuration);
}

/** Build a plan from a Period (or Period-less root) container. */
function buildFromContainer(
  period: XmlTag,
  mpdUrl: string,
  mpdBase: string,
  mediaPresentationDuration: number
): DashPlan {
  const container = period.content;
  const periodBase = firstText(container, 'BaseURL') || mpdBase;
  const periodDuration = isoDurationToSeconds(period.attrs.get('duration') ?? '') || mediaPresentationDuration;

  // Merge period-level SegmentTemplate (attributes) for later template merging.
  const periodTemplate = findTags(container, 'SegmentTemplate')[0] ?? null;

  const adaptationSets = findTags(container, 'AdaptationSet');
  if (adaptationSets.length === 0) {
    // No AdaptationSet: use the container itself as a "single representation".
    return buildSingleRepresentation(container, mpdUrl, periodBase, periodTemplate, periodDuration, mediaPresentationDuration);
  }

  // Select the video AdaptationSet (contentType/mimeType video), else the first.
  let chosenSet: XmlTag | null = null;
  for (const as of adaptationSets) {
    const ct = (as.attrs.get('contentType') ?? '').toLowerCase();
    const mime = (as.attrs.get('mimeType') ?? '').toLowerCase();
    if (ct === 'video' || mime.includes('video')) {
      chosenSet = as;
      break;
    }
  }
  if (!chosenSet) {
    chosenSet = adaptationSets[0];
  }
  return buildFromAdaptationSet(chosenSet, mpdUrl, periodBase, periodTemplate, periodDuration, mediaPresentationDuration);
}

/** Build a plan from a single AdaptationSet (best bandwidth Representation). */
function buildFromAdaptationSet(
  as: XmlTag,
  mpdUrl: string,
  periodBase: string,
  periodTemplate: XmlTag | null,
  periodDuration: number,
  mediaPresentationDuration: number
): DashPlan {
  if (hasContentProtection(as.content)) {
    throw new Error('DASH: 流已加密 (ContentProtection/DRM)，暂不支持解密');
  }
  const asBase = firstText(as.content, 'BaseURL') || periodBase;
  const asTemplate = findTags(as.content, 'SegmentTemplate')[0] ?? periodTemplate;

  const representations = findTags(as.content, 'Representation');
  if (representations.length === 0) {
    // No Representation (template may live directly on the AdaptationSet).
    return buildFromRepresentation(as, as.content, mpdUrl, asBase, asTemplate, periodDuration, mediaPresentationDuration);
  }

  // Pick the highest-bandwidth Representation (官方 max_by_key bandwidth).
  let chosen: XmlTag = representations[0];
  for (const rep of representations) {
    const bw = parseInt(rep.attrs.get('bandwidth') ?? '0', 10);
    const chosenBw = parseInt(chosen.attrs.get('bandwidth') ?? '0', 10);
    if (bw > chosenBw) {
      chosen = rep;
    }
  }
  return buildFromRepresentation(chosen, chosen.content, mpdUrl, asBase, asTemplate, periodDuration, mediaPresentationDuration);
}

/** Build the final segment plan from a Representation (or element acting as one). */
function buildFromRepresentation(
  rep: XmlTag,
  repContent: string,
  mpdUrl: string,
  parentBase: string,
  parentTemplate: XmlTag | null,
  periodDuration: number,
  mediaPresentationDuration: number
): DashPlan {
  const repBase = firstText(repContent, 'BaseURL') || parentBase;
  const repTemplate = findTags(repContent, 'SegmentTemplate')[0] ?? parentTemplate;
  const repId = rep.attrs.get('id') ?? '';
  const bandwidth = rep.attrs.get('bandwidth') ?? '';
  const mime = (rep.attrs.get('mimeType') ?? '').toLowerCase();
  const fileExt = mime.includes('mp4') ? 'mp4' : (mime.includes('webm') ? 'webm' : (mime.includes('m4a') ? 'm4a' : 'mp4'));
  const fileNameHint = repId ? `dash_${repId}.${fileExt}` : `dash_output.${fileExt}`;

  // ---- SegmentBase: single-file (ignore indexRange; download whole file) ----
  const segBase = findTags(repContent, 'SegmentBase')[0];
  if (segBase) {
    // Initialization within SegmentBase is a byte range of the same file; the
    // whole-file download already contains it, so no separate init fetch.
    return { segments: [{ url: resolveUri(mpdUrl, repBase) }], initUrl: '', fileNameHint };
  }

  // ---- SegmentList ----
  const segList = findTags(repContent, 'SegmentList')[0];
  if (segList) {
    const segments: DashSegment[] = [];
    const urls = findTags(segList.content, 'SegmentURL');
    for (const u of urls) {
      const media = u.attrs.get('media') ?? '';
      const range = u.attrs.get('mediaRange') ?? '';
      if (!media) {
        continue;
      }
      segments.push({ url: resolveUri(mpdUrl, media), range: range ? range.replace('/', '-') : undefined });
    }
    if (segments.length > 0) {
      const initTags = findTags(segList.content, 'Initialization');
      const initSrc = initTags.length > 0 ? (initTags[0].attrs.get('sourceURL') ?? '') : '';
      const initUrl = initSrc ? resolveUri(mpdUrl, initSrc) : '';
      return { segments, initUrl, fileNameHint };
    }
  }

  // ---- SegmentTemplate ----
  const st = repTemplate;
  if (st) {
    const mediaTemplate = st.attrs.get('media') ?? '';
    if (mediaTemplate) {
      const initTemplate = st.attrs.get('initialization') ?? '';
      const startNumber = parseInt(st.attrs.get('startNumber') ?? '1', 10);
      const timescale = parseInt(st.attrs.get('timescale') ?? '1', 10) || 1;
      const duration = parseFloat(st.attrs.get('duration') ?? '0');
      const totalDuration = periodDuration || mediaPresentationDuration;
      const baseParams: Record<string, string> = {};
      if (repId) baseParams['RepresentationID'] = repId;
      baseParams['Bandwidth'] = bandwidth;
      baseParams['representationID'] = repId;
      baseParams['bandwidth'] = bandwidth;

      const segments: DashSegment[] = [];
      const timeline = findTags(st.content, 'SegmentTimeline')[0];
      if (timeline) {
        // Expand <S t d r> entries: each S yields (r+1) segments at t, t+d, ...
        const sTags = findTags(timeline.content, 'S');
        let number = startNumber;
        let impliedT = 0;
        for (const s of sTags) {
          const d = parseInt(s.attrs.get('d') ?? '0', 10);
          const tRaw = s.attrs.get('t');
          const t = tRaw !== undefined ? parseInt(tRaw, 10) : impliedT;
          const r = parseInt(s.attrs.get('r') ?? '0', 10);
          for (let k = 0; k <= r; k++) {
            const params: Record<string, string> = { ...baseParams };
            params['Number'] = String(number);
            params['number'] = String(number);
            params['Time'] = String(t + k * d);
            params['time'] = String(t + k * d);
            segments.push({ url: resolveUri(mpdUrl, substituteTemplate(mediaTemplate, params)) });
            number++;
          }
          impliedT = t + (r + 1) * d;
        }
      } else if (duration > 0 && totalDuration > 0) {
        // Constant-duration fallback: count = ceil(periodDuration / segDuration).
        const segDuration = duration / timescale;
        const count = Math.max(1, Math.ceil(totalDuration / segDuration));
        for (let k = 0; k < count; k++) {
          const params: Record<string, string> = { ...baseParams };
          params['Number'] = String(startNumber + k);
          params['number'] = String(startNumber + k);
          params['Time'] = String(Math.round((startNumber - 1 + k) * duration));
          params['time'] = String(Math.round((startNumber - 1 + k) * duration));
          segments.push({ url: resolveUri(mpdUrl, substituteTemplate(mediaTemplate, params)) });
        }
      } else if (!/Time|\$Time\$/.test(mediaTemplate)) {
        // Neither timeline nor duration: emit a single segment if the template
        // resolves without $Number$/$Time$ (e.g. a plain URL).
        if (!/\$(Number|number|Time|time)\$/.test(mediaTemplate)) {
          segments.push({ url: resolveUri(mpdUrl, substituteTemplate(mediaTemplate, baseParams)) });
        } else {
          throw new Error('DASH: SegmentTemplate 缺少 SegmentTimeline/duration，无法确定分片数量');
        }
      }

      const initUrl = initTemplate ? resolveUri(mpdUrl, substituteTemplate(initTemplate, baseParams)) : '';
      return { segments, initUrl, fileNameHint };
    }
  }

  // ---- Plain BaseURL (single file) ----
  if (repBase) {
    return { segments: [{ url: resolveUri(mpdUrl, repBase) }], initUrl: '', fileNameHint };
  }
  throw new Error('DASH: 无法识别 MPD 的分片描述（无 SegmentTemplate/SegmentList/SegmentBase/BaseURL）');
}

/** Fetch the MPD manifest and build the download plan. */
async function fetchDashPlan(mpdUrl: string, ignoreTls: boolean, proxy?: ProxyConfig): Promise<DashPlan> {
  const req = http.createHttp();
  try {
    const resp = await req.request(mpdUrl, {
      method: http.RequestMethod.GET,
      header: { Accept: '*/*' },
      expectDataType: http.HttpDataType.STRING,
      connectTimeout: 20000,
      readTimeout: 60000,
      remoteValidation: ignoreTls ? 'skip' : 'system',
      usingProxy: proxy
    });
    const code = resp.responseCode as number;
    if (code < 200 || code >= 300) {
      throw new Error(`DASH: HTTP ${code} 获取 MPD 失败`);
    }
    const xml = resp.result as string;
    return parseMpd(xml, mpdUrl);
  } finally {
    req.destroy();
  }
}

/** Build the per-segment list for a DASH task. */
export async function buildDashSegments(task: DownloadTask, hooks?: EngineHooks): Promise<void> {
  const plan = await fetchDashPlan(task.url, hooks ? hooks.shouldIgnoreTlsErrors() : false,
    hooks ? hooks.proxyOption() : undefined);
  if (plan.segments.length === 0) {
    throw new Error('DASH: 无法解析MPD清单（未找到媒体分片）');
  }
  task.segments = plan.segments.map<Segment>((s, i) => ({
    index: i,
    url: s.url,
    start: 0,
    end: -1,
    downloaded: 0,
    done: false,
    byteRange: s.range
  }));
  task.manifestInitUrl = plan.initUrl;
  if (!task.fileName || task.fileName === '') {
    task.fileName = plan.fileNameHint;
  }
  task.isHls = true; // reuse the HLS sequential-append path
  task.isDash = true;
}

/** Fetch a single DASH media/init segment body. */
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
      throw new Error(`DASH: HTTP ${code} 获取分片失败`);
    }
    if (byteRange && code !== 206) {
      throw new Error('DASH: 分段请求未返回 206 Partial Content');
    }
    const result = resp.result;
    return result instanceof ArrayBuffer ? result : new ArrayBuffer(0);
  } finally {
    req.destroy();
  }
}

/**
 * Download a DASH stream: fetch each segment in order (byte-ranged when
 * required) and append to the output file. The fMP4 Initialization segment is
 * written first when the output file is empty.
 */
export async function downloadDash(task: DownloadTask, ctrl: Ctrl, hooks: EngineHooks): Promise<void> {
  const file = fs.openSync(task.filePath, fs.OpenMode.READ_WRITE | fs.OpenMode.CREATE);
  try {
    let writeOffset = fs.statSync(task.filePath).size;
    // fMP4 初始化段（Initialization）：先写 init，媒体分片才能解码。
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
      const data = await fetchSegmentBytes(seg.url ?? task.url, seg.byteRange, hooks);
      // 全局/单任务限速（DASH 按整段节流）
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
