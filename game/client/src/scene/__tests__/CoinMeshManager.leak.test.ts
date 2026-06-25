import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Module mocks (shared idiom — see leakHarness.ts) ────────────────────

vi.mock("@babylonjs/core", async () => {
  const { createBabylonCoreMock } = await import("./leakHarness");
  return createBabylonCoreMock();
});

vi.mock("../ToonMaterial", async () => {
  const { createToonMaterialMock } = await import("./leakHarness");
  return createToonMaterialMock();
});

import { CoinMeshManager } from "../CoinMeshManager";
import {
  createMockScene,
  snapshotPoolCounters,
  expectCountersWithin,
} from "./leakHarness";

// Private maps/sets whose size must return to baseline after despawn.
const TRACKED_FIELDS = [
  "idToIndex",
  "kcIdToIndex",
  "keyCoinIds",
  "coinSponsorLookup",
  "spawnAnims",
  "coinToColorIndex",
];

const SPONSOR_ID = "acme";

describe("CoinMeshManager leak", () => {
  let mgr: CoinMeshManager;

  beforeEach(() => {
    mgr = new CoinMeshManager(createMockScene());
    mgr.createSponsorCoinPrototype(SPONSOR_ID, "#ff8800", "logo.png");
  });

  it("returns to baseline after 500 spawn/despawn cycles (regular + key + sponsor)", () => {
    const baseline = snapshotPoolCounters(mgr, TRACKED_FIELDS);

    for (let i = 0; i < 500; i++) {
      const regId = i;
      const keyId = 1_000_000 + i;
      const sponId = 2_000_000 + i;

      mgr.addCoin(regId, [0, 0.1, 0], [0, 0, 0, 1]);
      mgr.addCoin(keyId, [0.1, 0.1, 0], [0, 0, 0, 1], true);
      mgr.addCoin(sponId, [0.2, 0.1, 0], [0, 0, 0, 1], false, SPONSOR_ID);
      mgr.commitNewCoins();
      mgr.updateInstances();

      mgr.removeCoin(regId);
      mgr.removeCoin(keyId);
      mgr.removeCoin(sponId);
      mgr.updateInstances();
    }

    // Counters must return to baseline BEFORE dispose() — dispose()'s clear()
    // would otherwise mask a forgot-to-unpool leak. This is the assertion that
    // fails if a removeCoin path is skipped.
    const after = snapshotPoolCounters(mgr, TRACKED_FIELDS);
    expectCountersWithin(baseline, after, 1);
    expect(mgr.getCoinCount()).toBe(0);
    expect((mgr as any).spawnAnims.size).toBe(0);

    expect(() => mgr.dispose()).not.toThrow();
  });

  it("dispose after spawn with zero despawns leaves no orphan/negative counts", () => {
    for (let i = 0; i < 50; i++) {
      mgr.addCoin(i, [0, 0.1, 0], [0, 0, 0, 1]);
    }
    mgr.commitNewCoins();
    mgr.updateInstances();
    expect(mgr.getCoinCount()).toBe(50);

    expect(() => mgr.dispose()).not.toThrow();
    // clear() zeroes everything; no negative counts.
    expect(mgr.getCoinCount()).toBe(0);
    expect((mgr as any).idToIndex.size).toBe(0);
  });

  it("rank highlights spawned and removed return to baseline", () => {
    const baseline = snapshotPoolCounters(mgr, TRACKED_FIELDS);

    for (let i = 0; i < 200; i++) {
      mgr.addCoin(i, [0, 0.1, 0], [0, 0, 0, 1]);
      mgr.commitNewCoins();
      mgr.addRankHighlight(i, i % 5);
      mgr.removeCoin(i); // removeCoin must also clean the highlight
    }

    const after = snapshotPoolCounters(mgr, TRACKED_FIELDS);
    expectCountersWithin(baseline, after, 1);
    expect((mgr as any).coinToColorIndex.size).toBe(0);
    for (const hl of (mgr as any).rankHl) {
      expect(hl.active).toBe(0);
      expect(hl.idToIndex.size).toBe(0);
      expect(hl.timers.size).toBe(0);
    }
  });
});
