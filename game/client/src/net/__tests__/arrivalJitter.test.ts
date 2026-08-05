import { describe, it, expect } from "vitest";
import { ArrivalJitter } from "../ArrivalJitter";
import { Interpolator } from "../Interpolator";
import { StateBuffer } from "../StateBuffer";
import { ClockSync } from "../ClockSync";
import { debugConfig } from "../debugConfig";

/**
 * The interpolation delay has to cover how unevenly packets arrive, not just
 * how far away the server is.
 *
 * Measured on a live client 2026-08-05: the server published evenly (verified
 * from inside DigitalOcean — zero gaps over 250ms in 90s), while the browser
 * saw 21 gaps over 250ms with a 678ms worst case. The delay was pinned at its
 * 110ms floor the whole time, because it was computed from RTT alone and this
 * link's RTT was fine. Every gap that outlasted delay + extrapolation (260ms)
 * froze the table: 8 of them in 50 seconds.
 */

/** Drive ArrivalJitter with a scripted sequence of gaps instead of real time. */
function jitterFromGaps(gaps: number[], capacity = 64): ArrivalJitter {
  let t = 1_000_000;
  const j = new ArrivalJitter(capacity, () => t);
  j.record(); // first arrival establishes the baseline, produces no gap
  for (const g of gaps) {
    t += g;
    j.record();
  }
  return j;
}

const repeat = (value: number, n: number) => new Array(n).fill(value);

describe("ArrivalJitter", () => {
  it("reports nothing until it has enough samples to mean anything", () => {
    // A connection that just opened must not drag the delay anywhere on the
    // strength of two or three arrivals.
    const j = jitterFromGaps(repeat(400, 3));
    expect(j.sampleCount()).toBe(3);
    expect(j.p99()).toBe(0);
  });

  it("sizes off the far tail, where the freezes actually are", () => {
    // 98 good arrivals, 2 stalls — the measured shape, where gaps that empty
    // the buffer sit in the top ~2%. A p95 would report a harmless 66ms here
    // and leave both stalls a freeze; only a higher quantile sees them.
    const j = jitterFromGaps([...repeat(66, 98), ...repeat(500, 2)], 100);
    expect(j.p99()).toBeGreaterThanOrEqual(400);
  });

  it("does not let a single outlier pin the measurement", () => {
    // A backgrounded tab or a reconnect produces one enormous gap. If that
    // moved the quantile, the delay would sit at its ceiling for seconds after.
    const j = jitterFromGaps([...repeat(66, 255), 30_000], 256);
    expect(j.p99()).toBeLessThan(200);
  });

  it("forgets old conditions as the window rolls over", () => {
    // Jitter that has passed must stop costing latency.
    const j = jitterFromGaps([...repeat(500, 256), ...repeat(66, 256)], 256);
    expect(j.p99()).toBeLessThan(100);
  });
});

// ---------------------------------------------------------------------------
// The delay itself
// ---------------------------------------------------------------------------

/** ClockSync stand-in with a fixed RTT — isolates the jitter term. */
function fixedRttClock(rtt: number): ClockSync {
  return { getRTT: () => rtt } as unknown as ClockSync;
}

/** Read the private delay the renderer would use. */
const delayOf = (i: Interpolator) =>
  (i as unknown as { getInterpolationDelay(): number }).getInterpolationDelay();

