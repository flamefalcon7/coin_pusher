---
title: "feat: Stacked coins with pusher notch and rising platform"
type: feat
status: proposed
date: 2026-04-20
origin: docs/brainstorms/2026-04-20-stacked-coins-rising-platform-requirements.md
reviewed: 2026-09-02
outcome: "Never started: no commits, no branch, none of the planned files exist. PLATFORM.TILT_ANGLE premise is dead config; re-verify before executing."
---

# feat: Stacked coins with pusher notch and rising platform

## Overview

Add a stacked coin attraction mechanic: a rising sub-platform clears space and spawns a cylinder stack of real physics coins. The pusher has a semicircular notch so normal oscillation bypasses the stack. Players push the stack over by dropping coins or using super push.

## Problem Frame

High coin stacks create a strong "I want to push that over" impulse — core coin pusher psychology. Currently, spawning stacks on the platform fails because the pusher immediately knocks them over. This plan adds the physical infrastructure (pusher notch + rising platform) to support stable stacks. Trigger events are designed independently. (see origin: `docs/brainstorms/2026-04-20-stacked-coins-rising-platform-requirements.md`)

## Requirements Trace

- R1. ~~Remove platform 2° tilt~~ **Resolved: platform tilt was never applied in physics or rendering. Clean up dead config only.**
- R2. ~~Evaluate tilt removal impact~~ **N/A — platform was already flat.**
- R3. Pusher semicircular notch — normal oscillation bypasses stack position
- R4. Precise arc collision via Rapier compound collider (6-8 cuboids along arc)
- R5. Client renders matching semicircular notch pusher mesh (BabylonJS CSG)
- R6. Notch radius sized to cylinder stack (stack radius 0.168m → notch radius ~0.2m)
- R7. Rising sub-platform at pusher-front center, under notch path
- R8. Sub-platform rises to push aside existing coins, clearing space
- R9. Stack coins spawn on raised sub-platform
- R10. Sub-platform lowers back to main platform surface
- R11. Stack = real physics coins, falling off front edge = player score
- R12. Stack generation triggered by events (designed independently, this plan exposes a `triggerStackSpawn()` API)

## Scope Boundaries

- No trigger event design (which event, frequency, reward amount) — independent work
- No special VFX for stacks (glow, particles) — future enhancement
- No super push modification — it can push through the notch and knock over stacks (intended)
- Stability strategy: pure physics first, kinematic freeze as fallback if needed

## Context & Research

### Relevant Code and Patterns

- **Pusher physics:** `game/server/src/physics/Pusher.ts` — kinematic velocity-based body, single cuboid collider (1.2m × 0.2m × 1.0m), sinusoidal Z oscillation
- **Pusher rendering:** `game/client/src/scene/PusherMesh.ts` — `MeshBuilder.CreateBox`, toon material, `updatePosition(z)` syncs from server
- **Platform physics:** `game/server/src/physics/SceneBuilder.ts` — fixed body, decomposed into center rect + 6 flare pieces + lip. Platform is FLAT (TILT_ANGLE defined but never used)
- **Stack patterns:** `game/server/src/game/StackSpawner.ts` — cylinder pattern: 30 levels × 8 coins/ring, radius 0.168m, flat rotation
- **Event trigger pattern:** `game/server/src/game/GameLoop.ts` — slot/wheel use counter → trigger → delayed spawn pattern. State tracked with boolean flags + setTimeout
- **Protocol:** `game/shared/src/types.ts` — `AbilityEventMessage` pattern for broadcast events. `StateDeltaMessage` carries `pusherZ` every frame
- **Coin physics:** `game/server/src/physics/Coin.ts` — dynamic body, CCD, sleep thresholds

### Institutional Learnings

- Physics/rendering alignment: always grep actual BabylonJS/Rapier source for coordinate conventions before writing geometry code (from MEMORY.md)
- BabylonJS CSG: `CSG.FromMesh` → `.subtract()` for boolean operations

## Key Technical Decisions

- **Compound collider for arc (not trimesh):** Rapier trimesh doesn't support kinematic bodies. 8 cuboids arranged along semicircle provides good arc approximation with negligible perf cost
- **Cylinder stack type:** Bottom radius 0.168m fits naturally inside 0.2m notch. Visually impressive (30 levels high). Round base matches round notch
- **Notch radius 0.2m:** Cylinder stack radius (0.168m) + 0.032m clearance. Notch spans ~33% of pusher width (0.4m of 1.2m)
- **Pure physics stability first:** Platform is flat, cylinder base is inherently stable (8 coins in ring). Add kinematic freeze later only if needed — trivial to add (`body.setBodyType(Dynamic, true)`)
- **Rising platform = kinematic body:** Same pattern as pusher — server-authoritative position, smooth animation via `setTranslation()` per tick
- **Sub-platform position:** Z ≈ 0.3 (pusher front, well beyond normal push range Z ≈ 0.0), X = 0 (center)

