---
module: accounting
date: 2026-04-14
problem_type: integration_issue
component: payments
severity: critical
symptoms:
  - "BatchInsertRefundFailures P0 counter increments — balance debited, NATS publish failed, refund also failed"
  - "Player sees balance deduction but coins never spawn on table"
  - "No automated recovery path once both publish and refund fail"
root_cause: async_timing
resolution_type: code_fix
related_components:
  - background_job
  - database
tags: [outbox, nats, postgres, at-least-once, coin-loss, transactional-outbox, ce-review]
related_plan: docs/plans/2026-04-13-001-fix-batch-insert-outbox-plan.md
pr_branch: feat/batch-insert-outbox
status: merged-pending-deploy
---

# Transactional Outbox for `batch_insert` — Eliminating the P0 Coin-Loss Class

## Problem

The `BatchInsertRefundFailures` P0 alert fires when a player's balance is
debited in Postgres but the subsequent NATS publish fails **and** the
refund transaction also fails. When this happens, the player has paid for
coins they will never see on the table, and we have no automatic recovery
path.

Root cause: Postgres commit and NATS publish are two independent systems
with no cross-system atomicity. The naive "publish first, refund on
failure" path narrows the failure window but doesn't eliminate it — when
NATS is unreachable AND Postgres is simultaneously slow enough to fail
the refund tx, the coin is permanently lost.

## Solution: Transactional Outbox

Write NATS-bound events to a Postgres `nats_outbox` table **inside the
same transaction** as the balance debit. A background drainer reads the
table, publishes to NATS with at-least-once semantics, and deletes on
success. Game server dedups on `reference_id` to absorb retry duplicates.

This is the canonical answer to "Postgres commit + external message must
be atomic". Used by Kafka transactional producer, Debezium, AWS
EventBridge, and most payment systems.

## Final Architecture

```
HTTP/WS handler
    │
    ▼
accounting.Core.ProcessGameInsert(ctx, acct, count, refID, outboxWriter)
    │
    └── execTx(
         │   ├── user.DecrementForInsert        (UPDATE balance_play/cash)
         │   ├── storer.Create(accounting_log)  (audit row)
         │   └── outboxWriter(s):               (INSERT nats_outbox row)
         │       └── s.InsertOutboxRow(subj, payload, refID)
         ▼
    ) → COMMIT
    │
    └── pg_notify('outbox_new')  (best-effort, 500ms timeout)

outbox.Run (always-on goroutine)
    │
    ├── pq.NewListener on 'outbox_new' channel
    ├── fallback ticker every 5s
    ├── SELECT round-robin CTE with backoff filter + partial index
    ├── publish each row; stop-on-fail per-subject
    ├── batch DELETE on success
    └── exile to nats_outbox_dlq at attempt_count >= 10

game-server (NATS subscriber)
    │
    ├── RefIDDedup (10k FIFO Set) checks reference_id
    └── apply batch_insert → spawn coins
```

## Key Decisions

1. **Outbox, not 2PC.** NATS has no XA transaction support, and even if
   it did, 2PC's coordinator blocking would couple backend latency to
   NATS health. Outbox gives at-least-once + consumer dedup, which is
   strictly better for our workload.

2. **Flag-gated rollout but always-on drainer.** The handler flag
   (`BACKEND_OUTBOX_ENABLED`) only gates NEW writes. The drainer runs
   unconditionally so a flag rollback can never orphan committed rows.
   Idle drainer against an empty table is cheap (one empty SELECT per 5s
   tick).

3. **Per-subject ordering via CTE round-robin.** Naive `ORDER BY id` +
   stop-on-fail meant one subject's backlog could starve others. The
   `ROW_NUMBER() OVER (PARTITION BY subject ORDER BY id)` CTE interleaves
   subjects so a NATS outage on `game.room-A.*` doesn't block
   `game.room-B.*`.

4. **Exponential retry backoff.** Without backoff, a 50s NATS outage
   burned all 10 retry attempts for every row and DLQ-exiled the whole
   window. Exponential 5s * 2^attempt, capped at 300s, gives ~18m total
   time-to-DLQ — survives typical outages, still reaches DLQ within one
   on-call shift for genuine poison rows.

