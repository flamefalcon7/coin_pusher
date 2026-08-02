import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { SponsorManager } from "../SponsorManager.js";

/**
 * Sponsor quotas are billed inventory: a quota of N means an advertiser paid
 * for N coins to appear on the table, and `sponsor_quota_consumed` reports
 * `coins_spawned` back to the billing side when the quota drains.
 *
 * The spawn callback returns null whenever the table is at MAX_ACTIVE_COINS —
 * a normal condition in a busy room, not an error. If the quota were charged
 * anyway, the advertiser would be reported as having received impressions that
 * were never rendered. The quota must be held, not consumed.
 */

const QUOTA_INTERVAL_TICKS = 150; // must match SponsorManager's private constant

function makeNats() {
  const consumed: { quota_id: string; coins_spawned: number }[] = [];
  const spawned: unknown[] = [];
  return {
    consumed,
    spawned,
    publishCoinSpawn: (m: unknown) => spawned.push(m),
    publishSponsorQuotaConsumed: (m: { quota_id: string; coins_spawned: number }) =>
      consumed.push(m),
  };
}

/** Drive `ticks` quota intervals. */
function runIntervals(mgr: SponsorManager, intervals: number) {
  for (let i = 1; i <= intervals; i++) {
    mgr.tick(i * QUOTA_INTERVAL_TICKS);
  }
}

describe("SponsorManager quota accounting", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("does not consume quota when the table refuses the spawn", () => {
    const nats = makeNats();
    const mgr = new SponsorManager(nats as never, () => 0.5);

    // The table is full: every spawn is refused, exactly as GameLoop's
    // atCoinCap() guard does.
    mgr.setSpawnFn(() => null);
    mgr.onSponsorQuota({ quota_id: "q1", sponsor_id: "acme", coin_count: 5 });

    runIntervals(mgr, 20); // far more intervals than the quota has coins

    expect(mgr.pendingQuotas).toHaveLength(1);
    expect(mgr.pendingQuotas[0].remaining).toBe(5);
    // Nothing delivered, so nothing may be reported as delivered.
    expect(nats.consumed).toHaveLength(0);
    expect(nats.spawned).toHaveLength(0);
  });

  it("consumes quota only for coins that actually reached the table", () => {
    const nats = makeNats();
    const mgr = new SponsorManager(nats as never, () => 0.5);

    let nextId = 1;
    let accepting = false;
    mgr.setSpawnFn(() => (accepting ? nextId++ : null));

    mgr.onSponsorQuota({ quota_id: "q1", sponsor_id: "acme", coin_count: 3 });

    // Table full for a while — quota untouched.
    runIntervals(mgr, 5);
    expect(mgr.pendingQuotas[0].remaining).toBe(3);

    // Table drains; the held impressions are now served.
    accepting = true;
    runIntervals(mgr, 5);

    expect(mgr.pendingQuotas).toHaveLength(0);
    expect(nats.consumed).toEqual([{ quota_id: "q1", coins_spawned: 3 }]);
    expect(nats.spawned).toHaveLength(3);
  });

  it("reports coins_spawned equal to the number of coins actually spawned", () => {
    const nats = makeNats();
    const mgr = new SponsorManager(nats as never, () => 0.5);

    let nextId = 1;
    mgr.setSpawnFn(() => nextId++);
    mgr.onSponsorQuota({ quota_id: "q1", sponsor_id: "acme", coin_count: 4 });

    runIntervals(mgr, 10);

    expect(nats.consumed).toHaveLength(1);
    // The billing number must match reality, not the quota's intent.
    expect(nats.consumed[0].coins_spawned).toBe(nats.spawned.length);
  });
});
