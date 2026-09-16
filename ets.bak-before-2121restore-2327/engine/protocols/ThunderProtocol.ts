import { ProtocolType } from '../../model/ProtocolType';
import { detectProtocol, decodeWrappedUrl } from '../../utils/common';

/**
 * Decodes wrapper-protocol URLs (thunder://, flashget://, qqdl://) into the
 * underlying real URL and its protocol type.
 *
 * Link formats:
 *  - thunder://  → base64("AA" + realUrl + "ZZ")
 *  - flashget:// → base64("[FLASHGET]" + realUrl + "[FLASHGET]")
 *  - qqdl://     → base64(realUrl)
 *
 * The actual base64/prefix unwrapping lives in `common.decodeWrappedUrl` — the
 * single authoritative implementation shared with `fileNameFromUrl`. This
 * module only adds the protocol re-classification needed for dispatch.
 */
export interface DecodedLink {
  url: string;
  protocol: ProtocolType;
}

/**
 * Decode a thunder://, flashget://, or qqdl:// link to the real URL.
 * Returns null if the link cannot be decoded (malformed base64, unknown
 * wrapper, etc.).
 */
export function decodeWrapperLink(rawUrl: string): DecodedLink | null {
  const decoded = decodeWrappedUrl(rawUrl);
  if (decoded === null) {
    return null;
  }
  return resolve(decoded);
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
