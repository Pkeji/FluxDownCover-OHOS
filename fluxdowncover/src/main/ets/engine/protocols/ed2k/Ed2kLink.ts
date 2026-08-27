/**
 * ed2k:// link parser.
 *
 * Standard format:
 *   ed2k://|file|<filename>|<size>|<MD4-hex>|/
 *
 * Optional server hint:
 *   ed2k://|file|<filename>|<size>|<MD4-hex>||s|<server-ip>|<server-port>|/
 *
 * A-ICH (Intelligent Corruption Handling) variant with hash set:
 *   ed2k://|file|<filename>|<size>|<MD4-hex>|h|<chunk-hashes...>|/
 */

export interface Ed2kServerHint {
  ip: string;
  port: number;
}

export interface Ed2kLinkInfo {
  fileName: string;
  fileSize: number;
  fileHash: Uint8Array; // 16-byte MD4
  fileHashHex: string;
  servers: Ed2kServerHint[];
}

const HEX_CHARS = '0123456789abcdefABCDEF';

function isHex(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    if (!HEX_CHARS.includes(s.charAt(i))) {
      return false;
    }
  }
  return true;
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.substring(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/**
 * Parse an ed2k:// URL.
 * @throws Error if the link is malformed.
 */
export function parseEd2kLink(url: string): Ed2kLinkInfo {
  const trimmed = url.trim();

  if (!trimmed.startsWith('ed2k://')) {
    throw new Error('Not an ed2k link: must start with "ed2k://"');
  }

  // Strip "ed2k://" prefix and trailing "/" or "|/"
  let body = trimmed.substring('ed2k://'.length);
  if (body.endsWith('/')) {
    body = body.substring(0, body.length - 1);
  }
  if (body.endsWith('|')) {
    body = body.substring(0, body.length - 1);
  }

  // Split by "|"
  const parts = body.split('|');

  // Expect: ["file", <name>, <size>, <hash>, ...]
  if (parts.length < 4 || parts[0] !== 'file') {
    throw new Error('Malformed ed2k link: expected |file|<name>|<size>|<hash>|');
  }

  const fileName = decodeURIComponent(parts[1]);
  const fileSize = parseInt(parts[2], 10);
  const fileHashHex = parts[3].toLowerCase();

  if (!isFinite(fileSize) || fileSize <= 0) {
    throw new Error(`Invalid file size in ed2k link: ${parts[2]}`);
  }

  if (fileHashHex.length !== 32 || !isHex(fileHashHex)) {
    throw new Error(`Invalid MD4 hash in ed2k link: ${parts[3]} (expected 32 hex chars)`);
  }

  const fileHash = hexToBytes(fileHashHex);

  // Parse optional server hints: |s|<ip>|<port>|s|<ip>|<port>...
  const servers: Ed2kServerHint[] = [];
  let i = 4;
  while (i < parts.length) {
    if (parts[i] === 's' && i + 2 < parts.length) {
      const ip = parts[i + 1];
      const port = parseInt(parts[i + 2], 10);
      if (ip && isFinite(port) && port > 0 && port < 65536) {
        servers.push({ ip, port });
      }
      i += 3;
    } else if (parts[i] === 'h') {
      // Hash set marker — skip for now (A-ICH); we request hash set from peer
      i += 1;
    } else {
      i += 1;
    }
  }

  return { fileName, fileSize, fileHash, fileHashHex, servers };
}
