import cryptoFramework from '@ohos.security.cryptoFramework';
import fs from '@ohos.file.fs';

/**
 * Compute the SHA-256 of a file, streaming it in 1 MB chunks.
 *
 * Runs on the caller's thread using the async cryptoFramework API. The hashing
 * is off-loaded from the UI by virtue of being asynchronous (native crypto work
 * yields between chunks); if it ever blocks the UI too much, the caller treats a
 * failure as non-fatal (sha256 left empty).
 */
export async function hashFile(filePath: string): Promise<string> {
  const file = fs.openSync(filePath, fs.OpenMode.READ_ONLY);
  try {
    const md = cryptoFramework.createMd('SHA256');
    const buf = new ArrayBuffer( 1024 * 1024);
    while (true) {
      const len = fs.readSync(file.fd, buf);
      if (len <= 0) {
        break;
      }
      const view = new Uint8Array(buf, 0, len);
      await md.update({ data: view });
    }
    const digest = await md.digest();
    const bytes = digest.data;
    let hex = '';
    for (let i = 0; i < bytes.length; i++) {
      hex += bytes[i].toString(16).padStart(2, '0');
    }
    return hex;
  } finally {
    fs.closeSync(file);
  }
}
