/**
 * eDonkey server connection — login and source query.
 *
 * Connects to an eDonkey2000 server via TCP, logs in, then requests
 * sources (peers) for a given file hash. Returns a list of peer addresses.
 */

import { socket } from '@kit.NetworkKit';
import { BusinessError } from '@kit.BasicServicesKit';
import {
  OP_SERVERMESSAGE,
  OP_SERVERSTATUS,
  OP_FOUNDSOURCES,
  CLIENT_PORT,
  buildLoginPacket,
  buildGetSourcesPacket,
  parsePacket,
  readU32LE,
  bytesToIp,
  Ed2kPacket
} from './Ed2kPacket';

export interface Ed2kPeerAddr {
  ip: string;
  port: number;
}

/** Random 16-byte user hash for login. */
function randomUserHash(): Uint8Array {
  const hash = new Uint8Array(16);
  for (let i = 0; i < 16; i++) {
    hash[i] = Math.floor(Math.random() * 256);
  }
  return hash;
}

/**
 * Connect to an eDonkey server and retrieve sources for a file.
 *
 * @param serverIp   server IP address
 * @param serverPort server TCP port (usually 4661)
 * @param fileHash   16-byte MD4 file hash
 * @param fileSize   file size in bytes
 * @param timeoutMs  connection / response timeout
 * @returns array of peer addresses that claim to have the file
 */
export async function getSourcesFromServer(
  serverIp: string,
  serverPort: number,
  fileHash: Uint8Array,
  fileSize: number,
  timeoutMs: number = 15000
): Promise<Ed2kPeerAddr[]> {
  const userHash = randomUserHash();
  const clientId = 0x01000000 | Math.floor(Math.random() * 0xFFFFFF);

  return new Promise<Ed2kPeerAddr[]>((resolve, reject) => {
    let tcp: socket.TCPSocket | null = null;
    let recvBuf: Uint8Array = new Uint8Array(0);
    let settled = false;
    let sources: Ed2kPeerAddr[] = [];
    let gotSources = false;

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        cleanup();
        reject(new Error(`eD2K server timeout after ${timeoutMs}ms`));
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

    function finish(): void {
      if (!settled) {
        settled = true;
        cleanup();
        resolve(sources);
      }
    }

    try {
      tcp = socket.constructTCPSocketInstance();
      const endpoint: socket.NetAddress = {
        address: serverIp,
        port: serverPort,
        family: 1
      };

      tcp.on('message', (info: socket.SocketReceiveInfo) => {
        // Append received data to buffer
        const newData = new Uint8Array(info.message);
        const combined = new Uint8Array(recvBuf.length + newData.length);
        combined.set(recvBuf, 0);
        combined.set(newData, recvBuf.length);
        recvBuf = combined;

        // Process all complete packets
        while (recvBuf.length >= 6) {
          const pkt = parsePacket(recvBuf);
          if (!pkt) break;

          const consumed = 5 + 1 + pkt.payload.length;
          recvBuf = recvBuf.subarray(consumed);

          handlePacket(pkt);
        }
      });

      tcp.on('close', () => {
        finish();
      });

      tcp.on('error', (err: BusinessError) => {
        if (!settled) {
          settled = true;
          cleanup();
          reject(new Error(`eD2K server socket error: ${err.message}`));
        }
      });

      tcp.connect(endpoint, () => {
        // Send login
        const loginPkt = buildLoginPacket(userHash, clientId, CLIENT_PORT);
        tcp!.send({ data: loginPkt.buffer }, () => {
          // After login, request sources
          setTimeout(() => {
            const srcPkt = buildGetSourcesPacket(fileHash, fileSize);
            tcp!.send({ data: srcPkt.buffer }, () => {
              // Wait for response — will be handled in on('message')
            });
          }, 500);
        });
      });
    } catch (e) {
      cleanup();
      reject(new Error(`eD2K server connection failed: ${(e as Error).message}`));
    }

    function handlePacket(pkt: Ed2kPacket): void {
      switch (pkt.op) {
        case OP_SERVERMESSAGE:
          // Server welcome message — ignore
          break;

        case OP_SERVERSTATUS: {
          // Server status: userCount + fileCount
          break;
        }

        case OP_FOUNDSOURCES: {
          // Parse source list: fileHash(16) + count(4) + [ip(4) + port(4)] * count
          if (pkt.payload.length >= 20) {
            const count = readU32LE(pkt.payload, 16);
            const peerSize = 6; // ip(4) + port(2) in compact format
            for (let i = 0; i < count; i++) {
              const base = 20 + i * peerSize;
              if (base + peerSize <= pkt.payload.length) {
                const ip = bytesToIp(pkt.payload, base);
                const port = (pkt.payload[base + 4] | (pkt.payload[base + 5] << 8)) & 0xFFFF;
                if (port > 0) {
                  sources.push({ ip, port });
                }
              }
            }
          }
          gotSources = true;
          // Give a short grace period for more source packets, then finish
          setTimeout(() => finish(), 2000);
          break;
        }

        default:
          // Unknown opcode — ignore
          break;
      }
    }
  });
}