describe("Interpolator delay", () => {
  it("stays at the floor on a clean connection", () => {
    // The fix must not tax clients that do not need it.
    let t = 1_000_000;
    const jitter = new ArrivalJitter(256, () => t);
    const interp = new Interpolator(new StateBuffer(), fixedRttClock(20), jitter);

    for (let i = 0; i < 80; i++) {
      t += 66;
      interp.noteArrival();
    }

    expect(delayOf(interp)).toBe(debugConfig.interpolationDelayBase);
  });

  it("buys enough buffer to ride out the stalls it is seeing", () => {
    // The regression: with the delay derived from RTT alone this returns 110ms,
    // and every one of these 400ms stalls outlasts 110 + 150 extrapolation.
    let t = 1_000_000;
    const jitter = new ArrivalJitter(256, () => t);
    const interp = new Interpolator(new StateBuffer(), fixedRttClock(20), jitter);

    // A link alternating between healthy and stalling — the measured shape.
    for (let i = 0; i < 80; i++) {
      t += i % 5 === 0 ? 400 : 66;
      interp.noteArrival();
    }

    const delay = delayOf(interp);
    const EXTRAPOLATION = 150;

    expect(delay).toBeGreaterThan(debugConfig.interpolationDelayBase);
    expect(
      delay + EXTRAPOLATION,
      "delay plus extrapolation must outlast the stalls actually being observed",
    ).toBeGreaterThanOrEqual(400);
  });

  it("never exceeds the configured ceiling, however bad the link", () => {
    let t = 1_000_000;
    const jitter = new ArrivalJitter(256, () => t);
    const interp = new Interpolator(new StateBuffer(), fixedRttClock(20), jitter);

    for (let i = 0; i < 80; i++) {
      t += 5_000;
      interp.noteArrival();
    }

    expect(delayOf(interp)).toBe(debugConfig.interpolationDelayMax);
  });

  it("rises at once when jitter appears, and comes down only gradually", () => {
    // Rising late means the next stall is still a freeze. Falling fast yanks
    // render time forward, which is visible in its own right.
    let t = 1_000_000;
    const jitter = new ArrivalJitter(256, () => t);
    const interp = new Interpolator(new StateBuffer(), fixedRttClock(20), jitter);

    for (let i = 0; i < 64; i++) {
      t += 400;
      interp.noteArrival();
    }
    const raised = delayOf(interp);
    expect(raised).toBeGreaterThan(debugConfig.interpolationDelayBase);

    // The link recovers. One good arrival must not collapse the delay.
    t += 66;
    interp.noteArrival();
    expect(delayOf(interp)).toBeGreaterThan(raised * 0.9);

    // But sustained recovery does bring it back down.
    for (let i = 0; i < 400; i++) {
      t += 66;
      interp.noteArrival();
    }
    expect(delayOf(interp)).toBe(debugConfig.interpolationDelayBase);
  });

  it("never drops the delay in one visible step when the link recovers", () => {
    // The percentile window alone is not enough here. Once 256 good arrivals
    // roll the jittered ones out, p99 collapses in a single sample — and a
    // delay that falls with it yanks render time forward by hundreds of ms,
    // which is its own visible artefact. The decay is what spreads that out.
    let t = 1_000_000;
    const jitter = new ArrivalJitter(256, () => t);
    const interp = new Interpolator(new StateBuffer(), fixedRttClock(20), jitter);

    for (let i = 0; i < 256; i++) {
      t += 400;
      interp.noteArrival();
    }

    let prev = delayOf(interp);
    let worstDrop = 0;
    for (let i = 0; i < 512; i++) {
      t += 66;
      interp.noteArrival();
      const now = delayOf(interp);
      worstDrop = Math.max(worstDrop, prev - now);
      prev = now;
    }

    expect(worstDrop, "delay must ease down, not snap").toBeLessThan(20);
    // ...and it must actually arrive back at the floor, not merely creep.
    expect(prev).toBe(debugConfig.interpolationDelayBase);
  });

  it("still honours RTT when that is the larger term", () => {
    // The jitter term is an additional floor, not a replacement.
    let t = 1_000_000;
    const jitter = new ArrivalJitter(256, () => t);
    const interp = new Interpolator(new StateBuffer(), fixedRttClock(200), jitter);

    for (let i = 0; i < 80; i++) {
      t += 66;
      interp.noteArrival();
    }

    expect(delayOf(interp)).toBe(200 * debugConfig.interpolationDelayMultiplier);
  });
});
