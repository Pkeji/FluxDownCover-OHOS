/**
 * BitTorrent protocol module — barrel export.
 *
 * Provides all public symbols for the BitTorrent sub-system:
 * bencoding, metadata (torrent/magnet), DHT, PEX, seeding,
 * tracker protocol, peer wire protocol, and UPnP port mapping.
 */

// ── Bencode ──
export {
  BencodeList,
  BencodeDict,
  BValue,
  bdecode,
  bencode,
  bytesToAscii,
  asciiToBytes,
  concatBytes,
  bytesToHex,
  dictGetString,
  dictGetBytes,
  dictGetInt,
  dictGetList,
  dictGetDict
} from './Bencode';

// ── DHT (Kademlia) ──
export { Dht } from './Dht';

// ── Magnet Link ──
export { MagnetLink, parseMagnetLink } from './MagnetLink';

// ── Metadata Exchange (UT_METADATA) ──
export { MetadataResult } from './MetadataExchange';

// ── Peer Server (TCP listener for incoming connections) ──
export {
  SeedLookup,
  SeedResolver,
  PeerServerOptions,
  PeerServer
} from './PeerServer';

// ── Peer Wire Protocol ──
export {
  MSG_CHOKE,
  MSG_UNCHOKE,
  MSG_INTERESTED,
  MSG_NOT_INTERESTED,
  MSG_HAVE,
  MSG_BITFIELD,
  MSG_REQUEST,
  MSG_PIECE,
  MSG_CANCEL,
  MSG_EXTENDED,
  PieceBlock,
  PeerMessageHandler,
  PeerConnection,
  writeUint32BE,
  readUint32BE,
  buildBitfield,
  bitfieldHas
} from './PeerWire';

// ── Piece Manager ──
export { BLOCK_SIZE, PieceVerifiedCallback, PieceManager } from './PieceManager';

// ── Seeding Manager ──
export { SeedingManager } from './SeedingManager';

// ── Torrent Metadata ──
export {
  TorrentFile,
  TorrentMeta,
  parseTorrentBytes,
  generatePeerId,
  sha1Sync,
  sha1FileRegion,
  bytesEqual
} from './TorrentMeta';

// ── Tracker (HTTP/UDP announce) ──
export { Peer, AnnounceResult } from './Tracker';
export { TrackerManager } from './TrackerManager';

// ── UPnP Port Mapper ──
export { UpnpPortMapper } from './UpnpPortMapper';
