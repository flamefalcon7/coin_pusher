import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ── Module mock (shared idiom — see leakHarness.ts) ─────────────────────

vi.mock("@babylonjs/core", async () => {
  const { createBabylonCoreMock } = await import("./leakHarness");
  return createBabylonCoreMock();
});

import { VFXManager } from "../VFXManager";
import { MockVector3, createMockScene, resetParticleSystemCount } from "./leakHarness";

const FIXED_DT = 1 / 60; // frozen clock: one fixed frame step

/**
 * Drive a deterministic VFX sequence with a frozen clock and record the
 * pool-size sequence (burst / active-ring / ring-pool) at each step.
 *
 * Scope: COUNTS only. Per-particle trajectory is NOT asserted — most effects
 * call Math.random() per particle, so only emission/pool counts are
 * reproducible without seeding the client VFX RNG (out of scope; see U10).
 */
function runFrozen(steps: number): number[][] {
  resetParticleSystemCount();
  const vfx = new VFXManager(createMockScene());
  vfx.init();

  // Deterministic effects (no per-call RNG in placement).
  for (let i = 0; i < 5; i++) vfx.playCoinInsert(i % 5);
  for (let i = 0; i < 3; i++) vfx.playCoinLand(new MockVector3(0.1 * i, 0.3, 0) as any);

  const seq: number[][] = [];
  for (let t = 0; t < steps; t++) {
    vfx.stepForTest(FIXED_DT);
    seq.push([vfx.getActiveBurstCount(), vfx.getActiveRingCount(), vfx.getRingPoolSize()]);
  }
  vfx.dispose();
  return seq;
}

describe("VFXManager deterministic (frozen clock)", () => {
  it("reproduces the same pool-size sequence across two runs", () => {
    const a = runFrozen(40);
    const b = runFrozen(40);
    expect(b).toEqual(a);
  });

  it("burst/ring counts at a fixed tick are identical and non-empty", () => {
    const a = runFrozen(5);
    const b = runFrozen(5);
    // Tick 5 (index 4): bursts still alive, rings still mid-animation.
    const [burstsA, ringsA] = a[4];
    const [burstsB, ringsB] = b[4];
    expect(burstsA).toBe(burstsB);
    expect(ringsA).toBe(ringsB);
    expect(burstsA).toBeGreaterThan(0); // not a vacuous all-zero pass
    expect(ringsA).toBeGreaterThan(0);
  });

  it("rings recycle into a capped pool deterministically over the frozen clock", () => {
    // After enough fixed steps, all active rings age out into the pool.
    const seq = runFrozen(60);
    const last = seq[seq.length - 1];
    expect(last[1]).toBe(0); // no active rings remain
    expect(last[2]).toBeLessThanOrEqual(16); // ring pool capped at MAX_RING_POOL
  });

  it("burst pool stays capped under the frozen clock", () => {
    resetParticleSystemCount();
    const run = () => {
      const vfx = new VFXManager(createMockScene());
      vfx.init();
      for (let i = 0; i < 30; i++) vfx.playCoinInsert(i % 5);
      const counts: number[] = [];
      for (let t = 0; t < 10; t++) {
        vfx.stepForTest(FIXED_DT);
        counts.push(vfx.getActiveBurstCount());
      }
      vfx.dispose();
      return counts;
    };
    const a = run();
    const b = run();
    expect(b).toEqual(a);
    expect(Math.max(...a)).toBeLessThanOrEqual(20); // maxBurstSystems
  });

  describe("lightning under fake timers", () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it("spawns a deterministic count of bolts/rings/sparks across runs", () => {
      const run = () => {
        resetParticleSystemCount();
        const vfx = new VFXManager(createMockScene());
        vfx.init();
        vfx.playLightning(1);
        vi.advanceTimersByTime(540); // 3 intervals @ 180ms — no render step yet
        const counts = {
          bursts: vfx.getActiveBurstCount(),
          rings: vfx.getActiveRingCount(),
          bolts: (vfx as any).activeBolts.length,
        };
        vfx.dispose();
        return counts;
      };
      const a = run();
      const b = run();
      // Counts are deterministic even though per-bolt mesh composition uses
      // Math.random (branch count / jitter) — those affect geometry, not counts.
      expect(b).toEqual(a);
      expect(a.bolts).toBe(3);
    });
  });
});
