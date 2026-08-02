import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { GameLoop } from "../GameLoop.js";
import { GameState } from "../GameState.js";
import { CoinManager } from "../CoinManager.js";
import { DropScheduler } from "../DropScheduler.js";
import { PhysicsWorld } from "../../physics/PhysicsWorld.js";
import { SceneBuilder } from "../../physics/SceneBuilder.js";
import { Pusher } from "../../physics/Pusher.js";
import { SimClock } from "../../simulation/SimClock.js";
import { COIN_CONFIG, RATE_LIMIT_CONFIG } from "@coin-pusher/shared";

/**
 * Acceptance test for the hard body cap.
 *
 * Physics cost grows with live body count, so MAX_ACTIVE_COINS is what keeps a
 * busy room inside the 33.3ms tick budget. It only works if *every* spawn path
 * consults it — coin_insert, spawn_stack, sponsor coins, bonus rain and the
 * operator fill command all create bodies.
 *
 * The queue-preservation case matters just as much: coins waiting in
 * DropScheduler have already been paid for. Hitting the cap must delay them,
 * never consume them.
 */

function makeNatsStub() {
  const noop = () => {};
  const spawnedOwners: string[] = [];
  return {
    spawnedOwners,
    publishCoinSpawn: (msg: { coins: { owner_id?: string }[] }) => {
      for (const c of msg.coins) spawnedOwners.push(c.owner_id ?? "");
    },
    publishCoinDespawn: noop,
    publishDespawn: noop,
    publishKeyCoinFrontDespawn: noop,
    publishSlotCounter: noop,
    publishSlotSpin: noop,
    publishSlotStatus: noop,
    publishStateDelta: noop,
    publishWheelCounter: noop,
    publishWheelSpin: noop,
  };
}

function makeSponsorStub() {
  let spawnFn: ((x: number, y: number, id: string) => number | null) | null = null;
  return {
    setSpawnFn: (fn: (x: number, y: number, id: string) => number | null) => {
      spawnFn = fn;
    },
    tick: () => {},
    onCoinDespawn: () => undefined,
    /** Test hook: fire the callback GameLoop registered. */
    fireSpawn: (x: number, y: number, id: string) => spawnFn?.(x, y, id) ?? null,
  };
}

async function buildLoop() {
  const physicsWorld = new PhysicsWorld();
  await physicsWorld.init();
  new SceneBuilder(physicsWorld).buildStaticScene();

  const clock = new SimClock();
  const pusher = new Pusher(physicsWorld, () => clock.now());
  const gameState = new GameState();
  const coinManager = new CoinManager(gameState);
  const dropScheduler = new DropScheduler();
  const sponsor = makeSponsorStub();
  const nats = makeNatsStub();

  const loop = new GameLoop(
    physicsWorld,
    pusher,
    gameState,
    coinManager,
    nats as never,
    dropScheduler,
    sponsor as never,
  );
  (loop as unknown as { running: boolean }).running = true;

  return { loop, physicsWorld, dropScheduler, sponsor, nats };
}

const coinCount = (loop: GameLoop) =>
  (loop as unknown as { coins: Map<number, unknown> }).coins.size;
const runTick = (loop: GameLoop) => (loop as unknown as { tick(): void }).tick();

/**
 * Fill the table to the cap cheaply. Building 800 real Rapier bodies through
 * the scene is slow, so drive the counter with the same public entry point the
 * production paths use and stop as soon as it refuses.
 */
function fillToCap(loop: GameLoop): number {
  let n = 0;
  while (loop.trySpawnCoin(0, COIN_CONFIG.SPAWN_HEIGHT + n * 0.001, 0) !== null) {
    n++;
    if (n > RATE_LIMIT_CONFIG.MAX_ACTIVE_COINS + 10) break; // runaway guard
  }
  return n;
}

describe("GameLoop hard coin cap", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("stops accepting spawns at exactly MAX_ACTIVE_COINS", async () => {
    const { loop } = await buildLoop();

    const accepted = fillToCap(loop);

    expect(accepted).toBe(RATE_LIMIT_CONFIG.MAX_ACTIVE_COINS);
    expect(coinCount(loop)).toBe(RATE_LIMIT_CONFIG.MAX_ACTIVE_COINS);
    expect(loop.trySpawnCoin(0, COIN_CONFIG.SPAWN_HEIGHT, 0)).toBeNull();
  }, 60_000);

  it("refuses sponsor coin spawns at the cap", async () => {
    const { loop, sponsor } = await buildLoop();
    fillToCap(loop);

    expect(sponsor.fireSpawn(0, COIN_CONFIG.SPAWN_HEIGHT, "sponsor-a")).toBeNull();
  }, 60_000);

  /**
   * The regression that matters most. DropScheduler.tick() decrements the queue
   * as it hands out drops, so checking the cap *after* dequeuing silently
   * destroys coins the player was already charged for. The invariant is
   * conservation: every coin that leaves the queue must become a body.
   *
   * Asserted while the table is saturated — that is the only state where the
   * old code lost coins, and coins genuinely leave the queue here because the
   * pile keeps shedding bodies off the front edge.
   */
  it("never drops a queued coin on the floor — dequeued always equals spawned", async () => {
    const { loop, dropScheduler, nats } = await buildLoop();
    fillToCap(loop);

    const QUEUED = 40;
    dropScheduler.enqueue("player-1", 0, QUEUED);
    nats.spawnedOwners.length = 0; // ignore the fill

    for (let i = 0; i < 400; i++) runTick(loop);

    const dequeued = QUEUED - dropScheduler.getPending("player-1");
    const spawned = nats.spawnedOwners.filter((o) => o === "player-1").length;

    expect(dequeued).toBeGreaterThan(0); // not a vacuous pass
    expect(spawned).toBe(dequeued);
  }, 120_000);

  it("holds the queue while the table is genuinely full", async () => {
    const { loop, dropScheduler } = await buildLoop();

    // Freeze the population: no despawns, so the cap stays binding for the
    // whole window and the queue must not move at all.
    vi.spyOn(
      loop as unknown as { atCoinCap(): boolean },
      "atCoinCap",
    ).mockReturnValue(true);

    dropScheduler.enqueue("player-1", 0, 25);
    for (let i = 0; i < 200; i++) runTick(loop);

    expect(dropScheduler.getPending("player-1")).toBe(25);
  }, 60_000);

  it("drains the held queue once the table has room again", async () => {
    const { loop, dropScheduler } = await buildLoop();

    const capSpy = vi.spyOn(
      loop as unknown as { atCoinCap(): boolean },
      "atCoinCap",
    );

    capSpy.mockReturnValue(true);
    dropScheduler.enqueue("player-1", 0, 5);
    for (let i = 0; i < 40; i++) runTick(loop);
    expect(dropScheduler.getPending("player-1")).toBe(5); // blocked

    capSpy.mockReturnValue(false);
    for (let i = 0; i < 60; i++) runTick(loop);

    expect(dropScheduler.getPending("player-1")).toBeLessThan(5);
  }, 60_000);

  it("caps the operator fill command too", async () => {
    const { loop } = await buildLoop();
    fillToCap(loop);

    const before = coinCount(loop);
    loop.fillPlatform();

    // Bounded overshoot only — fillPlatform breaks out per row, so it may add
    // at most one row's worth before the check bites on the next iteration.
    expect(coinCount(loop)).toBe(before);
  }, 60_000);
});
