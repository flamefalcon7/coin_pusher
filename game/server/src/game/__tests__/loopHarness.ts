import { GameLoop } from "../GameLoop.js";
import { GameState } from "../GameState.js";
import { CoinManager } from "../CoinManager.js";
import { DropScheduler } from "../DropScheduler.js";
import { PhysicsWorld } from "../../physics/PhysicsWorld.js";
import { SceneBuilder } from "../../physics/SceneBuilder.js";
import { Pusher } from "../../physics/Pusher.js";

/**
 * Shared harness for the GameLoop tests that drive `tick()` by hand instead of
 * waiting on a real 30Hz interval.
 */

/** Minimal NATS stub — records publishes, never touches the network. */
export function makeNatsStub() {
  const calls: string[] = [];
  const despawnedIds: number[] = [];
  const rec = (name: string) => (..._args: unknown[]) => {
    calls.push(name);
  };
  return {
    calls,
    despawnedIds,
    /** How many times a given publish has been recorded so far. */
    countOf(name: string): number {
      return calls.filter((c) => c === name).length;
    },
    publishCoinSpawn: rec("publishCoinSpawn"),
    publishCoinDespawn: rec("publishCoinDespawn"),
    publishDespawn: (msg: { ids: number[] }) => {
      calls.push("publishDespawn");
      despawnedIds.push(...msg.ids);
    },
    publishKeyCoinFrontDespawn: rec("publishKeyCoinFrontDespawn"),
    publishSlotCounter: rec("publishSlotCounter"),
    publishSlotSpin: rec("publishSlotSpin"),
    publishSlotStatus: rec("publishSlotStatus"),
    publishStateDelta: rec("publishStateDelta"),
    publishWheelCounter: rec("publishWheelCounter"),
    publishWheelSpin: rec("publishWheelSpin"),
  };
}

/** Minimal SponsorManager stub — no timers, no spawning. */
export function makeSponsorStub() {
  return {
    setSpawnFn: (_fn: unknown) => {},
    tick: (_tick: number) => {},
    onCoinDespawn: (_id: number) => undefined,
  };
}

export async function buildLoop() {
  const physicsWorld = new PhysicsWorld();
  await physicsWorld.init();
  new SceneBuilder(physicsWorld).buildStaticScene();

  const pusher = new Pusher(physicsWorld);
  const gameState = new GameState();
  const coinManager = new CoinManager(gameState);
  const dropScheduler = new DropScheduler();
  const nats = makeNatsStub();
  const sponsor = makeSponsorStub();

  const loop = new GameLoop(
    physicsWorld,
    pusher,
    gameState,
    coinManager,
    nats as never,
    dropScheduler,
    sponsor as never,
  );

  // Mark the loop live without calling start() — we drive tick() by hand rather
  // than waiting on a real 30Hz setInterval, but stop() is a no-op unless the
  // loop believes it is running.
  (loop as unknown as { running: boolean }).running = true;

  return { loop, physicsWorld, gameState, coinManager, dropScheduler, nats };
}

/** Invoke the private guarded entry point. */
export const runTick = (loop: GameLoop) =>
  (loop as unknown as { tick(): void }).tick();

export const isRunning = (loop: GameLoop) =>
  (loop as unknown as { running: boolean }).running;

export const coinCount = (loop: GameLoop) =>
  (loop as unknown as { coins: Map<number, unknown> }).coins.size;
