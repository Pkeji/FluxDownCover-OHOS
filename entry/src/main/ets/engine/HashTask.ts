import { taskpool } from '@kit.ArkTS';
import cryptoFramework from '@ohos.security.cryptoFramework';
import fs from '@ohos.file.fs';

/**
 * Compute the SHA-256 of a file, streaming it in 1 MB chunks.
 * Runs inside a TaskPool worker so the (CPU-bound) hashing never blocks the UI
 * thread — this is FluxDown's "verify integrity" step.
 *
 * NOTE: if the device/runtime disallows cryptoFramework inside a TaskPool task,
 * the caller treats the failure as non-fatal (sha256 left empty).
 */
@Concurrent
export function computeFileHash(filePath: string): string {
  const file = fs.openSync(filePath, fs.OpenMode.READ_ONLY);
  const md: cryptoFramework.Md = cryptoFramework.createMd('SHA256');
  const buf = new ArrayBuffer(1024 * 1024);
  try {
    while (true) {
      const bytesRead: number = fs.readSync(file.fd, buf);
      if (bytesRead <= 0) {
        break;
      }
      const view = new Uint8Array(buf, 0, bytesRead);
      md.updateSync({ data: view });
    }
  } finally {
    fs.closeSync(file);
  }
  const digest: cryptoFramework.DataBlob = md.digestSync();
  const bytes: Uint8Array = digest.data;
  let hex = '';
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i].toString(16).padStart(2, '0');
  }
  return hex;
}

/** Convenience wrapper that executes computeFileHash on a TaskPool worker. */
export async function hashFile(filePath: string): Promise<string> {
  const task = new taskpool.Task(computeFileHash, filePath);
  return (await taskpool.execute(task)) as string;
}
