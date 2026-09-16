import { socket } from '@kit.NetworkKit';
import { BusinessError } from '@kit.BasicServicesKit';
import { TorrentMeta } from './TorrentMeta';
import { Peer, AnnounceResult } from './Tracker';

/**
 * UDP Tracker Protocol (BEP-15).
 *
 * Two-step process:
 *   1. Connect  → obtain an 8-byte connection_id
 *   2. Announce → send connection_id + torrent params, receive peer list
 *
 * All integers are big-endian (network byte order).
 */

const PROTOCOL_ID = 0x41727101980n; // magic constant for UDP trackers
const ACTION_CONNECT = 0;
const ACTION_ANNOUNCE = 1;
const CONNECT_TIMEOUT = 15000;
const ANNOUNCE_TIMEOUT = 15000;

/** Write a big-endian uint32 at offset in a DataView. */
function writeUint32BE(dv: DataView, offset: number, val: number): void {
  dv.setUint32(offset, val >>> 0, false);
}

/** Write a big-endian uint64 at offset in a DataView (using BigInt). */
function writeUint64BE(dv: DataView, offset: number, val: bigint): void {
  dv.setUint32(offset, Number(val >> 32n) >>> 0, false);
  dv.setUint32(offset + 4, Number(val & 0xFFFFFFFFn) >>> 0, false);
}

/** Read a big-endian uint32 from a DataView. */
function readUint32BE(dv: DataView, offset: number): number {
  return dv.getUint32(offset, false);
}

/** Read a big-endian uint64 from a DataView (as BigInt). */
function readUint64BE(dv: DataView, offset: number): bigint {
  const hi = BigInt(dv.getUint32(offset, false));
  const lo = BigInt(dv.getUint32(offset + 4, false));
  return (hi << 32n) | lo;
}

/** Generate a random 32-bit transaction ID. */
function randomTransactionId(): number {
  return (Math.random() * 0xFFFFFFFF) >>> 0;
}

/** Parse a udp:// URL into host and port. */
function parseUdpUrl(url: string): { host: string; port: number } {
  // udp://host:port/announce
  const rest = url.substring('udp://'.length);
  const slashIdx = rest.indexOf('/');
  const hostPort = slashIdx >= 0 ? rest.substring(0, slashIdx) : rest;
  const colonIdx = hostPort.lastIndexOf(':');
  if (colonIdx < 0) {
    return { host: hostPort, port: 80 };
  }
  return {
    host: hostPort.substring(0, colonIdx),
    port: parseInt(hostPort.substring(colonIdx + 1), 10) || 80
  };
}

/**
 * Announce to a UDP tracker.
 *
 * @param trackerUrl  e.g. "udp://tracker.opentrackr.org:1337/announce"
 * @param meta        parsed torrent metadata
 * @param peerId      20-byte peer ID
 * @param port        port we report to the tracker
 * @param uploaded    bytes uploaded so far
 * @param downloaded  bytes downloaded so far
 * @param left        bytes remaining
 */
export async function announceUdp(
  trackerUrl: string,
  meta: TorrentMeta,
  peerId: Uint8Array,
  port: number,
  uploaded: number,
  downloaded: number,
  left: number
): Promise<AnnounceResult> {
  const { host, port: trackerPort } = parseUdpUrl(trackerUrl);

  // Step 1: Connect to get connection_id
  const connectionId = await udpConnect(host, trackerPort);

  // Step 2: Announce with the connection_id
  return await udpAnnounce(
    host, trackerPort, connectionId,
    meta, peerId, port, uploaded, downloaded, left
  );
}

/** Perform the UDP connect step and return the connection_id. */
async function udpConnect(host: string, port: number): Promise<bigint> {
  const udp = socket.constructUDPSocketInstance();

  // Bind to a local ephemeral port
  await new Promise<void>((resolve, reject) => {
    udp.bind({ address: '0.0.0.0', port: 0 }, (err: BusinessError) => {
      if (err) {
        reject(new Error(`UDP bind failed: ${err.message}`));
      } else {
        resolve();
      }
    });
  });

  try {
    const txnId = randomTransactionId();

    // Build connect request: protocol_id(8) + action(4) + transaction_id(4) = 16 bytes
    const reqBuf = new ArrayBuffer(16);
    const reqDv = new DataView(reqBuf);
    writeUint64BE(reqDv, 0, PROTOCOL_ID);
    writeUint32BE(reqDv, 8, ACTION_CONNECT);
    writeUint32BE(reqDv, 12, txnId);

    // Send and wait for response
    const respData = await sendAndWait(udp, host, port, reqBuf, 16, CONNECT_TIMEOUT);

    // Parse connect response: action(4) + transaction_id(4) + connection_id(8) = 16 bytes
    const respDv = new DataView(respData);
    const action = readUint32BE(respDv, 0);
    const respTxnId = readUint32BE(respDv, 4);

    if (action !== ACTION_CONNECT) {
      throw new Error(`UDP tracker connect: unexpected action ${action}`);
    }
    if (respTxnId !== txnId) {
      throw new Error('UDP tracker connect: transaction ID mismatch');
    }

    return readUint64BE(respDv, 8);
  } finally {
    udp.close();
  }
}

