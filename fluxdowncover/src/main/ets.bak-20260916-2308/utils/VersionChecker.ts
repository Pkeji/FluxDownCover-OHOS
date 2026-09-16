import { http } from '@kit.NetworkKit';
import { logCollector } from '../utils/LogCollector';
import { ProxyConfig } from '../engine/EngineHooks';

/** Current app version, must match AppScope/app.json5 versionName. */
export const APP_VERSION = '1.2.3.66';

const GITHUB_API = 'https://api.github.com/repos/Pkeji/FluxDownCover-OHOS/releases/latest';

/** Parsed release info from GitHub API. */
export interface ReleaseInfo {
  tagName: string;           // e.g. "v1.1.4"
  version: string;           // e.g. "1.1.4"
  body: string;              // raw markdown body
  summary: string;           // auto-summarized bullet points
  downloadUrl: string;       // first .hap/.apk asset download URL
}

/**
 * Compare two semantic version strings like "1.1.3" and "1.1.4".
 * Returns >0 if v1 > v2, <0 if v1 < v2, 0 if equal.
 */
function compareVersions(v1: string, v2: string): number {
  const p1 = v1.split('.').map(Number);
  const p2 = v2.split('.').map(Number);
  const len = Math.max(p1.length, p2.length);
  for (let i = 0; i < len; i++) {
    const a = p1[i] || 0;
    const b = p2[i] || 0;
    if (a !== b) return a - b;
  }
  return 0;
}

/**
 * Auto-summarize release body: extract meaningful lines (bullet points, ### sections).
 * Falls back to first 200 chars if no structured content found.
 */
function summarizeBody(body: string): string {
  if (!body) return '暂无更新说明。';

  const lines = body.split('\n').map(l => l.trim()).filter(l => l.length > 0);

  // Collect bullet points (lines starting with -, *, or numbers)
  const bullets: string[] = [];
  for (const line of lines) {
    const clean = line.replace(/^[-*]\s+/, '').replace(/^\d+[\.\)]\s+/, '').trim();
    if (clean.length > 0 && clean !== line) {
      bullets.push(clean);
    } else if (line.startsWith('###') || line.startsWith('##')) {
      // Keep section headers as context markers
      const header = line.replace(/^#+\s*/, '');
      if (header.length > 0 && header.length < 50) {
        bullets.push(`【${header}】`);
      }
    }
  }

  if (bullets.length > 0) {
    return bullets.join('\n');
  }

  // Fallback: truncate to first meaningful paragraph
  const para = lines.find(l => l.length > 20);
  return para ? para.slice(0, 200) + (para.length > 200 ? '…' : '') : '暂无更新说明。';
}

/**
 * Extract version string from a tag like "v1.1.4" -> "1.1.4".
 */
function tagToVersion(tag: string): string {
  return tag.replace(/^v/i, '').trim();
}

/** Check if string is a valid semver like "1.2.0". */
function isValidVersion(v: string): boolean {
  return /^\d+(\.\d+){0,3}$/.test(v.trim());
}

/**
 * Check GitHub releases API for the latest version.
 * Returns ReleaseInfo if a newer version is found, or null if already up-to-date.
 */
export async function checkForUpdate(currentVersion: string, proxy?: ProxyConfig, ignoreTls: boolean = false): Promise<ReleaseInfo | null> {
  const req = http.createHttp();
  try {
    const resp = await req.request(GITHUB_API, {
      method: http.RequestMethod.GET,
      header: {
        Accept: 'application/vnd.github.v3+json',
        'User-Agent': 'FluxDownCover/1.0'
      },
      connectTimeout: 15000,
      readTimeout: 15000,
      remoteValidation: ignoreTls ? 'skip' : 'system',
      usingProxy: proxy
    });

    if (resp.responseCode !== 200) {
      logCollector.warn('Update', `VersionCheck: GitHub API returned ${resp.responseCode}`);
      return null;
    }

    const data = JSON.parse(resp.result as string);
    const tagName: string = data.tag_name || '';
    const releaseName: string = data.name || '';
    // 优先用 release name（如 "1.2.0"），其次用 tag_name（如 "v1.2.0"）
    let version = tagToVersion(releaseName);
    if (!isValidVersion(version)) {
      version = tagToVersion(tagName);
    }
    const body: string = data.body || '';

    // Find first downloadable asset (.hap or .apk)
    let downloadUrl = '';
    if (data.assets && Array.isArray(data.assets)) {
      const asset = data.assets.find((a: Record<string, Object>) => {
        const name = (a.name as string) || '';
        return name.endsWith('.hap') || name.endsWith('.apk');
      });
      if (asset) {
        downloadUrl = asset.browser_download_url as string || '';
      }
    }

    if (!version) return null;

    // Compare with current version
    if (compareVersions(version, currentVersion) <= 0) {
      return null; // already up-to-date
    }

    return {
      tagName,
      version,
      body,
      summary: summarizeBody(body),
      downloadUrl
    };
  } catch (e) {
    logCollector.warn('Update', `VersionCheck: request failed: ${JSON.stringify(e)}`);
    return null;
  } finally {
    req.destroy();
  }
}

export { compareVersions };
