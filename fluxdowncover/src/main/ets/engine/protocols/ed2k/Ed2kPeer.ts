/**
 * eD2K peer connection — handshake, file status, and block download.
 *
 * After the server gives us a list of peers, we connect to each one,
 * exchange hello, request file status (which chunks the peer has),
 * then request and download blocks until we have the complete file.
 */

import { socket } from '@kit.NetworkKit';
import { BusinessError } from '@kit.BasicServicesKit';
import {
  OP_HELLOANSWER,
  OP_FILESTATUS,
  OP_BLOCKDATA,
  OP_QUEUERANK,
  CLIENT_PORT,
  buildHelloPacket,
  buildFileStatusReqPacket,
  buildBlockRequestPacket,
  parsePacket,
  Ed2kPacket
} from './Ed2kPacket';

/** Bitfield of available chunks from a peer. */
export interface PeerFileStatus {
  chunkCount: number;
  available: boolean[]; // true = peer has this chunk
}

/** Result of a block download. */
export interface BlockResult {
  start: number;
  data: Uint8Array;
}

/** Random user hash for peer handshake. */
function randomUserHash(): Uint8Array {
  const hash = new Uint8Array(16);
  for (let i = 0; i < 16; i++) {
    hash[i] = Math.floor(Math.random() * 256);
  }
  return hash;
}

/**
 * Connect to a peer, handshake, and retrieve file status (available chunks).
 */
export async function getPeerFileStatus(
  peerIp: string,
  peerPort: number,
  fileHash: Uint8Array,
  chunkCount: number,
  timeoutMs: number = 10000
): Promise<PeerFileStatus | null> {
  const userHash = randomUserHash();
  const clientId = 0x01000000 | Math.floor(Math.random() * 0xFFFFFF);

  return new Promise<PeerFileStatus | null>((resolve) => {
    let tcp: socket.TCPSocket | null = null;
    let recvBuf: Uint8Array = new Uint8Array(0);
    let settled = false;
    let helloDone = false;

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        cleanup();
        resolve(null);
      }
    }, timeoutMs);

    function cleanup(): void {
      clearTimeout(timer);
      if (tcp) {
        try {
          tcp.off('message');
          tcp.close();
        } catch (e) {
          // ignore
        }
        tcp = null;
      }
    }

    try {
      tcp = socket.constructTCPSocketInstance();
      const endpoint: socket.NetAddress = { address: peerIp, port: peerPort, family: 1 };

      tcp.on('message', (info: socket.SocketReceiveInfo) => {
        const newData = new Uint8Array(info.message);
        const combined = new Uint8Array(recvBuf.length + newData.length);
        combined.set(recvBuf, 0);
        combined.set(newData, recvBuf.length);
        recvBuf = combined;

        while (recvBuf.length >= 6) {
          const pkt = parsePacket(recvBuf);
          if (!pkt) break;
          const consumed = 5 + 1 + pkt.payload.length;
          recvBuf = recvBuf.subarray(consumed);
          handlePacket(pkt);
        }
      });

      tcp.on('close', () => {
        if (!settled) {
          settled = true;
          cleanup();
          resolve(null);
        }
      });

      tcp.on('error', () => {
        if (!settled) {
          settled = true;
          cleanup();
          resolve(null);
        }
      });

      tcp.connect(endpoint, () => {
        const helloPkt = buildHelloPacket(userHash, clientId, CLIENT_PORT);
        tcp!.send({ data: helloPkt.buffer }, () => {});
      });
    } catch (e) {
      cleanup();
      resolve(null);
    }

    function handlePacket(pkt: Ed2kPacket): void {
      if (pkt.op === OP_HELLOANSWER) {
        helloDone = true;
        // Request file status
        const statusReq = buildFileStatusReqPacket(fileHash);
        tcp!.send({ data: statusReq.buffer }, () => {});
      } else if (pkt.op === OP_FILESTATUS) {
        // Parse bitfield: each byte = 8 chunks
        const available: boolean[] = new Array(chunkCount).fill(false);
        for (let i = 0; i < chunkCount; i++) {
          const byteIdx = Math.floor(i / 8);
          const bitIdx = 7 - (i % 8);
          if (byteIdx < pkt.payload.length) {
            available[i] = ((pkt.payload[byteIdx] >> bitIdx) & 1) === 1;
          }
        }
        if (!settled) {
          settled = true;
          cleanup();
          resolve({ chunkCount, available });
        }
      }
    }
  });
}

/**
 * Download a block (byte range) from a connected peer.
 * Returns the raw data for the requested range.
 */
export async function downloadBlock(
  peerIp: string,
  peerPort: number,
  fileHash: Uint8Array,
  start: number,
  end: number,
  timeoutMs: number = 30000
): Promise<Uint8Array | null> {
  const userHash = randomUserHash();
  const clientId = 0x01000000 | Math.floor(Math.random() * 0xFFFFFF);

  return new Promise<Uint8Array | null>((resolve) => {
    let tcp: socket.TCPSocket | null = null;
    let recvBuf: Uint8Array = new Uint8Array(0);
    let settled = false;
    let blockData: Uint8Array = new Uint8Array(0);
    let expectedSize = end - start + 1;

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        cleanup();
        resolve(null);
      }
    }, timeoutMs);

    function cleanup(): void {
      clearTimeout(timer);
      if (tcp) {
        try {
          tcp.off('message');
          tcp.close();
        } catch (e) {
          // ignore
        }
        tcp = null;
      }
    }

    try {
      tcp = socket.constructTCPSocketInstance();
      const endpoint: socket.NetAddress = { address: peerIp, port: peerPort, family: 1 };

      tcp.on('message', (info: socket.SocketReceiveInfo) => {
        const newData = new Uint8Array(info.message);
        const combined = new Uint8Array(recvBuf.length + newData.length);
        combined.set(recvBuf, 0);
        combined.set(newData, recvBuf.length);
        recvBuf = combined;

        while (recvBuf.length >= 6) {
          const pkt = parsePacket(recvBuf);
          if (!pkt) break;
          const consumed = 5 + 1 + pkt.payload.length;
          recvBuf = recvBuf.subarray(consumed);
          handlePacket(pkt);
        }
      });

      tcp.on('close', () => {
        if (!settled) {
          settled = true;
          cleanup();
          resolve(blockData.length === expectedSize ? blockData : null);
        }
      });

      tcp.on('error', () => {
        if (!settled) {
          settled = true;
          cleanup();
          resolve(null);
        }
      });

      tcp.connect(endpoint, () => {
        const helloPkt = buildHelloPacket(userHash, clientId, CLIENT_PORT);
        tcp!.send({ data: helloPkt.buffer }, () => {});
      });
    } catch (e) {
      cleanup();
      resolve(null);
    }

    function handlePacket(pkt: Ed2kPacket): void {
      if (pkt.op === OP_HELLOANSWER) {
        // Request block
        const blockReq = buildBlockRequestPacket(start, end);
        tcp!.send({ data: blockReq.buffer }, () => {});
      } else if (pkt.op === OP_BLOCKDATA) {
        // Accumulate block data
        const combined = new Uint8Array(blockData.length + pkt.payload.length);
        combined.set(blockData, 0);
        combined.set(pkt.payload, blockData.length);
        blockData = combined;

        if (blockData.length >= expectedSize) {
          if (!settled) {
            settled = true;
            cleanup();
            resolve(blockData.subarray(0, expectedSize));
          }
        }
      } else if (pkt.op === OP_QUEUERANK) {
        // Queued — wait; for simplicity we timeout
      }
    }
  });
}
