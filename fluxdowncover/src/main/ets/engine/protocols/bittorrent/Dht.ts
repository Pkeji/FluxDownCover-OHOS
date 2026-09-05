import { socket } from '@kit.NetworkKit';
import { logCollector } from '../../../utils/LogCollector';
import { BusinessError } from '@kit.BasicServicesKit';
import {
  bdecode,
  bencode,
  BencodeDict,
  BencodeList,
  BValue,
  dictGetBytes,
  dictGetDict,
  dictGetList,
  bytesToHex,
  bytesToAscii,
  asciiToBytes
} from './Bencode';
import { Peer } from './Tracker';
import { Ctrl } from '../../types';

/**
 * Distributed Hash Table client (BEP-5, Kademlia-style KRPC over UDP).
 *
 * Responsibilities:
 *   - Maintain a routing table of known DHT nodes.
 *   - `get_peers(infoHash)` → discover peers without any tracker.
 *   - `announce(infoHash, port)` → publish our presence so others can find us
 *     while we seed (requires a token from a prior get_peers to each node).
 *
 * This is a *client* DHT implementation: it participates in the network
 * (responds to ping / find_node / get_peers / announce_peer well enough to be
 * a "good" node) but does not store third-party (info_hash → peers) data.
 *
 * Runs on the same UDP port as the BT listen TCP port (UDP and TCP can share
 * the port number).
 */

const K = 8; // bucket size
const ALPHA = 3; // concurrency factor
const MAX_NODES = 600; // soft cap on routing-table size
const RESPONSE_TIMEOUT = 8000; // ms per query
const SEARCH_TIMEOUT = 25000; // ms for a full get_peers search
const MAX_SEARCH_ITERS = 40;
const MAX_PEERS_PER_SEARCH = 200;

/** Well-known public DHT bootstrap nodes. */
const BOOTSTRAP_HOSTS: { host: string; port: number }[] = [
  { host: 'router.bittorrent.com', port: 6881 },
  { host: 'dht.transmissionbt.com', port: 6881 },
  { host: 'router.utorrent.com', port: 6881 },
  { host: 'dht.libtorrent.org', port: 25401 },
  { host: 'dht.aelitis.com', port: 6881 }
];

/** A node in the DHT routing table. */
interface DhtNode {
  id: Uint8Array;
  idHex: string;
  ip: string;
  port: number;
  lastSeen: number;
  /** Token issued by this node in a recent get_peers response (for announce_peer). */
  token: Uint8Array | null;
  bootstrap: boolean;
}

/** Pending outgoing query awaiting a response. */
interface PendingQuery {
  resolve: (r: BencodeDict) => void;
  reject: (e: Error) => void;
  timer: number;
  ip: string;
  port: number;
}

export class Dht {
  private udp: socket.UDPSocket | null = null;
  private selfId: Uint8Array = new Uint8Array(20);
  private nodes: Map<string, DhtNode> = new Map();
  private pending: Map<string, PendingQuery> = new Map();
  private txnCounter = 1;
  private running = false;
  private port = 6881;

  constructor() {
    this.generateSelfId();
  }

  /** Bind the DHT UDP socket and start listening for replies / queries. */
  async start(port: number): Promise<void> {
    this.port = port;
    const udp = socket.constructUDPSocketInstance();
    this.udp = udp;
    await new Promise<void>((resolve, reject) => {
      udp.bind({ address: '0.0.0.0', port }, (err: BusinessError) => {
        if (err) {
          reject(new Error(`DHT UDP bind on :${port} failed: ${err.message}`));
        } else {
          resolve();
        }
      });
    });
    udp.on('message', (value: socket.SocketMessageInfo) => {
      try {
        this.onMessage(value);
      } catch (_) { /* ignore malformed packets */ }
    });
    udp.on('error', (err: BusinessError) => {
      logCollector.error('Error', `FluxDown Cover DHT socket error: ${err.message}`);
    });
    this.running = true;
    // Seed the routing table with bootstrap nodes (placeholder ids; real ids
    // are learned from their ping replies).
    for (const b of BOOTSTRAP_HOSTS) {
      this.addNode(this.randomId(), b.host, b.port, null, true);
    }
  }