## Open Questions

### Resolved During Planning

- **Platform tilt:** Config `TILT_ANGLE: 2` exists but was never applied. Platform is already flat. Just clean up dead config.
- **Stack type:** Cylinder — round base matches round notch, visually impressive
- **Notch radius:** 0.2m (cylinder radius 0.168m + clearance)
- **Stability strategy:** Pure physics first, kinematic freeze as trivial fallback

### Deferred to Implementation

- **Exact cuboid angles for arc:** Need to experiment with 6 vs 8 segments and verify visual gap is acceptable
- **Rising platform animation curve:** easeInOut timing (likely similar to super push easing functions already in Pusher.ts)
- **Stack coin count for gameplay:** Current cylinder is 240 coins (30 levels × 8). May need tuning for balance — expose as config
- **Sub-platform collision with existing coins:** How aggressively it pushes coins aside during rise

## High-Level Technical Design

> *This illustrates the intended approach and is directional guidance for review, not implementation specification. The implementing agent should treat it as context, not code to reproduce.*

```
Server tick lifecycle (extended):

  pusher.update()
  → risingPlatform.update()        ← NEW: animate platform Y
  → dropScheduler.processTicks()
  → abilities (tornado, etc.)
  → physicsWorld.step()
  → despawnCoins()
  → publishState()                 ← includes risingPlatform Y position

Rising platform state machine:
  idle → rising → spawning → lowering → idle
         (0.8s)   (instant)   (0.8s)

Pusher collider change:
  BEFORE: 1 cuboid (1.2m × 0.2m × 1.0m)
  AFTER:  2 cuboids (left + right) + 8 small cuboids (arc)

Protocol extension:
  StateDeltaMessage.risingPlatformY  (number, platform Y offset)
  RisingPlatformEventMessage         (op: "rising_platform", phase: "rising"|"spawning"|"lowering"|"idle")
```

## Implementation Units

- [ ] **Unit 1: Clean up dead platform tilt config**

**Goal:** Remove unused `TILT_ANGLE` from platform config and update requirements doc

**Requirements:** R1, R2

**Dependencies:** None

**Files:**
- Modify: `game/shared/src/types.ts`
- Modify: `docs/brainstorms/2026-04-20-stacked-coins-rising-platform-requirements.md`

**Approach:**
- Remove `TILT_ANGLE: 2` from `SCENE_CONFIG.PLATFORM`
- Verify no code references it (already confirmed — only back wall and side walls use their own TILT_ANGLE)

**Patterns to follow:**
- Existing config structure in `game/shared/src/types.ts`

**Test expectation:** none — pure config cleanup, no behavioral change

**Verification:**
- TypeScript compiles clean
- No references to `PLATFORM.TILT_ANGLE` anywhere in codebase

---

- [ ] **Unit 2: Pusher compound collider with semicircular notch (server physics)**

**Goal:** Replace pusher's single cuboid collider with compound collider that has a semicircular notch in the center

**Requirements:** R3, R4, R6

**Dependencies:** Unit 1

**Files:**
- Modify: `game/server/src/physics/Pusher.ts`
- Modify: `game/shared/src/types.ts` (add notch config)
- Test: `game/server/src/__tests__/Pusher.test.ts` (create if not exists)

**Approach:**
- Add `NOTCH` config to `SCENE_CONFIG.PUSHER`: `{ RADIUS: 0.2, SEGMENTS: 8 }`
- Replace single `ColliderDesc.cuboid()` with compound collider:
  - Two side cuboids: left half and right half of pusher, each `(WIDTH/2 - RADIUS)/2` wide
  - 8 small cuboids arranged along semicircle arc at the front edge of the notch
  - Each arc cuboid rotated to approximate the curve, sized to fill gaps between segments
- All colliders attached to the same kinematic rigid body — motion logic unchanged

**Technical design:**
> *Directional guidance, not implementation specification.*
```
Pusher top-down view with notch:

  ┌─────┐         ┌─────┐
  │  L  │ ╲     ╱ │  R  │
  │     │   ╲ ╱   │     │
  │     │   ╱ ╲   │     │
  │     │ ╱     ╲ │     │
  └─────┘         └─────┘

L cuboid: x = -(WIDTH/2 + RADIUS)/2, half-width = (WIDTH/2 - RADIUS)/2
R cuboid: x = +(WIDTH/2 + RADIUS)/2, half-width = (WIDTH/2 - RADIUS)/2
Arc segments: 8 cuboids along semicircle from -90° to +90° (front half)
```

**Patterns to follow:**
- Existing collider creation in `Pusher.ts` constructor
- `SceneBuilder.ts` `addFlareCollider` for compound shape pattern

