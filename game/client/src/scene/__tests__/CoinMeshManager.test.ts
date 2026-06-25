import { describe, it, expect, vi, beforeEach } from "vitest";
import { RANK_COLORS, RANK_NONE } from "@coin-pusher/shared";

// ── Module mocks (shared idiom — see leakHarness.ts) ────────────────────

vi.mock("@babylonjs/core", async () => {
  const { createBabylonCoreMock } = await import("./leakHarness");
  return createBabylonCoreMock();
});

vi.mock("../ToonMaterial", async () => {
  const { createToonMaterialMock } = await import("./leakHarness");
  return createToonMaterialMock();
});

// ── Import after mocks ──────────────────────────────────────────────────

import { CoinMeshManager } from "../CoinMeshManager";

// ── Helpers ─────────────────────────────────────────────────────────────

function addCoinToManager(mgr: CoinMeshManager, id: number) {
  mgr.addCoin(id, [0, 0.1, 0], [0, 0, 0, 1]);
  mgr.commitNewCoins();
}

// ── Tests ───────────────────────────────────────────────────────────────

describe("CoinMeshManager — rank highlights", () => {
  let mgr: CoinMeshManager;

  beforeEach(() => {
    mgr = new CoinMeshManager({} as any);
  });

  it("creates 6 rank highlight meshes on init", () => {
    const rankHl = (mgr as any).rankHl;
    expect(rankHl).toHaveLength(RANK_COLORS.length);
    for (let i = 0; i < RANK_COLORS.length; i++) {
      expect(rankHl[i].mesh.name).toBe(`rankHighlight_${i}`);
      expect(rankHl[i].active).toBe(0);
    }
  });

  it("addRankHighlight places coin in correct color buffer", () => {
    addCoinToManager(mgr, 100);
    mgr.addRankHighlight(100, 0);
    const rankHl = (mgr as any).rankHl;
    expect(rankHl[0].idToIndex.has(100)).toBe(true);
    expect(rankHl[0].active).toBe(1);
    expect(rankHl[1].active).toBe(0);
    expect(rankHl[RANK_NONE].active).toBe(0);
  });

  it("addRankHighlight with RANK_NONE places in grey buffer", () => {
    addCoinToManager(mgr, 200);
    mgr.addRankHighlight(200, RANK_NONE);
    const rankHl = (mgr as any).rankHl;
    expect(rankHl[RANK_NONE].idToIndex.has(200)).toBe(true);
    expect(rankHl[RANK_NONE].active).toBe(1);
  });

  it("does not double-add the same coin", () => {
    addCoinToManager(mgr, 100);
    mgr.addRankHighlight(100, 0);
    mgr.addRankHighlight(100, 0);
    const rankHl = (mgr as any).rankHl;
    expect(rankHl[0].active).toBe(1);
  });

  it("removeRankHighlight cleans up from the correct buffer", () => {
    addCoinToManager(mgr, 100);
    addCoinToManager(mgr, 200);
    mgr.addRankHighlight(100, 2);
    mgr.addRankHighlight(200, 4);

    mgr.removeRankHighlight(100);
    const rankHl = (mgr as any).rankHl;
    expect(rankHl[2].active).toBe(0);
    expect(rankHl[4].active).toBe(1);
    expect((mgr as any).coinToColorIndex.has(100)).toBe(false);
  });

  it("defers highlight when coin not yet allocated", () => {
    mgr.addRankHighlight(999, 1);
    const rankHl = (mgr as any).rankHl;
    expect(rankHl[1].active).toBe(0);
    expect(rankHl[1].pending.has(999)).toBe(true);
    expect((mgr as any).coinToColorIndex.get(999)).toBe(1);
  });

  it("flushes pending highlights after commitNewCoins", () => {
    mgr.addRankHighlight(50, 3);
    addCoinToManager(mgr, 50);

    const rankHl = (mgr as any).rankHl;
    expect(rankHl[3].active).toBe(1);
    expect(rankHl[3].pending.has(50)).toBe(false);
  });

  it("expires highlights after HIGHLIGHT_DURATION", () => {
    vi.useFakeTimers();
    const mgr2 = new CoinMeshManager({} as any);
    addCoinToManager(mgr2, 100);
    mgr2.addRankHighlight(100, 0);

    const rankHl = (mgr2 as any).rankHl;
    expect(rankHl[0].active).toBe(1);

    vi.advanceTimersByTime(2100);
    mgr2.updateHighlights();
    expect(rankHl[0].active).toBe(0);
    vi.useRealTimers();
  });

  it("removing a coin cleans up its rank highlight", () => {
    addCoinToManager(mgr, 100);
    mgr.addRankHighlight(100, 0);

    mgr.removeCoin(100);
    const rankHl = (mgr as any).rankHl;
    expect(rankHl[0].active).toBe(0);
    expect((mgr as any).coinToColorIndex.has(100)).toBe(false);
  });

  it("auto-resizes buffer when capacity exceeded", () => {
    for (let i = 0; i < 12; i++) {
      addCoinToManager(mgr, 1000 + i);
      mgr.addRankHighlight(1000 + i, 0);
    }
    const rankHl = (mgr as any).rankHl;
    expect(rankHl[0].active).toBe(12);
    expect(rankHl[0].capacity).toBeGreaterThanOrEqual(12);
  });

  it("clear() resets all rank highlight buffers", () => {
    addCoinToManager(mgr, 100);
    addCoinToManager(mgr, 200);
    mgr.addRankHighlight(100, 0);
    mgr.addRankHighlight(200, RANK_NONE);

    mgr.clear();
    const rankHl = (mgr as any).rankHl;
    for (const hl of rankHl) {
      expect(hl.active).toBe(0);
      expect(hl.idToIndex.size).toBe(0);
      expect(hl.timers.size).toBe(0);
    }
    expect((mgr as any).coinToColorIndex.size).toBe(0);
  });

  it("multiple rank colors work simultaneously", () => {
    for (let i = 0; i < 5; i++) {
      addCoinToManager(mgr, i);
      mgr.addRankHighlight(i, i);
    }
    addCoinToManager(mgr, 99);
    mgr.addRankHighlight(99, RANK_NONE);

    const rankHl = (mgr as any).rankHl;
    for (let i = 0; i < 5; i++) {
      expect(rankHl[i].active).toBe(1);
    }
    expect(rankHl[RANK_NONE].active).toBe(1);
  });
});