5. **DLQ-failure fallback.** If `moveToDLQ` fails at
   `attempt_count=MaxAttempts-1`, the row would stay at count=9 and
   `stop-on-fail` would wedge the subject forever. Fix: advance
   attempt_count past threshold anyway so the row exits the drainer's
   SELECT filter. Audit query catches orphans:
   `attempt_count >= MaxAttempts AND NOT in nats_outbox_dlq`.

6. **Graceful shutdown via cancelable ctx + WaitGroup.** Drainer
   goroutine must finish in-flight pass before `defer db.Close()` and
   `defer nc.Drain()` tear down its dependencies. Without this, the
   final DELETE hits a closed pool and rows re-publish on next boot.

7. **Partial index on (subject, id) WHERE attempt_count < 10.** Exactly
   matches the drain query predicate. Without it, sustained backlog
   forces a seq-scan every tick.

## What Went Wrong and Why It Matters

### Round 1 of `ce:review` (autofix mode) caught:

- Silent failure points (metrics added for notify_errors, panics,
  delete_errors, bump_errors)
- Tripwire on `BatchInsertRefundFailures` wasn't asserted in
  `accounting_test.go` (the test mocks `db=nil` so the tx path isn't
  exercised — added integration test to close this)

### Round 2 (full 13-reviewer) surfaced the real stuff:

| # | Finding | Severity | Reviewer agreement |
|---|---|---|---|
| 1 | Drainer used `context.Background()` — never cancelled on SIGTERM | **P0** | 4 reviewers (correctness, reliability, adversarial, maintainability) |
| 2 | Flag flip ON→OFF with pending rows = permanent coin loss | **P0** | 2 reviewers (correctness, adversarial) |
| 3 | DLQ move failure at `attempt_count=9` wedges subject forever | **P1** | 4 reviewers |
| 4 | No CLI for DLQ ops — alerts dead-end without psql | **P1** | 1 reviewer (agent-native) |
| 5 | `attempt_count` filter unindexed — seq-scan under backlog | **P1** | 2 reviewers (performance, data-migrations) |
| 6 | No retry backoff — 50s outage = whole window DLQ'd | **P1** | 1 reviewer (reliability) |
| 7 | "Chaos test" didn't actually simulate an outage | **P1** | 2 reviewers (reliability, testing) |
| 8 | OutboxWriter atomicity invariant had zero integration coverage | **P1** | 1 reviewer (testing) |
| 9 | WS `handleBatchInsert` had zero tests | **P1** | 1 reviewer (testing) — deferred |

All 8 `safe_auto` findings applied in one commit. All 8 `gated`/`manual`
P0/P1 fixed except #9 (WS handler test — deferred to follow-up;
HTTP-path tripwire still covers the same regression).

### Bugs that only surfaced when actually running integration tests

