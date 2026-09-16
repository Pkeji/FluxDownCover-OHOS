/**
 * MD4 hash — the hash algorithm used by eDonkey2000 (eD2K) for file identification.
 *
 * MD4 is not available in HarmonyOS cryptoFramework, so we implement it from the
 * RFC 1320 specification. Only the 128-bit (16-byte) digest is needed.
 */

/** Single-shot MD4: returns 16-byte digest. */
export function md4(data: Uint8Array): Uint8Array {
  const ctx = new Md4Context();
  ctx.update(data);
  return ctx.finalize();
}

class Md4Context {
  private a: number = 0x67452301;
  private b: number = 0xEFCDAB89;
  private c: number = 0x98BADCFE;
  private d: number = 0x10325476;
  private buf: Uint8Array = new Uint8Array(64);
  private bufLen: number = 0;
  private totalLen: number = 0;

  update(data: Uint8Array): void {
    this.totalLen += data.length;
    let offset = 0;

    // Fill remaining buffer
    if (this.bufLen > 0) {
      const need = 64 - this.bufLen;
      const take = Math.min(need, data.length);
      this.buf.set(data.subarray(0, take), this.bufLen);
      this.bufLen += take;
      offset = take;
      if (this.bufLen === 64) {
        this.processBlock(this.buf);
        this.bufLen = 0;
      }
    }

    // Process full blocks
    while (offset + 64 <= data.length) {
      this.processBlock(data.subarray(offset, offset + 64));
      offset += 64;
    }

    // Buffer remainder
    if (offset < data.length) {
      const remain = data.length - offset;
      this.buf.set(data.subarray(offset), 0);
      this.bufLen = remain;
    }
  }

  finalize(): Uint8Array {
    // Save length before padding (in bits, as two 32-bit LE words)
    const bitLenLo = (this.totalLen << 3) >>> 0;
    const bitLenHi = Math.floor(this.totalLen / 0x20000000) >>> 0;

    // Append 0x80
    this.buf[this.bufLen] = 0x80;
    this.bufLen++;

    // Pad with zeros until 56 mod 64
    if (this.bufLen > 56) {
      for (let i = this.bufLen; i < 64; i++) {
        this.buf[i] = 0;
      }
      this.processBlock(this.buf);
      this.bufLen = 0;
    }
    for (let i = this.bufLen; i < 56; i++) {
      this.buf[i] = 0;
    }

    // Append length (little-endian)
    this.buf[56] = bitLenLo & 0xFF;
    this.buf[57] = (bitLenLo >>> 8) & 0xFF;
    this.buf[58] = (bitLenLo >>> 16) & 0xFF;
    this.buf[59] = (bitLenLo >>> 24) & 0xFF;
    this.buf[60] = bitLenHi & 0xFF;
    this.buf[61] = (bitLenHi >>> 8) & 0xFF;
    this.buf[62] = (bitLenHi >>> 16) & 0xFF;
    this.buf[63] = (bitLenHi >>> 24) & 0xFF;
    this.processBlock(this.buf);

    // Output digest (little-endian a, b, c, d)
    const out = new Uint8Array(16);
    const state = [this.a, this.b, this.c, this.d];
    for (let i = 0; i < 4; i++) {
      out[i * 4] = state[i] & 0xFF;
      out[i * 4 + 1] = (state[i] >>> 8) & 0xFF;
      out[i * 4 + 2] = (state[i] >>> 16) & 0xFF;
      out[i * 4 + 3] = (state[i] >>> 24) & 0xFF;
    }
    return out;
  }

