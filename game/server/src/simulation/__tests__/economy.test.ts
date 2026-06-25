import { describe, it, expect } from "vitest";
import { SimLoop, type SimLoopConfig } from "../SimLoop.js";
import { NO_ABILITIES } from "../AbilitySimulator.js";
import { Statistics, type TrialResult } from "../Statistics.js";
import { mulberry32 } from "../Rng.js";

// Reduced config: a full DEFAULT_CONFIG trial runs ~12k+ ticks (~25s each),
// far past vitest's budget. This keeps a single trial to a few seconds while
// still exercising warmup fill -> insert -> front-edge revenue + slot path.
const ECON_CONFIG: Partial<SimLoopConfig> = {
  coinsPerTrial: 50,
  coinInsertIntervalTicks: 60,
  warmupCoins: 120,        // fuller platform => meaningful front-edge revenue
  warmupSettleTicks: 150,
  abilities: NO_ABILITIES,
  drainTimeoutTicks: 400,
};

// Documented RTP band (rationale):
//   Seeded, short-trial harness RTP sits at ~0.5–3% across seeds (measured
//   over seeds 1,2,3,7,11,42,99 → 0.67%..2.67%). This is the *harness* RTP, not
//   the live-game target — short trials give coins little time to spill off the
//   front edge. The band is wide enough to never flake across seeds/builds yet
//   tight enough to catch a gross payout regression: if classifyCoin wrongly
//   counted coins as front-edge revenue, RTP would jump toward ~100%+ and bust
//   the ceiling; a sign/divide bug would go negative/NaN and bust the floor.
const RTP_MIN = 0;
const RTP_MAX = 50;

const SEED = 7;
const TRIALS = 3;

async function runReport(seed: number, trials: number): Promise<ReturnType<Statistics["report"]>> {
  const stats = new Statistics();
  const loop = new SimLoop(ECON_CONFIG, { rng: mulberry32(seed) });
  for (let i = 0; i < trials; i++) {
    stats.addTrial(await loop.runTrial());
  }
  return stats.report();
}

describe("economy / RTP invariant", () => {
  it("aggregate RTP falls within the documented band", async () => {
    const report = await runReport(SEED, TRIALS);
    expect(Number.isFinite(report.rtpPercent)).toBe(true);
    expect(report.rtpPercent).toBeGreaterThanOrEqual(RTP_MIN);
    expect(report.rtpPercent).toBeLessThanOrEqual(RTP_MAX);
  }, 60_000);

  it("seeded payout is reproducible (same seed -> identical revenue/RTP)", async () => {
    const a = await runReport(SEED, 2);
    const b = await runReport(SEED, 2);
    // Deterministic payout — any change to classification/payout logic moves this.
    expect(b.rtpPercent).toBe(a.rtpPercent);
    expect(b.totalFrontEdge).toBe(a.totalFrontEdge);
    expect(b.totalLeftWall).toBe(a.totalLeftWall);
    expect(b.totalLost).toBe(a.totalLost);
  }, 60_000);

  // ── Statistics guards (fast, no physics) ───────────────────────────────────

  it("report() throws on zero trials (no divide-by-zero, explicit guard)", () => {
    expect(() => new Statistics().report()).toThrow(/No trials/);
  });

  it("zero-coin trial does not divide by zero", () => {
    const stats = new Statistics();
    const zeroCoinTrial: TrialResult = {
      coinsInserted: 0,
      frontEdgeCoins: 0,
      leftWallCoins: 0,
      lostCoins: 0,
      bonusCoinsSpawned: 0,
      bonusFrontEdge: 0,
      slotSpins: 0,
      slotJackpots: 0,
    };
    stats.addTrial(zeroCoinTrial);
    const report = stats.report();
    expect(report.rtp).toBe(0);
    expect(Number.isNaN(report.rtpPercent)).toBe(false);
    expect(report.perTrialRTP).toEqual([0]);
    expect(report.slotTriggerRate).toBe(0);
    // No spins -> jackpotRate is NaN by design (documented in Statistics).
    expect(Number.isNaN(report.jackpotRate)).toBe(true);
  });
});
