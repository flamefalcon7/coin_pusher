import { PHYSICS_CONFIG } from '@coin-pusher/shared';

/**
 * Fixed-timestep scheduler with drift correction.
 *
 * `setInterval` only promises "not earlier than" — never "on time". A plain
 * `setInterval(tick, 33.33)` therefore runs slower than 30Hz by however much
 * the runtime, GC and the tick's own work delay each firing, and the loss is
 * permanent: nothing ever gives the time back. Over minutes the simulation
 * clock falls behind the wall clock without any single tick looking late.
 *
 * The accumulator pattern fixes that by measuring real elapsed time and
 * spending it in whole fixed steps, carrying the remainder forward. Physics
 * still advances by a constant dt (required for a stable solver), but the
 * *number* of steps adapts so simulated time tracks real time.
 *
 * Two things this deliberately does NOT do:
 *
 * 1. Unbounded catch-up. After a long stall, replaying every missed tick would
 *    take longer than the stall itself and dig the hole deeper — the classic
 *    spiral of death. Catch-up is capped at MAX_CATCHUP_STEPS; beyond that we
 *    drop the debt, log it, and accept a discontinuity in simulated time.
 * 2. Emit network state on every catch-up step. Clients interpolate against
 *    wall-clock arrival, so firing several state snapshots in the same
 *    millisecond makes them jump. Only the final step of a burst is flagged
 *    `emitState`; the intermediate steps advance physics silently.
 */

/** Called once per fixed step. `emitState` marks the last step of a burst. */
export type TickFn = (opts: { emitState: boolean }) => void;

export interface TickSchedulerStats {
  /** Fixed steps executed since start(). */
  ticksRun: number;
  /** Steps that ran as catch-up (i.e. beyond the first step of a firing). */
  catchUpSteps: number;
  /** Times the catch-up cap was hit and accumulated debt was discarded. */
  spiralEvents: number;
  /** Simulated time debt discarded by those events, in milliseconds. */
  droppedMs: number;
  /** Real milliseconds elapsed since start(). */
  elapsedMs: number;
}

export class TickScheduler {
  private readonly callback: TickFn;
  private readonly fixedDtMs: number;
  private intervalId?: NodeJS.Timeout;
  private running: boolean = false;

  private accumulatorMs: number = 0;
  private lastTimeNs: bigint = 0n;
  private startTimeNs: bigint = 0n;

  private ticksRun: number = 0;
  private catchUpSteps: number = 0;
  private spiralEvents: number = 0;
  private droppedMs: number = 0;

  /**
   * At 30Hz this is ~166ms of catch-up. Large enough to absorb a GC pause or a
   * slow tick, small enough that recovery never costs more than a few frames.
   */
  private static readonly MAX_CATCHUP_STEPS = 5;

  constructor(callback: TickFn, fixedDtMs: number = PHYSICS_CONFIG.TICK_INTERVAL) {
    this.callback = callback;
    this.fixedDtMs = fixedDtMs;
  }

  start(): void {
    if (this.running) return;

    this.running = true;
    this.accumulatorMs = 0;
    this.ticksRun = 0;
    this.catchUpSteps = 0;
    this.spiralEvents = 0;
    this.droppedMs = 0;
    this.startTimeNs = process.hrtime.bigint();
    this.lastTimeNs = this.startTimeNs;

    this.intervalId = setInterval(() => this.pump(), this.fixedDtMs);
    console.log(
      `⏱️  Tick scheduler started at ${PHYSICS_CONFIG.TICK_RATE}Hz ` +
        `(fixed dt ${this.fixedDtMs.toFixed(2)}ms, catch-up cap ${TickScheduler.MAX_CATCHUP_STEPS})`,
    );
  }

  stop(): void {
    if (!this.running) return;

    this.running = false;
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = undefined;
    }
    console.log('⏱️  Tick scheduler stopped');
  }

  isRunning(): boolean {
    return this.running;
  }

  /**
   * Advance the scheduler using real elapsed time. Exposed so tests can drive
   * it with an injected clock instead of waiting on real timers.
   */
  pump(nowNs: bigint = process.hrtime.bigint()): void {
    const elapsedMs = Number(nowNs - this.lastTimeNs) / 1e6;
    this.lastTimeNs = nowNs;
    this.accumulatorMs += elapsedMs;

    const owed = Math.floor(this.accumulatorMs / this.fixedDtMs);
    if (owed <= 0) return;

    const steps = Math.min(owed, TickScheduler.MAX_CATCHUP_STEPS);

    for (let i = 0; i < steps; i++) {
      this.accumulatorMs -= this.fixedDtMs;
      this.ticksRun++;
      if (i > 0) this.catchUpSteps++;
      // Network state is emitted only once per firing, on the final step.
      this.callback({ emitState: i === steps - 1 });
    }

    if (owed > steps) {
      // Debt we are choosing not to repay. Dropping it is what prevents the
      // spiral; recording it is what makes the gap visible afterwards.
      this.spiralEvents++;
      this.droppedMs += this.accumulatorMs;
      this.accumulatorMs = 0;
      console.warn(
        `⚠️  Tick catch-up capped at ${steps} steps (${owed} owed) — ` +
          `dropped simulated time to avoid a spiral. Total spiral events: ${this.spiralEvents}`,
      );
    }
  }

  getStats(nowNs: bigint = process.hrtime.bigint()): TickSchedulerStats {
    return {
      ticksRun: this.ticksRun,
      catchUpSteps: this.catchUpSteps,
      spiralEvents: this.spiralEvents,
      droppedMs: this.droppedMs,
      elapsedMs: this.startTimeNs === 0n ? 0 : Number(nowNs - this.startTimeNs) / 1e6,
    };
  }
}
