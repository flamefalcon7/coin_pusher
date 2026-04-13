---
title: "fix: Eliminate batch-insert coin-loss via Postgres outbox"
type: fix
status: active
date: 2026-04-13
deepened: 2026-04-13
---

# fix: Eliminate batch-insert coin-loss via Postgres outbox

## Overview

Replace the current "debit balance → NATS publish → refund on publish failure" flow with a Postgres-outbox pattern. The accounting transaction that debits the player's balance will also, atomically, write the `batch_insert` event into an `nats_outbox` table. A background worker drains the outbox and publishes to NATS with at-least-once semantics. This closes the window where a player's coins can be permanently lost when NATS publish AND refund both fail — the failure mode the existing `coinpusher_batch_insert_refund_failures_total` P0 alert exists to detect.

## Problem Frame

Today's batch-insert flow:

1. `ProcessGameInsert` commits a Postgres tx that decrements balance + writes `accounting_logs` rows.
2. Handler calls `h.nc.Publish(TopicBatchInsert, ...)`.
3. If publish returns error, handler calls `RefundBatchInsert` (another Postgres tx) to credit the balance back.
4. If the refund also fails, `metrics.BatchInsertRefundFailures.Inc()` fires and coins are permanently lost.

The root cause is that **step 1 (Postgres commit) and step 2 (NATS publish) are not atomic**. Any failure mode that breaks step 2 while step 1 has already committed — NATS broker outage, process crash between commit and publish, decimal-parse error in the refund path, DB overload preventing the refund tx — results in "balance debited but insert event never emitted". The refund path is a best-effort compensating transaction that can itself fail.

The outbox pattern closes this by collapsing steps 1+2 into a single Postgres tx: the event to publish is written as a row in the same tx that debits balance. A worker polls the outbox and publishes to NATS. If publish fails, the row stays pending and retries indefinitely. The failure mode "balance debited, event never published" becomes impossible.

This is not 2PC — Postgres is the single source of truth; NATS publish is now an eventually-consistent delivery problem, not a consistency problem. Eventual publish latency (~poll interval) is acceptable because the game server already tolerates NATS-delivery latency in the ms range, and the existing WS ack to the client is independent of the game-server receiving the insert event.

## Requirements Trace

- R1. Eliminate the `BatchInsertRefundFailures` trigger condition structurally — balance debit and event emission must be atomic. Enforced by the tripwire regression test (Unit 6) asserting the counter stays at 0 across all batch-insert tests.
- R2. Preserve per-subject (per-room) event ordering: events on the same NATS subject must reach the game server in commit order. Per-subject failures do not leapfrog other subjects.
- R3. Preserve idempotency: a retried outbox publish must not cause the game server to apply a batch-insert twice. Bounded by DLQ after 10 failed attempts so a poison-pill row can never block its subject indefinitely.
- R4. Preserve the current WS/HTTP ack contract — client still sees `balance_play`, `balance_cash`, `play_debited`, `cash_debited` on success.
- R5. Observability: metrics for queue depth, publish latency, publish failures, DLQ growth, oldest-pending age, drainer liveness (`last_tick_timestamp`), and table size.
- R6. Deployable without coin loss during rollout — no window where outbox exists but isn't being drained, or where both old and new code emit the same event twice.

## Scope Boundaries

**In scope:**
- `batch_insert` event path only (the one with refund semantics today).
- `nats_outbox` table, outbox-aware accounting write, outbox drainer worker, metrics, removal of the old inline-publish-then-refund code path in both WS and HTTP handlers.

**Out of scope (non-goals):**
- Other `nc.Publish` sites (scroll, shock, tornado, explosion, lightning, super_push, clear_all, fill_platform, spawn_stack, update_scene_objects). These are fire-and-forget cosmetic/ability events that don't debit balance; losing one is a UX glitch, not a coin loss. Applying outbox to them is a future consideration, not this plan.
- Switching batch_insert to JetStream. JetStream persists on the broker side, but the client-side atomicity gap (Postgres commit vs. JetStream ack) remains, so JetStream alone doesn't solve R1. Outbox makes JetStream redundant for this path.
- Refactoring `RefundBatchInsert` / `ProcessGameInsertRefund` — these stay in the codebase for now as dead code after handler flip, to be removed in a follow-up once production confirms zero regressions. Keeping them during rollout gives a one-commit revert path.
- Multi-worker horizontal scaling of the outbox drainer. Initial deployment runs a single worker (piggy-backed in the API service process, matching the heat-broadcast / nonce-purge pattern). Multi-worker coordination is a future concern.

## Context & Research

### Relevant Code and Patterns

- `backend/business/core/accounting/accounting.go:68` — `execTx` wraps balance decrement + log writes in a single Postgres tx. Outbox insert slots into this tx.
- `backend/business/core/accounting/accounting.go:131` — `ProcessGameInsert` is the target tx. The new outbox row must be written inside the same `execTx` callback.
- `backend/business/web/ws/handler.go:627` (`handleBatchInsert`) and `:706` (publish + refund path) — WS handler to simplify.
- `backend/app/services/api/handlers/v1/gamegrp/gamegrp.go:136`–`:158` — HTTP handler, symmetric path.
- `backend/business/web/ws/topics.go:22` — `TopicBatchInsert(room)` is the NATS subject the worker must publish on.
- `backend/app/services/api/main.go:326`, `:406`, `:561` — three existing ticker-based background goroutines (heat broadcast, nonce purge, reward flush). The outbox drainer follows this exact shape.
- `backend/app/tooling/admin/main.go:73` — `migrate` command runs `zarf/docker/database/schema.sql` idempotently (`CREATE TABLE IF NOT EXISTS`). New table is appended to this file.
- `backend/foundation/metrics/metrics.go:138` — `BatchInsertRefundFailures` counter definition. The P0 alert stays in place as a safety net even after outbox deployment.
- `backend/foundation/nats/nats.go` — existing core-NATS connection with reconnect handling. Worker uses the shared `*nats.Conn`.
- `backend/foundation/database/` — `ExecTx` helper used by `accounting.execTx`.

