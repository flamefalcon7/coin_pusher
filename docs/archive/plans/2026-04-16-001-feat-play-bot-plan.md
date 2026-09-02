---
title: Play Bot — Server-Controlled NPC Players
type: feat
status: completed
date: 2026-04-16
origin: docs/archive/brainstorms/2026-04-16-play-bot-requirements.md
deepened: 2026-04-16
reviewed: 2026-09-02
outcome: "Shipped across 15a1a17..6e0a886; ops follow-up in 2026-05-08 bot-reenable plan."
---

# Play Bot — Server-Controlled NPC Players

## Overview

Introduce server-controlled bot accounts that insert coins into the shared coin-pusher platform to avoid the "empty board / single-player feel" when real player count is low. Bots share schema with real accounts (differentiated by `role='bot'`), never use abilities or megaspeaker, and have behavior driven by a backend-embedded goroutine scheduler that reacts to current real-player WS connection count.

No new currency, no sweep job — bot balances drain naturally via play-first draw + house edge. Full operator control via `admin bot` CLI and an `.agents/skills/play-bot-admin/` skill so the AI agent can run operations via natural language.

## Problem Frame

Per origin doc: With few real players online, the shared platform stagnates — low coin density → low pusher amplitude → rare cascades → no heat competition → 5% floor dominates reward share → side-wall triggers starve (slot machine / jackpot wheel need 10-coin thresholds). New real players entering this state feel like they're playing a dead single-player game, hurting first-session stickiness.

Solution framing from brainstorm: inject "there are other players" signal through server-controlled accounts that look identical to real players from the outside, funded by the house, with economic neutrality guaranteed by (a) excluding bots from the 5% floor, (b) reporting queries filtering on role, (c) their winnings being re-consumed via play-first draw on next insert.

## Requirements Trace

All 14 success criteria (R1–R14 = origin doc success criteria 1–14) map to implementation units below:

- R1 (0-real-player bot activity) → Unit 5
- R2 (bot visibility in player list / heat broadcast) → Units 3, 5
- R3 (no bot-specific fields in client-facing API/WS shapes) → verified across all units; no schema divergence
- R4 (RTP reports filter `role != 'bot'`) → Unit 7
- R5 (liability reports filter `role != 'bot'`) → Unit 7
- R6 (bot inserts/rewards written to `accounting_logs`) → Unit 5 (uses `game.Core.ProcessBatchInsert`)
- R7 (refill uses `ActionBotRefill`) → Unit 2
- R8 (admin CLI feature-complete) → Unit 6
- R9 (kill-switch propagates ≤ 30s) → Unit 5 (per-tick config reload)
- R10 (daily cap halts refill + error log) → Unit 5
- R11 (5% floor skipped for bots) → Unit 3
- R12 (`provider_type='bot'` rejected at login) → Unit 4
- R13 (Prometheus metrics) → Unit 5
- R14 (AI agent skill exists) → Unit 8

## Scope Boundaries

Carried forward from origin doc:

- **Non-goals (v1):** bot disclosure UI; bot ability/scroll use; bot megaspeaker; board-state or heat-aware decisioning; ML/adaptive behavior; separate bot currency (shadow balance); sweep job; HTTP admin endpoint; `bot_sessions` table
- **Schema scope:** only add new `bot_config` table + extend `accounts.role`/`auth_providers.provider_type` via string values (no column additions)
- **Behavior scope:** insert coins only; jittered intervals; session-based online/offline rotation; crowd-reactive active-bot count

## Context & Research

### Relevant Code and Patterns

- **Core module shape** — mirror `backend/business/core/accounting/` exactly:
  - `bot.go` (Core struct + `NewCore`)
  - `model.go` (domain types + constants)
  - `storer.go` (Storer interface)
  - `bot_test.go` (table-driven with mockStorer)
  - `stores/botdb/botdb.go` (sqlx impl + `NewStore`)
  - Bot is tx-capable (writes balance + outbox) → follow `accounting.go:60-97` pattern with `execTx` helper and StorerFactory
- **Admin CLI template** — `backend/app/tooling/admin/dlq.go:22-53` is the canonical subcommand shape. Dispatch registered in `backend/app/tooling/admin/main.go:70`-ish switch + usage help in `main.go:37-48`.
- **Goroutine lifecycle** — outbox drainer in `backend/app/services/api/main.go:281-295` (ctx + sync.WaitGroup, shutdown ordering `main.go:1077-1079`) is the pattern for payment-adjacent goroutines. Bot scheduler uses this, not the simpler channel pattern.
- **Canonical insert path** — the authoritative game-facing insert is `game.Core.ProcessBatchInsert` (`backend/business/core/game/game.go:98-115`), which wraps `accounting.ProcessGameInsert` with input validation (zero-guard, cap checks) and `GameEventResult` shaping. Bot scheduler calls `gameCore.ProcessBatchInsert`, NOT `accounting.ProcessGameInsert` directly, to stay on the tested path.
- **Outbox writer construction** — `backend/business/web/ws/handler.go:694-705` builds the canonical `OutboxWriter` closure using `EncodeBatchInsertPayload(userID.String(), slotID, accepted, refKey)` + `TopicBatchInsert(room)`. Bot must build the same writer and pass it to `ProcessBatchInsert`. Bot scheduler hardcodes `room = "main"` (mirrors `ws/handler.go:73` and `gamegrp/gamegrp.go:48`); promote to config if multi-room lands.
- **Heat engine** — `backend/business/core/heat/heat.go:37` (`guaranteed = 0.05`), `GetShares` (~line 103), `GetShareForUser` (~line 139). Both formulas are where 5% floor is applied. `PlayerHeat` struct (no role awareness today) must gain a way to flag bots. Heat is currently added by the WS handler AFTER `ProcessGameInsert` returns (`handler.go:721`), NOT inside `ProcessGameInsert` — bot scheduler must do the same: call `heatEngine.AddHeatForBot(accountID, amount)` after `ProcessBatchInsert` succeeds.
- **Login handlers** — `backend/app/services/api/handlers/v1/usergrp/usergrp.go:41-70` (dev `Login`) + `backend/business/core/user/user.go:268-302` (`VerifyWalletLogin` / `FindOrCreateWithMeta`). Defense in depth: reject at both HTTP and core layer.
- **Metrics pattern** — `backend/foundation/metrics/metrics.go` uses `promauto.NewCounter/Gauge/HistogramVec` at package level. `WorkerRuns`/`WorkerDuration`/`WorkerErrors` vecs (`metrics.go:100-116`) accept a worker-label — reuse with label `"bot_scheduler"` to stay consistent with existing workers (`heat_broadcast`, `nonce_purge`, `reward_flush`, `rtp_monitor`).
- **Schema file** — single `backend/zarf/docker/database/schema.sql`, applied wholesale by `admin migrate`. Add `CREATE TABLE IF NOT EXISTS bot_config (...)` block. Existing unique index on ledger: `idx_accounting_logs_unique_ref_v2` on `(action_type, reference_id, currency) WHERE reference_id != ''` — bot refill `reference_id`s must be unique & non-empty.
- **Role validation** — `backend/app/tooling/admin/main.go:111-114` has the only current allowlist (`"user"` / `"admin"`). Extend to include `"bot"`.
- **RTP monitor** — `backend/app/services/api/main.go:912-920` queries `ActionGameInsert`/`ActionGameReward` without role filter today. Unit 7 adds the filter in SQL and in admin reports.

