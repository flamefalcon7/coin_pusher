/**
 * Rolling measure of how unevenly `state_delta` messages arrive.
 *
 * Why this exists: the interpolation delay used to be derived from RTT alone.
 * RTT and jitter are different properties of a link, and this game's problem is
 * the second one — measured from a real client on 2026-08-05, the server
 * published evenly (verified inside DigitalOcean: zero gaps over 250ms in 90s)
 * while the browser saw 21 gaps over 250ms with a 678ms worst case. A link can
 * have a perfectly good RTT and still stall for half a second when a packet is
 * lost and TCP head-of-line blocking holds the stream until the retransmit
 * lands.
 *
 * When a gap outlasts the delay plus the extrapolation window, the renderer has
 * nothing to interpolate toward and the table visibly freezes. Feeding a
 * percentile of recent gaps into the delay is what lets a jittery client buy
 * itself enough buffer to ride them out, while a clean client keeps the low
 * latency it already had.
 *
 * p95 rather than max: one outlier should not pin the delay at its ceiling for
 * the next several seconds. With a 64-sample window a single stall sits at
 * position 64 of 64 and cannot move the 95th percentile, so no special-casing
 * of absurd gaps (backgrounded tab, reconnect) is needed.
 */
export class ArrivalJitter {
  private readonly gaps: number[];
  private readonly capacity: number;
  private readonly now: () => number;

  private writeIdx = 0;
  private filled = 0;
  private lastArrival = 0;

  /** Cached so the per-frame delay read never sorts. Recomputed on arrival. */
  private cachedP99 = 0;

  /** Scratch array for the percentile sort; avoids allocating per arrival. */
  private readonly sortScratch: number[];

  constructor(capacity: number = 256, now: () => number = Date.now) {
    this.capacity = capacity;
    this.gaps = new Array(capacity).fill(0);
    this.sortScratch = new Array(capacity).fill(0);
    this.now = now;
  }

  /** Call once per arriving state_delta. */
  record(): void {
    const t = this.now();

    if (this.lastArrival !== 0) {
      this.gaps[this.writeIdx] = t - this.lastArrival;
      this.writeIdx = (this.writeIdx + 1) % this.capacity;
      if (this.filled < this.capacity) this.filled++;
      this.recomputeP99();
    }

    this.lastArrival = t;
  }

  /**
   * 99th percentile of recent inter-arrival gaps, in ms. Zero until enough
   * samples exist to say anything — callers fall back to their static floor,
   * which is the right behaviour for a connection that just opened.
   *
   * p99 rather than p95 because that is where the freezes actually live. On the
   * link measured 2026-08-05 the p95 was a harmless 133ms while gaps past 260ms
   * — the ones that empty the buffer — occurred 8 times in 50 seconds, i.e. in
   * the top ~2%. Sizing off p95 would have left every one of them a freeze.
   */
  p99(): number {
    return this.cachedP99;
  }

  /** Number of gap samples currently held. Exposed for tests and diagnostics. */
  sampleCount(): number {
    return this.filled;
  }

  private recomputeP99(): void {
    // Too few samples to be meaningful: a couple of arrivals during connection
    // setup should not drive the delay anywhere.
    const MIN_SAMPLES = 8;
    if (this.filled < MIN_SAMPLES) {
      this.cachedP99 = 0;
      return;
    }

    for (let i = 0; i < this.filled; i++) this.sortScratch[i] = this.gaps[i];
    const view = this.sortScratch.slice(0, this.filled);
    view.sort((a, b) => a - b);

    const idx = Math.min(view.length - 1, Math.floor(view.length * 0.99));
    this.cachedP99 = view[idx];
  }
}
