---
module: infrastructure
date: 2026-07-23
problem_type: duplicate_message_processing
component: nats
severity: high
symptoms:
  - "Player inserts 1 coin, 3 coins drop from the slot — balance debited only once"
  - "Game server logs the same `📥 Batch insert` line 3x within ~1ms per press"
  - "NATS `/subsz` shows every `game.main.cmd.*` subject subscribed by 3 different cids"
  - "`/proc/1/net/tcp` inside game container shows 3 ESTABLISHED sockets to NATS"
  - "Game server logs `🔄 NATS reconnected` every ~3.5 min (430x/24h) since 2026-07-22 10:26 UTC"
root_cause: nats_zombie_subscriptions_after_ping_timeout_reconnect_loop
resolution_type: code_change_plus_ops
related_components:
  - game_server_node
  - backend_ws_handler
  - backend_gamegrp_http
  - nats
tags: [nats, zombie-connection, reconnect, ping-timeout, duplicate-delivery, idempotency, reference_id, dedup, at-least-once, economy, rtp, fanout, misdiagnosis]
related_commits:
  - "(pending) fix(backend): legacy batch_insert publishes carry reference_id so game-server dedup can suppress duplicate deliveries"
status: code_fix_local_green_prod_mitigation_pending
---

# One press drops 3 coins: NATS zombie subscriptions triple every game command (2026-07-23)

## What happened

Since **2026-07-22 10:26 UTC**, every command published to `game.main.cmd.*`
(batch_insert, shock, tornado, …) was processed **3 times** by the game server.
Players received 3 coins per 1-coin debit — the house was silently giving away
~2 free coins per insert. Economy/RTP data from 2026-07-22 10:26 onward is
contaminated.

Money was **not** multi-debited: the Go side ran once per press (verified in
`accounting_logs`). The amplification happened purely on the NATS consume side.

## Root-cause chain

1. Something (still undiagnosed — VPC or NATS-server-side; NATS container logs
   stopped at the 2026-06-07 incident) started making the game server's NATS
   connection **ping-timeout every ~3.5 min** at 2026-07-22 10:26 UTC. Zero
   reconnects before that moment; 430/day after. Cadence matches nats.js
   stale detection (`pingInterval` 2 min × `maxPingOut` 2).
2. On each stale-reconnect, nats.js opens a new connection and re-issues all
   subscriptions on it — but the **old socket stays ESTABLISHED and its read
   loop keeps dispatching**. The NATS server only reaps the old connection
   ~10 min later, so fanout goes to old + new.
3. Steady state: births every ~3.5 min, reaping at ~10 min age → **3 live
   connections × the same 15 subscriptions** in one node process. Every
   publish → handler runs 3×.
4. The dedup that exists for exactly this class (`RefIDDedup`,
   `game/server/src/nats/dedup.ts`) was structurally blind:
   - prod game container built **2026-04-24** — predates dedup entirely;
   - even on latest main, the **legacy (outbox-off) publish path did not set
     `reference_id`**, and empty ref bypasses dedup by design.

## Why every layer looked correct

Client sends once; Go debits once and publishes once; NATS delivers once *per
subscription* (its actual contract); game server processes what arrives. The
bug only exists in the composition — the unexamined assumption was
"1 publish = 1 processing". Classic duplicate-delivery failure; the defense
(idempotency key + consumer dedup) was half-built.

## The diagnostic trap (misdiagnosis worth remembering)

First hypothesis was "the extra coins belong to bots / other players sharing
the slot queue" — plausible because `insertAmountMin=3` for bots matched the
observed count. **Wrong**: game logs showed zero bot inserts in 72h. The
correct discriminator was timestamps: 3 identical log lines within ~1ms of a
single press cannot be independent actors.

## Diagnostic commands that worked

