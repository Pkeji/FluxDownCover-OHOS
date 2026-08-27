/**
 * Magnet URI parser (BEP-9 / BEP-53).
 *
 * Format:
 *   magnet:?xt=urn:btih:<info_hash_hex>&tr=<tracker_url>&dn=<display_name>
 *
 * Only `xt=urn:btih:<40-char-hex>` is mandatory.
 * Multiple `xt`, `tr`, `dn` parameters are allowed.
 */
export interface MagnetLink {
  /** 20-byte raw info hash (SHA-1 of bencoded info dict). */
  infoHash: Uint8Array;
  /** Hex-encoded info hash (40 chars). */
  infoHashHex: string;
  /** Tracker announce URLs extracted from `tr=` params. */
  trackers: string[];
  /** Display name from `dn=` param (optional). */
  displayName: string;
}

/**
 * Parse a magnet URI string into a MagnetLink struct.
 * Returns null if the URI is invalid or lacks a usable info_hash.
 */
export function parseMagnetLink(uri: string): MagnetLink | null {
  const lower = uri.toLowerCase().trim();
  if (!lower.startsWith('magnet:')) {
    return null;
  }

  // Strip "magnet:?" or "magnet:"
  const queryStart = uri.indexOf('?');
  const query = queryStart >= 0 ? uri.substring(queryStart + 1) : uri.substring('magnet:'.length);

  // Parse query string manually (ArkTS has no URLSearchParams)
  const queryParams = parseQueryString(query);

  // Find xt=urn:btih:<hex>
  let infoHashHex = '';
  const trackers: string[] = [];
  let displayName = '';

  // xt parameters (multiple allowed, take first btih)
  const xtValues = queryParams.getAll('xt');
  for (const xt of xtValues) {
    // urn:btih:<40-hex-char-info-hash> or urn:btih:<32-base32-char-info-hash>
    const btihMatch = /^urn:btih:([a-f0-9]{40})$/i.exec(xt);
    if (btihMatch) {
      infoHashHex = btihMatch[1].toLowerCase();
      break;
    }
    // Also try base32 encoded info_hash (32 chars)
    const b32Match = /^urn:btih:([a-z2-7]{32})$/i.exec(xt);
    if (b32Match) {
      infoHashHex = base32ToHex(b32Match[1]);
      break;
    }
  }

  if (!infoHashHex || infoHashHex.length !== 40) {
    return null;
  }

  // tr parameters
  const trValues = queryParams.getAll('tr');
  for (const tr of trValues) {
    const decoded = decodeURIComponent(tr);
    if (decoded.startsWith('http://') || decoded.startsWith('https://') ||
        decoded.startsWith('udp://')) {
      trackers.push(decoded);
    }
  }

  // dn parameter
  const dn = queryParams.get('dn');
  if (dn) {
    displayName = decodeURIComponent(dn);
  }

  // Convert hex to raw 20-byte Uint8Array
  const infoHash = new Uint8Array(20);
  for (let i = 0; i < 20; i++) {
    infoHash[i] = parseInt(infoHashHex.substring(i * 2, i * 2 + 2), 16);
  }

  return {
    infoHash,
    infoHashHex,
    trackers,
    displayName
  };
}

/**
 * Convert a base32-encoded info hash (32 chars) to hex (40 chars).
 * Base32 alphabet: abcdefghijklmnopqrstuvwxyz234567
 */
function base32ToHex(b32: string): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz234567';
  let bits = '';
  for (const ch of b32.toLowerCase()) {
    const idx = alphabet.indexOf(ch);
    if (idx < 0) {
      return '';
    }
    bits += idx.toString(2).padStart(5, '0');
  }
  // Take only the first 160 bits (40 hex chars = 20 bytes)
  const hexChars: string[] = [];
  for (let i = 0; i < 40 && i * 4 + 4 <= bits.length; i++) {
    const nibble = parseInt(bits.substring(i * 4, i * 4 + 4), 2);
    hexChars.push(nibble.toString(16));
  }
  return hexChars.join('');
}

/**
 * Simple query string parser (replacement for URLSearchParams, which is not
 * available in ArkTS). Supports multiple values for the same key.
 */
interface QueryParams {
  getAll(key: string): string[];
  get(key: string): string | null;
}

function parseQueryString(query: string): QueryParams {
  const map = new Map<string, string[]>();
  if (query.length === 0) {
    return { getAll: (k: string): string[] => map.get(k) || [], get: (k: string): string | null => (map.get(k) || [])[0] || null };
  }
  const pairs = query.split('&');
  for (const pair of pairs) {
    const eqIdx = pair.indexOf('=');
    let key: string;
    let val: string;
    if (eqIdx < 0) {
      key = decodeURIComponent(pair);
      val = '';
    } else {
      key = decodeURIComponent(pair.substring(0, eqIdx));
      val = decodeURIComponent(pair.substring(eqIdx + 1));
    }
    const existing = map.get(key);
    if (existing) {
      existing.push(val);
    } else {
      map.set(key, [val]);
    }
  }
  return {
    getAll: (k: string): string[] => map.get(k) || [],
    get: (k: string): string | null => (map.get(k) || [])[0] || null
  };
}
