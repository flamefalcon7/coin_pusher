import { describe, it, expect, beforeEach } from "vitest";
import { StateBuffer, type BufferedState } from "../StateBuffer";

function makeState(serverTime: number, tick = 0, pusherZ = 0): BufferedState {
  return {
    serverTime,
    tick,
    updates: [{ id: 1, pos: [0, 0, 0] as [number, number, number], rot: [0, 0, 0, 1] as [number, number, number, number], vel: [0, 0, 0] as [number, number, number] }],
    pusherZ,
  };
}

describe("StateBuffer", () => {
  let buffer: StateBuffer;

  beforeEach(() => {
    buffer = new StateBuffer(5); // small capacity for easier wrap-around testing
  });

  // ── addState / getBufferSize ──────────────────────────────────────────

  describe("addState", () => {
    it("increments count", () => {
      expect(buffer.getBufferSize()).toBe(0);
      buffer.addState(makeState(100));
      expect(buffer.getBufferSize()).toBe(1);
      buffer.addState(makeState(200));
      expect(buffer.getBufferSize()).toBe(2);
    });

    it("caps at capacity", () => {
      for (let i = 0; i < 10; i++) {
        buffer.addState(makeState(i * 100));
      }
      expect(buffer.getBufferSize()).toBe(5);
    });

    it("wraps around and overwrites oldest", () => {
      // Fill buffer: times 100,200,300,400,500
      for (let i = 1; i <= 5; i++) buffer.addState(makeState(i * 100));
      expect(buffer.getOldestTime()).toBe(100);

      // Add one more — oldest (100) should be evicted
      buffer.addState(makeState(600));
      expect(buffer.getBufferSize()).toBe(5);
      expect(buffer.getOldestTime()).toBe(200);
      expect(buffer.getNewestTime()).toBe(600);
    });
  });

  // ── getStatesForInterpolation ─────────────────────────────────────────

  describe("getStatesForInterpolation", () => {
    it("returns null when buffer has < 2 states", () => {
      expect(buffer.getStatesForInterpolation(100)).toBeNull();
      buffer.addState(makeState(100));
      expect(buffer.getStatesForInterpolation(100)).toBeNull();
    });

    it("finds correct before/after pair", () => {
      buffer.addState(makeState(100));
      buffer.addState(makeState(200));
      buffer.addState(makeState(300));

      const result = buffer.getStatesForInterpolation(150);
      expect(result).not.toBeNull();
      expect(result!.before.serverTime).toBe(100);
      expect(result!.after.serverTime).toBe(200);
    });

    it("finds pair at exact boundary", () => {
      buffer.addState(makeState(100));
      buffer.addState(makeState(200));
      buffer.addState(makeState(300));

      // targetTime exactly on a state — before=that state, after=next
      const result = buffer.getStatesForInterpolation(200);
      expect(result).not.toBeNull();
      expect(result!.before.serverTime).toBe(200);
      expect(result!.after.serverTime).toBe(300);
    });

    it("returns null when targetTime is before all states", () => {
      buffer.addState(makeState(100));
      buffer.addState(makeState(200));

      expect(buffer.getStatesForInterpolation(50)).toBeNull();
    });

    it("returns null when targetTime is after all states", () => {
      buffer.addState(makeState(100));
      buffer.addState(makeState(200));

      expect(buffer.getStatesForInterpolation(250)).toBeNull();
    });

    it("works correctly after ring buffer wraps", () => {
      // Fill: 100,200,300,400,500
      for (let i = 1; i <= 5; i++) buffer.addState(makeState(i * 100));
      // Wrap: add 600,700 — evicts 100,200
      buffer.addState(makeState(600));
      buffer.addState(makeState(700));

      // Buffer now: 300,400,500,600,700
      const result = buffer.getStatesForInterpolation(550);
      expect(result).not.toBeNull();
      expect(result!.before.serverTime).toBe(500);
      expect(result!.after.serverTime).toBe(600);

      // Old times should not be findable
      expect(buffer.getStatesForInterpolation(150)).toBeNull();
    });

    it("reuses result object (same reference)", () => {
      buffer.addState(makeState(100));
      buffer.addState(makeState(200));
      buffer.addState(makeState(300));

      const r1 = buffer.getStatesForInterpolation(150);
      const r2 = buffer.getStatesForInterpolation(250);
      expect(r1).toBe(r2); // same object reference
      // But values updated
      expect(r2!.before.serverTime).toBe(200);
      expect(r2!.after.serverTime).toBe(300);
    });
  });

  // ── getNewestState / getNewestTime / getOldestTime ────────────────────

  describe("getNewestState / times", () => {
    it("returns null/0 when empty", () => {
      expect(buffer.getNewestState()).toBeNull();
      expect(buffer.getNewestTime()).toBe(0);
      expect(buffer.getOldestTime()).toBe(0);
    });

    it("returns correct values with partial fill", () => {
      buffer.addState(makeState(100));
      buffer.addState(makeState(200));

      expect(buffer.getNewestState()!.serverTime).toBe(200);
      expect(buffer.getNewestTime()).toBe(200);
      expect(buffer.getOldestTime()).toBe(100);
    });

    it("returns correct values after wrap", () => {
      for (let i = 1; i <= 7; i++) buffer.addState(makeState(i * 100));

      // capacity=5, so buffer has 300,400,500,600,700
      expect(buffer.getNewestTime()).toBe(700);
      expect(buffer.getOldestTime()).toBe(300);
      expect(buffer.getNewestState()!.serverTime).toBe(700);
    });
  });

  // ── getPreviousState ──────────────────────────────────────────────────

  describe("getPreviousState", () => {
    it("returns null when < 2 states", () => {
      const s = makeState(100);
      buffer.addState(s);
      expect(buffer.getPreviousState(s)).toBeNull();
    });

    it("returns the state before the given state", () => {
      const s1 = makeState(100);
      const s2 = makeState(200);
      const s3 = makeState(300);
      buffer.addState(s1);
      buffer.addState(s2);
      buffer.addState(s3);

      expect(buffer.getPreviousState(s3)).toBe(s2);
      expect(buffer.getPreviousState(s2)).toBe(s1);
    });

    it("returns null when given state is the oldest", () => {
      const s1 = makeState(100);
      const s2 = makeState(200);
      buffer.addState(s1);
      buffer.addState(s2);

      expect(buffer.getPreviousState(s1)).toBeNull();
    });
  });

  // ── clear ─────────────────────────────────────────────────────────────

  describe("clear", () => {
    it("resets buffer completely", () => {
      for (let i = 1; i <= 3; i++) buffer.addState(makeState(i * 100));
      expect(buffer.getBufferSize()).toBe(3);

      buffer.clear();
      expect(buffer.getBufferSize()).toBe(0);
      expect(buffer.getNewestState()).toBeNull();
      expect(buffer.getNewestTime()).toBe(0);
      expect(buffer.getOldestTime()).toBe(0);
      expect(buffer.getStatesForInterpolation(150)).toBeNull();
    });

    it("works correctly after refilling post-clear", () => {
      for (let i = 1; i <= 5; i++) buffer.addState(makeState(i * 100));
      buffer.clear();

      buffer.addState(makeState(1000));
      buffer.addState(makeState(2000));
      expect(buffer.getBufferSize()).toBe(2);
      expect(buffer.getOldestTime()).toBe(1000);

      const result = buffer.getStatesForInterpolation(1500);
      expect(result).not.toBeNull();
      expect(result!.before.serverTime).toBe(1000);
      expect(result!.after.serverTime).toBe(2000);
    });
  });
});
