import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { ClockSync } from "../ClockSync";
import { NETWORK_CONFIG } from "@coin-pusher/shared";

describe("ClockSync", () => {
  let clock: ClockSync;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(10000); // start at t=10000
    clock = new ClockSync();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ── recordStateDeltaTime / getOffset ──────────────────────────────────

  describe("recordStateDeltaTime", () => {
    it("computes offset from single sample", () => {
      // server clock is 50ms ahead of client
      vi.setSystemTime(10000);
      clock.recordStateDeltaTime(10050);
      expect(clock.getOffset()).toBe(50);
    });

    it("uses median, not mean", () => {
      vi.setSystemTime(10000);
      // 5 samples: offsets = [50, 50, 50, 50, 200]
      for (let i = 0; i < 4; i++) {
        clock.recordStateDeltaTime(10050);
      }
      clock.recordStateDeltaTime(10200); // outlier

      // median of [50,50,50,50,200] = 50 (not 80 which would be the mean)
      expect(clock.getOffset()).toBe(50);
    });

    it("caps at 30 samples", () => {
      vi.setSystemTime(10000);
      // Add 35 samples with offset = 100
      for (let i = 0; i < 35; i++) {
        clock.recordStateDeltaTime(10100);
      }
      // Should still work fine — just uses last 30
      expect(clock.getOffset()).toBe(100);
    });

    it("handles outliers via median", () => {
      vi.setSystemTime(10000);
      // 29 samples at offset=50, 1 wild outlier at offset=5000
      for (let i = 0; i < 29; i++) {
        clock.recordStateDeltaTime(10050);
      }
      clock.recordStateDeltaTime(15000); // massive outlier

      // median should still be 50 (29 values of 50 vs 1 value of 5000)
      expect(clock.getOffset()).toBe(50);
    });

    it("converges to new offset after clock jump", () => {
      vi.setSystemTime(10000);
      // Fill 30 samples at offset=50
      for (let i = 0; i < 30; i++) {
        clock.recordStateDeltaTime(10050);
      }
      expect(clock.getOffset()).toBe(50);

      // Now server jumps: 30 new samples at offset=200
      // Each new sample pushes out an old one
      for (let i = 0; i < 30; i++) {
        clock.recordStateDeltaTime(10200);
      }
      // All 30 samples are now 200
      expect(clock.getOffset()).toBe(200);
    });

    it("converges at halfway point (16 new samples of 30)", () => {
      vi.setSystemTime(10000);
      // Fill with offset=50
      for (let i = 0; i < 30; i++) {
        clock.recordStateDeltaTime(10050);
      }

      // Replace 16 of 30 with offset=200
      // Buffer: 14 samples of 50, 16 samples of 200
      // Sorted: [50 x14, 200 x16], median = index 15 = 200
      for (let i = 0; i < 16; i++) {
        clock.recordStateDeltaTime(10200);
      }
      expect(clock.getOffset()).toBe(200);
    });
  });

  // ── getServerTime ─────────────────────────────────────────────────────

  describe("getServerTime", () => {
    it("returns Date.now() + offset", () => {
      vi.setSystemTime(10000);
      clock.recordStateDeltaTime(10050); // offset = 50
      expect(clock.getServerTime()).toBe(10050);
    });

    it("returns Date.now() when no samples (offset=0)", () => {
      vi.setSystemTime(10000);
      expect(clock.getServerTime()).toBe(10000);
    });
  });

  // ── recordPong / getRTT ───────────────────────────────────────────────

  describe("recordPong / getRTT", () => {
    it("returns 0 when no samples", () => {
      expect(clock.getRTT()).toBe(0);
    });

    it("calculates RTT correctly", () => {
      // Client sent ping at t=10000, pong arrives at t=10080
      vi.setSystemTime(10080);
      clock.recordPong(10000, 50000); // serverTime doesn't matter for RTT
      expect(clock.getRTT()).toBe(80);
    });

    it("returns median RTT", () => {
      // 3 pongs with different RTTs
      vi.setSystemTime(10050);
      clock.recordPong(10000, 0); // rtt=50

      vi.setSystemTime(10120);
      clock.recordPong(10060, 0); // rtt=60

      vi.setSystemTime(10500);
      clock.recordPong(10200, 0); // rtt=300 (outlier)

      // sorted RTTs: [50, 60, 300], median index=1 → 60
      expect(clock.getRTT()).toBe(60);
    });

    it("caps samples at RTT_SAMPLES", () => {
      // Add more than RTT_SAMPLES (12)
      for (let i = 0; i < 20; i++) {
        vi.setSystemTime(10000 + (i + 1) * 100);
        clock.recordPong(10000 + i * 100, 0); // each rtt=100
      }
      // Should still return valid RTT
      expect(clock.getRTT()).toBe(100);
    });

    it("does not affect clock offset", () => {
      // Set offset via state_delta
      vi.setSystemTime(10000);
      clock.recordStateDeltaTime(10050); // offset=50
      expect(clock.getOffset()).toBe(50);

      // recordPong should NOT change offset
      vi.setSystemTime(10080);
      clock.recordPong(10000, 99999);
      expect(clock.getOffset()).toBe(50); // unchanged
    });
  });

  // ── shouldSendPing ────────────────────────────────────────────────────

  describe("shouldSendPing", () => {
    it("returns true on first call", () => {
      expect(clock.shouldSendPing()).toBe(true);
    });

    it("returns false before PING_INTERVAL", () => {
      clock.shouldSendPing(); // first call at t=10000
      vi.setSystemTime(10000 + NETWORK_CONFIG.PING_INTERVAL - 1);
      expect(clock.shouldSendPing()).toBe(false);
    });

    it("returns true after PING_INTERVAL", () => {
      clock.shouldSendPing(); // first call at t=10000
      vi.setSystemTime(10000 + NETWORK_CONFIG.PING_INTERVAL);
      expect(clock.shouldSendPing()).toBe(true);
    });

    it("resets timer after returning true", () => {
      clock.shouldSendPing(); // t=10000, returns true
      vi.setSystemTime(10000 + NETWORK_CONFIG.PING_INTERVAL);
      clock.shouldSendPing(); // t=13000, returns true, resets

      // Should be false again immediately after
      vi.setSystemTime(10000 + NETWORK_CONFIG.PING_INTERVAL + 1);
      expect(clock.shouldSendPing()).toBe(false);

      // Should be true after another full interval
      vi.setSystemTime(10000 + NETWORK_CONFIG.PING_INTERVAL * 2);
      expect(clock.shouldSendPing()).toBe(true);
    });
  });
});
