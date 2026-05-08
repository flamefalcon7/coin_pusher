# Monitoring & Alerting

## Architecture

```
Services Machine                          Game Machine
┌──────────────────────────────────┐     ┌────────────────────┐
│ Backend :4000 (API)              │     │ Game Server         │
│         :4010 (debug + /metrics) │     │   :9100 (/metrics)  │
│ Indexer  :9091 (/metrics)        │     └────────────────────┘
│ Executor :9092 (/metrics)        │            ↑
│ Prometheus :9090 (internal)      │     scrapes via VPC IP
│ Grafana    :3000 (internal)      │
│ Nginx ─→ /grafana/ (basic auth)  │
└──────────────────────────────────┘
```

- **Prometheus** scrapes 4 targets every 15s, retains 30 days
- **Grafana** at `https://<domain>/grafana/` behind nginx basic auth
- **Telegram** alerts via Grafana unified alerting

## Metrics Endpoints

| Service | Port | Path | Metric Prefix |
|---------|------|------|---------------|
| Backend API | 4010 | `/metrics` | `coinpusher_http_*`, `coinpusher_ws_*`, `coinpusher_db_*`, `coinpusher_worker_*` |
| Indexer | 9091 | `/metrics` | `coinpusher_indexer_*` |
| Executor | 9092 | `/metrics` | `coinpusher_executor_*` |
| Game Server | 9100 | `/metrics` | `coinpusher_game_*`, `coinpusher_process_*`, `coinpusher_nodejs_*` |

## Dashboards

### Overview (`coinpusher-overview`)
- Service health (up/down stat panels)
- HTTP request rate by status, latency percentiles (p50/p95/p99)
- WebSocket connections, messages by op, buffer overflows
- Database pool usage (in_use, idle, wait_count)
- Worker run rate and error rate

### Game Server (`coinpusher-game`)
- Tick timing percentiles and per-phase breakdown
- Coin counts (active/sleeping), despawn rate by zone
- Slot/wheel counters, ability usage
- Node.js process stats (heap, RSS, event loop lag)

### Blockchain (`coinpusher-blockchain`)
- Indexer: block lag, cursor, deposits processed, RPC latency
- Executor: withdrawals processed/failed, sweeps, gas price, RPC latency

### Economy RTP (`economy-rtp`)
- Top-20 real users by 24h RTP (table, color-coded by threshold)
- Count of real users with 24h RTP > 100% (alert source)
- Aggregate real-player RTP across last 24h
- Sourced from PostgreSQL `accounting_logs` via the read-only `grafana_ro` role.
- Powers the `p1-real-user-rtp-over-100pct` alert.
- Used during bot re-enable per [`docs/runbooks/bot-reenable.md`](runbooks/bot-reenable.md).

## Datasources

| Name | Type | URL | Notes |
|------|------|-----|-------|
| Prometheus | prometheus | `http://prometheus:9090` | Default; metrics scrape (15s, 30d retention) |
| Postgres | postgres (grafana-postgresql-datasource) | `postgres:5432` | Read-only `grafana_ro` role; used by Economy RTP dashboard. Password set via `GRAFANA_DB_PASSWORD` env var; role created by `schema.sql` migration. |

## Alert Tiers

### P0 — Critical (eval 1min, Telegram repeat 15min)

| Alert | Condition | For |
|-------|-----------|-----|
| API server down | `up{job="backend"} == 0` | 1m |
| Game server down | `up{job="game"} == 0` | 1m |
| DB pool exhausted | `db_pool_in_use / db_pool_max_open > 0.9` | 2m |
| NATS disconnected | `increase(nats_disconnects_total[2m]) > 0` | 0s |
| Indexer block lag >100 | `indexer_block_lag > 100` | 5m |
| Executor failures | `increase(executor_withdrawals_failed_total[10m]) > 5` | 0s |

**Response**: Investigate immediately. Check container logs, restart if needed.

### P1 — Urgent (eval 5min, Telegram repeat 1h)

| Alert | Condition | For |
|-------|-----------|-----|
| HTTP 5xx rate >5% | `rate(5xx) / rate(total) > 0.05` | 5m |
| API latency p99 >2s | `histogram_quantile(0.99, ...) > 2` | 5m |
| WS mass disconnect >50% | connections dropped >50% in 5min | 0s |
| Physics tick p99 >33ms | `histogram_quantile(0.99, ...) > 0.033` | 5m |
| Reward flush errors | `increase(reward_flush_errors[5m]) > 0` | 0s |

**Response**: Investigate within 30 minutes. Check for spike patterns, resource saturation.

### P2 — Important (eval 15min, Telegram repeat 8h)

| Alert | Condition | For |
|-------|-----------|-----|
| Backend memory >1.5GB | `process_resident_memory_bytes > 1.5e9` | 15m |
| WS message drops | `increase(ws_send_buffer_overflow[5m]) > 0` | 0s |
| Worker errors trending | `increase(worker_errors_total[1h]) > 5` | 0s |

**Response**: Review in daily standup. May indicate gradual degradation.

