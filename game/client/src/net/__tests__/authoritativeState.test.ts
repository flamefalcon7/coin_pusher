import { describe, it, expect } from "vitest";
import { toAuthoritativeState } from "../authoritativeState";
import type { BufferedState } from "../StateBuffer";

describe("toAuthoritativeState", () => {
  it("returns null for a null newest state (before the first snapshot)", () => {
    expect(toAuthoritativeState(null)).toBeNull();
  });

  it("maps serverTime, pusherZ, and updates→coins by the exact field names", () => {
    const newest: BufferedState = {
      serverTime: 12345,
      tick: 42,
      pusherZ: -0.02,
      updates: [
        { id: 1, pos: [0.1, 0.3, 0.0], rot: [0, 0, 0, 1] },
        { id: 2, pos: [-0.2, 0.28, 0.05], rot: [0, 1, 0, 0] },
      ],
    };

    const state = toAuthoritativeState(newest);

    expect(state).not.toBeNull();
    expect(state!.serverTime).toBe(12345);
    expect(state!.pusherZ).toBeCloseTo(-0.02);
    // coins is the raw updates array — this is the R1/R3 physics ground truth.
    expect(state!.coins).toBe(newest.updates);
    expect(state!.coins.map((c) => c.id)).toEqual([1, 2]);
  });

  it("carries an empty coin list through without inventing entries", () => {
    const newest: BufferedState = { serverTime: 1, tick: 0, pusherZ: 0, updates: [] };
    expect(toAuthoritativeState(newest)).toEqual({ serverTime: 1, pusherZ: 0, coins: [] });
  });
});