  private processBlock(block: Uint8Array): void {
    // Parse 16 32-bit little-endian words
    const x = new Array<number>(16);
    for (let i = 0; i < 16; i++) {
      x[i] = (block[i * 4] |
        (block[i * 4 + 1] << 8) |
        (block[i * 4 + 2] << 16) |
        (block[i * 4 + 3] << 24)) >>> 0;
    }

    let aa = this.a, bb = this.b, cc = this.c, dd = this.d;

    // Round 1: F(B,C,D) = (B & C) | (~B & D)
    const F = (g: number, h: number, i: number): number => ((g & h) | (~g & i)) >>> 0;
    const r1 = (a: number, k: number, s: number): number =>
      ((a + F(bb, cc, dd) + x[k]) << s | (a + F(bb, cc, dd) + x[k]) >>> (32 - s)) >>> 0;

    aa = r1(aa, 0, 3); dd = r1(dd, 1, 7); cc = r1(cc, 2, 11); bb = r1(bb, 3, 19);
    aa = r1(aa, 4, 3); dd = r1(dd, 5, 7); cc = r1(cc, 6, 11); bb = r1(bb, 7, 19);
    aa = r1(aa, 8, 3); dd = r1(dd, 9, 7); cc = r1(cc, 10, 11); bb = r1(bb, 11, 19);
    aa = r1(aa, 12, 3); dd = r1(dd, 13, 7); cc = r1(cc, 14, 11); bb = r1(bb, 15, 19);

    // Round 2: G(B,C,D) = (B & C) | (B & D) | (C & D)
    const G = (g: number, h: number, i: number): number => ((g & h) | (g & i) | (h & i)) >>> 0;
    const r2 = (a: number, k: number, s: number): number =>
      ((a + G(bb, cc, dd) + x[k] + 0x5A827999) << s |
        (a + G(bb, cc, dd) + x[k] + 0x5A827999) >>> (32 - s)) >>> 0;

    aa = r2(aa, 0, 3); dd = r2(dd, 4, 5); cc = r2(cc, 8, 9); bb = r2(bb, 12, 13);
    aa = r2(aa, 1, 3); dd = r2(dd, 5, 5); cc = r2(cc, 9, 9); bb = r2(bb, 13, 13);
    aa = r2(aa, 2, 3); dd = r2(dd, 6, 5); cc = r2(cc, 10, 9); bb = r2(bb, 14, 13);
    aa = r2(aa, 3, 3); dd = r2(dd, 7, 5); cc = r2(cc, 11, 9); bb = r2(bb, 15, 13);

    // Round 3: H(B,C,D) = B ^ C ^ D
    const H = (g: number, h: number, i: number): number => (g ^ h ^ i) >>> 0;
    const r3 = (a: number, k: number, s: number): number =>
      ((a + H(bb, cc, dd) + x[k] + 0x6ED9EBA1) << s |
        (a + H(bb, cc, dd) + x[k] + 0x6ED9EBA1) >>> (32 - s)) >>> 0;

    aa = r3(aa, 0, 3); dd = r3(dd, 8, 9); cc = r3(cc, 4, 11); bb = r3(bb, 12, 15);
    aa = r3(aa, 2, 3); dd = r3(dd, 10, 9); cc = r3(cc, 6, 11); bb = r3(bb, 14, 15);
    aa = r3(aa, 1, 3); dd = r3(dd, 9, 9); cc = r3(cc, 5, 11); bb = r3(bb, 13, 15);
    aa = r3(aa, 3, 3); dd = r3(dd, 11, 9); cc = r3(cc, 7, 11); bb = r3(bb, 15, 15);

    this.a = (this.a + aa) >>> 0;
    this.b = (this.b + bb) >>> 0;
    this.c = (this.c + cc) >>> 0;
    this.d = (this.d + dd) >>> 0;
  }
}

/** Convert 16-byte MD4 to 32-char lowercase hex string. */
export function md4ToHex(hash: Uint8Array): string {
  const hex = '0123456789abcdef';
  let out = '';
  for (let i = 0; i < hash.length; i++) {
    out += hex.charAt((hash[i] >> 4) & 0xF);
    out += hex.charAt(hash[i] & 0xF);
  }
  return out;
}

/** Verify a chunk's MD4 hash against expected. */
export function verifyMd4(data: Uint8Array, expected: Uint8Array): boolean {
  const actual = md4(data);
  for (let i = 0; i < 16; i++) {
    if (actual[i] !== expected[i]) {
      return false;
    }
  }
  return true;
}
