import type { StateUpdate } from '@coin-pusher/shared';

export interface BufferedState {
  serverTime: number;
  tick: number;
  updates: StateUpdate[];
  pusherZ: number;
}

export class StateBuffer {
  private buffer: BufferedState[] = [];
  private maxBufferSize: number = 100; // Keep last 100 states (~3 seconds at 30Hz)

  addState(state: BufferedState): void {
    this.buffer.push(state);

    // Keep buffer size manageable
    if (this.buffer.length > this.maxBufferSize) {
      this.buffer.shift();
    }
  }

  getStateAtTime(targetTime: number): BufferedState | null {
    if (this.buffer.length === 0) return null;

    // Find two states to interpolate between
    let before: BufferedState | null = null;
    let after: BufferedState | null = null;

    for (let i = 0; i < this.buffer.length; i++) {
      const state = this.buffer[i];
      
      if (state.serverTime <= targetTime) {
        before = state;
      } else {
        after = state;
        break;
      }
    }

    // If we only have states in the future, use the earliest one
    if (!before && after) {
      return after;
    }

    // If we only have states in the past, use the latest one
    if (before && !after) {
      return before;
    }

    // If we have both, return the one before (interpolation happens in Interpolator)
    if (before && after) {
      return before;
    }

    return null;
  }

  getStatesForInterpolation(targetTime: number): { before: BufferedState; after: BufferedState } | null {
    if (this.buffer.length < 2) return null;

    let before: BufferedState | null = null;
    let after: BufferedState | null = null;

    for (let i = 0; i < this.buffer.length; i++) {
      const state = this.buffer[i];
      
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
    this.buffer = [];
  }

  getBufferSize(): number {
    return this.buffer.length;
  }

  getOldestTime(): number {
    if (this.buffer.length === 0) return 0;
    return this.buffer[0].serverTime;
  }

  getNewestTime(): number {
    if (this.buffer.length === 0) return 0;
    return this.buffer[this.buffer.length - 1].serverTime;
  }
}

