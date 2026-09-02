# TODOs

Pre-existing reliability issues surfaced during the 2026-04-24 RPC fallback review
(`docs/archive/plans/2026-04-24-001-fix-rpc-fallback-and-telegram-alerts-plan.md`).
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

## Frontend — Design tokens missing

**Files:** `game/client/src/` UI components and styles.

Client UI styling is ad-hoc — colors, spacing, typography, and radii are
hardcoded across components with no shared source of truth. This causes
visual drift between screens (e.g. WalletLogin vs PlayerInfo vs sponsor
modals) and makes theme changes (psychedelic pop palette refresh,
sponsor pitch deck alignment) require touching many files.

**Fix direction:** introduce a design token layer — CSS custom properties
(or a TS constants module) for the core palette (ToonTheme colors already
mapped), spacing scale, type scale, and radii. Migrate existing components
incrementally to consume tokens instead of literals.

## Docs — drift found in the 2026-09-02 audit, not yet fixed

Fixed in that audit: CLAUDE.md structure (SUI → Base, missing tooling/domains), `heat-system.md`
parameters, `architecture-for-ai.md` chain/auth/trigger/heat/network lines, `monitoring.md`
retention + metric names, `DEPLOYMENT.md` RPC env names, `security-audit.md` status banner.
`Scene.md` and `backend-optimization.md` archived. Still stale:

- `docs/architecture-for-ai.md` §API table: `/v1/auth/login` is dev-mode only; `/v1/game/batch_insert`
  and `/v1/game/ability` are not HTTP routes (only game-secret-guarded `/v1/game/event`); missing
  `/v1/auth/nonce`, `/v1/auth/wallet/login`, `/v1/user/*`, `/v1/progress/{id}/claim`, `/v1/withdraw*`,
  `/v1/sponsor/*`, `/v1/admin/*`. File trees omit `simulation/`, `metrics.ts`, `TickScheduler.ts`,
  `core/{bot,outbox,sponsor}`. "Insert coins | SPACE" hotkey does not exist (Arrow keys only).
- `docs/monitoring.md`: alert tables list 14 of 53 provisioned rules; workers list lacks `rtp_monitor`,
  `rtp_anomaly`; env table lacks `GRAFANA_DB_PASSWORD`, `GRAFANA_DOMAIN`; `deploy/prometheus/{rules,tests}/`
  unmentioned.
- `docs/DEPLOYMENT.md`: dev compose has 6 services not 7; setup.sh has 10 steps (fail2ban); nginx is
  1.30-alpine; NATS binds `10.104.0.3:4222`, postgres `127.0.0.1:5432`; game exposes `:9100` metrics;
  prometheus/grafana rows missing from the service table; `.env.example` lacks `WALLET_SEED`/`GAME_API_KEY`;
  Cloudflare Pages also needs `VITE_WC_PROJECT_ID`; drain sequence in `index.ts` differs from the doc.
  Deploy workflows (`deploy-*.yml`) are presented as live but have never had secrets set.
- `docs/sponsor-ads-technical-guide{,-zh}.md`: API section lacks `GET /v1/sponsor/campaigns/mine` and
  the admin pause/resume/delete routes; Phase 1–2 and Bonus Drop data-flow sections describe quota/config/
  bonus publishing as live, but `sponsor.NewPublisher` has no callers.
- `docs/security-audit.md`: body still lists the P1s named as fixed in its banner as open; line refs drifted.
- `docs/agent-eyes-mcp.md` line 21: says Babylon "pinned to v6.49"; package.json declares `^6.38.1`.

## Code — dead or dormant values found in the same audit

- `backend/business/core/sponsor/publisher.go` `NewPublisher` and `backend/foundation/nats/jetstream.go`
  `ConnectWithJetStream` have zero callers (sponsor quota/config/bonus publishing never wired). Either
  wire them per the sponsor plan or delete. A Go dead-code gate (`golang.org/x/tools/cmd/deadcode`) in CI
  would catch the next one; knip only covers TypeScript.
- `game/shared/src/types.ts` `HEAT_CONFIG.ALPHA: 0.7` is unread; `heat.go` uses 0.95.
- `game/shared/src/types.ts` `PLATFORM.TILT_ANGLE: 2` is unread (premise of the proposed rising-platform plan).
- `game/client/src/pages/{AdminSponsorsPage,SponsorPage}.tsx`, `ui/{CampaignCard,SponsorBalances}.tsx`:
  parked "until deposit gate" (imports commented out in `App.tsx`), ignored in `knip.jsonc`. Decide.
- Outbox plan Unit 8: `RefundBatchInsert` / `ProcessGameInsertRefund` and the `BACKEND_OUTBOX_ENABLED`
  legacy flag are still in code.
