# Bot Re-Enable Runbook

**Status:** procedure ready, **not yet executed**.

This runbook flips `bot_config.kill_switch` from `on` back to `off` and ramps the bot population back to the PROD baseline. Bots have been disabled since 2026-04-25 (kill_switch flipped after the c1505470 incident). Three formula changes have shipped since:

- `30f8505` — disabled the guaranteed floor (closed the original heartbeat exploit class).
- `1e0da1c` — flipped α=0.95 + activity-driven decay (closed the residual leak class).
- `557cd6b` — added per-user RTP monitoring + P1 alert (this runbook gates on it).

> **Plan:** [`docs/plans/2026-05-08-001-feat-bot-reenable-prep-plan.md`](../plans/2026-05-08-001-feat-bot-reenable-prep-plan.md).

---

## Pre-Flight Checklist

All must be true. Verify each by running the command in the right column.

| # | Gate | Command / Where to look |
|---|------|---|
| 1 | Combo defaults deployed and stable | `ssh root@146.190.104.138 'docker logs coin_pusher-backend-1 --tail 5 \| grep "starting service"'` — backend image must be from commit `1e0da1c` or later |
| 2 | Scenario E reviewed | `cd backend && go run ./app/tooling/heatsim/ --scenario=E` — operator confirms result is acceptable. Current state (2026-05-08): small-real RTP 2-3% under whale dominance, **soft-pass-with-known-limitation** (see [Known Limitations](#known-limitations)). |
| 3 | Economy RTP dashboard live | Visit `https://<domain>/grafana/d/economy-rtp/` — must render all 3 panels without "datasource error" |
| 4 | RTP alert provisioned | `ssh root@146.190.104.138 'docker exec coin_pusher-grafana-1 wget -qO- --header="X-WEBAUTH-USER: admin" http://localhost:3000/api/v1/provisioning/alert-rules \| grep p1-real-user-rtp'` — must return the rule |
| 5 | grafana_ro role can read | `ssh root@146.190.104.138 'docker exec coin_pusher-postgres-1 psql -h localhost -U grafana_ro -d coinpusher -c "SELECT count(*) FROM accounting_logs"'` — must return a number, not an error |
| 6 | Telegram contact point reachable | Check Grafana → Alerting → Contact points → telegram → "Test" — must deliver |
| 7 | Operator has SSH + admin CLI ready | `ssh -i .csp/digitalOcean -o IdentitiesOnly=yes root@146.190.104.138 'docker exec coin_pusher-backend-1 /bin/admin bot list \| head -3'` — must list bot accounts |

If any gate fails: **do not proceed**. Debug or fix the failing gate first.

---

## Phased Ramp

Bots ramp via `bot_config.crowd_scale` JSON. The scheduler reads this every ~5s, so updates propagate without restart. Each phase soaks for 24h. Operator decides phase advance based on **zero RTP alerts AND aggregate RTP staying in a healthy band**.

### Phase 0 — Flip kill_switch off

**Time:** day 0, ~09:00 local (operator awake for first 2 hours minimum).

```bash
# SSH in
ssh -i .csp/digitalOcean -o IdentitiesOnly=yes root@146.190.104.138

# Flip the kill switch. Scheduler picks up within 5s tick.
docker exec coin_pusher-backend-1 /bin/admin bot kill-switch off

# Verify config row updated
docker exec coin_pusher-postgres-1 psql -U postgres -d coinpusher -c \
  "SELECT config_key, config_value FROM bot_config WHERE config_key='kill_switch'"
# Expected: kill_switch = "off"
```

Crowd scale is still at PROD default `{"0":3,"1":4,"2":4,"3":3,"4":3,"5":2}` at this point — but Phase 1 immediately tightens it.

### Phase 1 — 1 bot maximum

**Time:** day 0, immediately after Phase 0. Soak: 24h.

```bash
# Cap to 1 bot online regardless of real-player count.
docker exec coin_pusher-backend-1 /bin/admin bot config crowd_scale '{"0":1,"1":1,"2":1,"3":0,"4":0,"5":0}'

# Verify
docker exec coin_pusher-postgres-1 psql -U postgres -d coinpusher -c \
  "SELECT config_value FROM bot_config WHERE config_key='crowd_scale'"
```

Watch in dashboard:
- `https://<domain>/grafana/d/economy-rtp/` — refresh every 1-2h for the first 4h, then daily.
- Aggregate RTP panel: expect 30-70% (combo's healthy band).
- Top-N user table: any user with > 80% RTP warrants attention even if alert hasn't fired.

**Phase 1 → Phase 2 advance criteria** (24h after Phase 0):
- Zero P1 RTP alert firings in the last 24h.
- Aggregate real-player RTP < 80%.
- No top-10 user with sustained > 90% RTP across multiple polls.
- No production incidents (existing P0/P1 alerts).

If criteria met → advance. If any criterion misses → see [Stop Signals & Rollback](#stop-signals--rollback).

### Phase 2 — Tier-aware ramp (low)

**Time:** day 1, 24h after Phase 0. Soak: 24h.

```bash
docker exec coin_pusher-backend-1 /bin/admin bot config crowd_scale '{"0":2,"1":2,"2":1,"3":1,"4":0,"5":0}'
```

Same advance criteria as Phase 1.

### Phase 3 — PROD default

**Time:** day 2, 48h after Phase 0. Soak: 24h ongoing.

```bash
docker exec coin_pusher-backend-1 /bin/admin bot config crowd_scale '{"0":3,"1":4,"2":4,"3":3,"4":3,"5":2}'
```

This restores the original PROD bot density. Continue watching the RTP dashboard daily for the next week before declaring "stable".

---

## Stop Signals & Rollback

Any one of the following → **rollback immediately**, no debate.

### Hard signals (auto-rollback)

| Signal | Where | Action |
|---|---|---|
| P1 alert `p1-real-user-rtp-over-100pct` fires | Telegram | Rollback (kill switch on). Investigate before re-flipping. |
| P0 alert `p0-rtp-global-anomaly` fires | Telegram | Rollback. This is a wider-scope anomaly than per-user. |
| P1 alert `p1-rtp-player-anomalies` fires (≥4 players anomalous) | Telegram | Rollback. Sustained multi-user exploitation. |
| Aggregate real-player RTP > 80% sustained over 1h | Dashboard panel | Rollback. Combo is bleeding faster than predicted. |

### Soft signals (operator judgment, lean toward rollback)

| Signal | What it might mean |
|---|---|
| Top-1 user RTP between 80-100% sustained for 6h+ | Borderline exploit: alert hasn't fired (under 100%) but pattern is suspicious. Investigate the user's accounting_logs. |
| Single-user `coins_inserted` spike (10x prior 24h baseline) | Possible test-vector for new exploit. Investigate. |
| Existing P1/P0 alerts unrelated to RTP firing | Don't proceed to next phase until root cause is closed. |

### Rollback Procedure

```bash
ssh -i .csp/digitalOcean -o IdentitiesOnly=yes root@146.190.104.138

# Flip kill switch on. Bots stop within 5s.
docker exec coin_pusher-backend-1 /bin/admin bot kill-switch on

# Verify
docker exec coin_pusher-backend-1 /bin/admin bot list \
  | grep -c '^.*paused\|kill_switch=on' || echo "Check bot status manually"

# Snapshot the offending user(s) for post-mortem.
docker exec coin_pusher-postgres-1 psql -U postgres -d coinpusher -c "
  WITH activity AS (
    SELECT a.account_id,
      SUM(CASE WHEN al.action_type = 'GAME_INSERT' THEN al.amount ELSE 0 END) AS coins_inserted,
      SUM(CASE WHEN al.action_type = 'GAME_REWARD' AND al.currency = 'CASH' THEN al.amount ELSE 0 END) AS cash_earned
    FROM accounting_logs al
    JOIN accounts a ON a.account_id = al.account_id
    WHERE al.created_at > NOW() - INTERVAL '24 hours' AND a.role <> 'bot'
    GROUP BY a.account_id
  )
  SELECT * FROM activity WHERE coins_inserted >= 100 ORDER BY (cash_earned/NULLIF(coins_inserted,0)) DESC NULLS LAST LIMIT 20;
"
```

After rollback: **do not re-flip without a written post-mortem identifying the root cause and a tested fix.** This was the rule that the c1505470 incident codified.

---

## Known Limitations

These are accepted gaps the runbook does NOT close. They're documented so future operators / Claude sessions know to compensate.

### Whale-dominance asymmetry under combo

`heatsim --scenario=E` with combo defaults shows that when one user invests dramatically more than others (e.g., 1000 coins/30s sustained vs. 5 coins/30s), small players' RTP collapses to 2-3%. This is **proportionally fair** (small players invest 0.1% of total flow → get 0.1% of drops) but feels punitive to small users.

**Mitigation:** bots inserting 3-15 coins per 30s are effectively the "small player" baseline; if a real whale shows up at PROD scale and small players abandon the game, retune α (try 0.85) or coinHalfLife (try 60). Track this via the aggregate RTP panel — if real-player aggregate drops below 20% sustained, that's the whale-crush signal.

### Out-of-distribution adversarial patterns

`heatsim` covered heartbeat, drive-by, constant-low, whale, multi-real coexistence. Real users may invent patterns the simulator didn't model. The P1 RTP alert catches *post-fact* exploitation but only above the 100% RTP threshold; sub-100% sustained extraction (e.g., 95% RTP for weeks across many users) won't fire.

**Mitigation:** weekly manual review of `accounting_logs` aggregate RTP by user role and lifetime cumulative RTP. Cron a manual `psql` query into a calendar reminder. (If automated, this becomes a separate plan.)

### Single-instance grafana_ro password

The `grafana_ro` DB role's password lives in `/opt/coin_pusher/.env` on the backend droplet. If the droplet is replaced, the role exists but the password isn't migrated. Re-run the password-set step from `.env.example`.

### Manual gates, not automated

Phase advancement is operator-driven. A drowsy operator can advance prematurely. The 24h soak window is the safety margin; respect it.

---

## Alert Ladder Reference

For context when triaging during the ramp:

| UID | Severity | Window | Trigger | Source |
|---|---|---|---|---|
| `p0-rtp-global-anomaly` | P0 | 1h | aggregate RTP > 1.2 or < 0.3 | Prometheus `coinpusher_rtp_ratio{window="1h"}` |
| `p1-rtp-player-anomalies` | P1 | 1h | ≥4 players anomalous | Prometheus `coinpusher_rtp_player_anomaly_count` |
| `p1-real-user-rtp-over-100pct` | P1 | 24h | ≥1 user RTP > 100% with ≥100 coins inserted | Postgres SQL on `accounting_logs` (added 2026-05-08) |

The new (24h) alert covers a different attack surface than the existing (1h) alerts: a single user slowly extracting wealth that wouldn't show on a 1h window or trigger the multi-player count.

---

## See Also

- Plan: [`docs/plans/2026-05-08-001-feat-bot-reenable-prep-plan.md`](../plans/2026-05-08-001-feat-bot-reenable-prep-plan.md)
- Heat formula history: [`docs/heat-system.md`](../heat-system.md)
- Monitoring overview: [`docs/monitoring.md`](../monitoring.md)
- Deployment procedures: [`docs/DEPLOYMENT.md`](../DEPLOYMENT.md)
- Bot scheduler internals: `backend/business/core/bot/scheduler.go` (envelopes at lines 41-67)
- Admin CLI: `backend/app/tooling/admin/bot.go`