### Institutional Learnings

From `docs/solutions/integration-issues/batch-insert-outbox-2026-04-14.md` (the transactional-outbox retro):

- **Outbox is mandatory for game-facing inserts** — bypass = debited balance with no physics spawn. Bot scheduler MUST use `OutboxWriter`, not a parallel publish path.
- **Graceful shutdown is payment-critical** — use `context.WithCancel` + `sync.WaitGroup`, and order shutdown: cancel ctx → `Wait()` → then close DB/NATS. Using `context.Background()` on a goroutine that writes ledger was a 4-reviewer P0 last time.
- **Always-on workers, flag gates only new work** — kill switch should prevent *starting* new bot actions, not stop the goroutine itself. Any in-flight ledger/outbox write must finish cleanly.
- **Reference-ID dedup is per-game-server in memory** (10k FIFO, `RefIDDedup`). Bot `reference_id`s need a distinct prefix (`bot:<account_id>:<nonce>`) and must never be empty or null.
- **Integration test invisibility** — `//go:build integration` files don't run on default `go test ./...`. Document how to run them + add to CI.
- **Schema drift risk** — prior PR invented columns that didn't exist in `accounts`. Verify column names in `schema.sql` before writing seed SQL.
- **Admin CLI ships with the feature** — P1 lesson: `ce:review`'s agent-native reviewer flags missing ops tooling. Do not punt to follow-up.

### External References

None — this is all internal Go patterns with strong existing precedent.

## Key Technical Decisions

- **Goroutine pattern: ctx + WaitGroup** (not channel-only). Rationale: bot writes ledger + outbox; mid-tick shutdown cancellation must be clean. Follows outbox drainer pattern from learnings.
- **Single-instance constraint (scale-out guard).** Scheduler acquires a `pg_try_advisory_lock(bot_scheduler_lock_id)` at startup; if unavailable, logs and skips scheduler startup (API process still runs, just no bot activity from this replica). Prevents duplicate inserts if two API pods ever run simultaneously (rolling deploy, accidental replica=2). Released automatically on DB connection close.
- **Scheduler tick: 5s.** Compromise between responsiveness (kill switch propagates within one tick) and CPU overhead. Config is kept in memory with 5s TTL — every tick reloads if stale.
- **Config hot-reload: memory cache with DB-backed source of truth.** Admin CLI writes to `bot_config` table; scheduler reads at next tick boundary. No SIGHUP wiring needed.
- **Crowd counter: inject `PlayerCounter` interface.** Concrete impl returns `hub.Count() - hub.SpectatorCount()` (bots never open WS connections — Unit 4 rejects provider_type='bot' at login, so no role plumbing needed on `Connection`). Unit-tested with a stub.
- **Hysteresis on active-bot count: EMA-based.** `target = floor(ema(realPlayerCount, alpha=0.1))`, mapped through `crowd_scale`. Avoids the stuck-target failure mode of "12 consecutive identical observations" when WS churn is normal. Target is recomputed every tick; bots only transition online/offline when the EMA-derived target changes.
- **Per-bot session model:** each bot has in-memory state `{online: bool, sessionEndsAt: time, nextActionAt: time}`. Scheduler ticks decide: (a) which offline bot to bring online (if target count > current), (b) which online bot to take offline (if target count < current or session expired), (c) fire inserts for bots whose `nextActionAt` ≤ now.
- **Restart warm-up:** on scheduler startup, stagger initial bot eligibility across a 5–15 min randomized window so a cold-restart doesn't snap all bots online simultaneously with synchronized `nextActionAt`.
- **Reference ID format:** `bot:<account_id>:<unix_nano>` for inserts, `bot-refill:<account_id>:<yyyymmdd>` for refills (daily-bucketed for idempotency). Both satisfy the non-empty unique constraint on `accounting_logs`.
- **OutboxWriter reuse strategy:** depend on `backend/business/web/ws` package for `EncodeBatchInsertPayload` + `TopicBatchInsert`. A core→web import could create a cycle if accounting/game ever imports bot — audit `go list -deps` before landing Unit 5. If cycle appears, move both helpers to a new `backend/business/web/wsproto/` package (~30-line refactor). Plan starts with direct import; escalate to refactor only if cycle detected.
- **Heat 5% floor skip — last-write-wins semantics:** add `IsBot bool` to `heat.PlayerHeat` struct. `AddHeat` sets `IsBot=false` on every call; `AddHeatForBot` sets `IsBot=true` on every call. No sticky flag — this avoids: (a) the Prune()-loses-flag recovery bug, (b) permanent mis-flagging of real users if a seed bug ever calls `AddHeatForBot` with a real UUID. Role authority lives at the caller.
- **Login rejection — two layers, two call sites:** (a) `user.FindOrCreate`/`FindOrCreateWithMeta` reject `ProviderType == ProviderTypeBot` on the create path; (b) `user.VerifyWalletLogin` rejects if the account returned by `QueryByProvider` has `role='bot'` (closes the wallet-hex-collision attack surface — bot accounts seeded with 40-char-hex `provider_uid` must never grant a real wallet a login). HTTP `Login` handler adds an early reject for depth.
- **JWT middleware blocks `role='bot'` tokens:** `Authenticate` middleware (`backend/business/web/mid/auth.go`) rejects any JWT whose `claims.Role == "bot"`. Last-resort guard in case a token is ever issued. One-line change, eliminates the entire class of bot-JWT abuse.
- **`setRole` CLI does NOT accept `"bot"`:** bot accounts are created only via `admin bot seed`, never via the generic `admin set-role` command. Allowlist stays at `{"user", "admin"}` to prevent operator mistakes.
- **Admin CLI is part of initial PR**, not follow-up (P1 outbox lesson).
- **AI agent skill ships in the same PR** so natural-language ops work from day one.

## Open Questions

### Resolved During Planning

- **Scheduler tick cadence** → 5s.
- **Hysteresis on crowd transitions** → EMA (alpha=0.1) applied to real-player count; target = floor(ema) mapped through `crowd_scale`. No "N consecutive identical observations" rule.
- **`bot_config` reload mechanism** → per-tick re-read via memory cache (5s TTL); no signals.
- **20-bot display_name uniqueness** → seeder enforces: 8 bots get distinct entries from the curated pool (see Unit 6), 12 bots get distinct randomly-generated hex addresses stored as `provider_uid` (with `provider_type='bot'`, so they never collide with the `wallet` provider namespace).
- **Insert retry on failure** → silent skip + `bot_insert_failure_total` metric; next tick retries. Retries do NOT advance `nextActionAt` on recover()'d panics to avoid metric drift.
- **Testability via interface injection** → scheduler takes `Clock`, `*rand.Rand` (stdlib, seeded for test), `PlayerCounter`, `BotStorer`, `GameCore`, `HeatEngine` as dependencies; tests inject stubs. `RandSource` custom interface not needed.
- **WS hub player count accessor** → `hub.Count() - hub.SpectatorCount()`. Bots never connect via WS (Unit 4 login rejection), so no role plumbing on `Connection` is required.
- **"Real player" definition for crowd scale** → joined (non-spectator) WS connections only.
- **`IsBot` flag semantics** → last-write-wins (see Key Technical Decisions), not sticky. `AddHeat` resets to false; `AddHeatForBot` resets to true.
- **Daily cap quiescence** → when `TotalRefillToday >= daily_global_refill_cap`: (a) stop refills, (b) log ONE error at threshold crossing (tracked by `time.Since(lastCapLog) > 1h`), (c) take any bot whose balance is insufficient offline for rest of UTC day so `bot_insert_failure_total` doesn't spam.
- **Bot `reference_id` collision protection** → if two inserts in same tick body compute identical `unix_nano`, append `:<bot_index>` to disambiguate. Current single-scheduler sequential loop makes collision unlikely but the guard is cheap.

