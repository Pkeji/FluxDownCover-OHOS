/**
 * Supported transfer protocols. HTTP/HTTPS and HLS are fully implemented in this port;
 * FTP is implemented (passive mode); BitTorrent is implemented (HTTP tracker, peer wire
 * protocol, SHA-1 piece verification); eD2K is implemented (server + peer wire protocol);
 * Thunder / FlashGet / QQDL are wrapper-protocol decoders that re-dispatch to the
 * underlying real protocol; SFTP is not yet supported (requires SSH transport).
 */
export enum ProtocolType {
  HTTP = 'http',
  HTTPS = 'https',
  FTP = 'ftp',
  SFTP = 'sftp',
  HLS = 'hls',
  DASH = 'dash',
  BITTORRENT = 'bittorrent',
  THUNDER = 'thunder',
  FLASHGET = 'flashget',
  QQDL = 'qqdl',
  ED2K = 'ed2k'
}