### Institutional Learnings

- `docs/plans/2026-04-12-002-fix-unified-wallet-review-findings-plan.md` — prior round of review on this exact refund code path. Documents why parse-errors on `result.PlayDebited`/`CashDebited` now fail loudly (so the outbox removal preserves observability on that path until handler is simplified).
- Existing convention: `accounting_logs.reference_id` is the idempotency key; uniqueness is enforced. Outbox `reference_id` must use the **same** value as the accounting log so the game server's downstream dedup (if any) and log-outbox cross-lookup both work.
- Project memory — "Never split serialization boundaries across agents": the outbox payload encoding (msgpack for `BatchInsertPayload`) must be owned by one place, ideally a single helper in `business/web/ws/` reused by both writer (accounting tx path) and reader (drainer).

### External References

Not needed — outbox is a well-understood pattern, the codebase already has all required primitives (`execTx`, `*nats.Conn`, ticker goroutines, single-file schema migration), and the scope is narrow (one event type).

## Key Technical Decisions

- **Outbox row written inside `ProcessGameInsert`'s `execTx`, not in the handler.** Rationale: the tx is the atomicity boundary. Writing from the handler after `ProcessGameInsert` returns re-introduces the same two-system gap we're closing.
- **Payload encoded at write time, not at publish time.** The outbox stores the exact bytes the worker will publish (pre-serialized msgpack). Rationale: the writer has the typed struct; the drainer is a generic loop that shouldn't know event shapes. Also freezes the wire format at commit time — a later code change to the payload struct can't corrupt in-flight events.
- **Single worker, in-process, `LISTEN/NOTIFY`-driven with slow-tick fallback.** Matches existing pattern for in-process workers but avoids the idle-QPS cost of pure polling. Writer calls `pg_notify('outbox_new', '')` after tx commit; drainer `LISTEN`s and reacts immediately. A 5-second fallback ticker still runs to catch any missed notifications (writer crash between commit and notify, listener reconnection gap). Rationale: 0 QPS when idle, near-zero latency when active, no long-term cost if the outbox table grows.
- **Per-subject ordering, not global batch-stop-on-fail.** Drainer groups fetched rows by `subject` and processes each subject independently. A publish failure on subject A does NOT block draining of subjects B, C, D. Within a single subject, stop-on-fail preserves order. Rationale: coin-pusher's ordering requirement is per-room (`game.$room.cmd.batch_insert`), not global. One stuck room shouldn't freeze all rooms.
- **Bounded retry with DLQ.** After `attempt_count >= 10`, a row is moved to `nats_outbox_dlq` with full error context and removed from the main table. This prevents a permanently-malformed row from blocking its subject indefinitely. DLQ growth triggers a P1 alert for human intervention. Rationale: unbounded retry is a latent outage multiplier; DLQ makes "poison pill" rows observable and non-blocking.
- **At-least-once delivery; game server must be idempotent on `reference_id`.** Rationale: worker-side "mark sent after publish" vs. "publish then mark sent" can't both be atomic. The second ordering gives at-least-once (safer: never lose; may rarely duplicate). Game server already receives `reference_id`; verify it dedups (Unit 5).
- **Drainer liveness exposed as metric.** Worker updates `coinpusher_outbox_last_tick_timestamp` gauge on every iteration (including empty-outbox ticks). Alert fires when `time() - last_tick > 10s`. Rationale: a silently-panicked goroutine otherwise goes undetected until `pending_rows`/`oldest_pending_seconds` alerts fire on 60s+ timescale. Tick-timestamp gives early warning.
- **Panic recovery in drainer loop.** The outermost loop has `defer recover()` + log + restart. Rationale: a single malformed row or transient DB hiccup shouldn't require a full process restart to recover drainer availability.
- **Delete sent rows inline after publish.** Rationale: keeps the hot path small; no separate cleanup job. Trade-off: loses a replay log. If replayability matters later, switch to `sent_at` soft-delete + cleanup job.
- **Retain `RefundBatchInsert` code after flip (revert path).** Rationale: first production deploy of the outbox path is the riskiest moment; a one-commit revert to restore the publish+refund path is cheaper than forward-fixing under fire. Remove in a follow-up PR after production bakes for 1 week.
- **Keep `BatchInsertRefundFailures` metric + P0 alert in place post-deploy.** Rationale: after handler simplification, the counter should never increment (the refund code path no longer runs). Any increment = regression or revert-path re-activation, both worth paging on.
- **Dual-write phase NOT used.** Rationale: dual-write (outbox + inline publish simultaneously) would either require game-server dedup on this path (may not exist yet) or double-deliver events. Instead, deploy worker + handler flip together in a single coordinated deploy, using the feature-flag gate described in Rollout.

## Open Questions

### Resolved During Planning

