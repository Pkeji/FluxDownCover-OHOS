/**
 * NetworkPredictor — Phase 2: 智能网络预测.
 *
 * Tracks download speed history with a sliding window and uses weighted
 * moving average to predict available bandwidth. The engine uses these
 * predictions to:
 *  - Dynamically size segments for optimal parallelism
 *  - Pre-allocate the right number of concurrent chunk requests
 *  - Detect bandwidth changes (increase → spawn more; decrease → coalesce)
 *
 * Ported from FluxDown Cover's Rust bandwidth scheduler (phase2.rs).
 */
export class NetworkPredictor {
  private static instance: NetworkPredictor | null = null;

  static getInstance(): NetworkPredictor {
    if (!NetworkPredictor.instance) {
      NetworkPredictor.instance = new NetworkPredictor();
    }
    return NetworkPredictor.instance;
  }

  /** Sliding window for bandwidth samples (bytes/sec). */
  private samples: number[] = [];
  private readonly MAX_SAMPLES = 30; // ~30 seconds at 1 sample/sec
  private sampleWeight = 0;

  /** Current smoothed bandwidth in bytes/sec. */
  private _predictedBw: number = 0;

  /** Lowest observed bandwidth (bytes/sec). */
  private _minBw: number = Infinity;

  /** Highest observed bandwidth (bytes/sec). */
  private _maxBw: number = 0;

  /** Bandwidth variance — high → unstable network. */
  private _variance: number = 0;

  get predictedBw(): number {
    return this._predictedBw;
  }
  get minBw(): number {
    return this._minBw === Infinity ? 0 : this._minBw;
  }
  get maxBw(): number {
    return this._maxBw;
  }
  get variance(): number {
    return this._variance;
  }

  /**
   * Record a bandwidth sample (bytes transferred / elapsed seconds).
   * Called by the engine after each chunk download.
   */
  recordSample(bytes: number, elapsedMs: number): void {
    if (elapsedMs <= 0) {
      return;
    }
    const bw = Math.round(bytes / (elapsedMs / 1000));
    if (bw <= 0) {
      return;
    }
    this.samples.push(bw);
    if (this.samples.length > this.MAX_SAMPLES) {
      this.samples.shift();
    }
    if (bw < this._minBw) {
      this._minBw = bw;
    }
    if (bw > this._maxBw) {
      this._maxBw = bw;
    }
    this.recalc();
  }

  /** Clear all samples (e.g. network change). */
  reset(): void {
    this.samples = [];
    this._predictedBw = 0;
    this._minBw = Infinity;
    this._maxBw = 0;
    this._variance = 0;
    this.sampleWeight = 0;
  }

  /**
   * Recommend how many concurrent segments to use.
   * Uses a simple heuristic:
   *  - High bandwidth + low variance → more segments (up to 8)
   *  - Low bandwidth or high variance → fewer segments (min 1)
   */
  recommendSegmentCount(maxSegments: number = 8): number {
    if (this.samples.length < 3 || this._predictedBw <= 0) {
      return 1; // not enough data yet
    }
    // Base: 1 segment per 500 KB/s predicted bandwidth
    const base = Math.max(1, Math.round(this._predictedBw / (500 * 1024)));
    // Reduce if high variance (unstable network)
    const stability = this._variance > 0
      ? Math.max(0.3, 1 - (this._variance / this._predictedBw))
      : 1;
    const count = Math.max(1, Math.min(maxSegments, Math.round(base * stability)));
    return count;
  }

  /**
   * Recommend segment size in bytes based on predicted bandwidth.
   * Larger segments reduce overhead on fast connections;
   * smaller segments improve granularity on slow connections.
   */
  recommendSegmentSize(): number {
    if (this._predictedBw <= 0) {
      return 1024 * 1024; // default 1 MB
    }
    // Aim for ~2 seconds per segment
    const targetBytes = this._predictedBw * 2;
    // Clamp between 256 KB and 16 MB
    return Math.max(256 * 1024, Math.min(16 * 1024 * 1024, Math.round(targetBytes)));
  }

  /**
   * Predict how long a download of `remainingBytes` will take (ms).
   */
  predictRemainingTime(remainingBytes: number): number {
    if (this._predictedBw <= 0) {
      return Infinity;
    }
    return Math.round((remainingBytes / this._predictedBw) * 1000);
  }

  /**
   * Detect whether network conditions have changed significantly
   * (bandwidth increased or decreased by >40% recently).
   */
  detectNetworkChange(): 'improved' | 'degraded' | 'stable' {
    if (this.samples.length < 6) {
      return 'stable';
    }
    const recent = this.samples.slice(-3);
    const older = this.samples.slice(0, 3);
    if (recent.length < 3 || older.length < 3) {
      return 'stable';
    }
    const avgRecent = recent.reduce((a, b) => a + b, 0) / recent.length;
    const avgOlder = older.reduce((a, b) => a + b, 0) / older.length;
    if (avgOlder <= 0) {
      return 'stable';
    }
    const ratio = avgRecent / avgOlder;
    if (ratio > 1.4) {
      return 'improved';
    }
    if (ratio < 0.6) {
      return 'degraded';
    }
    return 'stable';
  }

  /**
   * Apply exponential weighted moving average and variance.
   */
  private recalc(): void {
    if (this.samples.length === 0) {
      return;
    }
    // Exponential Weighted Moving Average (α = 0.3)
    const alpha = 0.3;
    let ema = this.samples[0];
    for (let i = 1; i < this.samples.length; i++) {
      ema = alpha * this.samples[i] + (1 - alpha) * ema;
    }
    this._predictedBw = Math.round(ema);

    // Variance (population variance for simplicity)
    const mean = this.samples.reduce((a, b) => a + b, 0) / this.samples.length;
    const sqDiffs = this.samples.map((v) => (v - mean) ** 2);
    this._variance = Math.round(
      Math.sqrt(sqDiffs.reduce((a, b) => a + b, 0) / sqDiffs.length)
    );
  }
}
