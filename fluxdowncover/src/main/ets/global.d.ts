declare module 'torrent_napi.so' {
  export function nativeInit(saveDir: string, trackers: string, proxy: string, maxPeers: number, listenPort: number): boolean;
  export function nativeAddMagnet(magnet: string, saveDir: string): string;
  export function nativeGetStatus(gid: string): {
    found: boolean;
    status: number;
    totalLength: number;
    completedLength: number;
    downloadSpeed: number;
    connections: number;
    errorCode: number;
    name: string;
    files: Array<{ path: string; length: number }>;
  };
  export function nativePause(gid: string): number;
  export function nativeResume(gid: string): number;
  export function nativeRemove(gid: string, force: boolean): number;
  export function nativeGlobalStat(): { downloadSpeed: number; numActive: number };
  export function nativeStop(): boolean;
  export function nativeIsRunning(): boolean;
}

declare module 'libtorrent_bt.so' {
  export function initSession(): boolean;
  export function addMagnet(magnet: string, savePath: string): string;
  export function getStatus(id: string): {
    found: boolean;
    name: string;
    progress: number;
    downloadRate: number;
    state: number;
    total: number;
    done: number;
  };
  export function pause(id: string): boolean;
  export function resume(id: string): boolean;
  export function remove(id: string): boolean;
}

export {};
