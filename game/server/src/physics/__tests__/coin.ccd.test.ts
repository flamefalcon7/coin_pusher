import { describe, it, expect } from "vitest";
import { PhysicsWorld } from "../PhysicsWorld.js";
import { SceneBuilder } from "../SceneBuilder.js";
import { Coin } from "../Coin.js";
import { COIN_CONFIG, SCENE_CONFIG } from "@coin-pusher/shared";

/**
 * Acceptance test for coin CCD lifecycle.
 *
 * CCD (continuous collision detection) runs a sweep test every substep and is
 * the expensive path — it only earns its cost while a coin is in free-fall and
 * could tunnel through the platform. Once a coin is resting on the pile it must
 * be switched off, otherwise every coin on the table keeps paying for CCD and
 * the physics step cost grows with the *total* coin count instead of the moving
 * coin count.
 *
 * `Coin` must not keep a shadow copy of the flag that can drift from what
 * Rapier actually has set.
 */

const SETTLE_TICKS = 240; // 8 simulated seconds at 30Hz — ample to land and rest

async function buildWorld() {
  const physicsWorld = new PhysicsWorld();
  await physicsWorld.init();
  new SceneBuilder(physicsWorld).buildStaticScene();
  return physicsWorld;
}

/** Drive the GameLoop ordering: coin.update() for all coins, then step. */
function stepAll(physicsWorld: PhysicsWorld, coins: Coin[], ticks: number) {
  for (let t = 0; t < ticks; t++) {
    coins.forEach((c) => c.update());
    physicsWorld.step();
  }
}

function ccdOnCount(coins: Coin[]): number {
  return coins.filter((c) => c.getRigidBody().isCcdEnabled()).length;
}

describe("Coin CCD lifecycle", () => {
  it("enables CCD on spawn (free-fall needs the sweep test)", async () => {
    const physicsWorld = await buildWorld();
    const coins = [
      new Coin(physicsWorld, 1, 0, COIN_CONFIG.SPAWN_HEIGHT, 0),
    ];

    expect(ccdOnCount(coins)).toBe(1);
    // The TS-side view must agree with Rapier's — no shadow state.
    expect(coins[0].isCcdEnabled()).toBe(true);
  });

  it("disables CCD on every coin once the pile has come to rest", async () => {
    const physicsWorld = await buildWorld();

    // Spread 20 coins across the platform so they land and settle into a pile.
    const coins: Coin[] = [];
    const halfW = SCENE_CONFIG.PLATFORM.WIDTH / 2;
    for (let i = 0; i < 20; i++) {
      const x = -halfW + ((i + 0.5) / 20) * SCENE_CONFIG.PLATFORM.WIDTH;
      const z = SCENE_CONFIG.PLATFORM.POSITION.z + (i % 2 === 0 ? -0.1 : 0.1);
      coins.push(
        new Coin(physicsWorld, i + 1, x, COIN_CONFIG.SPAWN_HEIGHT + i * 0.02, z),
      );
    }

    expect(ccdOnCount(coins)).toBe(20); // all start in free-fall

    stepAll(physicsWorld, coins, SETTLE_TICKS);

    // Coins resting on the main platform — the population the CCD height gate
    // (COIN_CONFIG.CCD_DISABLE_HEIGHT) is tuned for. Coins that fell off the
    // table, or that parked on a side shelf at LEFT/RIGHT_PLATFORM.TOP_Y=1.5m,
    // are above that gate by design and keep CCD; see the note below.
    const onPlatform = coins.filter((c) => {
      const y = c.getPosition().y;
      return y > COIN_CONFIG.DESPAWN_Y && y < COIN_CONFIG.CCD_DISABLE_HEIGHT;
    });
    expect(onPlatform.length).toBeGreaterThan(0); // not a vacuous pass

    expect(ccdOnCount(onPlatform)).toBe(0);
  });

  // Known residual gap (config, not the flag bug this file fixes):
  // CCD_DISABLE_HEIGHT=0.5m is measured for the main platform (surface
  // ~0.275m). A coin that comes to rest on a side shelf
  // (LEFT/RIGHT_PLATFORM.TOP_Y=1.5m) never satisfies the height gate, so it
  // keeps paying for CCD. Shelves hold few coins, so the cost is bounded.
  // Left as-is deliberately: raising the gate, or retiring CCD when a body
  // sleeps, changes tunneling behaviour and should be its own decision.

  /**
   * The previous version of this test asserted
   * `coin.isCcdEnabled() === coin.getRigidBody().isCcdEnabled()`, which is a
   * tautology: the accessor IS that expression, so both sides evaluate the same
   * call on the same body. It could never fail. What is worth pinning is that
   * the flag flips for the documented reason — slow AND low — rather than at
   * some arbitrary moment.
   */
  it("retires CCD only once the coin is both slow and low", async () => {
    const physicsWorld = await buildWorld();
    const coin = new Coin(physicsWorld, 1, 0, COIN_CONFIG.SPAWN_HEIGHT, SCENE_CONFIG.PLATFORM.POSITION.z);
    const body = coin.getRigidBody();

    let flipTick = -1;
    let speedAtFlip = Infinity;
    let heightAtFlip = Infinity;

    for (let t = 0; t < SETTLE_TICKS; t++) {
      const wasEnabled = body.isCcdEnabled();
      coin.update();

      if (wasEnabled && !body.isCcdEnabled()) {
        flipTick = t;
        const v = body.linvel();
        speedAtFlip = Math.hypot(v.x, v.y, v.z);
        heightAtFlip = coin.getPosition().y;
      }

      physicsWorld.step();
    }

    expect(flipTick).toBeGreaterThanOrEqual(0); // it really did retire
    expect(speedAtFlip).toBeLessThan(COIN_CONFIG.CCD_DISABLE_VELOCITY);
    expect(heightAtFlip).toBeLessThan(COIN_CONFIG.CCD_DISABLE_HEIGHT);
    expect(coin.isCcdEnabled()).toBe(false);
  });

  it("does not retire CCD while the coin is still falling fast", async () => {
    const physicsWorld = await buildWorld();
    // Spawn high so the first ticks are genuine free-fall.
    const coin = new Coin(physicsWorld, 1, 0, COIN_CONFIG.SPAWN_HEIGHT + 2, SCENE_CONFIG.PLATFORM.POSITION.z);
    const body = coin.getRigidBody();

    for (let t = 0; t < 10; t++) {
      coin.update();
      physicsWorld.step();
      const v = body.linvel();
      if (Math.hypot(v.x, v.y, v.z) >= COIN_CONFIG.CCD_DISABLE_VELOCITY) {
        // Still fast — CCD must still be on, or a fast coin could tunnel.
        expect(coin.isCcdEnabled()).toBe(true);
      }
    }
  });
});