### Deferred to Implementation

- **Exact display_name pool beyond the 8 named** — implementation may tune strings after seeing the UI render. Pool can be extended later without migration (just re-running seed on empty pool).
- **Integration test Docker orchestration** — if we add an integration test for scheduler→accounting→outbox, the test runner may need a compose file. Defer until implementer sees whether unit tests cover enough.
- **Whether `RefillAll` should be a single admin CLI verb or split from `refill <account_id>`** — minor UX polish, decide at implementation.
- **Should heat-system unit tests seed a bot directly or mock `IsBot`?** Depends on heat_test.go fixture style; implementer decides.

## Implementation Units

- [ ] **Unit 1: Schema & Constants Foundation**

**Goal:** Add `bot_config` table to schema, extend role / provider_type / action_type constants so all downstream units can reference them.

**Requirements:** R7, R11, R12

**Dependencies:** None — this unit is the bedrock.

**Files:**
- Modify: `backend/zarf/docker/database/schema.sql` — append `CREATE TABLE IF NOT EXISTS bot_config (config_key TEXT PRIMARY KEY, config_value TEXT NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`. Optionally add `CHECK (role IN ('user','admin','bot'))` on `accounts.role` (consider if comfortable with the idempotent-re-migration cost).
- Modify: `backend/business/core/user/model.go` — add `RoleUser = "user"`, `RoleAdmin = "admin"`, `RoleBot = "bot"`, `ProviderTypeWallet = "wallet"`, `ProviderTypeEmail = "email"`, `ProviderTypeGoogle = "google"`, `ProviderTypeBot = "bot"` consts
- Modify: `backend/business/core/accounting/model.go` — add `ActionBotRefill = "BOT_REFILL"` const
- Modify: `backend/app/tooling/admin/main.go:111-114` — DO NOT add `"bot"` to the `setRole` allowlist. Keep it at `{"user","admin"}`. Bot provisioning goes through `admin bot seed` only.
- Test: no new test file; existing `accounting_test.go` + `user_test.go` references survive

**Approach:**
- Pure constant + schema additions. No logic changes.
- Schema addition is idempotent (`IF NOT EXISTS`) — safe on re-run.
- All stringly-typed role/provider/action references throughout the codebase stay unchanged; new code uses consts, existing string literals migrate opportunistically (not mandatory in this PR).

**Patterns to follow:**
- Existing `accounting/model.go:12-25` const block style
- Existing `user/model.go:63-68` const block style

**Test scenarios:**
- **Happy path**: `user.RoleBot` equals `"bot"`; `accounting.ActionBotRefill` equals `"BOT_REFILL"` (sanity compile-time test in `constants_test.go` optional, just asserting string values).
- **Integration**: `admin migrate` applied twice is idempotent (new schema line).
- Test expectation: none beyond existing — these are pure additions.

**Verification:**
- `admin migrate` completes without error and creates `bot_config` table
- `go build ./...` succeeds
- `grep "RoleBot" backend/` shows consts are exported

---

- [ ] **Unit 2: Bot Core Module (storage + config + account provisioning)**

**Goal:** Build `backend/business/core/bot/` with config CRUD, bot-account listing/filtering, and a `RefillBalance` helper that writes `ActionBotRefill` ledger entries through the existing accounting tx path.

**Requirements:** R6, R7, R8, R10

**Dependencies:** Unit 1

**Files:**
- Create: `backend/business/core/bot/bot.go` — `Core` struct with `NewCore(db, log)`, methods `GetConfig(ctx, key) (string, error)`, `SetConfig(ctx, key, value) error`, `ListAllBots(ctx) ([]Bot, error)`, `GetBot(ctx, accountID) (Bot, error)`, `DailyRefillTotal(ctx) (decimal.Decimal, error)` (thin wrapper over `Storer.SumRefillsSince(startOfDayUTC)` — single canonical entry point)
- Create: `backend/business/core/bot/model.go` — `Bot` struct `{AccountID, DisplayName *string, BalancePlay, BalanceCash decimal.Decimal, CreatedAt time.Time}`, `Config` struct, `ConfigKey*` consts for the 5 runtime-configurable keys only: `ConfigKeyKillSwitch`, `ConfigKeyRefillAmount`, `ConfigKeyRefillThreshold`, `ConfigKeyDailyCap`, `ConfigKeyCrowdScale`. Behavioral params (insert interval, amount, session length) are hardcoded as package-level Go constants, not DB rows.
- Create: `backend/business/core/bot/storer.go` — `Storer` interface with `QueryConfigAll`, `UpsertConfig`, `QueryBotAccounts`, `QueryBotAccountByID`, `SumRefillsSince(time) (decimal.Decimal, error)`
- Create: `backend/business/core/bot/stores/botdb/botdb.go` — sqlx impl
- Create: `backend/business/core/bot/bot_test.go` — table-driven with mockStorer
- Create: `backend/business/core/bot/stores/botdb/botdb_integration_test.go` — `//go:build integration` (run with `go test -tags=integration ./backend/business/core/bot/stores/botdb/`)
- Modify: `backend/business/core/accounting/accounting.go` — add `ProcessBotRefill(ctx, accountID, amount, referenceID)` function: writes `ActionBotRefill` ledger row + credits `balance_play`, inside `execTx`, with `QueryByReference` idempotency check (mirror `ProcessDeposit`). Bot's `RefillBalance` wraps this; no duplicate logic.

**Approach:**
- `RefillBalance` on `bot.Core` wraps `accounting.Core.ProcessBotRefill` — centralizes the "which action, which currency" policy in one place so scheduler and admin CLI both go through it. `ProcessBotRefill` handles the tx + ledger + balance credit atomically.
- `DailyRefillTotal` queries `SUM(amount) FROM accounting_logs WHERE action_type='BOT_REFILL' AND created_at >= DATE_TRUNC('day', NOW() AT TIME ZONE 'UTC')` — scheduler uses to enforce daily cap. Day boundary is UTC to avoid ambiguity across server/operator timezones.
- `GetConfig` / `SetConfig` are simple key-value upserts on `bot_config`.
- Per-bot `paused` state is NOT stored in `bot_config` (which is global config only). Instead, scheduler tracks `paused` as an in-memory set updated by admin CLI via a `/debug/bots/pause?id=<uuid>` endpoint (OR a small `bot_paused_accounts` table if we want restart-durable pause). Decision deferred below.

**Patterns to follow:**
- Core layout per `backend/business/core/accounting/accounting.go` (tx-capable, storer factory)
- Storer interface style per `backend/business/core/accounting/storer.go`
- Table-driven tests per `backend/business/core/accounting/accounting_test.go`

