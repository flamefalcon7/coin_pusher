---
date: 2026-06-25
status: superseded
reviewed: 2026-09-02
outcome: "Became docs/plans/2026-06-25-001, shipped."
---

# AI-Assisted Dev Feedback Loop — Requirements / Handoff Brief

**Date:** 2026-06-25
**Status:** Ready for planning (feed to `ce plan`)
**Audience:** Claude Code agent (plan → work → review)

> This brief is the *input* to the plan step. It is intentionally scoped so each
> workstream can be planned, implemented, and reviewed independently. Acceptance
> criteria are written as assertions so they can become tests directly.

---

## Problem

When developing this game with an AI agent, four recurring pains:

1. Coding output drifts from the description.
2. The agent finishes and asks the human to eyeball the result, because it can't see the rendered frame.
3. Objects aren't always recycled → memory leaks.
4. VFX / particle display bugs that only show up visually.

**Root cause:** the agent codes *blind*. It can't observe the rendered scene, the
physics world state, or resource counts, so it can't verify its own work — which
forces guessing (drift) and human-in-the-loop verification, and lets leaks / VFX
bugs through. Fixing the **feedback loop** addresses all four.

## Goal

Give the agent (a) *eyes* — the ability to observe the running game (screenshots,
console, scene/world counts) — and (b) *self-verification harnesses* so it can
prove a change is correct without a human looking at the screen. Encode the house
conventions as skills so output stops drifting.

## Non-goals (v1)

- No custom BabylonJS/Rapier MCP server. Off-the-shelf MCPs + existing harnesses cover ~90%; revisit only if live scene-graph introspection is needed.
- No full visual-regression CI gate yet (golden-image diffing). Start with counts + smoke screenshots; add pixel diffing later if VFX regressions persist.
- No rewrite of `dispose()` patterns — they're already good (see Inventory). We add *tests that enforce* them, not new patterns.
- No GPU in CI. NullEngine (logic/counts) + same-platform reproducibility is enough; real-GPU screenshots run locally / on-demand via MCP.

---

## Inventory — what already exists (LEVERAGE, do not reinvent)

The agent **must** read these before planning so it extends rather than duplicates:

| Capability | Where | Notes |
|---|---|---|
| Headless physics harness | `game/server/src/simulation/SimLoop.ts`, `run.ts`, `SimClock.ts`, `Statistics.ts` | Synchronous for-loop (no `setInterval`), persistent world, reuses real `PhysicsWorld`/`SceneBuilder`/`Pusher`/`Coin`. CLI flags via `run.ts`. This is the basis for server self-verification. |
| Rapier world wrapper | `game/server/src/physics/PhysicsWorld.ts` | Fixed timestep + substeps, set solver iterations → reproducible on a fixed build. `RAPIER.init()` is async. |
| Body lifecycle (clean) | `physics/Coin.ts`, `KeyCoin.ts`, `SponsorCoin.ts` | Each `world.createRigidBody` + `createCollider` and `world.removeRigidBody(this.rigidBody)` on despawn. Rapier auto-removes attached colliders with the body. |
| Mesh pooling + disposal | `game/client/src/scene/CoinMeshManager.ts` | Thin-instance buffers, swap-and-pop, static temp objects to avoid per-frame GC; `dispose()` frees prototypes, materials, textures. |
| VFX manager (pooled) | `game/client/src/scene/VFXManager.ts` | `burstSystems` pool capped at `maxBurstSystems` (20); tracks `renderObserver`, timers; `dispose()` removes observer + disposes systems. |
| Observable discipline | `scene/TargetingReticle.ts` (and others) | Stores observer handle, `scene.onBeforeRenderObservable.remove(...)` in `dispose()`. This is the house pattern to enforce. |
| Debug overlays | `scene/SceneDebugGUI.ts`, `ToonDebugGUI.ts`, `net/DebugPanel.ts`, `net/debugConfig.ts` | Foundation for a scrapeable debug HUD. |
| Test runner (client/shared) | `vitest@^4`, `environment: "node"`, `src/**/*.test.ts`, alias `@coin-pusher/shared` | Existing tests in `net/__tests__/` are logic tests. No scene/leak tests yet. |
| Babylon version | `@babylonjs/core@^6.38` | v6 → `NullEngine`, `Tools.CreateScreenshot*` available. |

## Gaps to close

- No leak tests (client mesh/material/texture counts; server body/collider counts).
- No NullEngine-based client scene tests at all (`vitest` only covers `net/`).
- **Server has no `test` script and no `vitest` dependency** — `nats/dedup.test.ts` can't be run via `pnpm test`. Self-verification needs this fixed.
- No MCP "eyes" configured (screenshots / console / Babylon docs).
- No scrapeable runtime counters (mesh/body/particle/draw-call/FPS) the agent can read as ground truth.
- No "restate acceptance criteria as a test before coding" convention.

---

## Workstreams (each is independently plannable)

### WS1 — Give the agent eyes (MCP)
Configure project-level MCP so the agent can observe the running client.

- **Chrome DevTools MCP** (observe/debug: console, network, perf, screenshots). Primary for leak/VFX debugging.
- **Babylon docs MCP** (semantic search over Babylon API/docs) so the agent stops guessing v6 APIs — addresses drift.
- *(Optional later)* Playwright MCP for driving interactions / future visual-regression suites.

