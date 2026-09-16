/**
 * eDonkey2000 (ed2k) protocol module — barrel export.
 *
 * Provides all public symbols for the eD2K sub-system:
 * link parsing, packet building/parsing, peer protocol,
 * server protocol, and MD4 hashing.
 */

// ── Link Parser ──
export { Ed2kServerHint, Ed2kLinkInfo, parseEd2kLink } from './Ed2kLink';

// ── Packet Protocol ──
export {
  PROTO_MARKER,
  OP_LOGIN,
  OP_GETSOURCES,
  OP_DISCONNECT,
  OP_SERVERMESSAGE,
  OP_SERVERSTATUS,
  OP_SERVERIDENT,
  OP_FOUNDSOURCES,
  OP_HELLO,
  OP_HELLOANSWER,
  OP_HASHSETREQUEST,
  OP_HASHSETANSWER,
  OP_FILESTATUSREQ,
  OP_FILESTATUS,
  OP_BLOCKREQUEST,
  OP_BLOCKDATA,
  OP_QUEUERANK,
  OP_ACCEPTUPLOADREQ,
  OP_STARTUPLOADREQ,
  OP_CANCELUPLOAD,
  CHUNK_SIZE,
  BLOCK_SIZE,
  CLIENT_PORT,
  readU32LE,
  readU16LE,
  ipToBytes,
  bytesToIp,
  buildPacket,
  buildLoginPacket,
  buildGetSourcesPacket,
  buildHelloPacket,
  buildFileStatusReqPacket,
  buildHashSetReqPacket,
  buildBlockRequestPacket,
  Ed2kPacket,
  parsePacket,
  nextPacketSize
} from './Ed2kPacket';

// ── Peer ──
export { PeerFileStatus, BlockResult } from './Ed2kPeer';

// ── Server ──
export { Ed2kPeerAddr } from './Ed2kServer';

// ── MD4 Hash ──
export { md4, md4ToHex, verifyMd4 } from './Md4';