- **Outbox table granularity — per-event-type vs. one-table-for-all?** Resolved: one table (`nats_outbox`) + one DLQ table (`nats_outbox_dlq`). Subject column lets the drainer group per-subject. Other events (scroll/shock/etc.) are out of scope but the schema doesn't preclude reusing it later.
- **Core NATS vs. JetStream for the drainer's publish?** Resolved: core NATS. The outbox IS the durability layer; JetStream would double-store. Matches existing publish style on all other topics.
- **Who owns the msgpack encoding call?** Resolved: a new helper colocated with `TopicBatchInsert` in `backend/business/web/ws/` (importable by the handler that constructs the outbox row). Keeps wire-format ownership in one place.
- **Should the worker run in the API service process or a separate binary?** Resolved: API service process, piggy-backed like existing background goroutines. Separate binary is an option later if scaling pressure appears.
- **Poll vs. push for drainer trigger?** Resolved: `LISTEN/NOTIFY` primary + 5s fallback ticker. Eliminates idle QPS, preserves correctness via fallback.
- **Ordering model — global vs. per-subject?** Resolved: per-subject. Coin pusher only requires per-room order; global stop-on-fail would make one stuck room freeze all rooms.
- **Unbounded retry vs. bounded + DLQ?** Resolved: bounded (attempt_count cap at 10) + DLQ table. Unbounded retry is a latent outage amplifier for poison-pill rows.
- **OutboxWriter callback signature — domain-aware or domain-pure?** Resolved: domain-pure (`func(ctx, Storer) error`). Accounting core stays NATS-ignorant; handler layer binds subject and payload.
- **Drainer liveness detection?** Resolved: `last_tick_timestamp` gauge updated every pass (including empty) + 10s staleness alert. Detects silent goroutine death faster than pending-row-based alerts.

### Deferred to Implementation

- **Exact column list for `nats_outbox`.** Minimum: `id bigserial PK, subject text, payload bytea, reference_id text, created_at timestamptz, attempt_count int, last_error text`. Final shape (e.g., whether to add `last_attempted_at`, `account_id` for debug) decided during Unit 1.
- **Does the game server already dedupe on `reference_id`?** Verify by inspection during Unit 5. If yes, no change needed. If no, add game-server-side dedup cache (scope: separate sub-unit, may bump plan to Unit 8).
- **Batch size for `SELECT ... LIMIT N`.** Start with 100; tune with live metrics.
- **Should we emit the outbox row from `ProcessBatchInsert` (game core) or `ProcessGameInsert` (accounting core)?** The outbox row must sit inside the same tx as the balance debit, so it has to be written inside `ProcessGameInsert` (accounting), but the `Topic` + payload-encoding are WS-layer concerns. Resolve via dependency inversion: accounting takes a `func(tx) error` outbox-writer callback supplied by the caller (handler or game core wrapper). Finalize shape during Unit 2.
- **Feature flag mechanism.** Codebase doesn't appear to have a flag system. Simplest: env var `BATCH_INSERT_OUTBOX_ENABLED=true`. Decide final name/location during Unit 6.

## High-Level Technical Design

> *This illustrates the intended approach and is directional guidance for review, not implementation specification. The implementing agent should treat it as context, not code to reproduce.*

```mermaid
sequenceDiagram
    participant C as Client
    participant H as WS/HTTP Handler
    participant A as Accounting Core (execTx)
    participant DB as Postgres
    participant W as Outbox Drainer (goroutine, 50ms tick)
    participant N as NATS
    participant GS as Game Server

    C->>H: batch_insert(count, refID)
    H->>A: ProcessGameInsert(ctx, acctID, count, refID, outboxWriter)
    A->>DB: BEGIN TX
    A->>DB: UPDATE accounts SET balance = ...
    A->>DB: INSERT INTO accounting_logs (...)
    A->>DB: INSERT INTO nats_outbox (subject, payload, ref_id)
    A->>DB: COMMIT
    A-->>H: GameEventResult (balances + split)
    H-->>C: ack (balance_play, balance_cash, play_debited, cash_debited)

    Note over A,DB: After COMMIT, accounting fires pg_notify('outbox_new', '')

    par Drainer reacts on LISTEN notification
        DB-->>W: NOTIFY outbox_new
    and Fallback slow-tick (every 5s)
        W->>W: backup tick
    end

    W->>DB: SELECT ... FROM nats_outbox ORDER BY subject, id LIMIT 100
    Note over W: Group rows by subject; process each subject independently
    loop Per subject group
        W->>N: Publish(subject, payload[0])
        alt Publish ok
            W->>DB: DELETE FROM nats_outbox WHERE id IN (...successful ids)
        else Publish failed
            alt attempt_count + 1 >= 10
                W->>DB: INSERT INTO nats_outbox_dlq ...; DELETE FROM nats_outbox WHERE id = ...
                Note over W: Row exiled; subject unblocked; P1 alert on DLQ growth
            else
                W->>DB: UPDATE nats_outbox SET attempt_count++, last_error=...
                Note over W: Stop processing this subject for now; other subjects continue
            end
        end
        N-->>GS: batch_insert event (idempotent on ref_id)
    end
    W->>W: update last_tick_timestamp gauge
```

Key invariants to preserve while reviewing each implementation unit:
- Ack to client happens on tx commit, not on publish success. Client no longer observes publish failures.
- The outbox row and the accounting_logs rows share `reference_id`. Any cross-correlation (debug, audit, re-emission) is a single SQL query away.
- If the drainer is down, inserts still succeed; events queue in the outbox. Recovery is automatic on worker restart.
- If Postgres is down, the request fails before tx commit — no balance debit, no outbox row, no partial state.

## Implementation Units

- [ ] **Unit 1: `nats_outbox` schema + admin migrate**

**Goal:** Add the outbox table to the schema. No code reads/writes it yet — this lands first so later units have the table available in dev, staging, and prod.

**Requirements:** R1 (foundation), R6 (deployable without coupling).

**Dependencies:** None.

**Files:**
- Modify: `backend/zarf/docker/database/schema.sql`
- Test: n/a (schema-only change; verified via `admin migrate` dry run + `\d nats_outbox` in psql during Unit 3).

