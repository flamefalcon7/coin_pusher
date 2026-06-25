import { describe, it, expect, beforeAll } from "vitest";
import { PhysicsWorld } from "../PhysicsWorld.js";
import { Coin } from "../Coin.js";

// Rapier's WASM module is initialized once per PhysicsWorld.init(); a fresh
// world per test keeps body/collider baselines isolated.
async function freshWorld(): Promise<PhysicsWorld> {
  const pw = new PhysicsWorld();
  await pw.init();
  return pw;
}

let spawnId = 0;
function spawnCoin(pw: PhysicsWorld): Coin {
  return new Coin(pw, spawnId++, 0, 1, 0);
}

describe("Coin physics-body lifecycle leak", () => {
  beforeAll(async () => {
    // Sanity: confirm Rapier WASM loads under vitest (the U3 risk item).
    const pw = await freshWorld();
    expect(pw.isInitialized()).toBe(true);
  });

  it("spawn + destroy 1000 coins returns bodies/colliders to baseline", async () => {
    const pw = await freshWorld();
    const world = pw.getWorld();
    const base = { bodies: world.bodies.len(), colliders: world.colliders.len() };

    for (let i = 0; i < 1000; i++) {
      const coin = spawnCoin(pw);
      coin.destroy(pw);
    }

    expect(world.bodies.len()).toBe(base.bodies);
    expect(world.colliders.len()).toBe(base.colliders);
  });

  it("interleaved spawn/remove returns to baseline", async () => {
    const pw = await freshWorld();
    const world = pw.getWorld();
    const base = { bodies: world.bodies.len(), colliders: world.colliders.len() };

    const live: Coin[] = [];
    for (let i = 0; i < 500; i++) {
      live.push(spawnCoin(pw));
      live.push(spawnCoin(pw));
      // Drop the oldest still-live coin every iteration (not all-then-all).
      const old = live.shift();
      old?.destroy(pw);
    }
    // Drain the remainder.
    for (const c of live) c.destroy(pw);

    expect(world.bodies.len()).toBe(base.bodies);
    expect(world.colliders.len()).toBe(base.colliders);
  });

  it("each spawned coin adds exactly one body and one collider", async () => {
    const pw = await freshWorld();
    const world = pw.getWorld();
    const base = { bodies: world.bodies.len(), colliders: world.colliders.len() };

    const coin = spawnCoin(pw);
    expect(world.bodies.len()).toBe(base.bodies + 1);
    expect(world.colliders.len()).toBe(base.colliders + 1);

    // removeRigidBody auto-removes the attached collider — assert we don't
    // also need to free it separately.
    coin.destroy(pw);
    expect(world.bodies.len()).toBe(base.bodies);
    expect(world.colliders.len()).toBe(base.colliders);
  });

  it("double-destroy does not corrupt body/collider counts", async () => {
    const pw = await freshWorld();
    const world = pw.getWorld();
    const base = { bodies: world.bodies.len(), colliders: world.colliders.len() };

    const coin = spawnCoin(pw);
    coin.destroy(pw);
    // Coin.destroy is not idempotent (it nulls its handle); a second call is a
    // caller error. Documented expectation: it must not leave the world in a
    // corrupted/negative-count state regardless of whether it throws.
    try {
      coin.destroy(pw);
    } catch {
      /* expected — body handle already removed */
    }
    expect(world.bodies.len()).toBe(base.bodies);
    expect(world.colliders.len()).toBe(base.colliders);
  });
});
