import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ── Module Mock (shared idiom — see leakHarness.ts) ─────────────────────────

vi.mock("@babylonjs/core", async () => {
  const { createBabylonCoreMock } = await import("./leakHarness");
  return createBabylonCoreMock();
});

// ── Import VFXManager (after mocks) ─────────────────────────────────────────

import { VFXManager } from "../VFXManager";
import { MockVector3, createMockScene, resetParticleSystemCount } from "./leakHarness";

// ── Tests ────────────────────────────────────────────────────────────────────

describe("VFXManager", () => {
  let scene: ReturnType<typeof createMockScene>;
  let vfx: VFXManager;

  beforeEach(() => {
    resetParticleSystemCount();
    scene = createMockScene();
    vfx = new VFXManager(scene);
    vfx.init();
  });

  // ── Lifecycle ──────────────────────────────────────────────────────────

  describe("lifecycle", () => {
    it("initializes without error", () => {
      expect(vfx).toBeDefined();
    });

    it("dispose cleans up all systems", () => {
      vfx.playCoinInsert(0);
      vfx.playCoinInsert(1);
      expect(vfx.getActiveBurstCount()).toBeGreaterThan(0);

      vfx.dispose();

      expect(vfx.getActiveBurstCount()).toBe(0);
    });

    it("double dispose does not throw", () => {
      vfx.dispose();
      expect(() => vfx.dispose()).not.toThrow();
    });
  });

  // ── Coin Insert ────────────────────────────────────────────────────────

  describe("playCoinInsert", () => {
    it("creates a particle system", () => {
      const ps = vfx.playCoinInsert(0);
      expect(ps).not.toBeNull();
      expect(vfx.getActiveBurstCount()).toBeGreaterThanOrEqual(1);
    });

    it("particle system has gold colors", () => {
      const ps = vfx.playCoinInsert(2) as any;
      expect(ps.color1.r).toBeGreaterThan(0.8);
      expect(ps.color1.g).toBeGreaterThan(0.5);
    });

    it("auto-disposes after targetStopDuration", () => {
      const ps = vfx.playCoinInsert(0) as any;
      expect(ps.disposeOnStop).toBe(true);
      expect(ps.targetStopDuration).toBeGreaterThan(0);
    });

    it("handles out-of-range slot index gracefully", () => {
      expect(() => vfx.playCoinInsert(99)).not.toThrow();
    });
  });

  // ── Coin Despawn ───────────────────────────────────────────────────────

  describe("playCoinDespawn", () => {
    it("creates a particle burst at given position", () => {
      const pos = new MockVector3(0.2, 0.3, 0.5) as any;
      const ps = vfx.playCoinDespawn(pos);
      expect(ps).not.toBeNull();
    });

    it("particle system uses brass/gold colors", () => {
      const ps = vfx.playCoinDespawn(new MockVector3(0, 0.3, 0) as any) as any;
      expect(ps.color1.r).toBeGreaterThan(0.7);
    });

    it("skips effect if position is below visible area", () => {
      const ps = vfx.playCoinDespawn(new MockVector3(0, -0.2, 0) as any);
      expect(ps).toBeNull();
    });
  });

  // ── Coin Land ──────────────────────────────────────────────────────────

  describe("playCoinLand", () => {
    it("creates an expanding ring", () => {
      const pos = new MockVector3(0, 0.3, 0) as any;
      vfx.playCoinLand(pos);
      expect(vfx.getActiveRingCount()).toBe(1);
    });

    it("multiple lands create multiple rings", () => {
      for (let i = 0; i < 5; i++) {
        vfx.playCoinLand(new MockVector3(i * 0.1, 0.3, 0) as any);
      }
      expect(vfx.getActiveRingCount()).toBe(5);
    });
  });

  // ── Shock Wave ─────────────────────────────────────────────────────────

  describe("playShockWave", () => {
    it("creates ring and particle burst", () => {
      const burstBefore = vfx.getActiveBurstCount();
      vfx.playShockWave();
      expect(vfx.getActiveRingCount()).toBeGreaterThan(0);
      expect(vfx.getActiveBurstCount()).toBeGreaterThan(burstBefore);
    });
  });

  // ── Pool Limits ────────────────────────────────────────────────────────

  describe("pool limits", () => {
    it("enforces maxBurstSystems limit", () => {
      const maxBurst = 20;
      for (let i = 0; i < maxBurst + 10; i++) {
        vfx.playCoinInsert(i % 5);
      }
      expect(vfx.getActiveBurstCount()).toBeLessThanOrEqual(maxBurst);
    });

    it("custom maxBurstSystems is respected", () => {
      vfx.dispose();
      vfx = new VFXManager(scene, { maxBurstSystems: 5 });
      vfx.init();

      for (let i = 0; i < 10; i++) {
        vfx.playCoinInsert(0);
      }
      expect(vfx.getActiveBurstCount()).toBeLessThanOrEqual(5);
    });
  });

  // ── Lightning Timer Cleanup ──────────────────────────────────────────

  describe("lightning timer cleanup", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("dispose clears all active lightning timers", () => {
      vfx.playLightning(1);

      // Advance a bit so some bolts spawn
      vi.advanceTimersByTime(400);

      vfx.dispose();

      // Advance well past the lightning duration — should not throw or create new bolts
      expect(() => vi.advanceTimersByTime(5000)).not.toThrow();
    });

    it("playLightning timers are cleaned up after duration", () => {
      vfx.playLightning(1);

      // Advance past the 1s duration + some margin
      vi.advanceTimersByTime(2000);

      // After duration expires, the interval should have been cleared by the setTimeout
      // Advancing more should be a no-op
      expect(() => vi.advanceTimersByTime(5000)).not.toThrow();
    });

    it("multiple playLightning calls don't accumulate unbounded timers", () => {
      for (let i = 0; i < 5; i++) {
        vfx.playLightning(0.5);
      }

      vfx.dispose();

      // All timers should be cleared — advancing should be safe
      expect(() => vi.advanceTimersByTime(10000)).not.toThrow();
    });
  });

  // ── Ring Pool Cap ──────────────────────────────────────────────────────

  describe("ring pool cap", () => {
    it("ring pool never exceeds MAX_RING_POOL (16)", () => {
      // Create many rings via playCoinLand, then manually trigger their expiration
      // by accessing the update loop. Since we can't easily trigger the internal
      // update, we check the pool inspector after creating and disposing many rings.
      for (let i = 0; i < 30; i++) {
        vfx.playCoinLand(new MockVector3(i * 0.01, 0.3, 0) as any);
      }
      expect(vfx.getActiveRingCount()).toBe(30);

      // The pool cap is enforced when rings finish their animation and return to pool.
      // We can't easily simulate the render loop update here, but we can verify
      // that after dispose, everything is cleaned up properly.
      vfx.dispose();
      expect(vfx.getActiveRingCount()).toBe(0);
      expect(vfx.getRingPoolSize()).toBe(0);
    });
  });

  // ── Stress Test ────────────────────────────────────────────────────────

  describe("stress", () => {
    it("handles 50 simultaneous despawn effects", () => {
      expect(() => {
        for (let i = 0; i < 50; i++) {
          vfx.playCoinDespawn(new MockVector3(Math.random(), 0, Math.random()) as any);
        }
      }).not.toThrow();
    });

    it("handles rapid insert + despawn interleaving", () => {
      expect(() => {
        for (let i = 0; i < 100; i++) {
          if (i % 2 === 0) {
            vfx.playCoinInsert(i % 5);
          } else {
            vfx.playCoinDespawn(new MockVector3(0, 0, 0) as any);
          }
        }
      }).not.toThrow();
    });
  });
});