**Acceptance:**
- A committed `.mcp.json` (see Setup) so any session inherits the tools.
- Agent can: launch `pnpm --filter @coin-pusher/client dev`, open the page, capture a screenshot, and read the console with **zero errors** on a clean boot.

### WS2 — Leak detection as tests
Make leaks fail CI instead of surfacing as lag.

**Client (NullEngine + vitest):**
- Helper `createTestScene()` returns a `NullEngine` + `Scene`.
- Snapshot `scene.meshes.length`, `scene.materials.length`, `scene.textures.length` (and `scene.transformNodes.length`) as baseline.
- **Acceptance:** after 500 spawn→despawn cycles through `CoinMeshManager` (incl. key/sponsor coins) then `dispose()`, all counts return to **±1 of baseline**.
- **Acceptance:** after firing 100 bursts through `VFXManager`, `burstSystems.length ≤ maxBurstSystems` (20) and, after `dispose()`, the render observer is removed (`onBeforeRenderObservable` count returns to baseline) and all tracked timers are cleared.

**Server (Rapier):**
- **Acceptance:** after spawning + removing 1000 coins, `world.bodies.len()` and `world.colliders.len()` return to the pre-spawn baseline.
- **Acceptance:** add `vitest` (or a `tsx` assert script) + a `test` script to `game/server/package.json` so these run in CI.

### WS3 — Headless self-verification harness
Let the agent prove behaviour without a human.

- Extend the existing `SimLoop` with assertion entry points (not just stats printing) so tests can drive N ticks and assert world state.
- **Acceptance (physics replay determinism):** stepping the world with an identical scripted input sequence twice yields identical coin positions (bitwise or within 1e-6) on the same build.
- **Acceptance (economy invariant, already simulated):** wire one `Statistics`-based RTP assertion into the test suite so payout-logic regressions fail fast.
- Note: full-trial determinism needs a **seeded RNG** — check `SlotMachine.ts` / `AbilitySimulator.ts`; if they use `Math.random()`, inject a seedable RNG. Flag as a sub-task.

### WS4 — Deterministic VFX checks
- Add a "frozen clock" test mode (fixed `deltaTime`) so particle/animation state is reproducible frame-to-frame.
- **Acceptance:** with the frozen clock, a burst's particle count and the ring-pool size are deterministic at tick N across runs.
- **Acceptance (smoke, via WS1):** a real-GPU screenshot after triggering each ability shows no console warning and a non-empty render (catches "particles silently not showing").

### WS5 — Scrapeable debug HUD
Turn the existing debug GUIs into ground truth the agent can read.

- Expose a `window.__coinpusher_debug` (gated by `debugConfig`) with: FPS, draw calls (`engine.drawCalls` or instrumentation), `scene.meshes.length`, active coin count, `burstSystems.length`, and (relayed) server body count.
- **Acceptance:** the agent can read these values via Chrome DevTools MCP and assert them, instead of asking the human.

### WS6 — Spec-alignment convention (drift)
- Adopt the rule: **before writing code, restate the acceptance criteria as a failing test** (encoded in the `self-verification` skill).
- Keep increments small and each independently verifiable by WS2–WS5.

---

## MCP setup (concrete)

Commit a project `.mcp.json` at repo root (Claude Code reads it):

```jsonc
{
  "mcpServers": {
    "chrome-devtools": {
      "command": "npx",
      "args": ["-y", "chrome-devtools-mcp@latest"]
    }
    // Babylon docs MCP: add per its README once chosen. Candidates from the
    // BabylonJS forum "MCP servers are out" announcement + community repos:
    //   - official Babylon MCP suite (node materials / particles / GUI / docs)
    //   - github: immersiveidea/babylon-mcp, davidvanstory/babylonjs-mcp
    // Pick the docs/API-search one first (lowest risk, fixes API drift).
  }
}
```

Verify the server picks them up with `claude mcp list` (or `/mcp` in-session).

---

## Suggested sequencing (plan → work → review per step)

1. **WS2 client leak test** — highest value, fully offline, proves the loop works.
2. **WS2 server leak test + add server test runner** — unblocks all server self-verification.
3. **WS1 MCP eyes** — once tests exist, eyes make iteration fast.
4. **WS3 determinism + economy assertion**, then **WS5 debug HUD**, then **WS4 VFX**, then **WS6** as a standing convention.

Each step: `ce plan` → implement → `ce code review`. Land as its own PR.

## Decisions to capture (per CLAUDE.md protocol)

Propose these ADRs in `docs/decisions.md` during planning (don't pre-write the code):

- **D-XXX:** Adopt off-the-shelf MCP (Chrome DevTools) over a custom Babylon/Rapier MCP — rationale: coverage vs. maintenance; alternatives rejected (custom MCP, no MCP).
- **D-XXX:** Standardize NullEngine + count-baseline as the leak-test method; add `vitest` to the game server.

## New skills added by this brief

- `.agents/skills/babylon-rapier-lifecycle/SKILL.md` — disposal + leak-prevention conventions and the leak-test template.
- `.agents/skills/self-verification/SKILL.md` — headless verification (NullEngine + SimLoop), MCP eyes, deterministic VFX, and the "restate criteria as a test first" rule.

The agent should load the relevant SKILL.md (and pass its path to any spawned sub-agents) before working in these areas.
