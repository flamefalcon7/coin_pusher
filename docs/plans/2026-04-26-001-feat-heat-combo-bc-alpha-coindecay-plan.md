---
title: "feat: Heat combo (B+C) — α=0.95 + activity-driven decay"
type: feat
status: active
date: 2026-04-26
---

# Heat combo (B+C) — α=0.95 + activity-driven decay

## Overview

Land the "B+C combo" change to the heat formula that closes the residual leak class still present after the 2026-04-25 floor=0 fix (commit `30f8505`):

1. **B (alpha bump)**: change diminishing-returns exponent `α` from 0.7 → 0.95 so 1-coin heartbeats can no longer extract a disproportionate share via `eff = decayed^α` boosting tiny inputs.
2. **C (activity-driven decay)**: introduce a second decay term keyed on coins inserted by **other players** since this player was last touched, so AFK / drive-by patterns get pushed out of share when bots (or other reals) keep pushing coins in. Heat decays at `max(λ_time × dt_sec, λ_coin × dt_coins_others)` — whichever erodes faster wins.

Combo defaults: `α = 0.95`, `coinHalfLife = 30` (i.e., 30 coins from others halves a player's heat). `halfLife` stays at 180s (combo doesn't need it lower; the activity term handles the AFK case).

The activity-decay engine machinery has already been authored locally (uncommitted) during 2026-04-26 simulator work and is gated by `WithCoinHalfLife(0)` until this plan flips the production default.

## Problem Frame

After yesterday's `guaranteed: 0.05 → 0.0` fix, `heatsim` (with PROD-faithful bot behavior — gauss(30,10s) interval, 3-15 coin uniform, 10-40min on / 2-8min off sessions, plus 15min warmup) shows the formula still leaks:

| Strategy | RTP under floor=0 only | RTP under combo |
|---|---:|---:|
| heartbeat-1c-60s | **223% LEAK** | 90.2% ok |
| heartbeat-1c-30s | **170% LEAK** | 96.4% ok |
| heartbeat-2c-60s | **172% LEAK** | 98.1% ok |
| heartbeat-3c-60s | **149% LEAK** | 83.3% ok |
| drive-by-1 | 491% LEAK (mostly cold-start) | 93.8% ok |
| drive-by-10 | 263% LEAK | 96.4% ok |
| drive-by-50 | 133% LEAK | 56.6% ok |
| drive-by-200 | 84% ok | 27.6% ok |
| constant-low-5c-30s | 92% ok | 83.2% ok |
| 24h "occasional player" aggregate (Scenario C) | 188% LEAK | 79% ok |
| 3 reals coexist (Scenario D) | 277% LEAK | 55% ok |

Single-mechanism alternatives (A: half-life=30 only; B alone; C alone) all leave at least one heartbeat strategy at RTP > 100%. Only the combo brings every measured adversarial pattern below 100%.

The RTP source is the bot-funded drop pool: when bots are the dominant heat source (PROD `crowd_scale[0]=3`, `crowd_scale[1]=4`), small real-player inserts buy a persistent share that extracts wealth from coins bots push through the field. Closing this is the precondition for re-enabling bots in PROD (currently `bot_config.kill_switch=on`).

## Requirements Trace

- **R1.** Every adversarial real-player strategy in heatsim's A/B/C/D scenario set must produce RTP < 100% with a meaningful safety margin (≤ 98%).
- **R2.** Healthy real-player strategies (constant-low, whale, mid-burst) must keep RTP in a sensible band (10-90%) — the formula still has to feel rewarding for legitimate play.
- **R3.** Bot-only baseline (Scenario A) must still distribute drop pool reasonably across bots; no single bot pathologically dominates.
- **R4.** Cross-real-player symmetry (Scenario D): two real players using the same strategy should receive comparable RTPs (within ~25% of each other) — no implicit "first-to-arrive" punishment beyond what raw heat-decay difference explains.
- **R5.** Existing heat-package tests must continue to pass (with adjustments for the new defaults where they explicitly assert α-dependent or floor-dependent values).
- **R6.** No new state stored per-player beyond an additional `LastTickerSnapshot float64` field on `PlayerHeat`. No new state outside the package.

## Scope Boundaries

