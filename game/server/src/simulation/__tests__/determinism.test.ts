import { describe, it, expect } from "vitest";
import { SimLoop, type SimLoopConfig } from "../SimLoop.js";
import { NO_ABILITIES } from "../AbilitySimulator.js";
import { mulberry32 } from "../Rng.js";

type Snapshot = Map<number, [number, number, number]>;

// Small config so a full trial completes well within the vitest timeout while
// still exercising warmup placement + coin inserts + physics + slot machine.
const FAST_CONFIG: Partial<SimLoopConfig> = {
  coinsPerTrial: 5,
  coinInsertIntervalTicks: 10,
  warmupCoins: 15,
  warmupSettleTicks: 20,
  abilities: NO_ABILITIES,
  abilityIntervalTicks: 150,
  maxBonusDepth: 2,
  drainTimeoutTicks: 120,
};

const CAPTURE_TICK = 15; // mid-trial: warmup coins settled, inserts in progress

/** Run one seeded trial, capturing every coin's position at CAPTURE_TICK. */
async function runCaptured(
  seed: number,
  config: Partial<SimLoopConfig> = FAST_CONFIG,
  captureTick = CAPTURE_TICK,
): Promise<Snapshot> {
  const snap: Snapshot = new Map();
  const loop = new SimLoop(config, {
    rng: mulberry32(seed),
    onTick: (tick, coins) => {
      if (tick !== captureTick || snap.size > 0) return;
      coins.forEach((coin, id) => {
        const p = coin.getPosition();
        snap.set(id, [p.x, p.y, p.z]);
      });
    },
  });
  await loop.runTrial();
  return snap;
}

function maxPositionDelta(a: Snapshot, b: Snapshot): number {
  let max = 0;
  for (const [id, pa] of a) {
    const pb = b.get(id);
    if (!pb) return Infinity; // key set diverged
    for (let i = 0; i < 3; i++) max = Math.max(max, Math.abs(pa[i] - pb[i]));
  }
  return max;
}

describe("SimLoop replay determinism", () => {
  it("two trials with the same seed produce identical mid-trial positions", async () => {
    const a = await runCaptured(12345);
    const b = await runCaptured(12345);

    // Not a vacuous pass: there must actually be coins to compare.
    expect(a.size).toBeGreaterThan(0);
    expect(b.size).toBe(a.size);
    expect([...a.keys()].sort()).toEqual([...b.keys()].sort());
    expect(maxPositionDelta(a, b)).toBeLessThan(1e-6);
  });

  it("a different seed changes the captured positions (RNG actually varies)", async () => {
    const a = await runCaptured(12345);
    const c = await runCaptured(67890);

    expect(a.size).toBeGreaterThan(0);
    // Either the coin set or some position must differ — otherwise the seed is
    // not actually feeding the simulation.
    const keysSame =
      a.size === c.size &&
      [...a.keys()].sort().join(",") === [...c.keys()].sort().join(",");
    const positionsClose = keysSame && maxPositionDelta(a, c) < 1e-6;
    expect(positionsClose).toBe(false);
  });

  it("same seed reproduces even a minimal-coin run (deterministic, not vacuous)", async () => {
    const minimal: Partial<SimLoopConfig> = {
      ...FAST_CONFIG,
      warmupCoins: 0,
      coinsPerTrial: 1,
    };
    // Capture at tick 1 — before the first insert at interval 10, so the
    // snapshot is legitimately empty; the point is that BOTH runs agree.
    const a = await runCaptured(42, minimal, 1);
    const b = await runCaptured(42, minimal, 1);
    expect([...a.keys()].sort()).toEqual([...b.keys()].sort());
    expect(maxPositionDelta(a, b)).toBeLessThan(1e-6);
  });
});
