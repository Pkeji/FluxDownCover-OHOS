/**
 * Supported transfer protocols. HTTP/HTTPS and HLS are fully implemented in this port;
 * FTP is implemented (passive mode); BitTorrent / eD2K are scaffolded (see README).
 */
export enum ProtocolType {
  HTTP = 'http',
  HTTPS = 'https',
  FTP = 'ftp',
  HLS = 'hls',
  BITTORRENT = 'bittorrent',
  ED2K = 'ed2k'
}