- **Non-goal**: re-enabling bots in PROD. That is a separate runbook step and depends on this plan landing first.
- **Non-goal**: redesigning `halfLife`. We keep it at 180s; the activity term carries the AFK-decay job.
- **Non-goal**: re-enabling the guaranteed floor. Stays at 0.
- **Non-goal**: `ProcessGameReward` bot filtering (the "death-water" issue in TODOS) — separate work, independent leak class.
- **Non-goal**: onboarding/welcome-bonus mechanism. Tracked separately — not heat-coupled.
- **Non-goal**: a full per-coin origin tracking redesign. The activity term is a behavioral approximation, not a true source-of-funds split.
- **Non-goal**: changing the `IsBot` flag's role. It stays dormant (floor is 0) and is only consulted when `WithGuaranteed(>0)` is passed in tests/sims.

## Context & Research

### Relevant Code and Patterns

- `backend/business/core/heat/heat.go` — `HeatEngine` core. Already has functional-options pattern (`Option`, `WithGuaranteed`, `WithHalfLife`, `WithAlpha`, `WithFloorThreshold`) added in commit `30f8505`. Activity-decay machinery (`coinTicker`, `lambdaCoin`, `LastTickerSnapshot`, `WithCoinHalfLife`, `decayedLocked`) is authored locally but uncommitted.
- `backend/business/core/heat/heat_test.go` — 21 existing tests. Most are α-invariant (equal-heat ratio tests, single-player tests). Tests asserting specific share values with non-equal heat or with the floor opt-in (e.g., `TestShares_OneRealOneBot`, `TestShares_TwoRealThreeBots`, `TestShares_FloorScalesWithActivity`) need to be updated either by passing `WithAlpha(0.7)` to keep the old math, or by recomputing expectations under α=0.95.
- `backend/app/tooling/heatsim/` — Monte Carlo simulator that drives the real heat engine via virtual clock. Already supports `--alpha`, `--coin-half-life`, `--scenario=A|B|C|D|all`, 15-min bot warmup. Used to validate this plan; will be re-run as part of verification.
- `backend/business/core/bot/scheduler.go` (lines 41-67) — PROD bot envelopes. Heatsim mirrors these constants (gauss interval, uniform amount, session lifecycle). Source of truth for "what does PROD bot insertion look like".
- `backend/app/services/api/main.go:574` — `heatEngine.DistributeFrontEdgeDrop(regularFrontCount)` integration point. Heat engine consumer; no changes needed here — engine API is unchanged.

### Institutional Learnings

- 2026-04-25 fix retrospective: dropping `guaranteed` to 0 was necessary but not sufficient. The "single dial" mental model was wrong — the leak class has multiple pressure points (floor, AFK persistence, alpha-amplified small inserts), each requiring its own treatment. This plan addresses the remaining two.
- Cold-start artifact lesson: heatsim originally produced inflated LEAK numbers because real players arrived at t=0 before bots warmed up. Adding a 15-min warmup phase to the simulator was essential — the same caveat applies to any future formula tuning. Always pre-warm before measuring.
- Functional-options pattern in `heat.go` (added 2026-04-25 in commit `30f8505`) was retrofit to enable simulator-driven tuning without breaking existing call sites. This plan's activity-decay machinery follows the same pattern (`WithCoinHalfLife`).

### External References

- None used. The heat formula is a custom design; no upstream reference to chase.

## Key Technical Decisions

