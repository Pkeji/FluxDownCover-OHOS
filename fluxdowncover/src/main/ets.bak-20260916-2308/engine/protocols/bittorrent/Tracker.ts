import { http } from '@kit.NetworkKit';
import {
  bdecode,
  bytesToAscii,
  BencodeDict,
  BencodeList,
  dictGetList,
  dictGetInt,
  dictGetBytes
} from './Bencode';
import { TorrentMeta } from './TorrentMeta';
import { announceUdp } from './UdpTracker';

/**
 * A single peer endpoint.
 */
export interface Peer {
  ip: string;
  port: number;
}

/**
 * Tracker announce response.
 */
export interface AnnounceResult {
  interval: number; // seconds between announces
  peers: Peer[];
}

/**
 * Announce to an HTTP tracker and retrieve the peer list.
 *
 * Uses compact peer format (compact=1) which is the modern standard.
 * Falls back to verbose peer dicts if compact is not supported.
 */
export async function announce(
  trackerUrl: string,
  meta: TorrentMeta,
  peerId: Uint8Array,
  port: number,
  uploaded: number,
  downloaded: number,
  left: number
): Promise<AnnounceResult> {
  const req = http.createHttp();
  try {
    const url = buildAnnounceUrl(trackerUrl, meta.infoHash, peerId, port, uploaded, downloaded, left);
    const resp = await req.request(url, {
      method: http.RequestMethod.GET,
      header: { Accept: '*/*', 'User-Agent': 'FluxDownCover/1.0' },
      expectDataType: http.HttpDataType.ARRAY_BUFFER,
      connectTimeout: 15000,
      readTimeout: 15000
    });

    const body = resp.result as ArrayBuffer;
    if (!body || body.byteLength === 0) {
      throw new Error('Tracker: empty response');
    }

    return parseAnnounceResponse(new Uint8Array(body));
  } finally {
    req.destroy();
  }
}

/** Build the tracker announce URL with query parameters. */
function buildAnnounceUrl(
  baseUrl: string,
  infoHash: Uint8Array,
  peerId: Uint8Array,
  port: number,
  uploaded: number,
  downloaded: number,
  left: number
): string {
  const sep = baseUrl.includes('?') ? '&' : '?';
  const params: string[] = [
    `info_hash=${urlEncodeBytes(infoHash)}`,
    `peer_id=${urlEncodeBytes(peerId)}`,
    `port=${port}`,
    `uploaded=${uploaded}`,
    `downloaded=${downloaded}`,
    `left=${left}`,
    `compact=1`,
    `numwant=50`
  ];
  return baseUrl + sep + params.join('&');
}

/** URL-encode raw bytes (each byte that isn't alphanumeric gets %XX). */
function urlEncodeBytes(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    if (
      (b >= 0x30 && b <= 0x39) || // 0-9
      (b >= 0x41 && b <= 0x5a) || // A-Z
      (b >= 0x61 && b <= 0x7a) || // a-z
      b === 0x2d || // -
      b === 0x2e || // .
      b === 0x5f || // _
      b === 0x7e    // ~
    ) {
      s += String.fromCharCode(b);
    } else {
      s += '%' + b.toString(16).padStart(2, '0').toUpperCase();
    }
  }
  return s;
}

/** Parse the bencoded tracker response. */
function parseAnnounceResponse(data: Uint8Array): AnnounceResult {
  const root = bdecode(data);
  if (!(root instanceof BencodeDict)) {
    throw new Error('Tracker: response is not a dict');
  }

  // Check for error
  const failure = root.entries.get('failure reason');
  if (failure instanceof Uint8Array) {
    throw new Error(`Tracker: ${bytesToAscii(failure)}`);
  }

  const interval = dictGetInt(root, 'interval') ?? 1800;
  const peers: Peer[] = [];

  // Compact format: 6 bytes per peer (4 IP + 2 port)
  const compactPeers = dictGetBytes(root, 'peers');
  if (compactPeers && compactPeers.length >= 6) {
    for (let i = 0; i + 6 <= compactPeers.length; i += 6) {
      const ip = `${compactPeers[i]}.${compactPeers[i + 1]}.${compactPeers[i + 2]}.${compactPeers[i + 3]}`;
      const port = (compactPeers[i + 4] << 8) | compactPeers[i + 5];
      if (port > 0) {
        peers.push({ ip, port });
      }
    }
  }

  // Verbose format (fallback): list of dicts with "ip" and "port"
  if (peers.length === 0) {
    const peerList = dictGetList(root, 'peers');
    if (peerList) {
      for (const p of peerList.items) {
        if (!(p instanceof BencodeDict)) {
          continue;
        }
        const ip = p.entries.get('ip');
        const port = p.entries.get('port');
        if (ip instanceof Uint8Array && typeof port === 'number') {
          peers.push({ ip: bytesToAscii(ip), port });
        }
      }
    }
  }

  // Also check "peers6" (IPv6 compact: 18 bytes per peer)
  const peers6 = dictGetBytes(root, 'peers6');
  if (peers6 && peers6.length >= 18) {
    // IPv6 peers — skip for now, most environments are IPv4
  }

  return { interval, peers };
}

/**
 * Try multiple trackers in sequence, return the first successful result.
 */
export async function announceAny(
  trackers: string[],
  meta: TorrentMeta,
  peerId: Uint8Array,
  port: number,
  uploaded: number,
  downloaded: number,
  left: number
): Promise<AnnounceResult> {
  let lastError: Error | null = null;
  for (const url of trackers) {
    try {
      if (url.startsWith('udp://')) {
        return await announceUdp(url, meta, peerId, port, uploaded, downloaded, left);
      } else if (url.startsWith('http://') || url.startsWith('https://')) {
        return await announce(url, meta, peerId, port, uploaded, downloaded, left);
      } else {
        continue; // unsupported tracker scheme
      }
    } catch (e) {
      lastError = e as Error;
    }
  }
  throw lastError ?? new Error('Tracker: no usable trackers available');
}
