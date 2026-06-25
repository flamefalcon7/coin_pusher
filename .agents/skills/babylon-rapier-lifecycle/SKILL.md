---
name: babylon-rapier-lifecycle
description: Use when creating, pooling, or destroying BabylonJS scene objects (meshes, materials, textures, particle systems, observers, post-process) or Rapier rigid bodies/colliders, or when diagnosing a memory leak / "objects not recycled" / growing-FPS-cost / VFX-not-disposed bug. Enforces the house disposal pattern and ships a leak-test template so leaks fail as tests instead of surfacing as lag.
license: MIT
metadata:
  version: "1.0.0"
  domain: game-client-server
  triggers: dispose, memory leak, 記憶體洩漏, 物件回收, leak, GC, particle, ParticleSystem, VFX cleanup, observer leak, onBeforeRenderObservable, removeRigidBody, collider, thin instance, texture dispose, material dispose, NullEngine leak test
  role: implementer
  scope: implementation
  output-format: code-then-test
  related-skills: self-verification, game-developer
---

# Babylon / Rapier Resource Lifecycle

Enforce correct creation **and destruction** of BabylonJS and Rapier resources, and
make leaks detectable as automated tests. This repo already disposes well — your job
is to **match the existing pattern** and **add tests that enforce it**, not invent new
patterns.

## When to Use This Skill

- Adding or changing anything that allocates a mesh, material, texture, particle system, render observer, post-process, or `TransformNode`.
- Adding or changing anything that calls `world.createRigidBody` / `world.createCollider`.
- Pooling objects (coins, rings, bursts).
- Investigating a leak: rising memory, FPS that degrades over a session, "objects not recycled", VFX that lingers or never shows.

## Read First (house patterns to copy)

- `game/client/src/scene/VFXManager.ts` — pooled particle systems, tracked render observer + timers, full `dispose()`.
- `game/client/src/scene/CoinMeshManager.ts` — thin-instance pooling, swap-and-pop, static temp objects, prototype/material/texture disposal.
- `game/client/src/scene/TargetingReticle.ts` — the canonical observer pattern (store handle → remove in `dispose()`).
- `game/server/src/physics/Coin.ts` — Rapier body create + `world.removeRigidBody` on despawn.

## MUST DO

1. **Every class that allocates Babylon resources exposes a `dispose()`** that frees *everything* it created, in this order: child VFX/helpers → meshes → materials → textures → render targets → observers/timers.
2. **Dispose materials and textures explicitly.** `mesh.dispose()` does **not** free shared materials/textures. Follow `CoinMeshManager` (null a material's diffuse texture before disposing the material when applicable).
3. **Every `onBeforeRenderObservable.add(...)` (or any observable) stores its handle and is `.remove()`d in `dispose()`.** Unremoved observers are the #1 leak here. Same for `setInterval`/`setTimeout` — track and clear them (VFXManager already tracks timers).
4. **Pools have a hard cap and dispose the overflow.** Match `VFXManager.maxBurstSystems` (excess is disposed, not retained). A pool that only grows is a leak.
5. **Rapier: pair every `createRigidBody` with `removeRigidBody` on despawn.** Removing a body auto-removes its attached colliders — do **not** also try to free those colliders separately. Never drop a body reference without removing it from the world.
6. **Null out references after disposal** so the object can be GC'd and double-dispose is safe.
7. **Add/extend a leak test** (see template) for any new pooled or spawnable resource.

## MUST NOT DO

- Do **not** add a new disposal style; reuse the existing one.
- Do **not** call `Math.random()` or wall-clock time in spawn/despawn logic you want testable — see the `self-verification` skill.
- Do **not** create materials/textures inside a per-frame or per-spawn path without pooling/caching them.
- Do **not** mark a leak bug fixed without a failing-then-passing count-baseline test.

## Leak-test template (client — NullEngine + vitest)

NullEngine renders nothing (no GPU/DOM needed; `vitest` runs `environment: "node"`),
so it's ideal for count-baseline leak tests.

```ts
// game/client/src/scene/__tests__/leak.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { NullEngine, Scene } from "@babylonjs/core";

function counts(scene: Scene) {
  return {
    meshes: scene.meshes.length,
    materials: scene.materials.length,
    textures: scene.textures.length,
    nodes: scene.transformNodes.length,
    beforeRender: scene.onBeforeRenderObservable.observers.length,
  };
}

describe("CoinMeshManager leak", () => {
  let engine: NullEngine;
  let scene: Scene;
  beforeEach(() => {
    engine = new NullEngine();
    scene = new Scene(engine);
  });
  afterEach(() => {
    scene.dispose();
    engine.dispose();
  });

  it("returns to baseline after 500 spawn/despawn cycles", () => {
    const mgr = new CoinMeshManager(scene);   // system under test
    const base = counts(scene);
    for (let i = 0; i < 500; i++) {
      mgr.addCoin(i, [0, 1, 0], [0, 0, 0, 1]); // queues into pending batch
      mgr.commitNewCoins();                     // creates the thin instance
      mgr.updateInstances();                    // flush instance buffer
      mgr.removeCoin(i);
    }
    mgr.dispose();
    const after = counts(scene);
    // allow ±1 for engine-internal singletons
    expect(Math.abs(after.meshes - base.meshes)).toBeLessThanOrEqual(1);
    expect(Math.abs(after.materials - base.materials)).toBeLessThanOrEqual(1);
    expect(Math.abs(after.textures - base.textures)).toBeLessThanOrEqual(1);
    expect(after.beforeRender).toBe(base.beforeRender); // observers fully removed
  });
});
```

> Verified method names: `CoinMeshManager` → `addCoin()` then `commitNewCoins()`
> then `updateInstances()` then `removeCoin(id)`; count via `getCoinCount()`.
> For `VFXManager`, fire ≥100 bursts via `playCoinDespawn(pos)`, assert
> `getActiveBurstCount() <= maxBurstSystems` (20) and `getRingPoolSize()` stays
> capped, then `dispose()` and assert
> `scene.onBeforeRenderObservable.observers.length` returns to baseline.

## Leak-test template (server — Rapier)

```ts
// run with vitest or `tsx` (see self-verification skill for adding a test runner)
import * as RAPIER from "@dimforge/rapier3d-compat";

await RAPIER.init();
const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
const base = { bodies: world.bodies.len(), colliders: world.colliders.len() };

for (let i = 0; i < 1000; i++) {
  const body = world.createRigidBody(RAPIER.RigidBodyDesc.dynamic());
  world.createCollider(RAPIER.ColliderDesc.ball(0.5), body);
  world.removeRigidBody(body); // auto-removes the collider too
}
// assert: world.bodies.len() === base.bodies && world.colliders.len() === base.colliders
```

## Quick diagnostic checklist (leak triage)

1. Reproduce with a count-baseline test (above) — turn the symptom into a failing assertion first.
2. Bisect by resource type: which count grows — meshes, materials, textures, observers, or bodies?
3. Observers/timers growing → a `dispose()` isn't removing a handle.
4. Materials/textures growing → created per-spawn instead of pooled/cached, or not disposed with the mesh.
5. Bodies/colliders growing → a despawn path skips `removeRigidBody`.
6. After the fix, the test goes green. Then consider a `docs/solutions/` entry if it took >15 min (per CLAUDE.md).
