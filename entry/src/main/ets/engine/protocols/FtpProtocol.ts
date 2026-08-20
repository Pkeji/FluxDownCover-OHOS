import { socket } from '@kit.NetworkKit';
import { BusinessError } from '@kit.BasicServicesKit';
import fs from '@ohos.file.fs';
import { DownloadTask } from '../../model/DownloadTask';
import { EngineHooks } from '../EngineHooks';
import { Ctrl } from '../types';
import { parseFtpUrl } from '../../utils/common';

/**
 * Minimal but functional FTP download client (anonymous, passive mode).
 *
 * Flow: connect control -> USER/PASS -> TYPE I -> PASV -> open data socket ->
 * RETR <path> -> stream data to file -> await 226 on control channel.
 *
 * Designed per the official @ohos.net.socket (TCPSocket) API. Because socket
 * behaviour is device/timing sensitive and cannot be exercised in this sandbox,
 * validate on a real device (DevEco + Mate 60 Pro) before relying on it.
 */
export async function downloadFtp(task: DownloadTask, ctrl: Ctrl, hooks: EngineHooks): Promise<void> {
  const { host, port, path } = parseFtpUrl(task.url);
  const ctrlSock = socket.constructTCPSocketInstance();
  let buf = '';
  let pending: ((lines: string[]) => void) | null = null;
  let lines: string[] = [];

  ctrlSock.on('message', (msg: Object) => {
    const text = ab2str((msg as { message: ArrayBuffer }).message);
    buf += text;
    let idx: number;
    while ((idx = buf.indexOf('\r\n')) >= 0) {
      const line = buf.substring(0, idx);
      buf = buf.substring(idx + 2);
      lines.push(line);
      if (/^\d\d\d /.test(line)) {
        const out = lines;
        lines = [];
        const r = pending;
        pending = null;
        if (r) {
          r(out);
        }
      }
    }
  });

  const readReply = (): Promise<string[]> => {
    if (lines.length && /^\d\d\d /.test(lines[lines.length - 1])) {
      const out = lines;
      lines = [];
      return Promise.resolve(out);
    }
    return new Promise<string[]>((resolve) => {
      pending = resolve;
    });
  };

  const cmd = async (text: string): Promise<string[]> => {
    await ctrlSock.send({ data: text + '\r\n' });
    return readReply();
  };

  await ctrlSock.connect({ address: { address: host, port }, timeout: 15000 });

  await cmd('USER anonymous');
  await cmd('PASS anonymous@fluxdown.local');
  await cmd('TYPE I');

  const pasv = await cmd('PASV');
  const last = pasv[pasv.length - 1] ?? '';
  const m = /\((\d+),(\d+),(\d+),(\d+),(\d+),(\d+)\)/.exec(last);
  if (!m) {
    throw new Error('FTP: 无法解析 PASV 响应');
  }
  const dataHost = `${m[1]}.${m[2]}.${m[3]}.${m[4]}`;
  const dataPort = Number(m[5]) * 256 + Number(m[6]);

  const file = fs.openSync(task.filePath, fs.OpenMode.READ_WRITE | fs.OpenMode.CREATE);
  const dataSock = socket.constructTCPSocketInstance();
  let offset = 0;
  let writeChain: Promise<void> = Promise.resolve();
  let dataErr: Error | null = null;
  let dataResolve: () => void = () => {};
  let dataReject: (e: Error) => void = () => {};
  const dataDone = new Promise<void>((res, rej) => {
    dataResolve = res;
    dataReject = rej;
  });

  dataSock.on('message', (msg: Object) => {
    if (ctrl.aborted) {
      return;
    }
    const chunk = (msg as { message: ArrayBuffer }).message;
    const cur = offset;
    offset += chunk.byteLength;
    writeChain = writeChain
      .then(() => fs.write(file.fd, chunk, { offset: cur }))
      .then((len: number) => {
        hooks.onChunk(task, len);
      })
      .catch((e: BusinessError) => {
        dataErr = e as Error;
      });
  });
  dataSock.on('close', () => {
    if (dataErr) {
      dataReject(dataErr);
      return;
    }
    writeChain
      .then(() => dataResolve())
      .catch((e) => dataReject(e as Error));
  });
  dataSock.on('error', (err: BusinessError) => {
    if (ctrl.aborted) {
      dataResolve();
      return;
    }
    dataReject(new Error(`FTP data error ${err.code}: ${err.message}`));
  });

  await dataSock.connect({ address: { address: dataHost, port: dataPort }, timeout: 15000 });
  await cmd('RETR ' + path);
  try {
    await dataDone;

    try {
      await readReply();
    } catch (e) {
      // ignore trailing control reply errors
    }
  } finally {
    fs.closeSync(file);
    try {
      ctrlSock.close();
    } catch (e) {
      // ignore
    }
    try {
      dataSock.close();
    } catch (e) {
      // ignore
    }
  }
}

function ab2str(buf: ArrayBuffer): string {
  const u = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < u.length; i++) {
    s += String.fromCharCode(u[i]);
  }
  return s;
}