**Test scenarios:**
- Happy path: pusher with notch oscillates correctly, Z position unchanged from before
- Happy path: compound collider bounding box matches original pusher width/depth
- Edge case: coin at notch center (x=0, z=0.3) does NOT collide with pusher during normal oscillation
- Edge case: coin at pusher side (x=0.4, z=-0.3) DOES collide during normal oscillation
- Integration: super push still pushes through notch area (Z extends to 0.6, past stack position)

**Verification:**
- Pusher oscillation behavior identical to before (except notch gap)
- Coins in notch path are not pushed during normal oscillation
- Coins outside notch path are pushed normally

---

- [ ] **Unit 3: Pusher notch mesh (client rendering)**

**Goal:** Render pusher with matching semicircular notch using BabylonJS CSG

**Requirements:** R5

**Dependencies:** Unit 2 (shared config)

**Files:**
- Modify: `game/client/src/scene/PusherMesh.ts`

**Approach:**
- Create box mesh (existing pusher shape)
- Create cylinder mesh positioned at notch center (radius = NOTCH.RADIUS, height = pusher HEIGHT)
- Use `CSG.FromMesh(box).subtract(CSG.FromMesh(cylinder))` to cut the notch
- Apply existing toon material to result mesh
- Dispose intermediate meshes
- `updatePosition(z)` logic unchanged

**Patterns to follow:**
- Existing `PusherMesh.ts` constructor pattern
- BabylonJS CSG API: `CSG.FromMesh()`, `.subtract()`, `.toMesh()`

**Test scenarios:**
- Happy path: pusher mesh renders with visible semicircular notch at center
- Happy path: toon material applies correctly to CSG result
- Edge case: CSG intermediate meshes properly disposed (no memory leak)

**Verification:**
- Visual: pusher displays semicircular notch in browser
- Pusher Z-position sync still works correctly

---

- [ ] **Unit 4: Rising platform physics (server)**

**Goal:** Add a kinematic sub-platform body that can rise and lower at the stack spawn position

**Requirements:** R7, R8, R10

**Dependencies:** Unit 2

**Files:**
- Create: `game/server/src/physics/RisingPlatform.ts`
- Modify: `game/shared/src/types.ts` (add config)
- Test: `game/server/src/__tests__/RisingPlatform.test.ts`

**Approach:**
- New `RisingPlatform` class, same kinematic pattern as `Pusher`
- Config: position (x=0, z=0.3), radius matching notch (~0.2m), rise height (~0.15m), animation duration (~800ms)
- Collider: cylinder or cuboid, small enough to fit inside notch
- State machine: `idle → rising → raised → lowering → idle`
- Animation: easeInOut Y translation per tick, reuse easing functions from Pusher.ts
- When rising, pushes aside any coins resting on it via kinematic motion (physics engine handles this naturally)

**Patterns to follow:**
- `Pusher.ts` — kinematic body, `setTranslation()` per tick, easing functions
- `GameLoop.ts` state machine pattern (e.g., `spState` in Pusher)

**Test scenarios:**
- Happy path: platform rises from Y=0 to Y=riseHeight over configured duration
- Happy path: platform lowers from raised back to Y=0
- Happy path: state machine transitions: idle→rising→raised→lowering→idle
- Edge case: trigger while already active is ignored (no double-rise)
- Edge case: `isRaised()` returns true only during `raised` state
- Integration: coins on platform surface are pushed upward when platform rises (kinematic body displaces dynamic bodies)

**Verification:**
- State machine transitions correctly
- Platform Y position animates smoothly
- Duplicate triggers are rejected

---

- [ ] **Unit 5: Stack spawn integration (server game loop)**

**Goal:** Wire rising platform + stack spawning into GameLoop, expose `triggerStackSpawn()` API

**Requirements:** R9, R11, R12

**Dependencies:** Unit 4

**Files:**
- Modify: `game/server/src/game/GameLoop.ts`
- Modify: `game/server/src/game/StackSpawner.ts` (add config for stack coin count)
- Modify: `game/shared/src/types.ts` (protocol messages)

**Approach:**
- GameLoop owns `RisingPlatform` instance, calls `update()` each tick
- `triggerStackSpawn()` public method:
  1. Start rising platform
  2. On `raised` state callback → spawn cylinder stack via `StackSpawner.getStackCoins("cylinder", ...)` at platform position + rise height
  3. Spawn coins as regular physics coins (dynamic bodies, normal despawn rules apply)
  4. Start lowering platform
- Add configurable stack params: levels, coins per ring (smaller than default 30×8 for gameplay balance)
- Broadcast `RisingPlatformEventMessage` to clients for visual sync
- Add `risingPlatformY` to `StateDeltaMessage` for frame-by-frame position sync

