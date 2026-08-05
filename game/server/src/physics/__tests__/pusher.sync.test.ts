import { describe, it, expect } from "vitest";
import { PhysicsWorld } from "../PhysicsWorld.js";
import { Pusher } from "../Pusher.js";
import { PHYSICS_PARAMS } from "../config.js";
import { PUSHER_CONFIG, SUPER_PUSH_CONFIG } from "@coin-pusher/shared";

/**
 * Acceptance test for the pusher position-sync contract.
 *
 * `GameLoop.tick()` broadcasts `pusher.getCurrentZ()` to every client, but that
 * value is only meaningful if it equals where the pusher rigid body actually is
 * in the physics world. Any gap is a permanent client/server disagreement that
 * no amount of interpolation can fix — coins visibly rest on a pusher face that
 * is not where the server thinks it is.
 *
 * Tolerance: 2mm. At AMPLITUDE=0.08m / FREQUENCY=0.6Hz the peak pusher speed is
 * A*omega = 0.302 m/s, so a single tick of unaccounted integration (33.3ms) is
 * ~10mm — five times the budget.
 */

const TOLERANCE_M = 0.002;
const DT_MS = PHYSICS_PARAMS.DELTA_TIME * 1000;

/**
 * Drive `ticks` iterations of the real GameLoop ordering:
 *   pusher.update() -> physicsWorld.step() -> read broadcast value
 * and return the largest gap between the broadcast Z and the physics-truth Z.
 */
async function maxBroadcastVsPhysicsGap(
  ticks: number,
  opts: { superPushAtTick?: number } = {},
): Promise<number> {
  const physicsWorld = new PhysicsWorld();
  await physicsWorld.init();

  const pusher = new Pusher(physicsWorld);
  const body = pusher.getRigidBody();

  const substepMs = DT_MS / physicsWorld.getSubsteps();

  let maxGap = 0;
  for (let tick = 0; tick < ticks; tick++) {
    if (opts.superPushAtTick === tick) {
      pusher.startSuperPush();
    }

    // Same ordering as GameLoop.runTick(): the pusher is advanced before each
    // substep, then the broadcast value is read for the state_delta. Simulated
    // time is derived from the tick index exactly as the game loop derives it.
    physicsWorld.step((substep) => {
      pusher.update(tick * DT_MS + (substep + 1) * substepMs);
    });

    const broadcastZ = pusher.getCurrentZ();
    const physicsZ = body.translation().z;
    maxGap = Math.max(maxGap, Math.abs(broadcastZ - physicsZ));
  }

  return maxGap;
}

describe("PhysicsWorld substep contract", () => {
  it("invokes beforeSubstep once per substep with indices 0..n-1", async () => {
    const physicsWorld = new PhysicsWorld();
    await physicsWorld.init();

    const seen: number[] = [];
    physicsWorld.step((i) => seen.push(i));

    expect(seen).toEqual(
      Array.from({ length: physicsWorld.getSubsteps() }, (_, i) => i),
    );
  });

  /**
   * The regression guard the end-of-tick gap assertion cannot provide.
   *
   * Advancing the pusher once per tick and advancing it once per substep both
   * leave the body at the same place when the tick ends — Rapier reaches the
   * target on the first substep and then sits still. So the sync test above
   * passes either way (measured: 2.7e-8 both ways).
   *
   * What differs is the trajectory *within* the tick, and therefore the contact
   * velocity handed to every coin resting on the face: once-per-tick moves at
   * double speed for half the tick and then stops dead. Sampling between
   * substeps is the only way to see it.
   */
  it("moves the pusher a fraction of the tick per substep, not all at once", async () => {
    const physicsWorld = new PhysicsWorld();
    await physicsWorld.init();

    const pusher = new Pusher(physicsWorld);
    const body = pusher.getRigidBody();
    const substeps = physicsWorld.getSubsteps();
    const substepMs = DT_MS / substeps;

    // Start at phase 0 where the pusher is at maximum speed, so the per-substep
    // travel is large enough to measure unambiguously.
    pusher.update(0);
    physicsWorld.step((s) => pusher.update((s + 1) * substepMs));

    // Now sample the body position at the start of each substep of the NEXT tick.
    const samples: number[] = [];
    physicsWorld.step((s) => {
      samples.push(body.translation().z);
      pusher.update(DT_MS + (s + 1) * substepMs);
    });

    expect(samples).toHaveLength(substeps);

    // Between the first and second substep the body must have advanced by
    // roughly one substep of travel. Under once-per-tick advancement it would
    // already be at the tick's end position by the second sample, so the
    // remaining travel would be ~0.
    const travelBetweenSubsteps = Math.abs(samples[1] - samples[0]);
    const perSubstepTravel =
      (PUSHER_CONFIG.AMPLITUDE * 2 * Math.PI * PUSHER_CONFIG.FREQUENCY * substepMs) / 1000;

    expect(travelBetweenSubsteps).toBeGreaterThan(perSubstepTravel * 0.5);
    expect(travelBetweenSubsteps).toBeLessThan(perSubstepTravel * 1.5);
  });
});

describe("Pusher broadcast/physics sync", () => {
  it("the Z sent to clients matches the rigid body's real Z within 2mm (steady oscillation)", async () => {
    // 30 simulated seconds at 30Hz — covers ~18 full cycles at 0.6Hz.
    const gap = await maxBroadcastVsPhysicsGap(900);
    expect(gap).toBeLessThan(TOLERANCE_M);
  });

  it("stays in sync through a super push (pullback/thrust/hold/recovery)", async () => {
    const totalMs =
      SUPER_PUSH_CONFIG.PULLBACK_DURATION +
      SUPER_PUSH_CONFIG.THRUST_DURATION +
      SUPER_PUSH_CONFIG.HOLD_DURATION +
      SUPER_PUSH_CONFIG.RECOVERY_DURATION;
    // Cover the whole state machine plus a second of normal oscillation after.
    const ticks = Math.ceil(totalMs / DT_MS) + 60;

    const gap = await maxBroadcastVsPhysicsGap(ticks, { superPushAtTick: 10 });
    expect(gap).toBeLessThan(TOLERANCE_M);
  });

  it("still oscillates over the configured amplitude (not a vacuous pass)", async () => {
    const physicsWorld = new PhysicsWorld();
    await physicsWorld.init();

    const pusher = new Pusher(physicsWorld);
    const body = pusher.getRigidBody();

    const substepMs = DT_MS / physicsWorld.getSubsteps();
    let minZ = Infinity;
    let maxZ = -Infinity;
    for (let tick = 0; tick < 900; tick++) {
      physicsWorld.step((substep) => {
        pusher.update(tick * DT_MS + (substep + 1) * substepMs);
      });
      const z = body.translation().z;
      minZ = Math.min(minZ, z);
      maxZ = Math.max(maxZ, z);
    }

    // Peak-to-peak must be ~2 * AMPLITUDE; a frozen pusher would pass the
    // sync assertions above trivially, so pin the motion down here.
    const peakToPeak = maxZ - minZ;
    expect(peakToPeak).toBeGreaterThan(PUSHER_CONFIG.AMPLITUDE * 1.8);
    expect(peakToPeak).toBeLessThan(PUSHER_CONFIG.AMPLITUDE * 2.2);
  });
});
