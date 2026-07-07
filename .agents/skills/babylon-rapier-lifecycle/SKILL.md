---
name: babylon-rapier-lifecycle
description: Use when creating, pooling, or destroying BabylonJS scene objects (meshes, materials, textures, particle systems, observers, post-process) or Rapier rigid bodies/colliders, or when diagnosing a memory leak / "objects not recycled" / growing-FPS-cost / VFX-not-disposed bug. Enforces the house disposal pattern and ships a leak-test template so leaks fail as tests instead of surfacing as lag.
license: MIT
metadata:
  version: "1.0.0"
  domain: game-client-server
  triggers: dispose, memory leak, 記憶體洩漏, 物件回收, leak, GC, particle, ParticleSystem, VFX cleanup, observer leak, onBeforeRenderObservable, removeRigidBody, collider, thin instance, texture dispose, material dispose, count-baseline leak test, coordinate, 座標, spatial contract, collider mapping, new mesh, 新增物件, position, axis
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
8. **Declare the Rapier collider mapping BEFORE creating any new visual mesh with physics** (see whitelist below). If no mapping exists, redesign the shape or decompose it — do not mesh first and hope.
9. **Look up coordinates in `references/spatial-contract.md` / `SCENE_CONFIG`; never guess or hardcode world positions.** Both engines are right-handed, units are meters, +Y up, +Z toward the player.

## Collider mapping whitelist (renderable ≠ physical)

BabylonJS can render shapes Rapier can't simulate. Every physical object MUST
map to one of:

| Rapier collider | Use for | Constraints |
|---|---|---|
| `cuboid` | walls, platform, pusher | house default — prefer this |
| `cylinder` | coins, pins | coins are cylinders, not balls |
| `ball` / `capsule` | round dynamics | — |
| **compound of cuboids** | walls with openings, arcs | house pattern: `SceneBuilder.createWallWithOpening` (4 cuboids), pusher-notch plan (6–8 cuboids along arc) |
| `convexHull` | irregular **convex** dynamic bodies | last resort; more expensive |
| `trimesh` | concave shapes, **static only** | never dynamic; no CCD guarantees |

- Concave dynamic body → decompose into convex parts or redesign. There is no
  concave dynamic collider.
- Purely visual elements (no collider) are allowed but MUST be explicitly
  marked client-only in config, like `SCENE_CONFIG.DROP_ZONE`.
- The client mesh and server collider MUST be built from the **same
  `SCENE_CONFIG` constants** so they can't drift apart.

## MUST NOT DO

- Do **not** add a new disposal style; reuse the existing one.
- Do **not** call `Math.random()` or wall-clock time in spawn/despawn logic you want testable — see the `self-verification` skill.
- Do **not** create materials/textures inside a per-frame or per-spawn path without pooling/caching them.
- Do **not** mark a leak bug fixed without a failing-then-passing count-baseline test.

## Leak-test template (client — mock idiom + count baseline)

Do **not** use `NullEngine` for these managers: they build `DynamicTexture` via
`getContext()`/`createRadialGradient` and use `ToonMaterial`/`ShaderMaterial`,
none of which load under a bare node `NullEngine` (no 2D canvas, no GL shader
compile). Instead extend the established `vi.mock("@babylonjs/core")` idiom and
assert the manager's **own pool counters** return to baseline. This catches the
leak class we own (forgot-to-dispose / forgot-to-unpool) and runs under `vitest`
(`environment: "node"`). See ADR **D-003**.

A shared harness factors the mock + count helpers — reuse it, don't re-author:
`game/client/src/scene/__tests__/leakHarness.ts` exports `createBabylonCoreMock()`,
`createMockScene()`, `snapshotPoolCounters(manager, extraFields)` and
`expectCountersWithin(baseline, after, tolerance)`.

```ts
// game/client/src/scene/__tests__/CoinMeshManager.leak.test.ts (worked example)
import { describe, it, expect, vi } from "vitest";

vi.mock("@babylonjs/core", async () => {
  const { createBabylonCoreMock } = await import("./leakHarness");
  return createBabylonCoreMock();
});
vi.mock("../ToonMaterial", async () => {
  const { createToonMaterialMock } = await import("./leakHarness");
  return createToonMaterialMock();
});

import { CoinMeshManager } from "../CoinMeshManager";
import { createMockScene, snapshotPoolCounters, expectCountersWithin } from "./leakHarness";

it("returns to baseline after 500 spawn/despawn cycles", () => {
  const mgr = new CoinMeshManager(createMockScene());
  const fields = ["idToIndex", "kcIdToIndex", "coinSponsorLookup", "spawnAnims"];
  const base = snapshotPoolCounters(mgr, fields);   // includes getCoinCount()
  for (let i = 0; i < 500; i++) {
    mgr.addCoin(i, [0, 1, 0], [0, 0, 0, 1]); // queues into pending batch
    mgr.commitNewCoins();                     // creates the thin instance
    mgr.updateInstances();                    // flush instance buffer
    mgr.removeCoin(i);
  }
  // Assert BEFORE dispose() — dispose()'s clear() would mask a forgot-to-unpool leak.
  expectCountersWithin(base, snapshotPoolCounters(mgr, fields), 1);
  expect(mgr.getCoinCount()).toBe(0);
});
```

> Verified method names: `CoinMeshManager` → `addCoin()` then `commitNewCoins()`
> then `updateInstances()` then `removeCoin(id)`; count via `getCoinCount()`.
> For `VFXManager` (see `__tests__/VFXManager.leak.test.ts`), fire ≥100 bursts via
> `playCoinInsert`/`playCoinDespawn(pos)`, assert `getActiveBurstCount() <=
> maxBurstSystems` (20) and `getRingPoolSize()` stays capped, then `dispose()` and
> assert `renderObserver` is null and `activeTimers.length === 0`.

## Leak-test template (server — Rapier)

The game server now has a `vitest` runner (`pnpm --filter @coin-pusher/game test`;
see ADR **D-003** and `game/server/vitest.config.ts`). Worked example:
`game/server/src/physics/__tests__/coinLifecycle.leak.test.ts`.

```ts
// snapshot real Rapier counts — no canvas dependency
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
