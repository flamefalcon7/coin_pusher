import { describe, it, expect } from "vitest";
import { PhysicsWorld } from "../PhysicsWorld.js";
import { SceneBuilder } from "../SceneBuilder.js";
import { Pusher } from "../Pusher.js";
import { Coin } from "../Coin.js";
import { PHYSICS_PARAMS } from "../config.js";
import { SCENE_CONFIG, COIN_CONFIG, PUSHER_CONFIG } from "@coin-pusher/shared";

/**
 * Behaviour guard for the switch to a position-based kinematic pusher.
 *
 * The old body was velocity-based and called `setLinvel(..., wakeUp = true)`
 * every tick, which woke any dynamic body it touched as a side effect.
 * `setNextKinematicTranslation()` has no such flag, so the question this file
 * answers is the one that actually decides whether the change is safe: does a
 * coin resting on the table — including one Rapier has put to sleep — still get
 * pushed?
 *
 * If it does not, coins pile up untouched and the game stops working, no matter
 * how exact the position sync is.
 */

const DT_MS = PHYSICS_PARAMS.DELTA_TIME * 1000;

async function buildScene() {
  const physicsWorld = new PhysicsWorld();
  await physicsWorld.init();
  new SceneBuilder(physicsWorld).buildStaticScene();
  const pusher = new Pusher(physicsWorld);
  return { physicsWorld, pusher };
}

/** Run the production tick ordering for `ticks` iterations. */
function run(
  physicsWorld: PhysicsWorld,
  pusher: Pusher,
  coins: Coin[],
  ticks: number,
  startTick = 0,
) {
  const substepMs = DT_MS / physicsWorld.getSubsteps();
  for (let t = startTick; t < startTick + ticks; t++) {
    coins.forEach((c) => c.update());
    physicsWorld.step((substep) => {
      pusher.update(t * DT_MS + (substep + 1) * substepMs);
    });
  }
}

/**
 * Place a coin flat on the platform inside the pusher's stroke, but clear of it
 * at t=0.
 *
 * The pusher face sweeps between Z_OFFSET ± AMPLITUDE ahead of its body. Spawn
 * closer than that and the first tick resolves a penetration, launching the
 * coin metres downrange and out of reach — which looks exactly like "the pusher
 * does not push" while actually testing nothing.
 */
function spawnCoinInFrontOfPusher(physicsWorld: PhysicsWorld, id: number): Coin {
  const platformTop =
    SCENE_CONFIG.PLATFORM.POSITION.y + SCENE_CONFIG.PLATFORM.THICKNESS / 2;
  const pusherMaxFaceZ =
    SCENE_CONFIG.PUSHER.POSITION.z +
    SCENE_CONFIG.PUSHER.DEPTH / 2 +
    PUSHER_CONFIG.Z_OFFSET +
    PUSHER_CONFIG.AMPLITUDE;

  return new Coin(
    physicsWorld,
    id,
    0,
    platformTop + COIN_CONFIG.THICKNESS,
    // Centre on the furthest-forward point of the stroke: the back edge starts
    // one radius behind it, well inside reach, but the face is at Z_OFFSET at
    // t=0 so there is no penetration to resolve on the first tick.
    pusherMaxFaceZ,
    // Lying flat: the default spawn rotation stands the coin on edge.
    { x: 0, y: 0, z: 0, w: 1 },
  );
}

describe("Pusher contact behaviour", () => {
  it("still pushes a resting coin forward", async () => {
    const { physicsWorld, pusher } = await buildScene();
    const coin = spawnCoinInFrontOfPusher(physicsWorld, 1);
    const startZ = coin.getPosition().z;

    // Several full pusher cycles at 0.6Hz (~50 ticks each). Measured from
    // spawn, not from a "settled" checkpoint: the pusher does its work in the
    // first cycle or two, after which the coin is beyond the stroke and
    // legitimately stops moving.
    run(physicsWorld, pusher, [coin], 450);
    const pushedZ = coin.getPosition().z;

    // The coin must have travelled toward the front of the table. A gain at or
    // below zero means the pusher is passing through it without transferring
    // momentum — the failure mode this file exists to catch.
    expect(pushedZ - startZ).toBeGreaterThan(0.01);
  }, 60_000);

  it("wakes a sleeping coin and moves it", async () => {
    const { physicsWorld, pusher } = await buildScene();
    const coin = spawnCoinInFrontOfPusher(physicsWorld, 1);

    // Let it land, then park it deep inside the stroke and force it asleep.
    // Doing this explicitly matters: left alone the pusher shoves the coin
    // just past its reach before Rapier gets round to sleeping it, so the
    // natural resting place is the one spot where the wake path is never
    // exercised.
    run(physicsWorld, pusher, [coin], 60);

    const body = coin.getRigidBody();
    const resting = coin.getPosition();
    const inReachZ =
      SCENE_CONFIG.PUSHER.POSITION.z +
      SCENE_CONFIG.PUSHER.DEPTH / 2 +
      PUSHER_CONFIG.Z_OFFSET;
    body.setTranslation({ x: 0, y: resting.y, z: inReachZ }, false);
    body.setLinvel({ x: 0, y: 0, z: 0 }, false);
    body.setAngvel({ x: 0, y: 0, z: 0 }, false);
    body.sleep();

    // Premise check — the assertion below is meaningless if it never slept.
    expect(body.isSleeping()).toBe(true);

    const beforeZ = coin.getPosition().z;
    run(physicsWorld, pusher, [coin], 120, 60);

    // setNextKinematicTranslation carries no wakeUp flag, unlike the setLinvel
    // call it replaced. If Rapier did not wake sleeping bodies on kinematic
    // contact, this coin would sit frozen and the game would stop working.
    expect(body.isSleeping()).toBe(false);
    expect(coin.getPosition().z).toBeGreaterThan(beforeZ);
  }, 60_000);
});
