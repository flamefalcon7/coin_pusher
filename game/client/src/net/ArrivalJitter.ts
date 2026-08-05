/**
 * Rolling measure of how unevenly `state_delta` messages arrive.
 *
 * Why this exists: the interpolation delay used to be derived from RTT alone,
 * and RTT does not see jitter. Measured from a real client on 2026-08-05, the
 * server published evenly (verified inside DigitalOcean: zero gaps over 250ms
 * in 90s, both direct and through nginx) while the browser over the public
 * internet saw 21 gaps over 250ms with a 678ms worst case — the signature of a
 * lost packet holding the stream until TCP retransmits. Same p50 either way;
 * the whole difference is in the tail.
 *
 * When a gap outlasts the delay plus the extrapolation window, the renderer has
 * nothing to interpolate toward and the table visibly freezes.
 *
 * Honest scope, measured after deploying this: on THAT link the RTT was ~200ms,
 * so `RTT × 1.5` already produced a 288ms delay and covered most of the tail on
 * its own — adding this term moved tolerance 438ms → 479ms and the freeze rate
 * from roughly 3/min to 2/min. It is not a dramatic win there. It matters on
 * the case RTT cannot see at all: a nearby server (low RTT, so a low delay) on
 * a lossy last mile, where nothing else would buy the buffer.
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
   * p99 rather than p95 because that is where the buffer-emptying gaps live. On
   * the link measured 2026-08-05 the p95 was 133ms — inside what the delay
   * already covered — while the gaps that actually outlast delay plus
   * extrapolation sat in the top ~2% (p99 242ms, max 626ms). Sizing off p95
   * would have measured the harmless part of the distribution.
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
