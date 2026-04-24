# TODOs

Pre-existing reliability issues surfaced during the 2026-04-24 RPC fallback review
(`docs/plans/2026-04-24-001-fix-rpc-fallback-and-telegram-alerts-plan.md`).
Flagged for follow-up PRs — out of scope for the fallback change itself.

## Reliability — Executor singleton drift

**File:** `backend/app/tooling/executor/main.go` around the advisory-lock acquisition.

`pg_try_advisory_lock` is **session-scoped**. The executor acquires it via a
pooled `*sql.DB` connection, then hands the connection back to the pool. When
that pooled connection is later recycled or dropped (e.g., network flap,
idle-timeout), Postgres silently releases the lock. A second executor can
then acquire the lock and run concurrently — breaking the single-instance
guarantee the lock was meant to provide. The original executor appears
healthy, and there's no metric or alert to surface the divergence.

**Fix direction:** acquire on a dedicated `sql.Conn` held for process
lifetime (`db.Conn(ctx)` + periodic heartbeat), or switch to a heartbeat-TTL
leader election row.

## Reliability — Executor recovery blocks startup

**File:** `backend/app/tooling/executor/main.go` `recoverSubmittedWithdrawals` /
`recoverStuckSweeps` calls in `run()`.

Each stuck withdrawal's receipt poll uses `cfg.Executor.ReceiptTimeout`
(default 120s). With N stuck withdrawals the executor can hang on boot for
`N × 120s` before the main ticker starts. Errors are logged as "non-fatal"
but operators see a silent executor for minutes.

**Fix direction:** cap recovery receipt timeout to ~15s, or run recovery
concurrently with (not before) the main poll loop.

## Reliability — Root context not tied to shutdown signal

**File:** `backend/app/tooling/executor/main.go` `run()`.

The root context is `context.Background()`, not `signal.NotifyContext`. On
SIGTERM the `case <-shutdown:` branch returns, but in-flight
`processWithdrawals` / `waitForReceipt` calls continue until their internal
timeouts expire because they carry a Background-derived context. Executor
can appear hung for up to 120s post-SIGTERM, risking Docker SIGKILL
mid-broadcast.

**Fix direction:**
```
ctx, cancel := signal.NotifyContext(context.Background(),
    syscall.SIGINT, syscall.SIGTERM)
defer cancel()
```
Replace the `case <-shutdown:` branch with `case <-ctx.Done():` and pass
`ctx` down into all background loops.

Same pattern applies to `backend/app/tooling/indexer/main.go`.

## Reliability — Metrics server bind failure is silent

**Files:**
- `backend/app/tooling/indexer/main.go:~134` (`:9091`)
- `backend/app/tooling/executor/main.go:~165` (`:9092`)

Both services run Prometheus scrape HTTP servers in a goroutine. On port
conflict, `http.ListenAndServe` returns error, the goroutine logs and
exits, but the main process keeps polling/processing. Grafana silently
stops seeing metrics. The `up{}==0` alert won't fire because the service
is technically Up — just without a `/metrics` endpoint.

**Fix direction:** either make the bind error fatal (return from `run`),
or add a `coinpusher_metrics_server_alive` gauge heartbeat and alert on
its staleness.
