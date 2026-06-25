---
name: self-verification
description: Use before and after implementing any game-client (BabylonJS) or game-server (Rapier) change, so the agent proves the change works WITHOUT asking the human to look at the screen. Covers restating acceptance criteria as a failing test first, NullEngine + SimLoop headless harnesses, deterministic VFX checks, reading the running game via Chrome DevTools MCP (screenshots/console), and a definition-of-done gate. Invoke whenever you would otherwise say "please verify this looks right".
license: MIT
metadata:
  version: "1.0.0"
  domain: game-client-server
  triggers: verify, self-verify, 自我驗證, acceptance criteria, test first, mock idiom, SimLoop, headless, screenshot, console errors, deterministic, frozen clock, definition of done, MCP eyes, chrome devtools mcp, prove it works
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

## Tier 1 — Logic & counts (mock idiom, no GPU)

For anything that doesn't strictly need pixels — pooling, disposal/leak counts,
math, state transitions — mock `@babylonjs/core` and assert the manager's own
counters. Runs under `vitest` (`environment: "node"`) — fast, deterministic,
CI-safe. **Avoid `NullEngine` for the scene managers**: they use
`DynamicTexture.getContext()` / `ToonMaterial` / `ShaderMaterial` that don't load
under a bare node NullEngine (no 2D canvas, no GL). See ADR **D-003**.

```ts
import { createMockScene, snapshotPoolCounters } from "./leakHarness";
vi.mock("@babylonjs/core", async () =>
  (await import("./leakHarness")).createBabylonCoreMock());
// ...build system under test, assert snapshotPoolCounters(mgr) returns to baseline.
```

The shared harness is `game/client/src/scene/__tests__/leakHarness.ts`. For
leak/count baselines, see the `babylon-rapier-lifecycle` skill's template.

## Tier 2 — Physics behaviour (extend the existing SimLoop)

There is already a synchronous headless harness — **use it, don't rebuild it**:
`game/server/src/simulation/SimLoop.ts` + `run.ts` + `Statistics.ts`. It steps the
real `PhysicsWorld`/`SceneBuilder`/`Pusher`/`Coin` in a plain for-loop.

- For a behaviour assertion, drive N ticks and assert world state. Use the
  `onTick(tick, coins)` hook on `SimLoop` to snapshot mid-trial coin positions
  (`runTrial()` otherwise drains the coins map before returning).
- **Determinism:** the same scripted input stepped twice on the same build yields
  identical results. A **seedable RNG** exists (`simulation/Rng.ts`, `mulberry32`):
  pass `new SimLoop(config, { rng: mulberry32(seed) })`, or `run.ts --seed N`.
  The injection is opt-in and threads into `SlotMachine`/`AbilitySimulator` +
  `SimLoop`'s own randomness; unseeded keeps production behavior (crypto reels).
  Worked example: `simulation/__tests__/determinism.test.ts`.
- **Economy invariants** are simulated via `Statistics`/RTP — an RTP-band
  assertion is wired in `simulation/__tests__/economy.test.ts`; keep at least one
  so payout regressions fail fast.

> The game server **now has a `vitest` runner**: `pnpm --filter @coin-pusher/game test`
> (`game/server/vitest.config.ts`, which includes a `.js`→`.ts` resolve plugin for
> NodeNext specifiers and a 30s timeout for Rapier WASM + sim trials). See ADR **D-003**.

## Tier 3 — Deterministic VFX (frozen clock)

Particle/animation bugs ("particles not showing", "burst lingers") are time-based.
Make them reproducible:

- Advance animation/particle state with a **fixed `deltaTime`** instead of wall
  clock. `VFXManager.stepForTest(dt)` exists for exactly this (drives `update(dt)`
  without the wall-clock render observer); use `vi.useFakeTimers()` for the
  `setInterval`/`setTimeout`-driven effects (lightning).
- Assert deterministic **counts** at tick N: burst pool size
  (`getActiveBurstCount()`), ring-pool size (`getRingPoolSize()` /
  `getActiveRingCount()`). Two runs must match. Per-particle *trajectory* is not
  reproducible (per-particle `Math.random()`) — counts only.
- This catches "silently emits nothing" (count == 0 when it should be > 0)
  without a human watching. Worked example:
  `game/client/src/scene/__tests__/VFXManager.deterministic.test.ts`.

## Tier 4 — Real pixels & console (Chrome DevTools MCP)

When you genuinely need to see the rendered frame, use the **Chrome DevTools MCP**
(configured in `.mcp.json`) instead of asking the human:

1. Start the client: `pnpm --filter @coin-pusher/client dev`.
2. Navigate to the dev URL, trigger the behaviour (e.g. fire each ability).
3. **Read the console** — assert zero errors/warnings on the path you touched.
4. **Capture a screenshot** — confirm a non-empty render / expected element present.
5. Prefer reading the scrapeable debug HUD (`window.__coinpusher_debug`, gated by
   `?debug=1` — see `scene/DebugReadout.ts`) for exact counts (fps, drawCalls,
   meshes, activeCoins, activeBursts) over eyeballing.

The Chrome DevTools MCP is committed in the repo-root `.mcp.json`; setup + the
clean-boot verification ritual are in `docs/agent-eyes-mcp.md`, and the
per-ability GPU smoke runbook is `docs/solutions/workflow/gpu-smoke-screenshots.md`.

Babylon API unsure? **Read the actual `node_modules/@babylonjs/core` source** —
it's pinned to the exact installed version (v6.49), so it can't mislead you the
way a latest-tracking docs site can. (A Babylon docs MCP was evaluated and
deliberately not adopted — see ADR D-002 / `docs/agent-eyes-mcp.md`.) Guessing v6
APIs is a top source of drift.

## Definition of Done (gate before declaring complete)

- [ ] Acceptance criteria were written as assertions *before* coding.
- [ ] `pnpm --filter @coin-pusher/client test` and `pnpm --filter @coin-pusher/game test` pass.
- [ ] If client visual change: a Tier 3 deterministic check and/or a Tier 4 screenshot + clean console is attached as evidence.
- [ ] If it touches pooling/spawn/despawn: a `babylon-rapier-lifecycle` leak test passes.
- [ ] No new console errors/warnings on the affected path.
- [ ] Evidence (test output / screenshot / counts) is presented in the summary — **not** a request for the human to verify.

## Anti-patterns

- "Looks good, can you confirm?" → instead attach a screenshot + console read.
- Asserting via logs the human must read → assert in code.
- Skipping the failing-test-first step "to save time" → this is exactly where drift enters.
