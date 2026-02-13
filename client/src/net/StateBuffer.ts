import type { StateUpdate } from "@coin-pusher/shared";

export interface BufferedState {
  serverTime: number;
  tick: number;
  updates: StateUpdate[];
  pusherZ: number;
}

/**
 * Ring buffer for server state snapshots.
 * O(1) add, no array shifting.
 * Interpolation queries operate directly on the ring buffer
 * using binary search — no temporary arrays are allocated.
 */
export class StateBuffer {
  private buffer: (BufferedState | null)[];
  private capacity: number;
  private head: number = 0; // next write index
  private count: number = 0; // number of valid entries

  // Reusable result object to avoid allocation per frame
  private interpolationResult: { before: BufferedState; after: BufferedState } = {
    before: null!,
    after: null!,
  };

  constructor(capacity: number = 100) {
    this.capacity = capacity;
    this.buffer = new Array(capacity).fill(null);
  }

  addState(state: BufferedState): void {
    this.buffer[this.head] = state;
    this.head = (this.head + 1) % this.capacity;
    if (this.count < this.capacity) {
      this.count++;
    }
  }

  /** Map a logical index (0 = oldest) to the physical ring buffer index. */
  private logicalToPhysical(logicalIdx: number): number {
    const start = this.count < this.capacity ? 0 : this.head;
    return (start + logicalIdx) % this.capacity;
  }

  /** Get a state by logical index (0 = oldest). */
  private getByLogical(logicalIdx: number): BufferedState | null {
    return this.buffer[this.logicalToPhysical(logicalIdx)];
  }

  /**
   * Binary search on the ring buffer to find the pair of states that
   * bracket targetTime. Returns the result through a reusable object
   * so no allocation occurs per frame.
   */
  getStatesForInterpolation(
    targetTime: number
  ): { before: BufferedState; after: BufferedState } | null {
    if (this.count < 2) return null;

    // Binary search: find the last state with serverTime <= targetTime
    let lo = 0;
    let hi = this.count - 1;
    let beforeIdx = -1;

    while (lo <= hi) {
      const mid = (lo + hi) >>> 1;
      const state = this.getByLogical(mid);
      if (state && state.serverTime <= targetTime) {
        beforeIdx = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }

    // Need a valid before and a valid after (beforeIdx + 1)
    if (beforeIdx < 0 || beforeIdx >= this.count - 1) return null;

    const before = this.getByLogical(beforeIdx);
    const after = this.getByLogical(beforeIdx + 1);
    if (!before || !after) return null;

    this.interpolationResult.before = before;
    this.interpolationResult.after = after;
    return this.interpolationResult;
  }

  clear(): void {
    this.buffer.fill(null);
    this.head = 0;
    this.count = 0;
  }

  getBufferSize(): number {
    return this.count;
  }

  getOldestTime(): number {
    if (this.count === 0) return 0;
    const oldestIdx =
      this.count < this.capacity ? 0 : this.head;
    return this.buffer[oldestIdx]?.serverTime ?? 0;
  }

  getNewestTime(): number {
    if (this.count === 0) return 0;
    const newestIdx = (this.head - 1 + this.capacity) % this.capacity;
    return this.buffer[newestIdx]?.serverTime ?? 0;
  }

  getNewestState(): BufferedState | null {
    if (this.count === 0) return null;
    const newestIdx = (this.head - 1 + this.capacity) % this.capacity;
    return this.buffer[newestIdx];
  }

  getPreviousState(currentState: BufferedState): BufferedState | null {
    if (this.count < 2) return null;
    // Walk backwards from newest to find currentState, then return the one before it
    for (let i = this.count - 1; i >= 1; i--) {
      if (this.getByLogical(i) === currentState) {
        return this.getByLogical(i - 1);
      }
    }
    return null;
  }
}
