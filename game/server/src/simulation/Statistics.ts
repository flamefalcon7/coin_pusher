/** Per-trial result captured by SimLoop. */
export type TrialResult = {
  coinsInserted: number;       // player coins invested
  frontEdgeCoins: number;      // coins that fell off front edge (revenue)
  leftWallCoins: number;       // coins that entered left wall (slot triggers)
  lostCoins: number;           // coins lost (sides / back)
  bonusCoinsSpawned: number;   // free bonus coins from slot jackpots
  bonusFrontEdge: number;      // bonus coins that scored
  slotSpins: number;           // total slot spins this trial
  slotJackpots: number;        // jackpot wins this trial
};

/** Aggregated simulation report (JSON-serializable). */
export type SimReport = {
  trials: number;
  totalCoinsInserted: number;
  totalFrontEdge: number;
  totalLeftWall: number;
  totalLost: number;
  totalBonusSpawned: number;
  totalBonusFrontEdge: number;
  totalSlotSpins: number;
  totalSlotJackpots: number;
  rtp: number;                  // totalFrontEdge / totalCoinsInserted (includes bonus scores)
  rtpPercent: number;
  ci95Lower: number;            // 95% CI lower bound (%)
  ci95Upper: number;            // 95% CI upper bound (%)
  perTrialRTP: number[];        // individual trial RTPs for distribution analysis
  slotTriggerRate: number;      // leftWallCoins / totalCoinsInserted
  jackpotRate: number;          // jackpots / spins (NaN if no spins)
  bonusRecursionRatio: number;  // bonusFrontEdge / bonusSpawned (p_l_b proxy)
};

export class Statistics {
  private results: TrialResult[] = [];

  addTrial(result: TrialResult): void {
    this.results.push(result);
  }

  /** Generate the final report. */
  report(): SimReport {
    const n = this.results.length;
    if (n === 0) throw new Error("No trials recorded");

    let totalInserted = 0;
    let totalFrontEdge = 0;
    let totalLeftWall = 0;
    let totalLost = 0;
    let totalBonusSpawned = 0;
    let totalBonusFrontEdge = 0;
    let totalSlotSpins = 0;
    let totalSlotJackpots = 0;
    const perTrialRTP: number[] = [];

    for (const r of this.results) {
      totalInserted += r.coinsInserted;
      totalFrontEdge += r.frontEdgeCoins + r.bonusFrontEdge; // revenue includes bonus scores
      totalLeftWall += r.leftWallCoins;
      totalLost += r.lostCoins;
      totalBonusSpawned += r.bonusCoinsSpawned;
      totalBonusFrontEdge += r.bonusFrontEdge;
      totalSlotSpins += r.slotSpins;
      totalSlotJackpots += r.slotJackpots;

      // Per-trial RTP: (front_edge player + bonus front_edge) / player inserted
      const trialRTP = r.coinsInserted > 0
        ? (r.frontEdgeCoins + r.bonusFrontEdge) / r.coinsInserted
        : 0;
      perTrialRTP.push(trialRTP);
    }

    const rtp = totalInserted > 0 ? totalFrontEdge / totalInserted : 0;
    const rtpPercent = rtp * 100;

    // 95% CI using CLT: mean ± 1.96 * (std / sqrt(n))
    const mean = perTrialRTP.reduce((s, v) => s + v, 0) / n;
    const variance = perTrialRTP.reduce((s, v) => s + (v - mean) ** 2, 0) / (n - 1);
    const std = Math.sqrt(variance);
    const se = std / Math.sqrt(n);
    const ci95Lower = (mean - 1.96 * se) * 100;
    const ci95Upper = (mean + 1.96 * se) * 100;

    return {
      trials: n,
      totalCoinsInserted: totalInserted,
      totalFrontEdge,
      totalLeftWall,
      totalLost,
      totalBonusSpawned,
      totalBonusFrontEdge,
      totalSlotSpins,
      totalSlotJackpots,
      rtp,
      rtpPercent,
      ci95Lower,
      ci95Upper,
      perTrialRTP,
      slotTriggerRate: totalInserted > 0 ? totalLeftWall / totalInserted : 0,
      jackpotRate: totalSlotSpins > 0 ? totalSlotJackpots / totalSlotSpins : NaN,
      bonusRecursionRatio: totalBonusSpawned > 0 ? totalBonusFrontEdge / totalBonusSpawned : 0,
    };
  }
}
