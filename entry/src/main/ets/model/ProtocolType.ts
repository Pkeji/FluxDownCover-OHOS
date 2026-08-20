/**
 * Supported transfer protocols. HTTP/HTTPS and HLS are fully implemented in this port;
 * FTP is implemented (passive mode); BitTorrent is implemented (HTTP tracker, peer wire
 * protocol, SHA-1 piece verification); SFTP / Thunder / eD2K are scaffolded (see README).
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
  ED2K = 'ed2k'
}