- **Combo (B+C), not single-mechanism**: Heatsim explicitly demonstrated each single mechanism leaves at least one strategy LEAK. Combo is the minimum sufficient design.
- **`max(λ_time × dt_sec, λ_coin × dt_coins_others)` not sum**: Using `max` instead of `+` means each decay term is a *floor on decay rate*, not a compounding accelerator. Sum would over-decay during high-activity windows and could cause real heat to vanish unrealistically fast. Max preserves the "either time or activity, whichever erodes faster" intuition.
- **`coinHalfLife = 30` (not 50, not 15)**: 30 was chosen by parameter sweep. With PROD bot rate ~1.2 coins/sec across 4 bots, this gives an effective real-time activity halflife of ~25s during normal traffic — fast enough to kill heartbeat exploits but not so fast that legit constant-low players are punished. Smaller values (15) over-punished constant-low; larger (50) failed to close heartbeat.
- **`α = 0.95`, not 1.0**: Pure linearity (α=1) eliminates anti-monopoly protection entirely. α=0.95 keeps a slight advantage for spreading bets vs. concentration (1-coin → eff=1; 100-coin → eff≈80; 1000-coin → eff≈710 vs. linear 1000). This stays meaningful at extreme scale while flattening the small-insert amplification at the bottom.
- **`halfLife` stays at 180s**: Keeping pure-time decay slow ensures players who invest meaningfully don't lose share unfairly fast during quiet periods (no bots/no other reals = no activity decay). The activity term is the primary AFK-suppression mechanism; time decay is the safety net for low-activity regimes.
- **Snapshot-after-increment for `LastTickerSnapshot`**: When player A inserts, `coinTicker += A.amount` happens BEFORE `A.LastTickerSnapshot = coinTicker`. This means A's own contribution is excluded from "others' coins" on next read, so A's own continuous inserting doesn't self-decay them. Tested via `TestActivityDecay_OwnInsertsDontSelfDecay` (added in this plan).
- **Backwards-compatible default surface**: `New()` returns combo-by-default, but the `Option` pattern means existing tests that depend on old math can opt in to the old constants explicitly. No call-site changes outside of tests.

## Open Questions

### Resolved During Planning

- **Should we also drop `halfLife`?** No. Heatsim shows combo at `halfLife=180` already passes every scenario. Dropping `halfLife` adds a new design pressure (forces players to play continuously) without RTP benefit.
- **Should activity decay count my own coins?** No — that creates self-cancellation where heartbeat players' own inserts don't accumulate. Snapshot-after-increment specifically excludes own contribution.
- **Should we pre-warm heat engine on deploy to avoid cold-start asymmetry in PROD?** No. PROD has been running continuously for weeks; the engine's in-memory state will be reset on backend restart, but bots are off (kill switch on) so there's no "real player arrives during bot warmup" risk. When bots eventually re-enable, the bot scheduler's own warmup envelope (5-15 min stagger from `scheduler.go`) handles this.
- **Do we need a feature flag / staged rollout?** No. Bots are off, so the only consumer of the new formula is real player traffic. Risk is bounded — at worst, real-player RTP drops below the combo simulator's modelled values, in which case we revert via single-line changes in heat.go.

### Deferred to Implementation

- **Exact wording of the test scenarios for opt-in-old-alpha tests** — the implementer will see which assertions break and decide unit-by-unit whether to recompute expectations under α=0.95 or pass `WithAlpha(0.7)` to preserve the floor-mechanic test intent.
- **Whether to keep or remove the locally-modified simulator scenarios** — the simulator is a tool, not production code. Implementer can land it as-is from the working tree.

## Implementation Units

- [ ] **Unit 1: Land activity-driven decay engine**

**Goal:** Land the locally-authored `heat.go` machinery that supports `max(time, activity)` decay, keeping the production default behavior unchanged (`lambdaCoin=0`). This is the infrastructure layer; Unit 3 flips the default.

**Requirements:** R6 (state shape).

**Dependencies:** None.

**Files:**
- Modify: `backend/business/core/heat/heat.go` (commit the locally-uncommitted activity-decay logic — `coinTicker` field, `lambdaCoin` field, `WithCoinHalfLife` option, `LastTickerSnapshot` field on `PlayerHeat`, `decayedLocked` helper, snapshot-after-increment in `addHeatInternal`, `decayedLocked` calls in `GetShares`/`GetShareForUser`/`Prune`).
- Test: `backend/business/core/heat/heat_test.go` (add tests below).

**Approach:**
- Local diff is already correct shape; review for edge cases (negative dtCoins guard, zero-RawHeat early return) and commit. Do NOT change the default value of `lambdaCoin` in `NewWithClock` yet (still 0). This unit lands the option-only.

**Patterns to follow:**
- Functional-option pattern matches existing `WithGuaranteed`, `WithHalfLife`, etc.
- `decayedLocked` helper consolidates the four call sites that previously inlined `RawHeat * exp(-h.lambda*dt)`.

