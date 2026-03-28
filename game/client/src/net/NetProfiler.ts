/**
 * TEMPORARY profiling instrumentation for network sync diagnostics.
 * Collects stats on interpolation, extrapolation, clock sync, and WS message timing.
 * Dumps a summary to console every 5 seconds.
 *
 * DELETE THIS FILE after profiling is complete.
 */

export class NetProfiler {
  // Interpolation vs extrapolation tracking
  private interpCount = 0;
  private extrapCount = 0;
  private nullCount = 0; // getInterpolatedState returned null

  // Clock sync offset tracking
  private offsets: number[] = [];

  // WS message arrival timing (state_delta only)
  private lastStateDeltaTime = 0;
  private stateDeltaIntervals: number[] = [];

  // Frame timing
  private lastFrameTime = 0;
  private frameTimes: number[] = [];

  // Buffer state
  private bufferSizes: number[] = [];

  // Report interval
  private reportInterval: ReturnType<typeof setInterval> | null = null;
  private startTime = Date.now();

  start(): void {
    this.startTime = Date.now();
    this.reportInterval = setInterval(() => this.report(), 5000);
    console.log("[NetProfiler] Started — collecting data every 5s");
  }

  stop(): void {
    if (this.reportInterval) {
      clearInterval(this.reportInterval);
      this.reportInterval = null;
    }
    this.report();
    console.log(
      "%c[NetProfiler] Stopped",
      "color: #ff8800; font-weight: bold"
    );
  }

  // Called from Interpolator.getInterpolatedState()
  recordInterpolation(): void {
    this.interpCount++;
  }

  recordExtrapolation(): void {
    this.extrapCount++;
  }

  recordNull(): void {
    this.nullCount++;
  }

  // Called from ClockSync.recordPong()
  recordOffset(offset: number): void {
    this.offsets.push(offset);
  }

  // Called from WebSocketClient on state_delta receipt
  recordStateDelta(): void {
    const now = performance.now();
    if (this.lastStateDeltaTime > 0) {
      this.stateDeltaIntervals.push(now - this.lastStateDeltaTime);
    }
    this.lastStateDeltaTime = now;
  }

  // Called from render loop
  recordFrame(): void {
    const now = performance.now();
    if (this.lastFrameTime > 0) {
      this.frameTimes.push(now - this.lastFrameTime);
    }
    this.lastFrameTime = now;
  }

  // Called from render loop
  recordBufferSize(size: number): void {
    this.bufferSizes.push(size);
  }

  private report(): void {
    const elapsed = ((Date.now() - this.startTime) / 1000).toFixed(1);
    const total = this.interpCount + this.extrapCount + this.nullCount;

    // Interpolation stats
    const interpPct = total > 0 ? ((this.interpCount / total) * 100).toFixed(1) : "0";
    const extrapPct = total > 0 ? ((this.extrapCount / total) * 100).toFixed(1) : "0";
    const nullPct = total > 0 ? ((this.nullCount / total) * 100).toFixed(1) : "0";

    // Clock offset stability
    const offsetJumps = this.countJumps(this.offsets, 30); // jumps > 30ms
    const offsetRange = this.offsets.length > 1
      ? (Math.max(...this.offsets) - Math.min(...this.offsets)).toFixed(1)
      : "N/A";

    // WS message timing
    const deltaStats = this.getStats(this.stateDeltaIntervals);
    const deltaBursts = this.stateDeltaIntervals.filter((d) => d < 10).length; // messages < 10ms apart = burst

    // Frame timing
    const frameStats = this.getStats(this.frameTimes);
    const longFrames = this.frameTimes.filter((f) => f > 20).length; // > 20ms = dropped frame

    // Buffer
    const bufStats = this.getStats(this.bufferSizes);

    console.log(`[NetProfiler] Report @ ${elapsed}s | INTERP: ${this.interpCount}(${interpPct}%) EXTRAP: ${this.extrapCount}(${extrapPct}%) NULL: ${this.nullCount}(${nullPct}%) | CLOCK: range=${offsetRange}ms jumps>${offsetJumps} | DELTA: mean=${deltaStats.mean}ms std=${deltaStats.std}ms bursts=${deltaBursts} | FRAME: mean=${frameStats.mean}ms long=${longFrames} | BUF: avg=${bufStats.mean} min=${bufStats.min} max=${bufStats.max}`);

    // Reset counters for next window
    this.interpCount = 0;
    this.extrapCount = 0;
    this.nullCount = 0;
    this.offsets = [];
    this.stateDeltaIntervals = [];
    this.frameTimes = [];
    this.bufferSizes = [];
  }

  private getStats(arr: number[]): {
    mean: string;
    std: string;
    min: string;
    max: string;
  } {
    if (arr.length === 0)
      return { mean: "N/A", std: "N/A", min: "N/A", max: "N/A" };
    const sum = arr.reduce((a, b) => a + b, 0);
    const mean = sum / arr.length;
    const variance =
      arr.reduce((a, b) => a + (b - mean) ** 2, 0) / arr.length;
    return {
      mean: mean.toFixed(1),
      std: Math.sqrt(variance).toFixed(1),
      min: Math.min(...arr).toFixed(1),
      max: Math.max(...arr).toFixed(1),
    };
  }

  private countJumps(arr: number[], threshold: number): number {
    let jumps = 0;
    for (let i = 1; i < arr.length; i++) {
      if (Math.abs(arr[i] - arr[i - 1]) > threshold) jumps++;
    }
    return jumps;
  }
}

// Singleton for easy access from multiple files
export const netProfiler = new NetProfiler();