**Approach:**
- Append two `CREATE TABLE IF NOT EXISTS ...` blocks at the end of `schema.sql`.
- `nats_outbox` columns (directional): `id bigserial primary key, subject text not null, payload bytea not null, reference_id text not null, created_at timestamptz not null default now(), attempt_count int not null default 0, last_error text, last_attempted_at timestamptz, payload_version smallint not null default 1`.
- `nats_outbox_dlq` columns: same shape plus `dlq_reason text not null, moved_at timestamptz not null default now(), original_id bigint not null`. Rows land here after `attempt_count >= 10` or on explicit operator action.
- Indexes:
  - `nats_outbox`: `(subject, id)` composite index for the per-subject ordered drain query (replaces reliance on PK alone); `(reference_id)` for cross-lookup with `accounting_logs.reference_id`.
  - `nats_outbox_dlq`: `(moved_at DESC)` for operator review.
- Idempotent (`IF NOT EXISTS`). `admin migrate` is safe to re-run.

**Patterns to follow:**
- `accounting_logs` table at `backend/zarf/docker/database/schema.sql:158` — similar shape, similar reference_id treatment.
- Existing admin migrate flow — no separate migration file needed.

**Test scenarios:**
- Test expectation: none — schema DDL change; validated by `admin migrate` succeeding and subsequent units' tests exercising both tables.

**Verification:**
- `admin migrate` runs to completion on a fresh DB without error.
- Re-running `admin migrate` on a populated DB is a no-op.
- `\d nats_outbox` and `\d nats_outbox_dlq` show the expected columns + indexes.
- `EXPLAIN SELECT ... ORDER BY subject, id LIMIT 100 FROM nats_outbox` shows the composite index is used.

- [ ] **Unit 2: Accounting-layer outbox writer callback**

**Goal:** Extend `ProcessGameInsert` to accept an optional `OutboxWriter` callback that runs inside the same `execTx`. When provided, the callback inserts the outbox row using the tx-bound storer.

**Requirements:** R1, R2.

**Dependencies:** Unit 1 (table exists).

**Files:**
- Modify: `backend/business/core/accounting/accounting.go`
- Modify: `backend/business/core/accounting/storer.go` (add `InsertOutboxRow(ctx, tx, subject, payload, referenceID) error` to the Storer interface)
- Modify: `backend/business/core/accounting/stores/ledgerdb/` (implement the new storer method)
- Test: `backend/business/core/accounting/accounting_test.go` (extend `TestProcessGameInsert` coverage)

