import cryptoFramework from '@ohos.security.cryptoFramework';
import fs from '@ohos.file.fs';

/**
 * Compute the SHA-256 of a file, streaming it in 1 MB chunks.
 *
 * Runs on the caller's thread using the async cryptoFramework API. The hashing
 * is off-loaded from the UI by virtue of being asynchronous (native crypto work
 * yields between chunks); the caller treats a failure as non-fatal (sha256 left
 * empty), so any IO / crypto error here is caught and returns an empty string.
 */
export async function hashFile(filePath: string): Promise<string> {
  let file: fs.File | null = null;
  try {
    file = fs.openSync(filePath, fs.OpenMode.READ_ONLY);
    const md = cryptoFramework.createMd('SHA256');
    const buf = new ArrayBuffer(1024 * 1024);
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
  } catch (e) {
    // Non-fatal by design: leave sha256 empty when the file cannot be hashed.
    console.warn(`[HashTask] hash failed for ${filePath}: ${(e as Error)?.message ?? e}`);
    return '';
  } finally {
    if (file) {
      try {
        fs.closeSync(file);
      } catch (_e) {
        // ignore close error
      }
    }
  }
}
