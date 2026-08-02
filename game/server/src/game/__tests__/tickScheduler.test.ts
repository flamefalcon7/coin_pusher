import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { TickScheduler } from "../TickScheduler.js";
import { PHYSICS_CONFIG } from "@coin-pusher/shared";

/**
 * Acceptance test for fixed-timestep drift correction.
 *
 * The failure this guards against is silent: `setInterval(tick, 33.33)` fires
 * late by a millisecond or two on every iteration, nothing ever repays that
 * time, and after ten minutes the simulation is seconds behind the wall clock
 * with no single tick ever having looked slow.
 *
 * Time is injected as nanosecond timestamps so the assertions are exact and the
 * suite does not spend ten real minutes proving a ten-minute property.
 */

const DT = PHYSICS_CONFIG.TICK_INTERVAL; // ~33.333ms — not a whole number of ns

/**
 * Milliseconds to nanosecond timestamps. Rounds *up*, so a timestamp meant to
 * represent "one whole dt has passed" is never a fraction of a nanosecond
 * short of it — an artifact of the test clock, not of the scheduler.
 */
const ns = (ms: number) => BigInt(Math.ceil(ms * 1e6));

/** Start a scheduler with the clock pinned at t=0. */
function makeScheduler(onTick: (emitState: boolean) => void = () => {}) {
  const sched = new TickScheduler((opts) => onTick(opts.emitState));
  vi.spyOn(process.hrtime, "bigint").mockReturnValue(0n);
  sched.start();
  return sched;
}

describe("TickScheduler fixed timestep", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("keeps simulated ticks within 0.5% of wall clock despite every firing being late", () => {
    let ticks = 0;
    const sched = makeScheduler(() => ticks++);

    // Ten simulated minutes of a timer that is consistently 2ms late — the
    // realistic Node behaviour that a naive loop turns into permanent drift.
    const LATE_MS = 2;
    const firings = Math.floor((10 * 60 * 1000) / (DT + LATE_MS));

    let nowMs = 0;
    for (let i = 0; i < firings; i++) {
      nowMs += DT + LATE_MS;
      sched.pump(ns(nowMs));
    }

    const expected = nowMs / DT;
    const driftPct = Math.abs(ticks - expected) / expected * 100;

    expect(ticks).toBeGreaterThan(0);
    expect(driftPct).toBeLessThan(0.5);
  });

  it("a naive fixed-count loop would have drifted — the test is not vacuous", () => {
    // Same 2ms-late timer, but counting one tick per firing (the old behaviour).
    const LATE_MS = 2;
    const firings = Math.floor((10 * 60 * 1000) / (DT + LATE_MS));
    const elapsedMs = firings * (DT + LATE_MS);

    const naiveTicks = firings;
    const expected = elapsedMs / DT;
    const naiveDriftPct = Math.abs(naiveTicks - expected) / expected * 100;

    // ~5.7% behind — an order of magnitude past the budget the fix must hit.
    expect(naiveDriftPct).toBeGreaterThan(5);
  });

  it("carries the sub-step remainder instead of discarding it", () => {
    let ticks = 0;
    const sched = makeScheduler(() => ticks++);

    // Firings smaller than dt must eventually add up to whole steps.
    let nowMs = 0;
    for (let i = 0; i < 300; i++) {
      nowMs += DT / 3;
      sched.pump(ns(nowMs));
    }

    // 300 x dt/3 is 100 whole steps. A loop that discarded the sub-step
    // remainder on each firing would have run zero.
    expect(ticks).toBeGreaterThanOrEqual(99);
    expect(ticks).toBeLessThanOrEqual(100);
  });

  it("emits network state exactly once per firing, on the last catch-up step", () => {
    const emits: boolean[] = [];
    const sched = makeScheduler((emitState) => emits.push(emitState));

    // One firing worth 3 steps of debt.
    sched.pump(ns(DT * 3));

    expect(emits).toEqual([false, false, true]);
  });

  it("caps catch-up and drops the debt rather than spiralling", () => {
    let ticks = 0;
    const sched = makeScheduler(() => ticks++);

    // A 10-second stall: 300 ticks owed. Replaying them all would take longer
    // than the stall and dig the hole deeper.
    sched.pump(ns(10_000));

    const stats = sched.getStats(ns(10_000));
    expect(ticks).toBe(5); // MAX_CATCHUP_STEPS
    expect(stats.spiralEvents).toBe(1);
    expect(stats.droppedMs).toBeGreaterThan(9_000);

    // And it recovers cleanly: the next normal firing produces one step, not a
    // backlog replay.
    ticks = 0;
    sched.pump(ns(10_000 + DT));
    expect(ticks).toBe(1);
  });

  /**
   * The rest of this file drives pump() by hand, which proves the accumulator
   * maths but never touches start()'s own wiring. Measured: reverting start()
   * to the old `setInterval(this.callback, ...)` — no accumulator, no
   * catch-up — left every other test in this file green. These two use fake
   * timers so the production path is actually exercised.
   */
  it("drives the callback from its own timer, and catches up within one firing", () => {
    vi.useFakeTimers();
    try {
      let ticks = 0;
      let nowNs = 0n;
      vi.spyOn(process.hrtime, "bigint").mockImplementation(() => nowNs);

      const sched = new TickScheduler(() => ticks++);
      sched.start();

      // One timer firing, but three ticks' worth of real time has passed — the
      // shape of a stall. Only an accumulator repays that debt; a scheduler
      // wired straight to setInterval runs the callback once per firing no
      // matter how much time went by, which is the regression this pins.
      //
      // (Asserting drift over many firings cannot distinguish the two here:
      // vitest's fake setInterval replays its own missed firings, masking it.)
      nowNs += ns(DT * 3);
      vi.advanceTimersByTime(DT);

      expect(ticks).toBe(3);

      sched.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops firing after stop()", () => {
    vi.useFakeTimers();
    try {
      let ticks = 0;
      let nowNs = 0n;
      vi.spyOn(process.hrtime, "bigint").mockImplementation(() => nowNs);

      const sched = new TickScheduler(() => ticks++);
      sched.start();

      for (let i = 0; i < 10; i++) {
        nowNs += ns(DT);
        vi.advanceTimersByTime(DT);
      }
      const before = ticks;
      expect(before).toBeGreaterThan(0); // the timer really was firing

      sched.stop();
      expect(sched.isRunning()).toBe(false);

      for (let i = 0; i < 10; i++) {
        nowNs += ns(DT);
        vi.advanceTimersByTime(DT);
      }
      expect(ticks).toBe(before); // and really stopped
    } finally {
      vi.useRealTimers();
    }
  });

  it("counts catch-up steps separately from normal ones", () => {
    const sched = makeScheduler();

    sched.pump(ns(DT)); // 1 step, no catch-up
    sched.pump(ns(DT * 4)); // 3 steps, 2 of them catch-up

    const stats = sched.getStats(ns(DT * 4));
    expect(stats.ticksRun).toBe(4);
    expect(stats.catchUpSteps).toBe(2);
    expect(stats.spiralEvents).toBe(0);
  });
});
