import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Coin } from "../../physics/Coin.js";
import { PhysicsWorld } from "../../physics/PhysicsWorld.js";
import { COIN_CONFIG } from "@coin-pusher/shared";
import { buildLoop, runTick, isRunning, coinCount } from "./loopHarness.js";

/**
 * Acceptance test for tick error containment.
 *
 * `GameLoop.start()` drives `tick()` from a `setInterval` callback. A throw in
 * that callback becomes an `uncaughtException`, and Node's default response is
 * to terminate the process — so a single bad coin reference would disconnect
 * every player in the room. The loop must absorb the failure, shed whatever
 * caused it, and keep simulating.
 */

describe("GameLoop tick error containment", () => {
  beforeEach(() => {
    // The guard logs every contained failure; keep the test output readable.
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("tells clients about evicted coins, and releases their Rapier bodies", async () => {
    const { loop, physicsWorld, coinManager, nats } = await buildLoop();
    const world = physicsWorld.getWorld();

    const goodId = coinManager.spawnCoin(0, COIN_CONFIG.SPAWN_HEIGHT, 0)!;
    loop.addCoin(new Coin(physicsWorld, goodId, 0, COIN_CONFIG.SPAWN_HEIGHT, 0));

    // A coin that fails for a reason OTHER than an already-destroyed body: its
    // rigid body is still live in the world, so eviction must release it or the
    // body leaks — invisible to the coin cap, still costing solver time.
    const badId = coinManager.spawnCoin(0.1, COIN_CONFIG.SPAWN_HEIGHT, 0)!;
    const bad = new Coin(physicsWorld, badId, 0.1, COIN_CONFIG.SPAWN_HEIGHT, 0);
    loop.addCoin(bad);
    vi.spyOn(bad, "getPosition").mockImplementation(() => {
      throw new Error("synthetic coin failure with a live body");
    });

    const bodiesBefore = world.bodies.len();

    // getPosition() is only reached on a network tick (every 2nd), so drive a
    // couple of ticks to guarantee the failure surfaces.
    expect(() => {
      runTick(loop);
      runTick(loop);
    }).not.toThrow();

    // The body is gone from the world, not just from the map.
    expect(world.bodies.len()).toBe(bodiesBefore - 1);

    // And clients were told, or the mesh stays on screen forever.
    expect(nats.despawnedIds).toContain(badId);
    expect(nats.despawnedIds).not.toContain(goodId);
  });

  it("survives a coin whose rigid body has been destroyed, and evicts it", async () => {
    const { loop, physicsWorld, coinManager } = await buildLoop();

    const goodId = coinManager.spawnCoin(0, COIN_CONFIG.SPAWN_HEIGHT, 0)!;
    loop.addCoin(new Coin(physicsWorld, goodId, 0, COIN_CONFIG.SPAWN_HEIGHT, 0));

    const badId = coinManager.spawnCoin(0.1, COIN_CONFIG.SPAWN_HEIGHT, 0)!;
    const bad = new Coin(physicsWorld, badId, 0.1, COIN_CONFIG.SPAWN_HEIGHT, 0);
    loop.addCoin(bad);
    // Simulate the stale-reference failure: body destroyed, entry still mapped.
    bad.destroy(physicsWorld);

    expect(coinCount(loop)).toBe(2);

    // The bad coin throws inside the tick; the guard must contain it.
    expect(() => runTick(loop)).not.toThrow();

    // ...and shed it, so the next tick is clean.
    expect(coinCount(loop)).toBe(1);
    expect(() => runTick(loop)).not.toThrow();
    expect(isRunning(loop)).toBe(true);
  });

  it("keeps simulating normally after recovering (physics still advances)", async () => {
    const { loop, physicsWorld, coinManager } = await buildLoop();

    const badId = coinManager.spawnCoin(0.1, COIN_CONFIG.SPAWN_HEIGHT, 0)!;
    const bad = new Coin(physicsWorld, badId, 0.1, COIN_CONFIG.SPAWN_HEIGHT, 0);
    loop.addCoin(bad);
    bad.destroy(physicsWorld);

    runTick(loop); // contained + evicted

    const goodId = coinManager.spawnCoin(0, COIN_CONFIG.SPAWN_HEIGHT, 0)!;
    const good = new Coin(physicsWorld, goodId, 0, COIN_CONFIG.SPAWN_HEIGHT, 0);
    loop.addCoin(good);

    const startY = good.getPosition().y;
    for (let i = 0; i < 30; i++) runTick(loop);

    // Gravity did its job — the loop is genuinely still stepping physics.
    expect(good.getPosition().y).toBeLessThan(startY);
    expect(isRunning(loop)).toBe(true);
  });

  it("gives up deliberately when the failure cannot be shed", async () => {
    const { loop, physicsWorld } = await buildLoop();

    // An unsheddable failure: the physics step itself throws. No coin eviction
    // can fix this, so the loop must stop rather than spin at 30Hz forever.
    vi.spyOn(physicsWorld, "step").mockImplementation(() => {
      throw new Error("synthetic unrecoverable physics failure");
    });

    for (let i = 0; i < 29; i++) runTick(loop);
    expect(isRunning(loop)).toBe(true); // still trying below the threshold

    runTick(loop); // 30th consecutive failure
    expect(isRunning(loop)).toBe(false);
  });

  it("resets the consecutive-error count after a good tick", async () => {
    const { loop, physicsWorld } = await buildLoop();

    const stepSpy = vi.spyOn(physicsWorld, "step");
    const original = PhysicsWorld.prototype.step;

    // Fail 20 times — below the give-up threshold.
    stepSpy.mockImplementation(() => {
      throw new Error("transient");
    });
    for (let i = 0; i < 20; i++) runTick(loop);
    expect(isRunning(loop)).toBe(true);

    // Recover, then fail 20 more. If the counter did not reset, the loop would
    // cross the 30-failure threshold and stop.
    stepSpy.mockImplementation(function (this: PhysicsWorld) {
      return original.call(this);
    });
    runTick(loop);

    stepSpy.mockImplementation(() => {
      throw new Error("transient again");
    });
    for (let i = 0; i < 20; i++) runTick(loop);

    expect(isRunning(loop)).toBe(true);
  });
});
