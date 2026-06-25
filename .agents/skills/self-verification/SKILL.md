---
name: self-verification
description: Use before and after implementing any game-client (BabylonJS) or game-server (Rapier) change, so the agent proves the change works WITHOUT asking the human to look at the screen. Covers restating acceptance criteria as a failing test first, NullEngine + SimLoop headless harnesses, deterministic VFX checks, reading the running game via Chrome DevTools MCP (screenshots/console), and a definition-of-done gate. Invoke whenever you would otherwise say "please verify this looks right".
license: MIT
metadata:
  version: "1.0.0"
  domain: game-client-server
  triggers: verify, self-verify, 自我驗證, acceptance criteria, test first, NullEngine, SimLoop, headless, screenshot, console errors, deterministic, frozen clock, definition of done, MCP eyes, chrome devtools mcp, prove it works
  role: implementer
  scope: verification
  output-format: test-then-evidence
  related-skills: babylon-rapier-lifecycle, game-developer
---

# Self-Verification (don't ask the human to look)

The agent must verify its own work. "Please confirm it looks right" is a failure
mode — it means the change wasn't made verifiable. Turn every visual/behavioural
claim into something checkable headlessly or via MCP, and present the **evidence**.

## When to Use This Skill

- Before starting any client scene / VFX / physics change (write the test first).
- Before declaring any such change done (run the gate below).
- Whenever you're tempted to ask the human to eyeball something.

## Core rule: restate acceptance criteria as a failing test FIRST

Before writing implementation code:

1. Restate the requested behaviour as 1–3 concrete assertions (counts, positions, payouts, "no console error", "render non-empty").
2. Write them as a failing test (vitest) or a scripted check.
3. Implement until green. This kills drift — the spec is now executable.

## Tier 1 — Logic & counts (NullEngine, no GPU)

Use `NullEngine` for anything that doesn't strictly need pixels: scene-graph
construction, pooling, disposal/leak counts, math, state transitions. Runs under
`vitest` (`environment: "node"`) — fast, deterministic, CI-safe.

```ts
import { NullEngine, Scene } from "@babylonjs/core";
const engine = new NullEngine();
const scene = new Scene(engine);
// ...build system under test, assert scene.meshes.length etc.
```

For leak/count baselines, see the `babylon-rapier-lifecycle` skill's template.

## Tier 2 — Physics behaviour (extend the existing SimLoop)

There is already a synchronous headless harness — **use it, don't rebuild it**:
`game/server/src/simulation/SimLoop.ts` + `run.ts` + `Statistics.ts`. It steps the
real `PhysicsWorld`/`SceneBuilder`/`Pusher`/`Coin` in a plain for-loop.

- For a behaviour assertion, drive N ticks and assert world state (coin positions, payout counts, body counts).
- **Determinism:** the same scripted input sequence stepped twice on the same build must yield identical results. Physics is reproducible (fixed timestep + set iterations in `PhysicsWorld`). If a *full trial* diverges, the randomness is in `SlotMachine.ts` / `AbilitySimulator.ts` — inject a **seeded RNG** before asserting trial-level determinism.
- **Economy invariants** are already simulated via `Statistics`/RTP — wire at least one RTP assertion into the test suite so payout regressions fail fast.

> The game server currently has **no `test` script and no `vitest`**. First task when
> adding server tests: add `vitest` (or a `tsx` assert script) + a `test` script to
> `game/server/package.json`. Capture this as an ADR (see CLAUDE.md protocol).

## Tier 3 — Deterministic VFX (frozen clock)

Particle/animation bugs ("particles not showing", "burst lingers") are time-based.
Make them reproducible:

- Add a test mode that advances animation/particle state with a **fixed `deltaTime`** instead of wall clock.
- Assert deterministic state at tick N: burst particle count, ring-pool size, alpha/age. Two runs must match.
- This catches "silently emits nothing" (count == 0 when it should be > 0) without a human watching.

## Tier 4 — Real pixels & console (Chrome DevTools MCP)

When you genuinely need to see the rendered frame, use the **Chrome DevTools MCP**
(configured in `.mcp.json`) instead of asking the human:

1. Start the client: `pnpm --filter @coin-pusher/client dev`.
2. Navigate to the dev URL, trigger the behaviour (e.g. fire each ability).
3. **Read the console** — assert zero errors/warnings on the path you touched.
4. **Capture a screenshot** — confirm a non-empty render / expected element present.
5. Prefer reading the scrapeable debug HUD (`window.__coinpusher_debug`, gated by `debugConfig`) for exact counts (FPS, draw calls, mesh/coin/burst counts) over eyeballing.

Babylon API unsure? Query the **Babylon docs MCP** rather than guessing — guessing v6 APIs is a top source of drift (repo is on `@babylonjs/core@^6`).

## Definition of Done (gate before declaring complete)

- [ ] Acceptance criteria were written as assertions *before* coding.
- [ ] `pnpm --filter @coin-pusher/client test` (and server tests, once they exist) pass.
- [ ] If client visual change: a Tier 3 deterministic check and/or a Tier 4 screenshot + clean console is attached as evidence.
- [ ] If it touches pooling/spawn/despawn: a `babylon-rapier-lifecycle` leak test passes.
- [ ] No new console errors/warnings on the affected path.
- [ ] Evidence (test output / screenshot / counts) is presented in the summary — **not** a request for the human to verify.

## Anti-patterns

- "Looks good, can you confirm?" → instead attach a screenshot + console read.
- Asserting via logs the human must read → assert in code.
- Skipping the failing-test-first step "to save time" → this is exactly where drift enters.
