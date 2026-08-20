/**
 * Token-bucket rate limiter for download speed control.
 * Ported from FluxDown's Rust speed governor.
 * Supports both global and per-task limits (0 = unlimited).
 */
export class SpeedLimiter {
  private static _global: SpeedLimiter | null = null;

  /** Global singleton limiter (0 = no limit). */
  static global(): SpeedLimiter {
    if (!SpeedLimiter._global) {
      SpeedLimiter._global = new SpeedLimiter(0);
    }
    return SpeedLimiter._global;
  }

  private _limitBytesPerSec: number; // 0 = unlimited
  private _tokens: number;
  private _lastRefill: number;

  constructor(limitBytesPerSec: number) {
    this._limitBytesPerSec = limitBytesPerSec;
    this._tokens = limitBytesPerSec > 0 ? limitBytesPerSec : Infinity;
    this._lastRefill = Date.now();
  }

  setLimit(bytesPerSec: number): void {
    this._limitBytesPerSec = bytesPerSec;
    if (bytesPerSec <= 0) {
      this._tokens = Infinity;
    }
  }

  getLimit(): number {
    return this._limitBytesPerSec;
  }

  /**
   * Attempt to consume `bytes` tokens. Returns the number of bytes
   * that can be sent immediately (may be less than requested).
   * If the limit is 0 (unlimited), always returns the full amount.
   */
  tryConsume(bytes: number): number {
    if (this._limitBytesPerSec <= 0) {
      return bytes;
    }
    this._refill();
    if (this._tokens >= bytes) {
      this._tokens -= bytes;
      return bytes;
    }
    const granted = Math.floor(this._tokens);
    this._tokens -= granted;
    return granted;
  }

  /**
   * Wait time in ms until `bytes` tokens are available.
   * Returns 0 if tokens are already available or limit is unlimited.
   */
  waitTime(bytes: number): number {
    if (this._limitBytesPerSec <= 0) {
      return 0;
    }
    this._refill();
    if (this._tokens >= bytes) {
      return 0;
    }
    const deficit = bytes - this._tokens;
    return Math.ceil((deficit / this._limitBytesPerSec) * 1000);
  }

  private _refill(): void {
    const now = Date.now();
    const elapsed = (now - this._lastRefill) / 1000;
    if (elapsed > 0 && this._limitBytesPerSec > 0) {
      this._tokens = Math.min(this._limitBytesPerSec, this._tokens + elapsed * this._limitBytesPerSec);
      this._lastRefill = now;
    }
  }
}
