# Spatial Contract (coordinate conventions — code-verified 2026-07-07)

Single source of truth for axes, units, and landmark positions. **Never guess a
coordinate; look it up here or in `SCENE_CONFIG`.** If you add a landmark, add it
to `game/shared/src/types.ts` config AND to this file AND to a landmark test.

## Handedness & engines

- **Both engines are right-handed.** Babylon is configured with
  `scene.useRightHandedSystem = true` (`game/client/src/scene/SceneManager.ts:74`)
  to match Rapier's native right-handed system. There is **no coordinate
  conversion layer anywhere** — positions/quaternions pass through verbatim.
- MUST NOT create a scene/engine without `useRightHandedSystem = true`.
  (Watch-item: `SceneManager.test.ts:96` mocks it as `false`; the real scene is `true`.)

## Units & axes

- Units: **meters, kilograms, seconds**. Coin radius 0.06 m ≈ real coin scale.
- Gravity `(0, -9.81, 0)` → **+Y is up** (`PHYSICS_CONFIG.GRAVITY`).
- **+Z points toward the player/camera** ("front"). Evidence: back wall at
  z=-0.4, drop zone at z=+0.75, pusher oscillates in +Z to push coins toward
  the front edge; default camera `ArcRotateCamera(alpha=π/2, beta=π/3, target=(0,1,0))`
  sits on the +Z side looking toward -Z (`CameraSetup.ts:15`).
- **+X is the player's right**; `SIDE_WALLS.LEFT_POSITION.x = -0.6`,
  `RIGHT_POSITION.x = +0.6`.
- Rotations: quaternions `{x, y, z, w}` everywhere (Rapier descriptors and
  network protocol). Axis-angle helper: `SceneBuilder.quatFromAxisAngle`.

## Landmarks (from `SCENE_CONFIG` / `COIN_CONFIG` / `PUSHER_CONFIG`, `game/shared/src/types.ts`)

| Landmark | Value | Notes |
|---|---|---|
| Platform center | `(0, 0.25, 0.05)` | WIDTH 1.2 (x), DEPTH 1.3 (z), THICKNESS 0.05 → top surface **y = 0.275** |
| Platform flare | starts at z = 0 (`FLARE_Z`), 30° outward | plan-view trapezoid toward front |
| Back wall | center `(0, 0.5, -0.4)`, tilt -5° | low friction, coins slide down |
| Side walls | x = ±0.6 (centers), THICKNESS 0.1, inner tilt 1.5° | front opening: 0.32 m square hole, hole center y = 0.35 |
| Pusher (rest) | center `(0, 0.3, -0.6)`, 1.2×0.2×1.0 | front face rest z = -0.1; oscillates along **+Z**, amplitude 0.08–0.24 + Z_OFFSET 0.1 |
| Drop zone (visual only) | `(0, 0.15, 0.75)` | client-only, **no Rapier body** |
| Coin | r=0.06, thickness 0.012 | key coin r=0.08/t=0.015; sponsor coin = regular geometry |
| Coin spawn | y = 1.5, x ∈ slots `[-0.4, -0.2, 0, 0.2, 0.4]` | x clamp ±0.5 (`RATE_LIMIT_CONFIG.MAX_X_POSITION`) |
| Despawn | y < -0.1 | below platform = removed & scored |
| Pins | 5 rows on back wall, 90° X-rotated cylinders | r=0.01, spacing 0.2/0.18 |

Known dead config: `PLATFORM.TILT_ANGLE = 2` is **not applied** in physics or
rendering (confirmed in `docs/plans/2026-04-20-001-...-plan.md` R1). Don't
build on it.

## Rules

1. **MUST NOT hardcode world coordinates** in client or server code — reference
   `SCENE_CONFIG`/`*_CONFIG` constants so client visuals and server physics
   can't drift apart.
2. New spatial feature → add config constant + a **landmark test** (assert the
   built body/mesh position matches config; SimLoop or mock-scene tier).
3. When describing positions in plans/requirements, use **relative references**
   ("platform top", "coin diameter × 3", "same width as pusher") resolved
   against this table — not freehand absolute numbers.
4. A shape that renders is not necessarily physical — see the collider mapping
   whitelist in `SKILL.md`. Visual-only elements MUST be documented as
   client-only (like `DROP_ZONE`).