Two mistakes slipped past the original commit and `go test` (because
integration tests didn't run):

1. **Import cycle** — `atomicity_integration_test.go` was in package
   `accounting` but imported `ledgerdb` which imports `accounting`. Only
   revealed by `go test -tags=integration`. Fix: external test package
   `accounting_test`.

2. **Wrong schema column names** — `INSERT INTO accounts (id, email,
   wallet_address, ...)` was invented from memory; real schema uses
   `account_id`, no `email`, no `wallet_address`, but does have required
   `referral_code` + uniqueness constraint. Only caught by running
   against real Postgres.

**Lesson logged (and re-confirmed):** integration tests that don't run
are equivalent to comments. Compilation passing is meaningless — the
`//go:build integration` tag makes them invisible to default `go test
./...`, and the `ce:review` agents reviewed the file by reading it, not
by running it.

## Testing Outcome

| Layer | Coverage | Command |
|---|---|---|
| Unit | 413 tests across 37 packages | `go test ./...` |
| Integration (Postgres + NATS) | 38 tests across 3 packages | `go test -tags=integration ...` |
| Alert rules | 7 outbox alerts × (positive + negative) | `promtool test rules` |
| TS dedup | 11 tests | `node --test dist/nats/dedup.test.js` |

Critical invariants pinned by tests:
- At-least-once under NATS outage (chaos test with flakyPublisher)
- Balance/logs/outbox all roll back together on OutboxWriter failure
- Per-subject ordering under 50-subject × 20-msg concurrency
- DLQ-move failure advances attempt_count past threshold (subject unwedged)
- Default 10k dedup cache cap
- Non-string reference_id bypasses dedup (defensive against JSON-null)

## Non-Obvious Things Future Readers Should Know

1. **NATS channel name `"outbox_new"` is duplicated between
   `accounting.go` (string literal) and `outbox.NotifyChannel` (const).**
   Circular import prevented import-share. Comment in accounting.go
   warns on rename. Future fix: extract to `foundation/outboxchannel`
   package.

2. **Legacy publish-then-refund path still present.** Flag-gated off for
   new writes, but kept as dead code for one-commit revert safety. Unit
   8 follow-up PR deletes it one week post-prod-flag-flip.

3. **Dedup cache is in-process per game-server instance.** Simultaneous
   backend + game-server rolling restart within the drainer's retry
   window can slip duplicates past a cold cache. Bounded-probability
   residual risk — runbook advises waiting for `pending_rows=0` before
   restarting game-server.

4. **`payload_version` column exists but is hardcoded 1 everywhere.**
   Future schema evolution should bump it on write and branch on read in
   game-server — not currently wired.

5. **`BACKEND_OUTBOX_ENABLED=false` with pending rows still drains.**
   The drainer is always-on (decoupled from handler flag). Rollback is
   safe; the drainer keeps working off the queue.

6. **`admin outbox status` + `admin dlq {list,inspect,retry,delete}`
   are the operator surface.** Every P1/P2 outbox alert annotation
   points to one of these commands.

## Follow-up Work

- **Unit 8 (scheduled one week post-prod-flag-flip):** delete legacy
  publish+refund path + `BACKEND_OUTBOX_ENABLED` flag + tripwire (no
  longer needed once legacy path is gone — the whole failure mode is
  structurally impossible).
- **Residual #9:** end-to-end test for WS `handleBatchInsert`. Requires
  `ws/handler_test.go` to grow a `gameCore` fixture; HTTP-path tripwire
  covers the functional regression meanwhile.
- **`foundation/outboxchannel` extraction** to eliminate the NOTIFY
  channel string-literal duplication.
- **Multi-replica drainer safety.** Current design assumes single
  backend instance per DB. Adding `FOR UPDATE SKIP LOCKED` to the drain
  SELECT would make it safe for horizontal scale.

## Meta-Lessons for Future Outbox-Class Features

1. **First-draft outbox implementations fail the same way.** The seven
   most-common mistakes (shutdown ctx, always-on decoupling, DLQ
   fallback, retry backoff, unindexed filter, missing CLI, misnamed
   chaos test) showed up in this PR and in every Stripe / Shopify /
   Debezium post-mortem I could find. Codify these as a review
   checklist for future message-durability work.

2. **`ce:review` caught 15 real issues across two rounds — 8 of them
   from reviewer agreement (3+ agents flagging the same thing).**
   Cross-reviewer agreement was the strongest signal. Any finding with
   3+ reviewers at >0.85 confidence was always a real bug.

3. **"Integration test exists and compiles" ≠ "integration test runs".**
   Build-tagged tests skip default runs. Always `docker compose up &&
   go test -tags=integration` before claiming the invariant is covered.

4. **Naming a test what you WISH it did instead of what it DOES is a
   lie that compounds.** `TestIntegration_ChaosNATSOutage` passed for
   months while never actually simulating an outage. Reviewer only
   caught it by reading the test body — not by running it.

5. **Payment-adjacent code deserves `ce:review` with the full reviewer
   team.** The 13-reviewer round found things no single reviewer would
   — `agent-native` flagged missing CLI, `kieran-typescript` caught the
   JSON-null dedup bypass, `adversarial` constructed the flag-rollback
   coin-loss scenario. No individual reviewer covered all three.
