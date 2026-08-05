import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { GameLoop } from "../GameLoop.js";
import { GameState } from "../GameState.js";
import { CoinManager } from "../CoinManager.js";
import { DropScheduler } from "../DropScheduler.js";
import { PhysicsWorld } from "../../physics/PhysicsWorld.js";
import { SceneBuilder } from "../../physics/SceneBuilder.js";
import { Pusher } from "../../physics/Pusher.js";
import { xoshiro128ss, formatSeed, type RngState } from "../../rng.js";

/**
 * Replay determinism for the LIVE game loop — not the offline SimLoop harness,
 * which has had a seeded path for a while. This is the one that matters for
 * arbitration: the loop that actually takes players' money must be able to
 * reproduce a round from a recorded seed.
 *
 * The bar is bit-identical coin positions, because "close enough" positions
 * diverge: a coin that lands a millimetre differently falls off a different
 * edge and pays out differently.
 *
 * Scope limit, asserted honestly below: this covers the physics RNG. Slot reel
 * and wheel outcomes stay on node:crypto by design, so a full replay also needs
 * those draws recorded. See docs/decisions.md D-005.
 */

function makeNatsStub() {
  const noop = () => {};
  return {
    publishCoinSpawn: noop,
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

const makeSponsorStub = () => ({
  setSpawnFn: () => {},
  tick: () => {},
  onCoinDespawn: () => undefined,
});

type Snapshot = Array<[number, number, number, number]>;

/** Two distinct full-width session seeds. */
const SEED_A: RngState = [0x00c0ffee, 0, 0, 0];
const SEED_B: RngState = [0x0badf00d, 0, 0, 0];

/**
 * Run a session: enqueue coins on every slot, tick, and return each surviving
 * coin's id and position.
 */
async function runSession(seed: RngState, ticks: number): Promise<{
  positions: Snapshot;
  /** The seed the server holds, read from where arbitration would read it. */
  heldSeed: string;
  /** Keys actually present on the wire-facing snapshot. */
  snapshotKeys: string[];
}> {
  const rng = xoshiro128ss(seed);

  const physicsWorld = new PhysicsWorld();
  await physicsWorld.init();
  new SceneBuilder(physicsWorld).buildStaticScene();

  const gameState = new GameState(formatSeed(seed));
  const coinManager = new CoinManager(gameState);
  const dropScheduler = new DropScheduler(rng);
  const pusher = new Pusher(physicsWorld);

  const loop = new GameLoop(
    physicsWorld,
    pusher,
    gameState,
    coinManager,
    makeNatsStub() as never,
    dropScheduler,
    makeSponsorStub() as never,
    rng,
  );
  (loop as unknown as { running: boolean }).running = true;

  // Same scripted input in both runs: a burst on every slot, then let it play.
  for (let slot = 0; slot < 5; slot++) {
    dropScheduler.enqueue(`player-${slot}`, slot, 12);
  }

  const tick = (loop as unknown as { tick(): void }).tick.bind(loop);
  for (let i = 0; i < ticks; i++) tick();

  const coins = (loop as unknown as {
    coins: Map<number, { getPosition(): { x: number; y: number; z: number } }>;
  }).coins;

  const positions: Snapshot = [];
  for (const [id, coin] of coins) {
    const p = coin.getPosition();
    positions.push([id, p.x, p.y, p.z]);
  }
  positions.sort((a, b) => a[0] - b[0]);

  return {
    positions,
    heldSeed: gameState.getRngSeed(),
    snapshotKeys: Object.keys(gameState.getWorldSnapshot()),
  };
}

describe("GameLoop replay determinism", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("reproduces coin positions bit-for-bit from the same seed", async () => {
    const a = await runSession(SEED_A, 400);
    const b = await runSession(SEED_A, 400);

    expect(a.positions.length).toBeGreaterThan(0); // not a vacuous pass
    expect(b.positions).toEqual(a.positions);
  }, 120_000);

  it("produces a different world from a different seed", async () => {
    const a = await runSession(SEED_A, 400);
    const c = await runSession(SEED_B, 400);

    expect(a.positions.length).toBeGreaterThan(0);
    // If the seed were not actually reaching the simulation, these would match.
    expect(c.positions).not.toEqual(a.positions);
  }, 120_000);

  it("keeps the seed server-side, out of anything sent to clients", async () => {
    const { heldSeed, snapshotKeys } = await runSession(SEED_A, 30);

    // Still recorded — a seed nobody wrote down cannot replay a session.
    expect(heldSeed).toBe("00c0ffee000000000000000000000000");

    // But not on the wire. A client holding the seed reproduces every draw the
    // simulation will make, and lightning strike positions come off that stream
    // while the player picks the moment to spend the scroll. This assertion is
    // the guard against someone helpfully adding the field back.
    expect(snapshotKeys).not.toContain("rngSeed");
    expect(snapshotKeys).not.toContain("rng_seed");
  }, 60_000);
});
