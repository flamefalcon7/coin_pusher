import { describe, it, expect, vi, afterEach } from "vitest";
import { SimLoop, type SimLoopConfig } from "../SimLoop.js";
import { NO_ABILITIES } from "../AbilitySimulator.js";
import { mulberry32 } from "../Rng.js";
import { PhysicsWorld } from "../../physics/PhysicsWorld.js";

/**
 * SimLoop is the harness that produces this project's RTP numbers, so it is
 * only useful while it simulates the same physics the live server does.
 *
 * The pusher is a position-based kinematic body: production advances it once
 * per solver substep from inside PhysicsWorld.step(). A caller that advances it
 * once per tick instead leaves the body in the same place at the tick boundary
 * — which is why the pusher sync assertions cannot see the difference — but
 * moves it at double speed for the first substep and not at all for the rest,
 * changing the contact velocity every coin on the face receives.
 *
 * This shipped broken once already: the PhysicsWorld.step() signature gained
 * its callback and SimLoop was updated only enough to compile.
 */

const FAST_CONFIG: Partial<SimLoopConfig> = {
  coinsPerTrial: 2,
  coinInsertIntervalTicks: 10,
  warmupCoins: 4,
  warmupSettleTicks: 5,
  abilities: NO_ABILITIES,
  abilityIntervalTicks: 150,
  maxBonusDepth: 1,
  drainTimeoutTicks: 60,
};

describe("SimLoop pusher cadence", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("always steps physics with a per-substep pusher callback", async () => {
    let stepCalls = 0;
    let callsWithoutCallback = 0;
    const substepIndexSets: number[][] = [];

    const original = PhysicsWorld.prototype.step;
    vi.spyOn(PhysicsWorld.prototype, "step").mockImplementation(function (
      this: PhysicsWorld,
      beforeSubstep?: (i: number) => void,
    ) {
      stepCalls++;
      if (!beforeSubstep) {
        callsWithoutCallback++;
        return original.call(this);
      }
      const seen: number[] = [];
      const result = original.call(this, (i: number) => {
        seen.push(i);
        beforeSubstep(i);
      });
      substepIndexSets.push(seen);
      return result;
    });

    await new SimLoop(FAST_CONFIG, { rng: mulberry32(1) }).runTrial();

    expect(stepCalls).toBeGreaterThan(0); // not a vacuous pass
    expect(callsWithoutCallback).toBe(0);

    // Every step advanced the pusher once per substep, in order.
    const expected = Array.from(
      { length: new PhysicsWorld().getSubsteps() },
      (_, i) => i,
    );
    for (const seen of substepIndexSets) {
      expect(seen).toEqual(expected);
    }
  }, 60_000);
});