**Test scenarios:**
- *Happy path*: `New(WithCoinHalfLife(30))`, two players each insert 10 coins, then advance time and have player B insert 100 more coins. Verify player A's heat decays via the activity term faster than time alone would predict. Specifically: A's RawHeat after this should equal `10 * exp(-max(λ_time * dt_sec, λ_coin * 100))`.
- *Edge case*: `WithCoinHalfLife(0)` (the production-pre-Unit-3 default) — engine behaves identically to pre-activity-decay implementation. All 21 existing tests still pass without modification.
- *Edge case*: A single player inserting 100 coins multiple times in a row. Their own inserts must NOT decay their own heat (snapshot-after-increment is correct).
- *Edge case*: New player added mid-simulation: their `LastTickerSnapshot` is initialized to current `h.coinTicker`, so their first decay call sees `dtCoins=0`.
- *Integration*: `WithCoinHalfLife(30)` + `WithGuaranteed(0.05)` together — activity decay applies, then floor mechanic computes from the decayed heats. Verify the two mechanisms compose correctly (no double-counting).

**Verification:**
- `go test ./business/core/heat/ -count=1` passes (21 existing + new tests).
- The 4 callsites that previously had inline decay (`GetShares`, `GetShareForUser`, `Prune`, `addHeatInternal`) now route through `decayedLocked`.

---

- [ ] **Unit 2: Land simulator updates**

**Goal:** Land the locally-authored `heatsim` rewrite — PROD-faithful bot behavior (gauss interval, uniform amount, session lifecycle), 4 named scenarios (A/B/C/D), 15-min warmup, `--coin-half-life` flag. The simulator is the verification harness for this plan.

**Requirements:** None directly. Supports R1-R4 via Unit 4 verification.

**Dependencies:** Unit 1 (the simulator imports `heat.WithCoinHalfLife`).

**Files:**
- Modify: `backend/app/tooling/heatsim/main.go` (commit the locally-uncommitted simulator rewrite).

**Approach:**
- Local diff is already correct shape; commit as-is. Simulator is non-production code; it doesn't gate the production behavior. Validation that combo passes was already done in 2026-04-26 conversation.

**Test scenarios:**
- Test expectation: none — simulator is a tool, not feature code. Verification is via Unit 4 RTP runs.

**Patterns to follow:**
- Existing tooling layout: `backend/app/tooling/{admin,executor,indexer}/`. Simulator already lives at `backend/app/tooling/heatsim/`.

**Verification:**
- `go build ./app/tooling/heatsim/` succeeds.
- `go run ./app/tooling/heatsim/ --scenario=all` produces a complete RTP table without panics.

---

- [ ] **Unit 3: Flip combo defaults in `heat.go`**

**Goal:** Change `NewWithClock` defaults so `New()` returns the combo-by-default engine. This is the actual behavior change that ships to PROD.

**Requirements:** R1, R2, R5.

**Dependencies:** Unit 1.

