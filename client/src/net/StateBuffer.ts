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
 */
export class StateBuffer {
  private buffer: (BufferedState | null)[];
  private capacity: number;
  private head: number = 0; // next write index
  private count: number = 0; // number of valid entries

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

  /**
   * Get the ordered array of valid states (oldest first).
   * Only called for interpolation searches — not every frame for all states.
   */
  private getOrdered(): BufferedState[] {
    if (this.count === 0) return [];
    const result: BufferedState[] = [];
    const start =
      this.count < this.capacity
        ? 0
        : this.head; // oldest entry
    for (let i = 0; i < this.count; i++) {
      const idx = (start + i) % this.capacity;
      const entry = this.buffer[idx];
      if (entry) result.push(entry);
    }
    return result;
  }

  getStatesForInterpolation(
    targetTime: number
  ): { before: BufferedState; after: BufferedState } | null {
    if (this.count < 2) return null;

    const ordered = this.getOrdered();

    let before: BufferedState | null = null;
    let after: BufferedState | null = null;

    for (let i = 0; i < ordered.length; i++) {
      const state = ordered[i];
      if (state.serverTime <= targetTime) {
        before = state;
      } else {
        after = state;
        break;
      }
    }

    if (before && after) {
      return { before, after };
    }

    return null;
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
    // Find currentState in ordered list and return the one before it
    const ordered = this.getOrdered();
    for (let i = 1; i < ordered.length; i++) {
      if (ordered[i] === currentState) {
        return ordered[i - 1];
      }
    }
    return null;
  }
}