**Test scenarios:**
- **Happy path (unit)**: `GetConfig` returns value for existing key; `SetConfig` upserts (insert then update); `ListAllBots` returns only `role='bot'` accounts; `RefillBalance` adds to `balance_play` + writes one `ActionBotRefill` ledger entry with the given `reference_id`.
- **Edge case**: `GetConfig` for missing key returns `ErrConfigNotFound` (not empty string).
- **Edge case**: `RefillBalance` with `amount <= 0` returns validation error (defense against scheduler bugs).
- **Error path**: `RefillBalance` for non-bot account rejects with `ErrNotABot`.
- **Error path**: `RefillBalance` with duplicate `reference_id` fails with a unique-constraint error the scheduler can silently swallow (idempotent on retry).
- **Integration** (optional, `//go:build integration`): ledger entry persists; `TotalRefillToday` returns correct sum after seed of 3 entries across 2 days.

**Verification:**
- `go test ./backend/business/core/bot/...` passes
- Unit tests cover all happy + edge + error scenarios above

---

- [ ] **Unit 3: Heat System — Exclude Bots from 5% Floor**

**Goal:** Modify `heat.go` so `role='bot'` accounts never receive the guaranteed 5% floor share but still contribute to the heat denominator.

**Requirements:** R2, R11

**Dependencies:** Unit 1 (for `RoleBot` const)

**Files:**
- Modify: `backend/business/core/heat/heat.go` — extend `PlayerHeat` struct with `IsBot bool`; add a new `AddHeatForBot(userID, amount)` method (parallel to existing `AddHeat`); update `GetShares` (~line 103) and `GetShareForUser` (~line 139) to skip floor when `IsBot == true` (last-write-wins — every call re-sets the flag). Keep existing `AddHeat` signature unchanged for backward compatibility.
- Modify: `backend/business/core/heat/heat_test.go` — add scenarios including the "bot heat pruned then re-added" case
- Modify: `docs/heat-system.md` — document the bot exclusion rule

**Approach:**
- **Formula change** inside both methods: replace the current
  ```
  guaranteed = min(0.05, 1/(2*n))
  share = guaranteed + (1 - guaranteed*n) * (effectiveHeat / totalEff)
  ```
  with a per-user computation where `guaranteed` is 0 for `IsBot == true`:
  ```
  floorTotal = guaranteed * (count of non-bot players)
  for each user i:
    if user_i.IsBot: share_i = (1 - floorTotal) * effectiveHeat_i / totalEff
    else:            share_i = guaranteed + (1 - floorTotal) * effectiveHeat_i / totalEff
  ```
  Bot's `effectiveHeat_i` stays in `totalEff` (denominator), so real players' competitive share doesn't change when bots are present.
- **How scheduler signals isBot (last-write-wins):** scheduler calls `heat.AddHeatForBot(accountID, amount)` after every successful `ProcessBatchInsert`. The engine sets `IsBot=true` on every call (not sticky). Real-player heat path continues using `AddHeat`, which sets `IsBot=false` on every call. If a real user's accountID ever receives `AddHeatForBot` by mistake (bug/seed issue), the next real `AddHeat` call flips it back — no permanent corruption. Concurrent access protected by existing heat engine RWMutex.

**Patterns to follow:**
- Existing `heat.go:106-179` formula structure
- Existing test fixture style in `heat_test.go`

**Test scenarios:**
- **Happy path**: 1 real + 1 bot, equal raw heat → real gets `0.05 + 0.475 = 0.525`, bot gets `0.475` (no floor). Shares sum to 1.0.
- **Happy path**: 2 real + 3 bots, all equal raw heat → each real gets `0.05 + (0.9 * 0.2) = 0.23`, each bot gets `0.9 * 0.2 = 0.18`. Shares sum to 1.0.
- **Edge case**: 0 real + 2 bots → each bot gets `0.5` (pure proportional, no floor applied to anyone).
- **Edge case**: 1 real + 0 bots → real gets `1.0` (existing behavior preserved).
- **Edge case (flag correctness)**: `AddHeat(X)` then `AddHeatForBot(X)` → `IsBot=true` at evaluation. Reverse order → `IsBot=false`. Asserts last-write-wins.
- **Edge case (prune recovery)**: bot heat decays below 0.01 → `Prune()` removes entry → `AddHeatForBot` re-adds → share correctly excludes floor.
- **Regression**: existing non-bot tests still pass without modification.

**Verification:**
- `go test ./backend/business/core/heat/...` passes
- `docs/heat-system.md` explicitly documents "bots excluded from 5% floor"

---

- [ ] **Unit 4: Login Rejection of `provider_type='bot'`**

**Goal:** Close the attack surface where someone tries to authenticate as a bot account via any login endpoint.

**Requirements:** R12

**Dependencies:** Unit 1 (for `ProviderTypeBot` const)

**Files:**
- Modify: `backend/business/core/user/user.go` — in `FindOrCreate` and `FindOrCreateWithMeta`, early-reject `provider_type == ProviderTypeBot` with `ErrForbiddenProviderType` on both create AND lookup branches (after `QueryByProvider`, before returning a found account).
- Modify: `backend/business/core/user/user.go` — in `VerifyWalletLogin`, after `QueryByProvider(ctx, "wallet", normalizedAddr)` succeeds, check if the returned account has `role='bot'` and reject with `ErrAuthFailed`. This closes the attack where a bot's `provider_uid` hex happens to match a real wallet address. (Belt + suspenders: bot seeding uses `provider_type='bot'`, not `'wallet'`, so this path theoretically never matches a bot — but defense in depth.)
- Modify: `backend/app/services/api/handlers/v1/usergrp/usergrp.go:41-70` — `Login` handler also early-rejects (defense in depth).
- Modify: `backend/business/web/mid/auth.go` — in `Authenticate` middleware, after JWT validation: if `claims.Role == "bot"`, reject with 401. Guards against bot JWT being accepted even if issued by a future bug.
- Modify: `backend/business/core/user/user_test.go` — add rejection scenarios (create + lookup + VerifyWalletLogin with bot account).
- Modify: `backend/app/services/api/handlers/v1/usergrp/usergrp_test.go` — add rejection scenarios.
- Modify: `backend/business/web/mid/auth_test.go` (or `mid_test.go`) — add test that `role='bot'` token is rejected by `Authenticate`.

**Patterns to follow:**
- Existing error typing in `backend/business/core/user/user.go` (e.g., `ErrNotFound`)

**Test scenarios:**
- **Error path (create)**: `user.Core.FindOrCreate(ctx, NewAccount{ProviderType: "bot", ProviderUID: "x"})` returns `ErrForbiddenProviderType`.
- **Error path (lookup)**: pre-seed bot with `provider_type='bot'`; call `FindOrCreate` with same `provider_type`/`provider_uid` — still rejected (lookup branch also blocked).
- **Error path (wallet bypass attack)**: pre-seed bot account with `provider_type='bot'`, `provider_uid='0xabc...'`. Attacker signs wallet challenge from `0xabc...` and calls `VerifyWalletLogin`. `QueryByProvider(ctx, "wallet", "0xabc...")` returns no row (because bot is under `provider_type='bot'`, not `'wallet'`) → attack naturally fails. Separately test: manually insert a row under `provider_type='wallet'` linked to a `role='bot'` account, then `VerifyWalletLogin` must reject on role check.
- **Error path (JWT)**: craft a JWT with `role='bot'` manually, hit any authenticated endpoint → `Authenticate` rejects with 401.
- **Error path (HTTP)**: `POST /v1/login` with body `{"provider_type":"bot",...}` returns 400.
- **Happy path (regression)**: `"wallet"`, `"email"`, `"google"` continue to work; real users with `role='user'` or `role='admin'` pass middleware.

