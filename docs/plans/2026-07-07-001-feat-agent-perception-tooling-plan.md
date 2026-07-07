---
title: "feat: Agent perception tooling — debugDump, collider wireframes, tuning HUD"
type: feat
status: active
date: 2026-07-07
origin: docs/solutions/workflow/claude-code-session-retro-2026-07.md
---

# feat: Agent perception tooling — debugDump, collider wireframes, tuning HUD

## Overview

Three tools that shrink the "describe → render → adjust" loop when developing
visual/physical features with an AI agent. Root problem (from the 2026-07 retro):
the agent has no structured perception of the scene — screenshots are its only
eyes, and pixels are a lossy, slow feedback channel. The 07-03 billboard
acceptance took a 225-turn loop largely because every check meant
screenshot → squint → guess.

Direction of fix: give the agent **numbers first, pixels last**, and give the
human a **direct-manipulation channel** so mm-level tuning never goes through
text description at all.

## Existing infrastructure (extend, don't rebuild)

- `window.__coinpusher_debug` (`DebugReadout.ts`) — read-only counters behind
  `?debug=1`, already consumed by Chrome DevTools MCP `evaluate_script`.
- `lil-gui@0.21` already a client dependency; `ToonDebugGUI` works,
  `SceneDebugGUI` is currently **non-functional** (rebuildWalls removed).
- Spatial contract: `.agents/skills/babylon-rapier-lifecycle/references/spatial-contract.md`.
- Debug screenshots workflow: `docs/solutions/workflow/gpu-smoke-screenshots.md`.

## Requirements

### R1 — `debugDump()`: structured scene state for the agent

- R1.1 Extend `__coinpusher_debug` with `dump(): SceneDump` returning JSON:
  per-mesh `{ name, position, rotationQuaternion, scaling, boundingBox: {min, max} }`
  for all non-thin-instance meshes, plus coin thin-instance count and the last
  received authoritative pose per networked body id (from the interpolator's
  latest snapshot, flagged `authoritative: true`).
- R1.2 Include `sceneConfigHash` (or the raw `SCENE_CONFIG` object) so a dump is
  self-describing against config drift.
- R1.3 Only installed behind `?debug=1`, same as existing readout.
- R1.4 Vitest (mock idiom): dump returns entries for known managers; bounding
  boxes finite; no throw on empty scene.

### R2 — Debug camera presets + axis gizmo

- R2.1 `__coinpusher_debug.camera(preset)` with presets `top | front | side | default`
  (orthographic for the first three), so screenshots are deterministic and
  comparable across runs.
- R2.2 Axis gizmo (RGB = XYZ) + platform-top grid rendered only in debug mode,
  so any screenshot self-documents orientation (kills coordinate-confusion
  misreads — see spatial contract).

### R3 — Rapier collider wireframe overlay

- R3.1 Client-side wireframe rendering of **static** colliders (platform, walls,
  pusher envelope, pins), built from the same `SCENE_CONFIG` constants the
  server uses — a visual diff of "rendered vs physical" in one screenshot.
- R3.2 Dynamic bodies (coins): wireframe cylinder at the latest network pose for
  a sampled subset (cap ~20, perf guard).
- R3.3 Toggle via lil-gui checkbox + `__coinpusher_debug.wireframe(true/false)`.
- R3.4 Follows the disposal MUST DOs (babylon-rapier-lifecycle skill); leak test
  for the overlay meshes.

### R4 — Tuning HUD (human does the last 10%)

- R4.1 Revive/replace `SceneDebugGUI`: lil-gui folders exposing the numeric
  leaves of `SCENE_CONFIG` (platform, walls, pusher, pins) as sliders.
- R4.2 Where live-apply is feasible client-side (mesh positions/scales), apply
  on change for instant visual feedback. Physics stays server-authoritative —
  no live physics rebuild in scope.
- R4.3 **Export button**: copies a ready-to-paste TS snippet (changed constants
  only, with old → new values in a comment) to clipboard + `console.log`. The
  workflow is: human drags sliders → export → agent applies snippet to
  `game/shared/src/types.ts` → server restart picks it up.
- R4.4 Debug-only; zero footprint without `?debug=1`.

### R5 — Action injection: let the agent *play*, not just look

(Borrowed from GDAI / godot-mcp-pro input-simulation suites.)

- R5.1 `__coinpusher_debug.actions = { insertCoin(slot), triggerAbility(name) }`
  calling the same client code paths as the real UI (not synthetic DOM clicks),
  so one `evaluate_script` line runs a full insert→observe acceptance loop.
- R5.2 Reuse the play-bot's action layer where possible; do not duplicate
  protocol logic.
- R5.3 Debug-only (`?debug=1`); server-side rate limits still apply unchanged.

### R6 — Isolated render mode

(Borrowed from CoplayDev unity-mcp `screenshot-isolated`.)

- R6.1 `__coinpusher_debug.isolate(meshOrVfxName | null)` hides everything else
  and shows the target against a neutral background, combined with R2 camera
  presets — for VFX/billboard acceptance without scene noise.
- R6.2 `isolate(null)` restores; leak test proves no residue.

### R7 — Agent-writable visual params

(Borrowed from GDAI runtime property set/get.)

- R7.1 `__coinpusher_debug.set(path, value)` for client-visual parameters only
  (mesh transforms, material params) — lets the agent binary-search a value via
  change→dump→screenshot loops. Physics/config stays read-only; permanent
  values still land in `SCENE_CONFIG` via the R4 export workflow.

## Scope Boundaries

- No live server physics rebuild from the HUD (restart-based loop is fine).
- No screenshot-diff/golden-image pipeline (future; R2 presets are its prereq).
- No server-side debug WS endpoint — client-side dump + network poses suffice
  for acceptance loops.
- `SceneDebugGUI`'s dead wall-rebuild path: delete, don't resurrect.

## Verification (Definition of Done gate)

- All new vitest suites green (`pnpm -r test`); leak tests for overlay + gizmo.
- MCP evidence per feature: `evaluate_script` on `dump()` returns landmarks
  matching the spatial contract table (platform top y=0.275, side walls x=±0.6,
  back wall z=-0.4); screenshots of top/front/side presets with wireframe on,
  showing collider boxes aligned with rendered meshes.
- One end-to-end demo: intentionally offset a wall mesh by 0.05 m, show
  `dump()` + wireframe screenshot catch it, revert.

## Implementation order

1. R1 debugDump + R5 action injection (same debug-API surface, highest leverage)
2. R2 camera presets + gizmo (makes all later screenshots comparable)
3. R3 wireframe overlay
4. R4 tuning HUD + R7 agent-writable params (same GUI/param plumbing)
5. R6 isolated render (independent, anytime after R2)

Each step lands with its own tests + MCP evidence; steps are independently
shippable.