  /** Stop the DHT and close the socket. */
  stop(): void {
    this.running = false;
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error('DHT stopped'));
    }
    this.pending.clear();
    if (this.udp) {
      try {
        this.udp.close();
      } catch (_) { /* ignore */ }
      this.udp = null;
    }
  }

  /** Number of nodes currently in the routing table. */
  get nodeCount(): number {
    return this.nodes.size;
  }

  /**
   * Discover peers for an info_hash via the DHT.
   * @param infoHash  20-byte info hash
   * @param onPeer    called for each peer discovered (may fire repeatedly)
   * @param ctrl      abort flag
   * @returns the collected peers
   */
  async getPeers(infoHash: Uint8Array, onPeer?: (p: Peer) => void, ctrl?: Ctrl): Promise<Peer[]> {
    return this.search(infoHash, true, onPeer, ctrl);
  }

  /**
   * Announce that we have a torrent available at `port` (used while seeding).
   * Performs a get_peers first to obtain per-node tokens, then announce_peer.
   */
  async announce(infoHash: Uint8Array, port: number, ctrl?: Ctrl): Promise<void> {
    // Ensure the routing table has some nodes.
    if (this.nodes.size === 0) {
      await this.pingBootstrap();
    }
    const closestNodes = this.closest(infoHash, K, new Set());
    for (const node of closestNodes) {
      if (ctrl?.aborted) {
        return;
      }
      try {
        const r = await this.sendGetPeers(node, infoHash);
        const token = dictGetBytes(r, 'token');
        if (token) {
          await this.sendAnnounce(node, infoHash, port, token);
        }
      } catch (_) {
        // node unreachable — try the next
      }
    }
  }

  // ── Internal: search (shared by get_peers and table expansion) ──────────

  private async search(
    target: Uint8Array,
    collectPeers: boolean,
    onPeer?: (p: Peer) => void,
    ctrl?: Ctrl
  ): Promise<Peer[]> {
    if (!this.running || !this.udp) {
      return [];
    }
    if (this.nodes.size === 0) {
      await this.pingBootstrap();
    }
    const queried = new Set<string>();
    const peers = new Map<string, Peer>();
    const deadline = Date.now() + SEARCH_TIMEOUT;
    let iter = 0;
    while (Date.now() < deadline && iter < MAX_SEARCH_ITERS && !ctrl?.aborted) {
      iter++;
      const candidates = this.closest(target, ALPHA, queried);
      if (candidates.length === 0) {
        break;
      }
      await Promise.allSettled(
        candidates.map(async (node) => {
          queried.add(node.idHex);
          try {
            const r = await this.sendGetPeers(node, target);
            const token = dictGetBytes(r, 'token');
            if (token) {
              node.token = token;
              node.lastSeen = Date.now();
            }
            if (collectPeers) {
              const values = dictGetList(r, 'values');
              if (values) {
                for (const v of values.items) {
                  if (v instanceof Uint8Array && v.length === 6) {
                    const p = parseCompactPeer(v);
                    const key = `${p.ip}:${p.port}`;
                    if (p.port > 0 && !peers.has(key)) {
                      peers.set(key, p);
                      onPeer?.(p);
                    }
                  }
                }
              }
            }
            const nodesBin = dictGetBytes(r, 'nodes');
            if (nodesBin) {
              this.addCompactNodes(nodesBin);
            }
          } catch (_) {
            // node unreachable
          }
        })
      );
      if (collectPeers && peers.size >= MAX_PEERS_PER_SEARCH) {
        break;
      }
    }
    return Array.from(peers.values());
  }

  // ── Internal: KRPC queries ─────────────────────────────────────────────

  private sendPing(ip: string, port: number): Promise<BencodeDict> {
    return this.sendQuery(ip, port, 'ping', new BencodeDict(new Map()));
  }

  private sendGetPeers(node: DhtNode, infoHash: Uint8Array): Promise<BencodeDict> {
    const a = new BencodeDict(new Map<string, any>());
    a.entries.set('id', this.selfId);
    a.entries.set('info_hash', infoHash);
    return this.sendQuery(node.ip, node.port, 'get_peers', a);
  }

  private sendAnnounce(
    node: DhtNode,
    infoHash: Uint8Array,
    port: number,
    token: Uint8Array
  ): Promise<BencodeDict> {
    const a = new BencodeDict(new Map<string, any>());
    a.entries.set('id', this.selfId);
    a.entries.set('info_hash', infoHash);
    a.entries.set('port', port);
    a.entries.set('token', token);
    return this.sendQuery(node.ip, node.port, 'announce_peer', a);
  }

  private sendQuery(
    ip: string,
    port: number,
    q: string,
    a: BencodeDict
  ): Promise<BencodeDict> {
    if (!this.udp) {
      return Promise.reject(new Error('DHT not started'));
    }
    const txid = this.nextTxid();
    const msg = new BencodeDict(new Map<string, any>());
    msg.entries.set('t', asciiToBytes(txid));
    msg.entries.set('y', asciiToBytes('q'));
    msg.entries.set('q', asciiToBytes(q));
    msg.entries.set('a', a);
    const payload = bencode(msg);

    return new Promise<BencodeDict>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(txid);
        reject(new Error(`DHT ${q} to ${ip}:${port} timed out`));
      }, RESPONSE_TIMEOUT);
      this.pending.set(txid, { resolve, reject, timer, ip, port });

      this.udp!
        .send({ data: payload.buffer.slice(payload.byteOffset, payload.byteOffset + payload.byteLength), address: { address: ip, port } })
        .catch((err: BusinessError) => {
          clearTimeout(timer);
          this.pending.delete(txid);
          reject(new Error(`DHT send failed: ${err.message}`));
        });
    });
  }

  private async pingBootstrap(): Promise<void> {
    await Promise.allSettled(
      BOOTSTRAP_HOSTS.map(async (b) => {
        try {
          const r = await this.sendPing(b.host, b.port);
          const idBytes = dictGetBytes(r, 'id');
          if (idBytes) {
            this.addNode(idBytes, b.host, b.port, null, true);
          }
        } catch (_) {
          // bootstrap node unreachable
        }
      })
    );
    // A couple of find_node(selfId) rounds to expand the table.
    for (let round = 0; round < 3; round++) {
      await this.search(this.selfId, false);
      if (this.nodes.size >= K) {
        break;
      }
    }
  }

  // ── Internal: message handling ─────────────────────────────────────────

  private onMessage(value: socket.SocketMessageInfo): void {
    const raw = value.message;
    const data = raw instanceof ArrayBuffer ? new Uint8Array(raw) : (raw as Uint8Array);
    const msg = bdecode(data);
    if (!(msg instanceof BencodeDict)) {
      return;
    }
    const yBytes = dictGetBytes(msg, 'y');
    if (!yBytes) {
      return;
    }
    const y = bytesToAscii(yBytes);
    const tBytes = dictGetBytes(msg, 't');
    const txid = tBytes ? bytesToHex(tBytes) : '';

    if (y === 'r' || y === 'e') {
      const pending = this.pending.get(txid);
      if (!pending) {
        return;
      }
      clearTimeout(pending.timer);
      this.pending.delete(txid);
      if (y === 'e') {
        pending.reject(new Error('DHT error response'));
        return;
      }
      const r = dictGetDict(msg, 'r');
      if (!r) {
        pending.reject(new Error('DHT empty response'));
        return;
      }
      const idBytes = dictGetBytes(r, 'id');
      if (idBytes) {
        this.addNode(idBytes, pending.ip, pending.port, null, false);
      }
      pending.resolve(r);
    } else if (y === 'q') {
      this.handleQuery(msg, value.remoteInfo);
    }
  }

  private handleQuery(msg: BencodeDict, remoteInfo?: socket.SocketRemoteInfo): void {
    if (!remoteInfo || !this.udp) {
      return;
    }
    const q = dictGetBytes(msg, 'q');
    if (!q) {
      return;
    }
    const qName = bytesToAscii(q);
    const tBytes = dictGetBytes(msg, 't');
    const txid = tBytes ? bytesToHex(tBytes) : '00';

    const r = new BencodeDict(new Map<string, any>());
    r.entries.set('id', this.selfId);
    if (qName === 'ping') {
      // reply with our id
    } else if (qName === 'find_node') {
      r.entries.set('nodes', new Uint8Array(0)); // we don't store third-party data
    } else if (qName === 'get_peers') {
      r.entries.set('token', this.randomId());
      r.entries.set('nodes', new Uint8Array(0));
    } else if (qName === 'announce_peer') {
      // accept; nothing to store
    } else {
      return;
    }
    const reply = new BencodeDict(new Map<string, any>());
    reply.entries.set('t', asciiToBytes(txid));
    reply.entries.set('y', asciiToBytes('r'));
    reply.entries.set('r', r);
    const payload = bencode(reply);
    this.udp
      .send({
        data: payload.buffer.slice(payload.byteOffset, payload.byteOffset + payload.byteLength),
        address: { address: remoteInfo.address, port: remoteInfo.port }
      })
      .catch(() => { /* ignore */ });
  }

  // ── Internal: routing table ────────────────────────────────────────────

  private addNode(id: Uint8Array, ip: string, port: number, token: Uint8Array | null, bootstrap: boolean): void {
    const idHex = bytesToHex(id);
    const existing = this.nodes.get(idHex);
    if (existing) {
      existing.lastSeen = Date.now();
      existing.ip = ip;
      existing.port = port;
      if (token) {
        existing.token = token;
      }
      return;
    }
    if (this.nodes.size >= MAX_NODES) {
      this.evictOldest();
    }
    this.nodes.set(idHex, {
      id,
      idHex,
      ip,
      port,
      lastSeen: Date.now(),
      token,
      bootstrap
    });
  }

  private addCompactNodes(nodesBin: Uint8Array): void {
    // Compact node info: 26 bytes per node (id 20 + ipv4 4 + port 2).
    for (let i = 0; i + 26 <= nodesBin.length; i += 26) {
      const id = nodesBin.subarray(i, i + 20);
      const ip = `${nodesBin[i + 20]}.${nodesBin[i + 21]}.${nodesBin[i + 22]}.${nodesBin[i + 23]}`;
      const port = (nodesBin[i + 24] << 8) | nodesBin[i + 25];
      if (port > 0) {
        this.addNode(id, ip, port, null, false);
      }
    }
  }

  private evictOldest(): void {
    let oldestHex: string | null = null;
    let oldestTime = Date.now();
    for (const [hex, node] of this.nodes) {
      if (node.bootstrap) {
        continue; // never evict bootstrap nodes
      }
      if (node.lastSeen < oldestTime) {
        oldestTime = node.lastSeen;
        oldestHex = hex;
      }
    }
    if (oldestHex) {
      this.nodes.delete(oldestHex);
    }
  }

  /** Return up to `n` nodes closest (by XOR distance) to `target`. */
  private closest(target: Uint8Array, n: number, exclude: Set<string>): DhtNode[] {
    const all = Array.from(this.nodes.values()).filter((node) => !exclude.has(node.idHex));
    all.sort((a, b) => this.xorCompare(a.id, b.id, target));
    return all.slice(0, n);
  }

  /** -1 if a closer to target than b, 1 if b closer, 0 if equal. */
  private xorCompare(a: Uint8Array, b: Uint8Array, target: Uint8Array): number {
    for (let i = 0; i < 20; i++) {
      const xa = (a[i] ^ target[i]) & 0xff;
      const xb = (b[i] ^ target[i]) & 0xff;
      if (xa !== xb) {
        return xa < xb ? -1 : 1;
      }
    }
    return 0;
  }

  // ── Helpers ─────────────────────────────────────────────────────────────

  private nextTxid(): string {
    const n = this.txnCounter++;
    const buf = new Uint8Array(2);
    buf[0] = (n >>> 8) & 0xff;
    buf[1] = n & 0xff;
    return bytesToHex(buf);
  }

  private generateSelfId(): void {
    // Prefix "-FD100-" (FluxDown Cover) + random bytes, like a real client.
    const prefix = asciiToBytes('-FD100-');
    this.selfId.set(prefix, 0);
    for (let i = 7; i < 20; i++) {
      this.selfId[i] = Math.floor(Math.random() * 256);
    }
  }

  private randomId(): Uint8Array {
    const id = new Uint8Array(20);
    for (let i = 0; i < 20; i++) {
      id[i] = Math.floor(Math.random() * 256);
    }
    return id;
  }
}

/** Parse a 6-byte compact peer (ipv4 4 + port 2) into a Peer. */
function parseCompactPeer(bin: Uint8Array): Peer {
  return {
    ip: `${bin[0]}.${bin[1]}.${bin[2]}.${bin[3]}`,
    port: (bin[4] << 8) | bin[5]
  };
}