### P3 — Dashboard only (no alerts)
- WS connections (online players), coin insert rate, platform coin count
- Deposit/withdrawal volume, ability usage breakdown

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `GAME_VPC_IP` | Yes | Game server VPC IP for Prometheus scraping |
| `TELEGRAM_BOT_TOKEN` | Yes | Telegram bot token for alert notifications |
| `TELEGRAM_CHAT_ID` | Yes | Telegram chat ID for alert notifications |
| `GF_ADMIN_USER` | No | Grafana admin username (default: `admin`) |
| `GF_ADMIN_PASSWORD` | Yes | Grafana admin password (change from default!) |
| `GRAFANA_ROOT_URL` | No | Grafana root URL (default: `https://localhost/grafana/`) |

## Key Metrics Reference

### HTTP
- `coinpusher_http_requests_total{method,path,status}` — request count
- `coinpusher_http_request_duration_seconds{method,path}` — latency histogram

### WebSocket
- `coinpusher_ws_connections_active` — current connection gauge
- `coinpusher_ws_messages_received_total{op}` — messages by known operation
- `coinpusher_ws_rate_limit_total{ability}` — rate-limited messages
- `coinpusher_ws_send_buffer_overflow_total` — dropped messages

### Game
- `coinpusher_game_tick_duration_seconds` — total tick latency
- `coinpusher_game_tick_phase_seconds{phase}` — per-phase (physics, despawn, serialize, etc.)
- `coinpusher_game_coins_active` / `coinpusher_game_coins_sleeping` — coin counts
- `coinpusher_game_coins_despawned_total{zone}` — despawn by zone (front/side/back)

### Blockchain
- `coinpusher_indexer_block_lag` — blocks behind chain tip
- `coinpusher_indexer_deposits_processed_total` — deposit count
- `coinpusher_executor_withdrawals_processed_total` / `_failed_total`
- `coinpusher_executor_gas_price_gwei` — current gas price

### Workers
- `coinpusher_worker_runs_total{worker}` — tick count per worker
- `coinpusher_worker_duration_seconds{worker}` — tick duration per worker
- `coinpusher_worker_errors_total{worker}` — error count per worker
- Workers: `heat_broadcast`, `reward_flush`, `reward_notify`, `nonce_purge`, `progress_expire`

## Troubleshooting

### Prometheus target DOWN
```bash
# Check if metrics endpoint responds
curl -s localhost:4010/metrics | head -5

# Check container status
docker compose -f docker-compose.services.yml ps
docker compose -f docker-compose.services.yml logs backend --tail 50
```

### Grafana not loading
```bash
# Check grafana logs
docker compose -f docker-compose.services.yml logs grafana --tail 50

# Verify nginx proxy
curl -I https://localhost/grafana/
```

### No alert notifications
1. Check Grafana > Alerting > Contact Points — test Telegram
2. Verify `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` in `.env`
3. Check Grafana > Alerting > Notification Policies — routes by severity

### Adding a new metric
1. Define metric in `backend/foundation/metrics/metrics.go` (Go) or `game/server/src/metrics.ts` (TS)
2. Instrument the code path
3. Add panel to relevant dashboard JSON in `deploy/grafana/dashboards/`
4. If alertable, add rule to `deploy/grafana/provisioning/alerting/alerts.yml`
5. Restart Grafana to pick up provisioned changes: `docker compose restart grafana`

## Report-Authoring Rule: Exclude `role='bot'` From Player Metrics

Any new report, dashboard query, or alert that aggregates over `accounting_logs`
(or any table whose rows are produced by both real players and server-controlled
bot accounts) **MUST** filter out `role='bot'` accounts so bot activity does not
pollute real-player metrics (RTP, liability, anomaly detection, etc.).

**Canonical SQL pattern** — join `accounts` and exclude the bot role:

```sql
SELECT ...
FROM accounting_logs l
JOIN accounts a ON a.account_id = l.account_id
WHERE l.action_type = $1
  AND l.created_at >= $2
  AND a.role != 'bot'
```

**In Go**, prefer the existing storer methods that encapsulate this join:

- `ledgerdb.Store.SumByActionSinceExcludingRole(ctx, action, "bot", since)` —
  global aggregates (RTP monitor window totals).
- `ledgerdb.Store.SumByPlayerSinceExcludingRole(ctx, action, "bot", since)` —
  per-player aggregates (RTP anomaly detection).

Existing enforcement sites (update these if you touch them):

- `backend/app/services/api/main.go` — `rtp_monitor` worker (window aggregates)
- `backend/app/services/api/main.go` — `rtp_anomaly` worker (per-player outliers)

Rationale: bot accounts (`accounts.role='bot'`) are server-controlled NPC
players funded by the house. Their inserts and rewards land in the same
`accounting_logs` table as real players but must not influence alert signals,
house-liability estimates, or RTP tuning decisions. See the play-bot plan
(`docs/plans/2026-04-16-001-feat-play-bot-plan.md`, Unit 7) for the full
design.