/** Perform the UDP announce step and return the peer list. */
async function udpAnnounce(
  host: string,
  port: number,
  connectionId: bigint,
  meta: TorrentMeta,
  peerId: Uint8Array,
  reportPort: number,
  uploaded: number,
  downloaded: number,
  left: number
): Promise<AnnounceResult> {
  const udp = socket.constructUDPSocketInstance();

  await new Promise<void>((resolve, reject) => {
    udp.bind({ address: '0.0.0.0', port: 0 }, (err: BusinessError) => {
      if (err) {
        reject(new Error(`UDP bind failed: ${err.message}`));
      } else {
        resolve();
      }
    });
  });

  try {
    const txnId = randomTransactionId();

    // Build announce request (98 bytes):
    // connection_id(8) + action(4) + transaction_id(4) +
    // info_hash(20) + peer_id(20) +
    // downloaded(8) + left(8) + uploaded(8) +
    // event(4) + ip(4) + key(4) + num_want(4) + port(2)
    const reqBuf = new ArrayBuffer(98);
    const reqDv = new DataView(reqBuf);
    let off = 0;

    writeUint64BE(reqDv, off, connectionId); off += 8;
    writeUint32BE(reqDv, off, ACTION_ANNOUNCE); off += 4;
    writeUint32BE(reqDv, off, txnId); off += 4;

    // info_hash (20 bytes)
    for (let i = 0; i < 20; i++) {
      reqDv.setUint8(off + i, meta.infoHash[i]);
    }
    off += 20;

    // peer_id (20 bytes)
    for (let i = 0; i < 20; i++) {
      reqDv.setUint8(off + i, peerId[i]);
    }
    off += 20;

    writeUint64BE(reqDv, off, BigInt(downloaded)); off += 8;
    writeUint64BE(reqDv, off, BigInt(left)); off += 8;
    writeUint64BE(reqDv, off, BigInt(uploaded)); off += 8;

    writeUint32BE(reqDv, off, 0); off += 4; // event: 0 = none
    writeUint32BE(reqDv, off, 0); off += 4; // ip: 0 = default
    writeUint32BE(reqDv, off, randomTransactionId()); off += 4; // key
    writeUint32BE(reqDv, off, 0xFFFFFFFF); off += 4; // num_want: -1 = default
    reqDv.setUint16(off, reportPort, false); off += 2; // port (big-endian)

    // Send and wait for response (minimum 20 bytes)
    const respData = await sendAndWait(udp, host, port, reqBuf, 20, ANNOUNCE_TIMEOUT);

    // Parse announce response:
    // action(4) + transaction_id(4) + interval(4) + leechers(4) + seeders(4) + peers(6*n)
    const respDv = new DataView(respData);
    const action = readUint32BE(respDv, 0);
    const respTxnId = readUint32BE(respDv, 4);

    if (action !== ACTION_ANNOUNCE) {
      // Check for error action (3 = error)
      if (action === 3 && respData.byteLength > 8) {
        const msgLen = respData.byteLength - 8;
        let errMsg = '';
        for (let i = 0; i < msgLen; i++) {
          errMsg += String.fromCharCode(respDv.getUint8(8 + i));
        }
        throw new Error(`UDP tracker error: ${errMsg}`);
      }
      throw new Error(`UDP tracker announce: unexpected action ${action}`);
    }
    if (respTxnId !== txnId) {
      throw new Error('UDP tracker announce: transaction ID mismatch');
    }

    const interval = readUint32BE(respDv, 8);
    // leechers at offset 12, seeders at offset 16 — we don't need them
    const peers: Peer[] = [];
    const peersStart = 20;
    const peersBytes = respData.byteLength - peersStart;

    for (let i = 0; i + 6 <= peersBytes; i += 6) {
      const ipOffset = peersStart + i;
      const ip = `${respDv.getUint8(ipOffset)}.${respDv.getUint8(ipOffset + 1)}.${respDv.getUint8(ipOffset + 2)}.${respDv.getUint8(ipOffset + 3)}`;
      const peerPort = respDv.getUint16(ipOffset + 4, false);
      if (peerPort > 0) {
        peers.push({ ip, port: peerPort });
      }
    }

    return { interval, peers };
  } finally {
    udp.close();
  }
}

/**
 * Send a UDP datagram and wait for the first response.
 * Returns the response as an ArrayBuffer.
 */
function sendAndWait(
  udp: socket.UDPSocket,
  host: string,
  port: number,
  data: ArrayBuffer,
  minResponseSize: number,
  timeoutMs: number
): Promise<ArrayBuffer> {
  return new Promise<ArrayBuffer>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        reject(new Error(`UDP tracker: timeout after ${timeoutMs}ms`));
      }
    }, timeoutMs);

    udp.on('message', (value: socket.SocketMessageInfo) => {
      if (settled) {
        return;
      }
      const resp = value.message;
      if (resp.byteLength >= minResponseSize) {
        settled = true;
        clearTimeout(timer);
        // Convert to ArrayBuffer if needed
        if (resp instanceof ArrayBuffer) {
          resolve(resp);
        } else {
          const arr = new Uint8Array(resp);
          resolve(arr.buffer.slice(arr.byteOffset, arr.byteOffset + arr.byteLength));
        }
      }
    });

    udp.on('error', (err: BusinessError) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(new Error(`UDP socket error: ${err.message}`));
      }
    });

    udp.send({
      data: data,
      address: { address: host, port: port }
    }).catch((err: BusinessError) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(new Error(`UDP send failed: ${err.message}`));
      }
    });
  });
}