```bash
# 1. Per-press amplification, with ms timestamps (3 lines ≈ 1ms apart = smoking gun)
docker logs -t coin_pusher-game-1 --since 72h 2>&1 | grep "Batch insert"

# 2. Authoritative debit count (proves money side ran once)
psql -c "SELECT created_at, action_type, amount, reference_id FROM accounting_logs
         WHERE account_id='<uuid>' AND action_type='GAME_INSERT'
         ORDER BY created_at DESC LIMIT 15;"

# 3. THE key evidence: subscription fanout per subject + owning connections
wget -qO- "http://localhost:8222/subsz?subs=1"   # inside nats container
wget -qO- "http://localhost:8222/connz"          # cids, IPs, uptimes

# 4. Zombie sockets from inside the game container (0300680A:107E = 10.104.0.3:4222)
docker exec coin_pusher-game-1 sh -c 'cat /proc/1/net/tcp' | awk '{print $3}' | sort | uniq -c

# 5. Onset timeline of the flapping
docker logs -t coin_pusher-game-1 2>&1 | grep "NATS reconnected" | head -3
for d in 96 72 48 24; do docker logs --since ${d}h ... | grep -c "NATS reconnected"; done
```

Ruled out along the way: VPC packet loss (ping 0%), event-loop stalls (tick
1ms avg / 33ms budget, 0 overruns), host OOM (dmesg clean), app-level
resubscribe (single `subscribeBatchInsert` call site; single node process).

## Fix

### Code (done, local, tests green — NOT yet deployed)

`reference_id` now ships on **every** batch_insert publish path, so
game-server `RefIDDedup` suppresses NATS-level duplicates regardless of route:

- `backend/business/web/ws/handler.go` — legacy WS path now uses
  `EncodeBatchInsertPayload(..., refKey)` (was a bare struct without ref).
- `backend/app/services/api/handlers/v1/gamegrp/gamegrp.go` — same for the
  HTTP path; `Group.nc` narrowed to a `natsPublisher` interface for testability.
- Regression test `TestBatchInsert_LegacyPathPublishesReferenceID` pins:
  payload ref non-empty **and equal to the ledger debit's reference**.
  Mutation-tested: reverting refKey to `""` fails the test with the incident
  message. Full backend suite 591/591 green.

Note: dedup only covers `batch_insert`. Ability commands (shock/tornado/…)
are still fire-and-forget without refs — they were also tripled during the
incident (cosmetic/physics impact only, no ledger effect).

### Ops (pending)

1. Restart `coin_pusher-nats-1` then `coin_pusher-game-1` (order matters:
   server first, then the client reconnects fresh). Then watch
   `docker logs -f coin_pusher-game-1 | grep reconnect` — if flapping
   resumes, the trigger is still live and needs the deeper hunt.
2. Deploy latest game server (gets `RefIDDedup`) + backend (gets ref on all
   paths). ⚠️ backend droplet `/opt/coin_pusher` git is drifted — reconcile
   before pulling (see reference_deploy memory / 2026-06-07 notes).

## Watch-items / follow-ups

- **NATS reconnect count must become a metric + alert.** 430 reconnects/day
  went unnoticed for 30+ hours; a human eyeball found it in-game.
- **Economy invariant reconciliation**: hourly `sum(GAME_INSERT ledger)` vs
  coins enqueued (game server metric). Divergence = alarm. This would have
  fired within the hour on 2026-07-22.
- **Root-cause the 2026-07-22 10:26 UTC trigger** — NATS server default
  logging is too quiet (nothing since Jun 7); consider `-DV` or at least
  connection-event logging before/after the restart so the next flap is
  attributable.
- **Zombie-transport behavior in nats.js 2.29.3**: old sockets keep
  dispatching after stale-reconnect. If flapping recurs post-restart,
  investigate/patch client-side teardown (force `close()` of the abandoned
  transport) or upgrade the client library.
- Deploy-lag process gap: the dedup fix sat merged-but-undeployed for ~1
  month (game container built Apr 24). Merged ≠ shipped.
- RTP/economy data from 2026-07-22 10:26 UTC until the game-server restart
  is contaminated (3× coin outflow per insert) — exclude that window from
  tuning decisions.
