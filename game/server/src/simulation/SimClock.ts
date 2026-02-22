/**
 * Virtual clock for simulation — allows advancing time at arbitrary speed.
 * Injected into Pusher via getTime() callback.
 */
export class SimClock {
  private ms: number = 0;

  /** Current virtual time in milliseconds (mimics Date.now()). */
  now(): number {
    return this.ms;
  }

  /** Advance virtual time by deltaMs milliseconds. */
  advance(deltaMs: number): void {
    this.ms += deltaMs;
  }

  /** Reset to zero. */
  reset(): void {
    this.ms = 0;
  }
}
