import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { GameLoop } from "../GameLoop.js";
import { PhysicsWorld } from "../../physics/PhysicsWorld.js";
import { Coin } from "../../physics/Coin.js";
import { COIN_CONFIG } from "@coin-pusher/shared";
import { buildLoop, runTick, isRunning, coinCount } from "./loopHarness.js";

/**
 * The tick breaker: what happens after containment gives up.
 *
 * Containment (gameLoop.errorContainment.test.ts) covers absorbing a bad tick
 * and shedding its cause. This file covers the decision made when that stops
 * working — stop the room, retry once with the table intact, and only then
 * leave. See docs/decisions.md D-006 for why stopping is itself the safety
 * mechanism: no slot_status means the backend refuses coin inserts.
 */

const RESTART_DELAY = (GameLoop as unknown as { BREAKER_RESTART_DELAY_MS: number })
  .BREAKER_RESTART_DELAY_MS;

/** Consecutive failures required to trip. */
const THRESHOLD = (GameLoop as unknown as { MAX_CONSECUTIVE_TICK_ERRORS: number })
  .MAX_CONSECUTIVE_TICK_ERRORS;

/** Make every physics step throw — a failure no coin eviction can shed. */
function breakPhysics(physicsWorld: PhysicsWorld) {
  return vi.spyOn(physicsWorld, "step").mockImplementation(() => {
    throw new Error("synthetic unrecoverable physics failure");
  });
}

describe("GameLoop tick breaker", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("stops publishing slot_status when it trips, which is what gates the backend", async () => {
    const { loop, physicsWorld, nats } = await buildLoop();

    // Warm up: a healthy loop is heartbeating.
    for (let i = 0; i < 60; i++) runTick(loop);
    const beatsWhileHealthy = nats.countOf("publishSlotStatus");
    expect(beatsWhileHealthy).toBeGreaterThan(0);

    breakPhysics(physicsWorld);
    for (let i = 0; i < THRESHOLD; i++) runTick(loop);

    expect(isRunning(loop)).toBe(false);

    // The heartbeat is what the backend's liveness gate watches. If a stopped
    // loop kept emitting it, D-006 would never fire and players would keep
    // being charged for a simulation that is not running.
    const beatsAfterTrip = nats.countOf("publishSlotStatus");
    for (let i = 0; i < 60; i++) runTick(loop);
    expect(nats.countOf("publishSlotStatus")).toBe(beatsAfterTrip);

    loop.stop();
  });

  it("restarts once, with the table exactly as players left it", async () => {
    const { loop, physicsWorld, coinManager } = await buildLoop();

    // Coins on the table when the failure hits. These are platform inventory —
    // players already paid to put them there, and a process restart would
    // vaporise them, which is the whole reason a restart-in-place is tried
    // first.
    for (let i = 0; i < 3; i++) {
      const id = coinManager.spawnCoin(i * 0.05, COIN_CONFIG.SPAWN_HEIGHT, 0)!;
      loop.addCoin(new Coin(physicsWorld, id, i * 0.05, COIN_CONFIG.SPAWN_HEIGHT, 0));
    }
    const coinsBefore = coinCount(loop);
    expect(coinsBefore).toBe(3);

    const stepSpy = breakPhysics(physicsWorld);
    for (let i = 0; i < THRESHOLD; i++) runTick(loop);
    expect(isRunning(loop)).toBe(false);

    // The cause clears while the room is dark.
    stepSpy.mockRestore();

    vi.advanceTimersByTime(RESTART_DELAY);

    expect(isRunning(loop)).toBe(true);
    expect(coinCount(loop)).toBe(coinsBefore);

    loop.stop();
  });

  it("does not restart before the delay has elapsed", async () => {
    const { loop, physicsWorld } = await buildLoop();

    breakPhysics(physicsWorld);
    for (let i = 0; i < THRESHOLD; i++) runTick(loop);

    vi.advanceTimersByTime(RESTART_DELAY - 1);
    expect(isRunning(loop)).toBe(false);

    loop.stop();
  });

  it("gives the restarted loop a full error budget, not one tick", async () => {
    const { loop, physicsWorld } = await buildLoop();

    const stepSpy = breakPhysics(physicsWorld);
    for (let i = 0; i < THRESHOLD; i++) runTick(loop);
    vi.advanceTimersByTime(RESTART_DELAY);
    expect(isRunning(loop)).toBe(true);

    // Still broken, but one short of the threshold. If the restart had left the
    // counter at 30, the first of these would have re-tripped immediately and
    // the second chance would have been one tick wide.
    stepSpy.mockImplementation(() => {
      throw new Error("still broken");
    });
    for (let i = 0; i < THRESHOLD - 1; i++) runTick(loop);

    expect(isRunning(loop)).toBe(true);

    loop.stop();
  });

  it("leaves the process when the restarted loop trips again", async () => {
    const { loop, physicsWorld } = await buildLoop();
    const onUnrecoverable = vi.fn();
    loop.setUnrecoverableHandler(onUnrecoverable);

    breakPhysics(physicsWorld);

    // First trip: stop and schedule the retry, but do NOT give up yet.
    for (let i = 0; i < THRESHOLD; i++) runTick(loop);
    expect(onUnrecoverable).not.toHaveBeenCalled();

    vi.advanceTimersByTime(RESTART_DELAY);
    expect(isRunning(loop)).toBe(true);

    // Second trip: the failure survived a restart and 60 eviction sweeps, so
    // it is structural. Hand off to the shutdown path.
    for (let i = 0; i < THRESHOLD; i++) runTick(loop);

    expect(onUnrecoverable).toHaveBeenCalledTimes(1);
    expect(isRunning(loop)).toBe(false);

    // And it must not keep firing on every subsequent tick.
    for (let i = 0; i < 10; i++) runTick(loop);
    expect(onUnrecoverable).toHaveBeenCalledTimes(1);
  });

  it("cancels a pending restart when the process is shutting down", async () => {
    const { loop, physicsWorld } = await buildLoop();

    breakPhysics(physicsWorld);
    for (let i = 0; i < THRESHOLD; i++) runTick(loop);
    expect(isRunning(loop)).toBe(false);

    // SIGTERM arrives during the dark window. stop() returns early on an
    // already-stopped loop, so if it did not clear the timer first, the restart
    // would fire afterwards and bring the loop back up on a process that is
    // trying to leave.
    loop.stop();

    vi.advanceTimersByTime(RESTART_DELAY * 2);

    expect(isRunning(loop)).toBe(false);
  });

  it("does not block shutdown draining a loop that cannot tick", async () => {
    const { loop, physicsWorld, coinManager } = await buildLoop();

    // A coin on the table means drain() has something to wait for.
    const id = coinManager.spawnCoin(0, COIN_CONFIG.SPAWN_HEIGHT, 0)!;
    loop.addCoin(new Coin(physicsWorld, id, 0, COIN_CONFIG.SPAWN_HEIGHT, 0));

    breakPhysics(physicsWorld);
    for (let i = 0; i < THRESHOLD; i++) runTick(loop);
    loop.stop(); // cancel the pending restart, as shutdown() would

    // drain() completes via drainCheck() at the end of a tick, and a stopped
    // loop never ticks. Without the not-running short-circuit this resolves
    // only on the 60s timeout, stalling every shutdown after a breaker trip.
    let resolved = false;
    const drained = loop.drain(60_000).then(() => {
      resolved = true;
    });

    await vi.advanceTimersByTimeAsync(0);
    await drained;

    expect(resolved).toBe(true);
  });
});