**Verification:**
- `go test ./backend/business/core/user/... ./backend/app/services/api/handlers/v1/usergrp/...` passes

---

- [ ] **Unit 5: Bot Scheduler Goroutine (core behavior)**

**Goal:** Implement the scheduler that manages bot sessions, inserts coins at jittered intervals, enforces kill switch & daily refill cap, emits metrics. Wire into `api/main.go` startup + shutdown.

**Requirements:** R1, R2, R6, R9, R10, R13

**Dependencies:** Units 1, 2, 3

**Files:**
- Create: `backend/business/core/bot/scheduler.go` — `Scheduler` struct with deps `{botCore, gameCore, accountingCore, heatEngine, playerCounter, clock, rng *rand.Rand, log, db *sqlx.DB (for advisory lock)}`, method `Run(ctx)` that ticks every 5s. Hysteresis tracked as two unexported fields: `targetEMA float64`, `lastTargetInt int` (no named hysteresis type).
- Create: `backend/business/core/bot/scheduler_test.go` — injection-heavy unit tests (stubs for all deps).
- Create: `backend/business/core/bot/scheduler_integration_test.go` — `//go:build integration` **REQUIRED** (not optional). End-to-end via real Postgres + outbox. This is the atomicity-critical test that the outbox retro learnings flagged as non-negotiable for payment-adjacent goroutines.
- Modify: `backend/foundation/metrics/metrics.go` — add `BotActiveCount` (gauge), `BotInsertTotalPlay` (counter), `BotRewardTotalCash` (counter — see decision below), `BotRefillTotalPlay` (counter), `BotRefillDailyCapRemaining` (gauge), `BotInsertFailureTotal` (counter), `BotInsertPanicTotal` (counter), `BotOutboxStalled` (gauge). Reuse `WorkerRuns/WorkerDuration/WorkerErrors` labeled `"bot_scheduler"`.
- Modify: `backend/business/web/ws/hub.go` — expose `Count() int` and `SpectatorCount() int` if not already public. `PlayerCounter` concrete impl returns `Count() - SpectatorCount()`. No role plumbing on `Connection`.
- Modify: `backend/app/services/api/main.go` — construct `bot.Core`, `bot.Scheduler`, acquire `pg_try_advisory_lock` at startup; if not held, skip scheduler (log WARN, API keeps running). Spawn `go scheduler.Run(ctx)` with `sync.WaitGroup` + `context.WithCancel`; shutdown: `cancel()` → `wg.Wait()` → advisory lock auto-releases on connection close → `db.Close()` → NATS drain.

**`BotRewardTotalCash` decision:** increment the counter at the reward distribution path (`backend/business/core/heat/heat.go` DistributeFrontEdgeDrop, or wherever rewards are credited to per-player `balance_cash`). Add one line filtering on role; no new unit — this adds ~3 lines to an existing file. List the file here rather than punting to a separate unit:
- Modify: `backend/app/services/api/main.go:531` (or the actual reward credit callsite) — after crediting a bot account, increment `metrics.BotRewardTotalCash`.

**Approach:**

Scheduler state per bot (in memory):
```
type botState struct {
    accountID uuid.UUID
    online bool
    sessionEndsAt time.Time   // when online, after this go offline
    offlineUntil time.Time    // when offline, after this eligible to go online
    nextActionAt time.Time    // when online, time of next insert
}
```