**Approach:**
- `OutboxWriter` signature is **domain-pure**: `type OutboxWriter func(ctx context.Context, s Storer) error`. Accounting only knows "call fn, fn may write a row via Storer". NATS subjects, topic names, and payload shape are bound by the handler layer, not by accounting. Accounting stays domain-ignorant.
- The core calls the callback inside `execTx` **after** the accounting_logs writes. If the callback returns an error, the tx rolls back — balance, logs, and outbox row all reverted together.
- **After** `execTx` returns success (i.e., tx committed), accounting fires `pg_notify('outbox_new', '')` via a plain `db.Exec`. If notify fails (Postgres weirdness, connection blip), we log and move on — the 5s fallback tick in the drainer catches it. Notify is best-effort, not load-bearing for correctness.
- `nil` callback = unchanged behavior (useful for unit tests + the deposit/refund paths that don't need outbox).
- Keep the public signature of `ProcessGameInsert` in one place; update both call sites (game.Core.ProcessBatchInsert and any tests).

**Patterns to follow:**
- Existing `MetricRecorder` callback plumbed through `accounting.Core` at `backend/business/core/accounting/accounting.go:25`, `:54` — same idea, different lifecycle (metric runs after tx, outbox runs inside tx).
- Factory functions (`StorerFactory`) pattern at `accounting.go:19`–`:23`.

**Test scenarios:**
- Happy path: `ProcessGameInsert` with non-nil outbox writer → balance debited, accounting_logs written, outbox row written, all committed, `pg_notify` fired.
- Integration: outbox writer returns error → entire tx rolls back (balance unchanged, no logs, no outbox row, no notify).
- Integration: outbox writer called exactly once per `ProcessGameInsert` invocation (assert via mock callback counter).
- Edge case: `nil` outbox writer → existing behavior preserved, no outbox row written, no notify (regression guard for deposit/refund paths).
- Edge case: outbox writer sees the **same tx** as the accounting_logs writes — assert by having the mock writer inspect row visibility.
- Edge case: `pg_notify` failure after successful commit → tx stays committed, outbox row stays written, error logged, no return error to caller. (Notify is not load-bearing.)
- Edge case: signature stays domain-pure — the `OutboxWriter` type definition imports nothing from `nats`, `ws`, or handler packages. Enforce via a `go vet`-style review check.

**Verification:**
- All existing accounting tests still pass.
- New integration test demonstrates atomic rollback.
- `grep -r 'nats' backend/business/core/accounting/` returns no matches (accounting stays nats-agnostic).

- [ ] **Unit 3: Batch-insert payload encoder helper**

**Goal:** Centralize msgpack encoding of the `batch_insert` NATS payload in one helper. Used by the outbox-row writer (via handler) and by the drainer-visible payload (indirectly — drainer just publishes raw bytes).

**Requirements:** R3 (stable wire format captured at commit time).

**Dependencies:** None.

**Files:**
- Create: `backend/business/web/ws/batch_insert_payload.go` (or extend existing `topics.go`)
- Test: `backend/business/web/ws/batch_insert_payload_test.go`

**Approach:**
- Extract the msgpack-encoding code currently inline in `handleBatchInsert` (`backend/business/web/ws/handler.go:700`-ish, the lines building the publish `data`) into `EncodeBatchInsertPayload(...) ([]byte, error)`.
- Keep the existing payload struct shape — this is purely a refactor-extract, no wire format change.
- Worker doesn't call the helper; it just moves bytes. Only the handler calls it when building the outbox row to write.

**Patterns to follow:**
- Existing `Topic*` helpers in `backend/business/web/ws/topics.go` live in the same package; the encoder fits naturally there.
- Existing test style in `backend/business/web/ws/`.

**Test scenarios:**
- Happy path: typical inputs → deterministic bytes; round-trip decode equals original.
- Edge case: zero debit splits (play=0, cash=N) → encode and decode correctly.
- Edge case: large count (max u32) → no overflow in encoding.
- Regression guard: encode a fixture and compare bytes-for-bytes to a frozen hex-string — catches any accidental wire-format drift.

**Verification:**
- All existing handler tests still pass.
- Encoder is the only place that knows msgpack field names/ordering for this payload.

- [ ] **Unit 4: Outbox drainer worker (LISTEN/NOTIFY, per-subject ordering, DLQ, liveness)**

**Goal:** Background goroutine that drains `nats_outbox`, publishes each row's payload to NATS, deletes sent rows, and exiles poison-pill rows to `nats_outbox_dlq`. Driven by Postgres `LISTEN/NOTIFY` with a 5-second fallback tick. Emits metrics including a liveness timestamp.

**Requirements:** R1, R2 (per-subject ordering), R3 (at-least-once bound by DLQ), R5 (metrics incl. liveness).

**Dependencies:** Unit 1 (both tables + composite index), core NATS connection (`foundation/nats/nats.go`).

**Files:**
- Create: `backend/business/core/outbox/outbox.go`
- Create: `backend/business/core/outbox/outbox_test.go`
- Create: `backend/business/core/outbox/chaos_test.go` (integration-style failure-injection tests — build-tagged `//go:build integration`)
- Modify: `backend/foundation/metrics/metrics.go` (add drainer metrics)

**Approach:**
- Exported `Run(ctx context.Context, db *sqlx.DB, nc *nats.Conn, log *zap.SugaredLogger, cfg Config)` function. Blocks until ctx canceled.
- **Panic recovery:** outermost loop wrapped in `defer recover()` + log + restart (with small backoff to avoid hot-spin). A single bad iteration must not kill the drainer permanently.
- **Trigger sources (whichever fires first wins a drain pass):**
  - `LISTEN outbox_new` — uses a dedicated `*sql.Conn` held open; `nc.Notify` channel fed from `pq`/pgx listener. Reconnect-on-error with backoff; on reconnect, force one drain pass (we may have missed a notify during the gap).
  - Fallback `time.Ticker(5 * time.Second)` — safety net against missed notifications, writer-commits-then-crashes-before-notify, listener connection gaps.
- **Drain pass algorithm:**
  1. `SELECT id, subject, payload, attempt_count FROM nats_outbox WHERE attempt_count < 10 ORDER BY subject, id ASC LIMIT $batch` (batch size default 100).
  2. Group rows by `subject` in memory.
  3. For each subject group, iterate rows in id order. On each row: `nc.Publish(subject, payload)`:
     - **Success:** collect id for batched delete.
     - **Failure:** update `attempt_count++`, `last_error`, `last_attempted_at` on this row. If new `attempt_count >= 10`, move to DLQ (insert into `nats_outbox_dlq`, delete from `nats_outbox`, log P1 event, increment `coinpusher_outbox_dlq_total`). Then **stop processing this subject** (preserve per-subject order for remaining rows). Continue to the next subject — failures in subject A do NOT block subject B.
  4. After processing all subjects: batch `DELETE FROM nats_outbox WHERE id = ANY($collected_ids)`.
  5. Update metrics (including `last_tick_timestamp`).
- **Metrics (Prometheus):**
  - `coinpusher_outbox_published_total` (counter)
  - `coinpusher_outbox_publish_errors_total` (counter)
  - `coinpusher_outbox_dlq_total` (counter, incremented on DLQ exile)
  - `coinpusher_outbox_pending_rows` (gauge, updated after each SELECT)
  - `coinpusher_outbox_oldest_pending_seconds` (gauge, from oldest `created_at` in the batch)
  - `coinpusher_outbox_last_tick_timestamp` (gauge, unix seconds; updated every drain pass including empty ones — liveness signal)
  - `coinpusher_outbox_table_bytes` (gauge, via `pg_total_relation_size('nats_outbox')`; updated every minute, not every tick)

**Patterns to follow:**
- `backend/app/services/api/main.go:326` (heat broadcast), `:406` (nonce purge) for goroutine lifecycle.
- Existing metrics declarations in `backend/foundation/metrics/metrics.go`.
- `pgx` / `lib/pq` LISTEN-reconnect idioms — standard documented patterns, follow current project's choice of driver (check `go.mod`).

**Test scenarios:**
- Happy path: insert 3 rows into outbox (same subject) → worker reacts to NOTIFY → all 3 published in id order → rows deleted. No fallback tick required.
- Happy path (fallback tick): insert row but block `pg_notify` (simulate) → fallback tick within 5s drains the row.
- Happy path: worker handles empty outbox (tick with no rows) without error, still updates `last_tick_timestamp`.
- **Per-subject ordering (R2):** two subjects A and B, row `A1` publish fails, rows `A2`, `B1`, `B2` all present → expected outcome: `B1`, `B2` published + deleted; `A1` stays with `attempt_count=1`; `A2` NOT published this pass (preserves per-subject order). On next pass, `A1` succeeds → `A1`, `A2` drain.
- **DLQ path (R3):** row reaches `attempt_count=9`, publish fails → row moves to `nats_outbox_dlq`, is gone from `nats_outbox`, `coinpusher_outbox_dlq_total` incremented, subject is unblocked for subsequent rows.
- Error path: DB SELECT fails → worker logs, does not crash, next trigger reattempts.
- Error path: LISTEN connection dropped → worker reconnects with backoff, forces one drain pass on reconnect (may have missed a notify).
- Integration: worker respects ctx cancellation — `ctx.Cancel()` → worker returns within one tick + closes LISTEN conn cleanly.
- **Panic recovery:** inject a panic inside drain loop → `defer recover()` catches it, logs, worker resumes on next trigger.
- **Chaos (integration):** NATS server stopped for 30 seconds while 50 rows accumulate in outbox → verify (a) rows stay in outbox, (b) no DLQ spillover (attempt_count < 10 within 30s of retries), (c) after NATS resumes, all 50 rows drain in commit-order within 2s, (d) `oldest_pending_seconds` peaked around 30s during outage and returned to <1s after.
- **Concurrency:** 1000 concurrent `ProcessGameInsert` calls across 50 simulated rooms (20 per room) → all 1000 rows in outbox → drainer drains → assert per-room order matches `accounting_logs.id` order + zero lost + zero duplicate publishes (subscribe to NATS subject in test, count + verify order).
- Edge case: concurrent writers while drainer drains — new NOTIFYs during an active drain pass coalesce via pg driver buffering; next pass picks them up. No lost rows.

**Verification:**
- `go test ./backend/business/core/outbox/...` passes (unit tests).
- `go test -tags=integration ./backend/business/core/outbox/...` passes against a local Postgres + NATS via `testcontainers-go` or docker-compose (chaos + concurrency scenarios).
- Manual: in dev, insert a row via `psql`, observe the `outbox_new` NOTIFY, worker publishes NATS message within 50ms.
- `/metrics` shows `coinpusher_outbox_last_tick_timestamp` advancing every 5s at minimum.

- [ ] **Unit 5: Game-server idempotency verification (read-only investigation + optional hardening)**

**Goal:** Confirm the game server dedupes incoming `batch_insert` events on `reference_id`. If it doesn't, add dedup so at-least-once delivery from the outbox never applies a batch twice.

**Requirements:** R3.

**Dependencies:** None (investigation). If hardening needed, depends on Unit 4 being deployable alongside.

**Files:**
- Read: `game/server/src/` (TypeScript game server) — find NATS `batch_insert` subscriber and trace whether `reference_id` is checked before applying.
- Modify (conditional): the subscriber handler, to cache recent `reference_id`s (LRU or short TTL) and drop repeats.
- Test (conditional): game-server-side unit test for dedup.

**Approach:**
- Investigate first — grep for `batch_insert`, `reference_id`, `refID` in `game/server/src/`.
- If dedup exists: document it as a code comment linking to this plan; no code change.
- If dedup missing: add a small LRU cache (size ~10k, covers burst + ~minutes of events) keyed on `reference_id`; drop incoming events whose ref is cached within TTL.

**Execution note:** Start as a read-only investigation; code change only if investigation finds a gap.

**Test scenarios (conditional on gap found):**
- Happy path: two events with same `reference_id` arrive in sequence → first applied, second dropped, metric `game_insert_duplicate_suppressed_total` incremented.
- Edge case: two events with same `reference_id` arrive far apart (beyond TTL) → second applied (acceptable: outbox retry window is seconds, not minutes; if this fires it's a bug, and a metric should surface it).
- Edge case: LRU eviction under burst (>10k distinct refs in TTL) → eviction metric; possibility of duplicate apply. Tune size based on observed insert rate.

**Verification:**
- Either: "game server already dedupes, linked by comment" OR "game server now dedupes, covered by test".

- [ ] **Unit 6: Flip WS + HTTP handlers to outbox path**

**Goal:** Rewrite `handleBatchInsert` (WS) and the HTTP batch-insert handler to use the outbox writer callback and remove the inline publish + refund path. Gate behind `BATCH_INSERT_OUTBOX_ENABLED` env flag so the old path can be restored without a code revert.

**Requirements:** R1, R4, R6.

**Dependencies:** Units 2, 3, 4 all merged; Unit 5 resolved.

**Files:**
- Modify: `backend/business/web/ws/handler.go` (`handleBatchInsert`)
- Modify: `backend/app/services/api/handlers/v1/gamegrp/gamegrp.go`
- Modify: `backend/app/services/api/main.go` (wire up outbox drainer goroutine; read env flag)
- Test: `backend/business/web/ws/handler_test.go` (update existing tests)
- Test: `backend/app/services/api/handlers/v1/gamegrp/gamegrp_test.go` (if present) or integration test
- Modify: `backend/foundation/metrics/metrics.go` (optional — add a `coinpusher_batch_insert_path_total{path="outbox|legacy"}` counter for deploy visibility)

**Approach:**
- When flag enabled: handler calls `ProcessGameInsert` with an `OutboxWriter` that inserts into `nats_outbox`. Handler returns ack on success. No inline publish. No refund. The `refund*` code path becomes unreachable (kept as dead code for one release).
- When flag disabled: existing code path (inline publish + refund) runs unchanged.
- Wire the drainer goroutine in `api/main.go` following the nonce-purge pattern; start only if flag enabled.
- Update tests to cover both flag states until flag is removed in follow-up.

**Patterns to follow:**
- Existing goroutine lifecycle in `api/main.go` (launch + ctx-based shutdown).
- Existing env-var reading pattern in `api/main.go` (search for `os.Getenv`).

**Test scenarios:**
- Happy path (flag on): WS batch_insert → client ack received → DB has accounting_logs + nats_outbox row → no inline publish attempted.
- Happy path (flag on, end-to-end): `testcontainers-go` brings up Postgres + NATS + a minimal TS game-server subscriber process → handler call → outbox write → drainer publish → game-server receives event with matching `reference_id`. This is the R1 end-to-end proof; do not skip or mock past the NATS boundary.
- Error path (flag on): outbox writer insert fails (e.g., DB constraint) → entire tx rolls back, balance unchanged, client gets error, `BatchInsertRefundFailures` NOT incremented.
- **R1 tripwire regression assertion:** every test in `handler_test.go` and `gamegrp_test.go` that exercises the batch-insert happy or sad path asserts `metrics.BatchInsertRefundFailures.Get() == 0` at teardown when flag is on. Codified as a shared test helper (`assertNoRefundFailures(t)`). Any future code change that re-introduces the refund code path will fail these tests. This is the hard guarantee for R1.
- Regression (flag off): legacy behavior identical to today's tests. Include smoke test of flag-off path in CI until Unit 8 deletes it.
- Integration: concurrent 1000 inserts across 50 rooms → ordering of outbox rows per room matches commit order; drainer publishes in same per-room order; zero duplicates; zero losses (subscribe to NATS in test, count by `reference_id`).
- Integration: drainer not running (kill goroutine mid-test) while flag on → inserts succeed (rows queue); restart drainer → rows drain, game-server-mock receives all events.

**Verification:**
- With flag on: `BatchInsertRefundFailures` counter stays at 0 under all normal and fault-injected scenarios — enforced by the tripwire assertion, not manual check.
- End-to-end `testcontainers-go` suite passes in CI (tagged `//go:build integration`; runs in a dedicated CI job).
- Existing HTTP + WS contract tests pass with flag in both states.

- [ ] **Unit 7: Operational alerting + dashboard for outbox health**

**Goal:** Add alert rules and dashboard panels so operators can see outbox lag, publish failure rate, and queue depth in Grafana.

**Requirements:** R5.

**Dependencies:** Unit 4 (metrics emitted).

**Files:**
- Modify: `deploy/prometheus/rules/alerts.yml`
- Modify: `deploy/grafana/provisioning/alerting/alerts.yml`
- Modify: `deploy/grafana/dashboards/` (pick the dashboard closest in domain — likely `blockchain.json` or a new `gameplay.json`)
- Modify: `deploy/prometheus/tests/alerts_test.yml`

**Approach:**
- Alerts:
  - **P0** `P0_OutboxDrainerDead`: `time() - coinpusher_outbox_last_tick_timestamp > 10` (no drain pass in 10 seconds — goroutine silently died or LISTEN connection is wedged). Early-warning before pending_rows backs up.
  - **P0** `P0_OutboxOldestPending`: `coinpusher_outbox_oldest_pending_seconds > 60` (a row has been stuck for a minute — something is actively broken).
  - **P1** `P1_OutboxPendingBacklog`: `coinpusher_outbox_pending_rows > 1000 for 2m` (drainer slow but alive).
  - **P1** `P1_OutboxDLQGrowth`: `increase(coinpusher_outbox_dlq_total[10m]) > 0` (at least one poison-pill row exiled in the last 10 minutes — human investigation required).
  - **P2** `P2_OutboxPublishErrors`: `increase(coinpusher_outbox_publish_errors_total[5m]) > 0` (publish errors happening, investigate — expected to be brief during NATS blips).
  - **P2** `P2_OutboxTableBloat`: `coinpusher_outbox_table_bytes > 1e9` (1 GB — autovacuum pressure risk before row count alerts would fire).
- Dashboard panels: pending gauge timeseries, publish rate (published + errors + DLQ stacked), oldest-pending-age timeseries, last-tick-age timeseries, table-size timeseries.
- Keep the existing `P0_BatchInsertRefundFail` rule — it's now a safety net that should never fire.

**Patterns to follow:**
- Existing alert rule shape in `deploy/prometheus/rules/alerts.yml:60` and Grafana provisioning in `deploy/grafana/provisioning/alerting/alerts.yml:155`.
- Existing promrules unit test in `deploy/prometheus/tests/alerts_test.yml` for `P0_BatchInsertRefundFail` — mirror for each new alert.

**Test scenarios:**
- `promtool test rules deploy/prometheus/tests/alerts_test.yml` passes for all six new alerts (positive + negative cases per alert).
- Manual: in dev, stop the drainer goroutine → `P0_OutboxDrainerDead` fires within 10s of the last_tick metric going stale.
- Manual: insert a stuck row with backdated `created_at` → `P0_OutboxOldestPending` fires within 60s.
- Manual: force an insert into `nats_outbox_dlq` → `P1_OutboxDLQGrowth` fires within the next evaluation cycle.

**Verification:**
- `promtool check rules` clean.
- Dashboard loads and shows panels with reasonable defaults (null-panel text when no data).

- [ ] **Unit 8: Cleanup + follow-up scheduling (low-risk housekeeping)**

**Goal:** Remove the flag, dead refund code, and associated tests once production has baked for 1 week without regressions.

**Requirements:** Hygiene, not a functional requirement.

**Dependencies:** Unit 6 deployed to production for 1 week with `BatchInsertRefundFailures` counter at 0.

**Files:**
- Modify: `backend/business/web/ws/handler.go` (remove flag branch + refund block)
- Modify: `backend/app/services/api/handlers/v1/gamegrp/gamegrp.go` (same)
- Modify: `backend/business/core/game/game.go` (remove `RefundBatchInsert`)
- Modify: `backend/business/core/accounting/accounting.go` (remove `ProcessGameInsertRefund` — but only if no other caller; grep first)
- Modify: `backend/app/services/api/main.go` (remove flag read; drainer always runs)
- Modify: Related tests
- **Do not** remove `BatchInsertRefundFailures` metric or the P0 alert — they remain as a tripwire that should never fire.

**Execution note:** Separate PR, one week after Unit 6 lands. This is the "revert path closeout" step.

**Test scenarios:**
- Happy path: all existing outbox-flow tests still pass after dead code removal.
- Regression guard: grep shows zero references to `RefundBatchInsert` and `ProcessGameInsertRefund` post-removal.

**Verification:**
- `go vet`, `go build`, full test suite clean.
- Code review confirms no branch remains for the legacy publish-then-refund path.

## System-Wide Impact

- **Interaction graph:** The batch-insert event now travels `handler → accounting.execTx → outbox table → drainer → NATS → game server` instead of `handler → accounting → handler → NATS`. The handler is no longer on the NATS path. The drainer becomes a new liveness dependency for event delivery (but not for request success).
- **Error propagation:** Publish errors no longer surface to the client — they stay in the drainer and increment drainer metrics. The client only sees tx-commit errors (DB down, balance insufficient). This is correct per the design: clients shouldn't care about broker-side delivery state.
- **State lifecycle risks:** Outbox table grows if the drainer is stuck. Mitigation: P0 alert on oldest-pending-age > 60s. Disk-space risk is low (rows are ~200 bytes; 10M stuck rows = ~2GB).
- **API surface parity:** HTTP and WS handlers stay symmetric — both go through the same `ProcessGameInsert` signature with the same outbox writer.
- **Integration coverage:** New cross-layer scenario: tx commit ↔ drainer publish. Unit 6's integration tests must cover "row written → drainer publishes → game server receives". Mock tests alone are insufficient for R1 confidence.
- **Unchanged invariants:** 
  - `accounting_logs.reference_id` uniqueness + meaning unchanged.
  - `GameEventResult` fields sent to client unchanged (R4).
  - `BatchInsertRefundFailures` metric + P0 alert remain — intentionally, as a tripwire.
  - All other `nc.Publish` topics (scroll/shock/etc.) unchanged.
  - `RefundBatchInsert` / `ProcessGameInsertRefund` exist until Unit 8 — dormant but still wired through `RefundKeySuffix` logic for revert-path safety.

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| Drainer goroutine crashes silently; outbox grows unbounded. | Panic recovery + auto-restart in the loop (Unit 4). Early-warning P0 alert on `last_tick_timestamp` staleness >10s (Unit 7), before `pending_rows`/`oldest_pending_seconds` alerts would fire. |
| Double-delivery causes game server to apply a batch twice. | Unit 5 verifies game-server-side idempotency on `reference_id`. Outbox is at-least-once by design; idempotent consumer + bounded retry (DLQ at attempt_count=10) close the loop. |
| Per-subject ordering broken (out-of-order delivery to a room). | Drainer uses `ORDER BY subject, id ASC`, groups by subject, and stops-on-fail **per subject** (Unit 4). Failures in room A do not leapfrog rows in room B. DLQ exile after 10 attempts unblocks a permanently-stuck subject without breaking its intended ordering invariant (the DLQ'd event is gone, not reordered). |
| Malformed or poison-pill payload blocks its subject forever (infinite retry). | DLQ table + attempt_count cap (Unit 1, 4). Rows past 10 failed attempts are exiled to `nats_outbox_dlq` + P1 alert (Unit 7). Subject is unblocked for subsequent rows. |
| Latency regression from polling. | Primary driver is `LISTEN/NOTIFY` — 0 idle QPS, near-zero latency on active events. 5s fallback tick is pure safety net. Client-facing ack is unaffected regardless (ack fires on tx commit). |
| Rollout: outbox worker deployed but handler flip fails to deploy — rows queue forever. | Flag-gated rollout (Unit 6) — worker only starts when flag is on, which is set in the same deploy as the handler flip. Dev/staging verified first. |
| Rollback: if the flag-off path stops working (hasn't been exercised in a while), revert is blocked. | Dual test coverage in Unit 6 (flag on + flag off) until Unit 8. Smoke-test the flag-off path in staging as part of each release until Unit 8 ships. |
| Postgres bloat from high-throughput delete-after-publish. | `DELETE FROM nats_outbox WHERE id = ANY($ids)` + periodic `VACUUM` (autovacuum should handle). Monitor table size; if bloat appears, switch to soft-delete + batched cleanup. |
| Schema change lands before code using it — cosmetic but awkward. | Intentional ordering (Unit 1 first). Table is unused until Unit 6; no risk. |

## Documentation / Operational Notes

- **docs/spec.md**: Update the "Economy / Balance Model" section to reflect that batch-insert events are delivered via outbox, removing the refund compensation model for this path. Note the preserved `RefundBatchInsert` code (until Unit 8) as a transitional revert path.
- **Runbook**: New section for outbox drainer — "If P0 outbox-stuck alert fires: check drainer goroutine logs, check Postgres availability, check NATS connectivity. Manually drain stuck rows via `nats-cli publish $subject $payload` (copy from `psql` query) as a break-glass."
- **Deploy checklist**: Unit 6 deploy is a coordinated deploy with the game server (if Unit 5 required changes there). Pre-deploy verification: `BatchInsertRefundFailures` at 0 for 24h; staging run for 24h without outbox-stuck alerts. Post-deploy: watch all four outbox metrics for first hour.
- **Memory note** (for this project's `MEMORY.md`): Add a note that batch_insert uses the outbox pattern — future work on other `nc.Publish` sites should consider the same pattern for any event that has a "debit first, publish second" shape.

## Sources & References

- Affected files today: `backend/business/core/accounting/accounting.go`, `backend/business/core/game/game.go`, `backend/business/web/ws/handler.go`, `backend/app/services/api/handlers/v1/gamegrp/gamegrp.go`, `backend/foundation/metrics/metrics.go`, `backend/zarf/docker/database/schema.sql`, `deploy/prometheus/rules/alerts.yml`, `deploy/grafana/provisioning/alerting/alerts.yml`.
- Related prior plan: `docs/plans/2026-04-12-002-fix-unified-wallet-review-findings-plan.md` — documents the current refund path's observability hardening, which this plan makes obsolete (Unit 6 removes that code; Unit 8 deletes it).
- Related metric: `coinpusher_batch_insert_refund_failures_total` in `backend/foundation/metrics/metrics.go:138`; corresponding P0 alert at `deploy/prometheus/rules/alerts.yml:60` and `deploy/grafana/provisioning/alerting/alerts.yml:155`.