**Files:**
- Modify: `backend/business/core/heat/heat.go` (default constants only — the option machinery already exists).
- Modify: `backend/business/core/heat/heat_test.go` (update tests asserting α-specific or coin-decay-specific values; opt back into old constants where the test's intent is to verify the floor mechanic in isolation).

**Approach:**
- In `NewWithClock`, change `alpha: 0.7` → `alpha: 0.95` and add coin-half-life initialization equivalent to `WithCoinHalfLife(30)` (set `h.lambdaCoin = math.Log(2) / 30`).
- Update inline doc comments to explain the new defaults and reference this plan + heatsim as the rationale source.
- For each existing test that breaks, choose:
  - If the test's intent is to verify some α-invariant or coin-decay-invariant property (most equal-heat / single-player tests), no change needed.
  - If the test's intent is to verify the floor mechanic with specific share values: pass `WithAlpha(0.7), WithCoinHalfLife(0)` along with the existing `WithGuaranteed(0.05)`, recomputing expected values isn't needed because the test was verifying floor-on behavior anyway.
  - If the test's intent is a non-floor share-value assertion (e.g., `TestShares_Whale` checking whale > small): assertions that depend on relative ordering (not specific values) keep working under combo. Only specific-value assertions need updates.

**Patterns to follow:**
- Same opt-in pattern used in 2026-04-25's `TestShares_FloorScalesWithActivity`, `TestShares_OneRealOneBot`, etc. — those tests pass `WithGuaranteed(0.05)` to opt into the old floor mechanic. Mirror that pattern with `WithAlpha(0.7), WithCoinHalfLife(0)` for any test whose intent depends on the old α/decay-only math.

**Test scenarios:**
- *Happy path*: `New()` → `engine.alpha == 0.95`, `engine.lambdaCoin == math.Log(2)/30`. Add `TestNew_CombosByDefault` regression test that locks this in.
- *Happy path*: Equal-heat ratio tests pass unchanged (α-invariant property).
- *Happy path*: `TestShares_NoFloorDefault` (added in commit `30f8505`) — with combo defaults, single real + single bot equal heat → both 0.5 share. Still passes (α-invariant for equal heat).
- *Edge case*: `TestShares_Whale` — under α=0.95 the whale's share will be larger than under α=0.7. Verify `whaleShare > smallShare` still holds (it does, even more so). No assertion change needed.
- *Edge case*: Floor-mechanic tests (`TestShares_OneRealOneBot`, `TestShares_TwoRealThreeBots`, `TestShares_FloorScalesWithActivity`, `TestShares_BotDoesNotDiluteRealFloor`, `TestShares_FloorZeroWhenHeatBarelyAboveNoise`, `TestAddHeatForBot_AfterPruneRestoresFlag`, `TestDistributeFrontEdgeDrop_MixedRealAndBot`) — opt into old α and lambdaCoin=0 to keep their expected share values intact. The intent of those tests is to verify the floor mechanic, not the new combo math.
- *Integration*: `TestActivityDecay_PushesAFKOut` — new test. Three real players: A inserts 100 coins at t=0 then AFK; B inserts 5 coins every 10s for 60s. Verify A's share at t=60s under combo defaults is meaningfully lower than under `WithAlpha(0.7), WithCoinHalfLife(0)`.

**Verification:**
- `go test ./business/core/heat/ -count=1` passes.
- `go test ./... -count=1` passes (no other consumer broke).
- `go run ./app/tooling/heatsim/ --scenario=all` (no flags — uses combo defaults from `heat.New()`) reproduces the combo RTP table from the planning conversation: every real strategy < 100% RTP.

---

- [ ] **Unit 4: Cross-build, deploy, verify**

**Goal:** Ship the combo to PROD using the same flow as commit `30f8505`'s deployment yesterday — local cross-build amd64 → save tar → scp → docker load → recreate backend container.

**Requirements:** R1-R4 verified post-deploy via heatsim and (for sanity) live log inspection.

**Dependencies:** Units 1-3.

**Files:**
- None directly — operational steps.

**Approach:**
- Cross-build using `docker buildx build --platform linux/amd64 -f backend/zarf/docker/Dockerfile.backend -t coin_pusher-backend:latest --load ./backend`.
- Save: `docker save coin_pusher-backend:latest -o /tmp/coin_pusher-backend.tar`.
- SCP: `scp -i .csp/digitalOcean -o IdentitiesOnly=yes /tmp/coin_pusher-backend.tar root@146.190.104.138:/tmp/`.
- Load + restart on prod: `docker load -i /tmp/...tar && docker compose -f /opt/coin_pusher/docker-compose.services.yml up -d backend`.
- Tail logs for 30s; verify clean startup (`api server starting`, `bot scheduler started` — bot scheduler still respects kill_switch=on).
- Confirm `bot_config.kill_switch=on` is unchanged.
- No bot re-enable in this plan. Bots stay off.

**Patterns to follow:**
- Same exact deployment recipe used in 2026-04-25 commit `30f8505` (documented in conversation history; mirrored from `~/.claude/projects/.../memory/reference_deploy.md`).

**Test scenarios:**
- Test expectation: none — operational steps; verified by log inspection and continued PROD health.

**Verification:**
- Backend container reaches "api server starting" within ~10s of `docker compose up -d backend`.
- Postgres / NATS / executor / indexer / nginx / grafana / prometheus all still `Up` after backend restart.
- `bot_config.kill_switch` is still `on` after deploy.
- No error spikes in `coin_pusher-backend-1` logs in the 5-minute window post-deploy.

## System-Wide Impact

- **Interaction graph:** Heat engine is consumed by `backend/app/services/api/main.go:574` (`DistributeFrontEdgeDrop`) and `:609` (`GetShares`). Engine API is unchanged — only internal math shifts. No callers need updating.
- **Error propagation:** None. The engine has no error returns; combo doesn't introduce any.
- **State lifecycle risks:** `PlayerHeat` gains `LastTickerSnapshot float64`. In-memory only — no DB / Redis / persistence. Restart wipes heat state for all players (existing behavior). No migration.
- **API surface parity:** None. `heat.HeatEngine` is the only mechanism; no parallel implementations.
- **Integration coverage:** Heatsim is the integration test harness — drives the real engine through end-to-end scenarios. Run `--scenario=all` post-Unit-3 as the regression check.
- **Unchanged invariants:**
  - Heat engine constructor signature (`New(opts ...Option)`) — unchanged.
  - `AddHeat` / `AddHeatForBot` / `GetShares` / `GetShareForUser` / `DistributeFrontEdgeDrop` / `Prune` signatures — unchanged.
  - Floor mechanic — still default-disabled (`guaranteed=0`). `WithGuaranteed(>0)` still opts in.
  - `IsBot` flag semantics — unchanged (still last-write-wins from `AddHeat`/`AddHeatForBot`).
  - Bot kill switch — `bot_config.kill_switch=on` is preserved across deploy. Bots remain off.

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| α=0.95 lets a whale dominate small players when both are real (Scenario E not yet tested in heatsim) | Run a follow-up scenario E (1 whale + 3 small reals + 4 bots) post-deploy. If RTP for small reals collapses to <5%, dial α back toward 0.85. Reverting requires only changing one constant in `heat.go`. |
| Combo is over-tuned to current PROD bot envelopes; if bot scheduler params change, combo may stop working | Heatsim mirrors `scheduler.go` constants explicitly. Any future bot-envelope change should re-run heatsim and re-tune `coinHalfLife` if needed. Mirror this expectation in CLAUDE.md or a TODO. |
| Real PROD player traffic patterns differ materially from heatsim's strategy set | Heatsim covers the dominant adversarial classes (heartbeat, drive-by, constant-low, whale, multi-real). Edge patterns we didn't model could leak. Mitigation: monitor accounting_logs RTP by user post-deploy for the first week; alert on any user RTP > 100% over 24h. (Monitoring is separate work — see TODOS.) |
| PROD heat engine reset on backend restart pulses a brief "no-active-players" window | Bots are off; real players in this window get full share of any drops they qualify for, which is fine — small drop pool while the field has no active heat. No exploit window. |
| Heatsim cold-start bias re-emerges if simulator is run without warmup | `defaultConfig().warmupSec = 900` is hardcoded. New scenarios added later must respect this. Mention in heatsim file header doc. |

## Documentation / Operational Notes

- Inline `heat.go` comments updated to reference 2026-04-26 heatsim findings (already partially done in commit `30f8505`; extend with combo rationale).
- Update `TODOS.md`? No — combo isn't a TODO; it's resolved by this plan.
- After Unit 4 lands, the heat-leak issue is closed *for re-enabling bots*. The decision to actually flip `kill_switch=off` belongs to a separate runbook step (with monitoring in place; not in this plan's scope).
- Memory note for future Claude sessions: combo is the post-2026-04-26 default. The floor mechanism is dormant code retained for sim/test only. `α=0.95` and `coinHalfLife=30` are calibrated to current PROD bot envelopes (`scheduler.go:41-67`). Re-tune if bots change.

## Sources & References

- **Origin conversation:** 2026-04-26 ce:brainstorm session (heatsim run on baseline, A, B, C, combo with PROD-faithful bot model + 15-min warmup; combo selected based on every adversarial strategy passing RTP < 100%).
- Related code:
  - `backend/business/core/heat/heat.go` (engine — locally has uncommitted activity-decay machinery)
  - `backend/business/core/heat/heat_test.go` (21 existing tests; some need opt-in-old-alpha)
  - `backend/app/tooling/heatsim/main.go` (simulator — locally has uncommitted scenario rewrite)
  - `backend/business/core/bot/scheduler.go:41-67` (bot envelopes; heatsim mirrors these)
  - `backend/app/services/api/main.go:574,609` (heat engine consumers)
- Related commits:
  - `30f8505` — 2026-04-25 floor=0 fix and Option pattern.
  - `e1758d9` — 2026-04-25 activity-scaled floor (now superseded; floor at 0).
  - `819cb05` — 2026-04-23 wall hole trigger 10→50 (orthogonal sink fix).
- TODOS reference: `TODOS.md` — separate reliability issues unrelated to this plan.