Scheduler tick (every 5s):
1. Re-read config from `bot.Core.GetConfig` (5 keys) with 5s memory cache.
2. If `kill_switch == "on"` → take all bots offline (set `online=false`) and return. In-flight ledger writes from prior tick already committed.
3. **Outbox-stalled preflight**: query `nats_outbox` row count; if `> 100` OR oldest row age `> 60s`, set `BotOutboxStalled=1`, skip inserts this tick (refill still runs — it's unrelated to physics spawn). Prevents silent house drain when the drainer or NATS is down.
4. Check `bot.Core.DailyRefillTotal(ctx)`; if ≥ `daily_global_refill_cap`:
   - Log error once (throttle: only if `time.Since(lastCapLog) > 1h`).
   - Take offline any bot whose `balance_play + balance_cash < refill_threshold` for rest of UTC day (prevents `BotInsertFailureTotal` spam).
   - Continue to step 7 (still tick running bots, just no new refills and no re-onboarding drained bots).
5. Otherwise, for each bot: if `balance_play + balance_cash < refill_threshold`, call `botCore.RefillBalance(accountID, refill_amount, "bot-refill:<account_id>:<yyyymmddUTC>")`. Daily-bucketed key is naturally idempotent (unique index blocks dup).
6. Compute `realPlayerCount := playerCounter.ActiveRealPlayerCount()`. Update EMA: `targetEMA = 0.9 * targetEMA + 0.1 * realPlayerCount`. Compute `target := crowd_scale[floor(targetEMA)]`. If `target == lastTargetInt`, skip transition logic; else update `lastTargetInt = target` and continue.
7. If current online count < target: pick a random offline bot whose `offlineUntil <= now` AND whose balance is above threshold, set `online=true`, `sessionEndsAt=now+random(10..40min)`, `nextActionAt=now+random(10..50s)` (initial jitter, independent of steady-state interval, to avoid synchronized first-fire).
8. If current online count > target: pick the online bot closest to `sessionEndsAt`, set `online=false`, `offlineUntil=now+random(2..8min)`.
9. For each online bot whose `sessionEndsAt <= now`: take offline.
10. For each online bot whose `nextActionAt <= now`:
    - Pick random slot (0..4), random amount (`[3, 15]` — hardcoded consts).
    - Build `refKey = fmt.Sprintf("bot:%s:%d", accountID.String(), clock.Now().UnixNano())`; if identical to last issued ref, append `:<bot_index>` to disambiguate.
    - Build `outboxWriter` closure: `InsertOutboxRow(ctx, TopicBatchInsert("main"), EncodeBatchInsertPayload(accountID.String(), slotID, amount, refKey), refKey)`.
    - Call `gameCore.ProcessBatchInsert(ctx, accountID, amount, refKey, outboxWriter)`. NOT `accounting.ProcessGameInsert` directly.
    - On success: increment `BotInsertTotalPlay` by `amount`; call `heatEngine.AddHeatForBot(accountID, amount)` (mirrors `ws/handler.go:721` pattern); set `nextActionAt = now + max(10s, min(90s, normal(30, 10)))`.
    - On failure: increment `BotInsertFailureTotal`, log warn, set `nextActionAt = now + interval` (silent skip, next tick retries).
    - On `recover()`'d panic: increment `BotInsertPanicTotal`; do NOT advance `nextActionAt` (retry next tick); don't treat `context.Canceled` as a panic — exit cleanly instead.
11. Update `BotActiveCount` / `BotRefillDailyCapRemaining` / `BotOutboxStalled` gauges, plus `WorkerRuns` / `WorkerDuration` labeled `bot_scheduler`.

**On scheduler startup** (before first tick):
- Acquire `pg_try_advisory_lock` on a well-known int64 constant. If not held, log WARN and return without spawning tick loop.
- For each bot in pool, set `offlineUntil = now + rand(5..15min)` to stagger initial eligibility and avoid cold-restart burst.

**Execution note:** Test-first for the scheduler tick loop. Each sub-behavior (refill gating, hysteresis, session lifecycle, kill-switch propagation) gets a stub-based unit test before the concrete logic lands. Clock/Rand/PlayerCounter/BotStorer/AccountingCore all injected.

**Technical design:**

> *Directional guidance, not implementation specification.*

```
tick(now):
    cfg = getConfigCached(now)
    if cfg.kill_switch == "on":
        take_all_offline()
        return
    refill_pass(cfg, now)
    targetCount = lookupCrowdScale(cfg, playerCounter.ActiveRealPlayerCount())
    if hysteresis.stableFor(targetCount, 60s, now):
        adjust_online_set(targetCount, now)
    end_expired_sessions(now)
    fire_due_inserts(now)
    emit_metrics()
```

**Patterns to follow:**
- Outbox drainer ctx+WaitGroup pattern in `api/main.go:281-295, 1077-1079`
- OutboxWriter construction in `backend/business/web/ws/handler.go:694-705`
- `metrics.WorkerRuns/WorkerDuration/WorkerErrors` labeling convention

**Test scenarios:**
- **Happy path**: 0 real players, 3 bots target → after first tick, 3 bots become online; after their `nextActionAt`, each fires one insert via a recorded `ProcessGameInsert` call with unique `reference_id` and correct `role=bot`.
- **Happy path**: online bot's `sessionEndsAt` elapses → goes offline, `offlineUntil` set to now + random 2-8min.
- **Happy path**: refill pass fires when `balance_play + balance_cash < threshold`, writes `ActionBotRefill` with `bot-refill:<id>:<yyyymmdd>` reference, increments `BotRefillTotalPlay`.
- **Edge case**: refill pass is idempotent across ticks within same day — duplicate reference_id fails silently, scheduler continues.
- **Edge case**: hysteresis prevents flapping — crowd goes 0→1→0 within 60s → target stays at bucket-for-0.
- **Edge case**: real-player count drops from 3 to 0, existing online bots don't suddenly all go offline — scheduler only adjusts on hysteresis window.
- **Error path**: `kill_switch` flipped to `"on"` mid-session → next tick takes all bots offline; no inserts fire; `BotActiveCount` drops to 0.
- **Error path**: daily cap reached → refill pass logs error (throttled), no new refill rows written, already-online bots continue running until balances drain.
- **Error path**: `ProcessGameInsert` returns error (e.g., outbox write fail) → `BotInsertFailureTotal` increments, session continues, next tick attempts another insert.
- **Integration** (**REQUIRED**, `//go:build integration`): end-to-end scheduler → `gameCore.ProcessBatchInsert` → `accounting_logs` row written → `nats_outbox` row written → `SumRefillsSince` returns expected total. Uses real Postgres. This is the atomicity-critical test the outbox retro flagged as non-negotiable.
- **Graceful shutdown**: `cancel()` called mid-tick → scheduler exits within 1s; `wg.Wait()` returns; advisory lock released; no panics.
- **Multi-instance guard**: acquire advisory lock, then spawn a second scheduler pointing at same DB → second one logs warning and exits cleanly; only first one ticks.
- **Outbox stalled**: seed 200 rows in `nats_outbox`; scheduler tick skips inserts, sets `BotOutboxStalled=1`, still performs refills.
- **Restart warm-up**: fresh scheduler start → verify no bot fires insert in first 5 minutes (staggered eligibility). Clock injection makes this deterministic.
- **Wallet collision defense**: pre-seed a bot with `provider_type='bot'` and a hex `provider_uid`; verify `VerifyWalletLogin(ctx, signer=that-hex-address)` returns `ErrAuthFailed`, not a token.

**Verification:**
- `go test ./backend/business/core/bot/...` passes unit tests
- `go test -tags=integration ./backend/business/core/bot/...` passes integration (if added)
- Local run: scheduler logs show periodic ticks with bot count, no panics

---

- [ ] **Unit 6: Admin CLI `bot` Subcommand**

**Goal:** Provide full operational control over bots from CLI: `seed`, `list`, `stats`, `pause`, `resume`, `kill-switch`, `refill`, `config`.

**Requirements:** R5, R8

**Dependencies:** Units 1, 2, 5

**Files:**
- Create: `backend/app/tooling/admin/bot.go` — `botCmd(db *sqlx.DB)` dispatcher + one helper per verb
- Modify: `backend/app/tooling/admin/main.go` — register `"bot"` case in top-level switch, add usage help line
- Create: `backend/app/tooling/admin/bot_test.go` — lightweight smoke tests per command

**Approach:**

Commands:

| Verb | Args | Implementation |
|---|---|---|
| `seed` | none | Create 20 bot accounts: 8 with curated `display_name`, 12 with `display_name=NULL`. For each bot: insert `accounts` row with `role='bot'` AND insert `auth_providers` row with `provider_type='bot'` (NOT `'wallet'`) and `provider_uid` = UUID string (or 40-char hex with `bot-` prefix to guarantee no collision with real wallet addresses). Idempotent (skip if 20 already exist with `role='bot'`). Seed initial `bot_config` rows with default values if missing. Pre-check curated `display_name` pool against existing users; if collision, pick from a fallback list. |
| `list` | optional `--json` | Print table: `account_id`, `display_name` (or truncated `provider_uid`), `last_insert_at` (from `accounting_logs` — "online" inferred as `< 2min` since last insert), `balance_play+balance_cash`, today's P/L. Does NOT read scheduler in-memory state (admin is a separate process). |
| `stats` | `--since <duration>` (default 24h) | Aggregate investment, reward, net flow, refill since timestamp (SQL with `role='bot'` filter) |
| `pause <account_id>` | account_id | Write to a new `bot_paused` set — stored in a small `bot_paused_accounts` table (single column `account_id UUID PRIMARY KEY`) so it survives restarts. Scheduler includes a lookup per-tick (cached 5s) to skip paused bots. |
| `resume <account_id>` | account_id | Delete from `bot_paused_accounts`. |
| `kill-switch on\|off` | flag | `SetConfig("kill_switch", "on"\|"off")`. |
| `refill <account_id> <amount>` | account_id, decimal | Manual refill via `botCore.RefillBalance`. Different `reference_id` format: `bot-refill-manual:<id>:<unix_nano>`. |
| `config show` | none | Print all rows from `bot_config`. |
| `config set <key> <value>` | key, value | Validate known key + value format; `SetConfig`. |

8 curated display names:
```
CoinDropMaster
0xPusher
jackpot_hunter
VitalikFan
SatoshiFTW
CascadeKing
RektLord
diamond_hands
```

**Patterns to follow:**
- `backend/app/tooling/admin/dlq.go:22-53` dispatcher + helper structure
- Existing `setRole` helper at `backend/app/tooling/admin/main.go:100-125` for how to construct storers/cores inline

**Test scenarios:**
- **Happy path**: `admin bot seed` on fresh DB creates 20 accounts; running again does not create duplicates; creates default `bot_config` rows.
- **Happy path**: `admin bot kill-switch on` sets config; `admin bot config show` reflects it.
- **Happy path**: `admin bot refill <id> 500` debits house + credits bot + writes `ActionBotRefill` ledger row.
- **Edge case**: `admin bot stats --since 1h` on empty DB returns zero totals, not an error.
- **Error path**: `admin bot refill <invalid-uuid> 500` returns error.
- **Error path**: `admin bot config set crowd_scale "not-json"` rejects on JSON parse failure (validation at CLI layer).
- **Error path**: `admin bot refill <non-bot account_id> 500` rejects (reuses `bot.Core.RefillBalance` validation).

**Verification:**
- Running each command against a dev DB produces expected side effects
- `admin bot list` after seed shows 20 rows
- `admin bot stats` after some simulated activity matches hand-computed SQL

---

- [ ] **Unit 7: RTP & Liability Report Filters**

**Goal:** Update existing reports/queries that previously had no role filter so bot activity doesn't pollute real-player RTP / house-liability numbers.

**Requirements:** R4, R5

**Dependencies:** Unit 1

**Files:**
- Modify: `backend/app/services/api/main.go:912-920` — RTP monitor (aggregate `SumByActionSince`) add `JOIN accounts a ON a.account_id = l.account_id WHERE a.role != 'bot'`.
- Modify: `backend/app/services/api/main.go:948-1025` — RTP anomaly worker (per-player `SumByPlayerSince`). Needs the same role filter; otherwise bot RTP outliers get logged as high-RTP player anomalies and pollute alert signal.
- Modify: `backend/business/core/accounting/stores/ledgerdb/ledgerdb.go:138` — `SumByPlayerSince` accepts an additional `excludeRole string` param (or a new method `SumByPlayerSinceExcludingRole`). Interface signature update in `backend/business/core/accounting/storer.go` ripples to mock storers in: `accounting_test.go`, `game_test.go`, `gamegrp_test.go`, `inventory_test.go`, `deposit_test.go` (5 files, all trivial no-op additions to existing mocks). Prefer adding a new method over changing existing signature to minimize blast radius.
- Modify: any existing admin reports in `backend/app/tooling/admin/` that compute RTP or sum balances: add role filter.
- Modify: `docs/monitoring.md` — document the filter rule.
- Modify: `docs/heat-system.md` — note bot exclusion from floor.

**Approach:**
- Targeted SQL edits at each site. Do NOT pre-build a helper (`ExcludeBotSQL()`) — only 2 call sites in main.go + admin queries; inline the JOIN fragment. Extract to helper later if ≥3 sites appear.

**Test scenarios:**
- **Integration**: insert 10 real-player `GAME_INSERT` rows and 10 bot `GAME_INSERT` rows; global RTP sum returns 10, not 20.
- **Integration (anomaly)**: create a bot with extreme per-player RTP; run anomaly worker; verify bot is NOT in the flagged list, real-player outliers still are.
- **Unit (mocks)**: each updated mock storer returns the expected filtered total when `excludeRole="bot"`.

**Verification:**
- `SELECT SUM(amount) FROM accounting_logs` vs filtered query yields expected difference after seed
- `docs/monitoring.md` explicitly calls out the rule

---

- [ ] **Unit 8: AI Agent Operations Skill**

**Goal:** Create `.agents/skills/play-bot-admin/SKILL.md` so AI agents (Claude, other tools) can operate the bot system via natural language by mapping user intent → admin CLI commands.

**Requirements:** R14

**Dependencies:** Unit 6 (CLI must exist and be stable)

**Files:**
- Create: `.agents/skills/play-bot-admin/SKILL.md`
- Create (optional): `.agents/skills/play-bot-admin/references/command-reference.md`

**Approach:**

The `SKILL.md` should include:

1. **Frontmatter**: skill name, description, trigger examples
2. **Triggers**: natural-language patterns that should invoke this skill
   - "bot 狀況 / bot status / 看看 bot"
   - "暫停 bot", "pause bot <id>", "停掉 3 號 bot"
   - "bot 補幣 / refill bot"
   - "把 bot 關掉 / kill bot / 全部停"
   - "調整 bot 活躍數 / change crowd scale"
   - "bot 今天賺多少 / bot stats today"
3. **Constraints (MUST/MUST-NOT)**:
   - MUST confirm with user before destructive actions (`kill-switch on` when currently off, `refill` with large amounts, `config set` that affects economics)
   - MUST NOT invent CLI flags not in the reference
   - MUST `admin bot config show` before calling `config set` (verify current state)
   - MUST report SQL query + result when aggregating stats, not just the summary
4. **Natural-language → command mapping table** (the meat of the skill)
5. **Safety rails**: daily cap, kill-switch semantics, how to recover from accidental kill-switch
6. **Where to find things**: `backend/business/core/bot/` for code, `docs/archive/brainstorms/2026-04-16-play-bot-requirements.md` for product intent, `docs/archive/plans/2026-04-16-001-feat-play-bot-plan.md` for implementation details

**Patterns to follow:**
- Existing `.agents/skills/*/SKILL.md` files (scan the repo — there are 15+ skills like `architecture-designer`, `senior-backend`, `devops-engineer` to mirror)

**Test scenarios:**
- Test expectation: documentation-only. Manual verification by running natural-language prompts through an AI agent with this skill loaded.
- **Happy path (manual)**: agent receives "暫停 bot 第 3 隻", skill loads, agent runs `admin bot list`, picks the 3rd account_id, runs `admin bot pause <id>`, reports success.
- **Happy path (manual)**: agent receives "看過去 24 小時 bot 表現", agent runs `admin bot stats --since 24h`, summarizes output.
- **Safety (manual)**: agent receives "把 bot 全部關掉", skill requires explicit confirmation before running `kill-switch on`.

**Verification:**
- File exists at `.agents/skills/play-bot-admin/SKILL.md`
- Scanning triggers covers all 8 admin CLI verbs
- Manual smoke test with an agent confirms at least 3 natural-language patterns resolve correctly

## System-Wide Impact

- **Interaction graph:** scheduler → `gameCore.ProcessBatchInsert` (→ `accounting.ProcessGameInsert` with `OutboxWriter`) → `nats_outbox` → outbox drainer → NATS → game server. After `ProcessBatchInsert` returns success, scheduler calls `heatEngine.AddHeatForBot` (mirrors `ws/handler.go:721` pattern for real players calling `heatEngine.AddHeat`). Bot inserts are indistinguishable from WS-originated inserts downstream of `ProcessBatchInsert`.
- **Error propagation:** insert failures silent-skip + metric + next-tick retry. Refill failures log error (throttled) + daily-cap breach halts refill pass. Scheduler-level panics are `recover()`-wrapped per tick so one bot's bug doesn't kill all bots.
- **State lifecycle risks:** bot in-memory session state is not persisted. On backend restart, all bots start offline and get re-scheduled — acceptable, short-lived state. `bot_config` (including `kill_switch`) IS persistent.
- **API surface parity:** no external API changes. WS messages, HTTP endpoints, JSON shapes all unchanged. Heat broadcast still includes bots as regular entries (their `user_id` = bot account_id, display_name = bot display_name).
- **Integration coverage:** critical end-to-end — scheduler tick → ledger write → outbox row → NATS publish → game server insert. Integration test recommended but not blocking (unit-level stub coverage is strong).
- **Unchanged invariants:**
  - `ProcessGameInsert` tx semantics, refund idempotency, `ActionGameInsert` / `ActionGameInsertRefund` flows
  - Real-player heat floor math (5% applied only to non-bots; bots added as zero-floor participants — denominator unchanged for non-bot perspective)
  - Withdraw flow — impossible for bots because `provider_type='bot'` blocks login, no JWT, no session
  - Deposit flow — bots never touch it; `balance_usdc` stays 0

## Accepted Product Risks

During `document-review` (2026-04-16), the product-lens reviewer surfaced three strategic concerns. Product owner (Rick) made explicit decisions to proceed with known tradeoffs. Recording here so the tradeoffs are traceable.

| Concern | Decision | Accepted tradeoff |
|---|---|---|
| Premise "empty board = churn" is unvalidated — no retention data cited | Ship full v1 without v0 validation pass | If the real churn driver is elsewhere (mechanics, mobile UX, reward pacing), the 8-unit build ships with zero measurable lift and permanent maintenance cost. Post-ship, team should still define a retention metric to observe and decide on roll-back/sunset if lift doesn't materialize in N weeks. |
| Covert bots as product identity (no user-facing disclosure) | Maintain covert approach | Accepted risks: (a) crypto-native users reverse-engineer bot patterns and publish findings — reputational cliff if viral; (b) multi-jurisdiction compliance exposure when real-money mode launches. Mitigation: fail-closed real-money gate already specified (Documentation / Operational Notes). |
| Scheduler addresses coin density but not side-wall triggers (slot machine / jackpot wheel) or ability visual events — the 4 stated new-player pain points are only partially addressed | Accept the gap for v1 | v1 delivers "板面有活動 + heat 競爭感" (pain points 1 & 2) but new players may still open the game to 3 "players" making small inserts with no cascade / no jackpot wheel during their first 2-3 minutes. If user feedback post-ship confirms this gap matters, a follow-up unit can add `onRealPlayerJoin` coordinated-burst behavior targeting side walls. Not in v1 scope. |

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| Outbox writer not passed to `ProcessBatchInsert` → coins debited but no spawn | Unit 5 required integration test explicitly checks `nats_outbox` row is created; payment-adjacent review required |
| Bot refill loop runaway due to config bug | `daily_global_refill_cap` hard stop + `BotRefillDailyCapRemaining` gauge alert-able from Prometheus |
| Outbox drainer down → silent house drain via refills continuing | Scheduler preflight checks `nats_outbox` depth and oldest row age; skips inserts when stalled (`BotOutboxStalled=1`); refills pause via existing daily-cap + per-bot balance gates |
| Scheduler goroutine panic cascades | Per-bot tick wrapped in `recover()`; panic metric counter; backend continues. Panic does NOT advance `nextActionAt` (avoids metric drift) |
| Race: config update mid-tick | Memory cache with 5s TTL means at most 5s of staleness; acceptable for operator use case |
| Heat formula regression affects real-player shares | Unit 3 regression scenario (all-real-player cases must match existing behavior byte-for-byte) |
| Real user mis-flagged as bot via stray `AddHeatForBot` call | Last-write-wins semantics: next legitimate `AddHeat` call restores `IsBot=false`. No permanent corruption. |
| `provider_type='bot'` auth bypass (wallet hex collision) | 4-layer defense: (a) seeder uses `provider_type='bot'` not `'wallet'`, (b) `VerifyWalletLogin` rejects `role='bot'` accounts, (c) `FindOrCreate`/`FindOrCreateWithMeta` reject on both create and lookup, (d) `Authenticate` middleware rejects `role='bot'` JWTs. `setRole` CLI does NOT allow promoting to `'bot'`. |
| Reports missing role filter leak bot activity | Unit 7 patches known sites (including per-player RTP anomaly worker); `docs/monitoring.md` note for future reviewers |
| 20 pre-seeded display_names collide with real user display_names | Seeder pre-checks pool against existing `display_name` values; fallback pool if collision |
| Scheduler keeps ticking after DB close during shutdown | `ctx+WaitGroup` pattern ensures `Wait()` before DB close (outbox retro learning); advisory lock released on connection close |
| Multi-instance scale-out double-inserts | `pg_try_advisory_lock` at scheduler startup; only one replica holds lock and ticks. Others log WARN and skip scheduler without failing startup. |
| Cold-restart burst (all bots come online simultaneously) | Staggered initial `offlineUntil` window (5–15 min) on scheduler startup |
| Future real-money mode shipped with bots still active | Add startup assertion: if `BACKEND_REAL_MONEY_ENABLED=true`, scheduler refuses to start (fail-closed). CI test asserts this invariant. |
| Bot inserts collide with real-player inserts on same slot's round-robin queue | Game server's round-robin handles this; bot inserts use unique `reference_id` so dedup works |
| Bot `reference_id` collision via same-tick `unix_nano` | Append `:<bot_index>` disambiguator if consecutive refKeys collide |

## Documentation / Operational Notes

- **Runbook entries needed:**
  - How to run `admin bot seed` on first deploy
  - How to toggle kill switch in emergency
  - How to interpret `bot_*` Prometheus metrics
  - What to do if daily cap alerts fire (investigate for runaway bug)
- **Deploy coordination:**
  - Schema migration (Unit 1) must run before code that references `bot_config`
  - First deploy with bot code: run `admin bot seed` after migration, then restart API (scheduler will pick up config)
- **Monitoring:**
  - Add `bot_refill_daily_cap_remaining < 5000` alert (would indicate we're approaching cap)
  - Add `bot_active_count == 0` check (if it stays 0 while real_player_count also 0, scheduler may be broken)
- **Future real-money mode — fail-closed structural gate**: bot scheduler checks `BACKEND_REAL_MONEY_ENABLED` env var at startup. If set to `true`, scheduler refuses to start (logs FATAL + exits scheduler goroutine; API keeps running). Companion integration test asserts this invariant. Shifts real-money-mode safeguard from "remember to kill-switch" to "process won't start" — immune to operator memory and deploy rush.

## Sources & References

- **Origin document:** [docs/archive/brainstorms/2026-04-16-play-bot-requirements.md](../brainstorms/2026-04-16-play-bot-requirements.md)
- **Related code:**
  - `backend/business/core/accounting/accounting.go` (ProcessGameInsert + OutboxWriter contract)
  - `backend/business/web/ws/handler.go:694-705` (canonical OutboxWriter pattern)
  - `backend/business/core/heat/heat.go` (5% floor formula)
  - `backend/app/services/api/main.go:281-295, 1077-1079` (ctx+WaitGroup shutdown)
  - `backend/app/tooling/admin/dlq.go` (subcommand template)
  - `backend/foundation/metrics/metrics.go` (metric registration pattern)
- **Institutional learning:** [docs/solutions/integration-issues/batch-insert-outbox-2026-04-14.md](../solutions/integration-issues/batch-insert-outbox-2026-04-14.md)
- **Spec:** [docs/spec.md](../spec.md) (game mechanics, heat system context)
