import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ── Module mock (shared idiom — see leakHarness.ts) ─────────────────────

vi.mock("@babylonjs/core", async () => {
  const { createBabylonCoreMock } = await import("./leakHarness");
  return createBabylonCoreMock();
});

import { VFXManager } from "../VFXManager";
import { MockVector3, createMockScene, resetParticleSystemCount } from "./leakHarness";

const MAX_BURST = 20; // VFXManager DEFAULT_CONFIG.maxBurstSystems

describe("VFXManager leak", () => {
  let vfx: VFXManager;

  beforeEach(() => {
    resetParticleSystemCount();
    vfx = new VFXManager(createMockScene());
    vfx.init();
  });

  it("burst pool stays capped at maxBurstSystems across 100 bursts", () => {
    for (let i = 0; i < 100; i++) {
      vfx.playCoinInsert(i % 5);
      vfx.playCoinDespawn(new MockVector3(0.1 * (i % 3), 0.3, 0.1) as any);
      // Invariant must hold at every step, not just at the end.
      expect(vfx.getActiveBurstCount()).toBeLessThanOrEqual(MAX_BURST);
    }
    expect(vfx.getActiveBurstCount()).toBeLessThanOrEqual(MAX_BURST);
  });

  it("ring pool stays capped after many lands", () => {
    for (let i = 0; i < 100; i++) {
      vfx.playCoinLand(new MockVector3(0.01 * i, 0.3, 0) as any);
    }
    // Active rings are recycled into a capped pool; pool size never exceeds cap.
    expect(vfx.getRingPoolSize()).toBeLessThanOrEqual(16); // MAX_RING_POOL
  });

  it("dispose removes the render observer and clears all timers", () => {
    const scene = (vfx as any).scene;
    // Fire a timer-driven effect so activeTimers is non-empty before dispose.
    vi.useFakeTimers();
    vfx.playLightning(1);
    vi.advanceTimersByTime(400);
    expect((vfx as any).activeTimers.length).toBeGreaterThan(0);

    vfx.dispose();

    expect((vfx as any).renderObserver).toBeNull();
    expect((vfx as any).activeTimers.length).toBe(0);
    expect(vfx.getActiveBurstCount()).toBe(0);
    expect(vfx.getActiveRingCount()).toBe(0);
    expect(vfx.getRingPoolSize()).toBe(0);
    expect(scene.onBeforeRenderObservable.remove).toHaveBeenCalled();

    // No bolts spawn after dispose.
    expect(() => vi.advanceTimersByTime(5000)).not.toThrow();
    vi.useRealTimers();
  });

  it("dispose with zero effects fired does not throw or leave negative counts", () => {
    expect(() => vfx.dispose()).not.toThrow();
    expect(vfx.getActiveBurstCount()).toBe(0);
    expect((vfx as any).renderObserver).toBeNull();
    expect((vfx as any).activeTimers.length).toBe(0);
  });

  afterEach(() => {
    vi.useRealTimers();
  });
});
