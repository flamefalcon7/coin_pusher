---
module: game-client
date: 2026-06-25
problem_type: best_practice
component: vfx
tags:
  - vfx
  - screenshot
  - mcp
  - chrome-devtools
  - smoke-test
  - self-verification
  - particles
root_cause: visual_only_bug
resolution_type: workflow
related_components:
  - VFXManager
  - DebugReadout
---

# On-demand GPU smoke screenshots per ability

## Problem

Particle/VFX bugs are **visual-only**: an ability can "silently emit nothing"
(pool count 0 when it should be > 0) or throw a console warning that never
surfaces in headless tests. Headless vitest covers *counts and determinism*
(`VFXManager.deterministic.test.ts`, the leak tests) but cannot prove pixels
actually render — that needs a real GPU.

GPU-in-CI is a non-goal (cost/flakiness). Instead this is an **on-demand,
local** ritual the agent runs via the Chrome DevTools MCP (see
`docs/agent-eyes-mcp.md`) before declaring a VFX change done.

## Ritual

For each ability touched (or all, before a VFX release):

1. Launch the client: `pnpm --filter @coin-pusher/client dev`.
2. Open the dev URL **with the HUD enabled**: append `?debug=1` so
   `window.__coinpusher_debug` is exposed.
3. Trigger the ability (admin controls / debug trigger). Abilities to cover:
   - coin **insert** / **despawn** / **land** bursts
   - **shock** wave (`playShockWave`)
   - **tornado** (`playTornado`)
   - **explosion** (`playExplosion`)
   - **lightning** (`playLightning`)
   - **super push** (`playSuperPush`)
   - reward **coin rain** / **ticket rain**
4. **Read the console** (Chrome DevTools MCP) — assert **zero** errors/warnings
   on the path you triggered.
5. **Capture a screenshot** — confirm a non-empty render (the effect is visible).
6. **Cross-check counts** via `window.__coinpusher_debug`:
   - `activeBursts > 0` while a burst-based effect is on screen,
   - `drawCalls` increases vs. idle,
   - `meshes` returns toward baseline after the effect ends (no lingering).

## Pass criteria

A clean console **and** a non-empty screenshot **and** plausible
`__coinpusher_debug` counts for every ability exercised. Attach the screenshot
+ counts as evidence — do **not** ask a human to eyeball it (see the
`self-verification` skill).

## Notes

- This is deliberately **not** automated and **not** a CI gate.
- If a count is 0 when the effect should be visible, that's the
  "silently emits nothing" class — reproduce it as a count assertion in the
  deterministic VFX test before fixing.
- Pairs with the headless harnesses: counts/determinism are proven offline;
  this proves *pixels* on demand.
