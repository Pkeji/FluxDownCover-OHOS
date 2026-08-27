import { util } from '@kit.ArkTS';
import { ProtocolType } from '../../model/ProtocolType';
import { detectProtocol } from '../../utils/common';

/**
 * Decodes wrapper-protocol URLs (thunder://, flashget://, qqdl://) into the
 * underlying real URL and its protocol type.
 *
 * Link formats:
 *  - thunder://  → base64("AA" + realUrl + "ZZ")
 *  - flashget:// → base64("[FLASHGET]" + realUrl + "[FLASHGET]")
 *  - qqdl://     → base64(realUrl)
 *
 * After decoding, the real URL is re-classified via detectProtocol so the
 * engine can dispatch to the correct handler (HTTP, FTP, eD2K, BT, …).
 */
export interface DecodedLink {
  url: string;
  protocol: ProtocolType;
}

/** Base64 decode → UTF-8 string. */
function base64ToString(b64: string): string {
  const helper = new util.Base64Helper();
  const bytes = helper.decodeSync(b64);
  const decoder = util.TextDecoder.create('utf-8', { ignoreBOM: true });
  return decoder.decodeToString(bytes);
}

/**
 * Decode a thunder://, flashget://, or qqdl:// link to the real URL.
 * Returns null if the link cannot be decoded (malformed base64, unknown
 * wrapper, etc.).
 */
export function decodeWrapperLink(rawUrl: string): DecodedLink | null {
  const lower = rawUrl.toLowerCase();

  try {
    if (lower.startsWith('thunder://')) {
      const payload = rawUrl.substring('thunder://'.length);
      let decoded = base64ToString(payload);
      // Strip "AA" prefix and "ZZ" suffix
      if (decoded.startsWith('AA')) {
        decoded = decoded.substring(2);
      }
      if (decoded.endsWith('ZZ')) {
        decoded = decoded.substring(0, decoded.length - 2);
      }
      return resolve(decoded);
    }

    if (lower.startsWith('flashget://')) {
      const payload = rawUrl.substring('flashget://'.length);
      let decoded = base64ToString(payload);
      const tag = '[FLASHGET]';
      if (decoded.toUpperCase().startsWith(tag)) {
        decoded = decoded.substring(tag.length);
      }
      if (decoded.toUpperCase().endsWith(tag)) {
        decoded = decoded.substring(0, decoded.length - tag.length);
      }
      return resolve(decoded);
    }

    if (lower.startsWith('qqdl://')) {
      const payload = rawUrl.substring('qqdl://'.length);
      const decoded = base64ToString(payload);
      return resolve(decoded);
    }
  } catch (e) {
    // base64 decode failure or other parse error
    return null;
  }

  return null;
}

/** Validate decoded URL and detect its real protocol. */
function resolve(url: string): DecodedLink | null {
  const trimmed = url.trim();
  if (!trimmed) {
    return null;
  }
  return {
    url: trimmed,
    protocol: detectProtocol(trimmed)
  };
}