**Patterns to follow:**
- `triggerSlotSpin()` / `triggerWheelSpin()` in GameLoop.ts — event trigger → delayed action → spawn
- `StackSpawner.getStackCoins()` for coin position generation
- `CoinManager.spawnCoinUnchecked()` for adding physics coins

**Test scenarios:**
- Happy path: `triggerStackSpawn()` starts rising platform, spawns coins when raised, lowers platform
- Happy path: spawned coins are real physics bodies with correct positions (cylinder pattern)
- Happy path: `RisingPlatformEventMessage` broadcast to all clients
- Edge case: trigger during active sequence is rejected
- Edge case: spawned coins that fall off front edge count toward player score (use existing despawn logic)
- Integration: full cycle — trigger → rise → spawn → lower → coins exist on platform → pusher can't reach them (Z > normal push range) → player coin or super push knocks them

**Verification:**
- Stack appears on platform after trigger
- Coins are real physics bodies tracked by CoinManager
- Despawn/scoring logic works for stack coins same as regular coins

---

- [ ] **Unit 6: Client rising platform rendering + sync**

**Goal:** Render rising platform on client, sync animation from server state

**Requirements:** R7, R8, R10

**Dependencies:** Unit 5 (protocol messages)

**Files:**
- Create: `game/client/src/scene/RisingPlatformMesh.ts`
- Modify: `game/client/src/scene/SceneManager.ts`
- Modify: `game/client/src/net/Interpolator.ts` (interpolate platform Y)

**Approach:**
- New `RisingPlatformMesh` class: cylinder mesh at stack position, toon material
- `SceneManager` creates instance, exposes `updateRisingPlatformY(y)` method
- `Interpolator` handles `risingPlatformY` same as `pusherZ` — lerp between server states for smooth animation
- On `RisingPlatformEventMessage`: optionally trigger client-side sound/minor VFX (scope boundary: no fancy particles)

**Patterns to follow:**
- `PusherMesh.ts` — mesh creation + `updatePosition()` pattern
- `Interpolator.ts` — `pusherZ` interpolation for smooth sync

**Test scenarios:**
- Happy path: platform mesh renders at correct position (x=0, z=0.3)
- Happy path: platform Y interpolates smoothly between server states
- Edge case: platform mesh stays at Y=0 when idle (flush with main platform)

**Verification:**
- Visual: rising platform visible in browser, animates smoothly up/down
- No jitter or snapping during animation
- Coins visually appear on raised platform

## System-Wide Impact

- **Interaction graph:** `GameLoop.triggerStackSpawn()` → `RisingPlatform` state machine → `StackSpawner` → `CoinManager.spawnCoinUnchecked()` → normal despawn/scoring pipeline. Client receives both `StateDeltaMessage.risingPlatformY` (per-frame) and `RisingPlatformEventMessage` (phase changes)
- **Error propagation:** If stack spawn fails (coin cap reached), rising platform still lowers — no stuck state. Log warning, skip spawn
- **State lifecycle risks:** Rising platform stuck in `raised` state if server crashes mid-animation. Mitigate: on GameLoop init, force platform to `idle`
- **API surface parity:** `triggerStackSpawn()` is server-only, called by future event triggers. No client-initiated trigger
- **Integration coverage:** Full cycle test: trigger → rise → spawn → lower → coins interact with pusher/other coins → despawn at front edge → score
- **Unchanged invariants:** Pusher oscillation frequency/amplitude unchanged. Normal coin spawn via DropScheduler unchanged. Slot machine / jackpot wheel triggers unchanged. Super push reaches Z=0.6 and CAN hit stack — this is intended behavior

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| Cylinder stack unstable on flat platform | Pure physics first; kinematic freeze is trivial fallback (one line: `body.setBodyType(Dynamic, true)`) |
| CSG performance on pusher mesh | One-time operation at scene init, not per-frame. BabylonJS CSG is well-tested for simple boolean ops |
| Arc collider gaps let coins slip through | 8 segments provides ~22.5° per segment. If gaps visible, increase to 10-12 segments (config change only) |
| Rising platform clips through existing coins | Kinematic body naturally pushes dynamic bodies. Rise speed should be slow enough (800ms) to avoid tunneling |
| Compound collider increases broadphase checks | 10 colliders vs 1, but all on same body. Broadphase cost negligible vs 800 coin×coin pairs |

## Sources & References

- **Origin document:** [docs/brainstorms/2026-04-20-stacked-coins-rising-platform-requirements.md](docs/brainstorms/2026-04-20-stacked-coins-rising-platform-requirements.md)
- Related code: `game/server/src/physics/Pusher.ts`, `game/server/src/game/StackSpawner.ts`, `game/server/src/game/GameLoop.ts`
- Related code: `game/client/src/scene/PusherMesh.ts`, `game/client/src/scene/StaticMeshes.ts`
- Rapier compound colliders: rigid body with multiple colliders attached
