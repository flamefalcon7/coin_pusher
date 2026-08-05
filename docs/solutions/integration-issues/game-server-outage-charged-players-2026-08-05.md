---
module: backend, game-server
date: 2026-08-05
problem_type: data-integrity
component: nats-sync
severity: critical
symptoms:
  - "Players charged for coin inserts that never appear on the table"
  - "batch_insert_ack reports success (200 / queued > 0) for coins that were never simulated"
  - "Scrolls consumed with no ability firing"
  - "Backend keeps accepting inserts after the game server has stopped, restarted, or crashed"
  - "SIGTERM to the game server hangs ~60s after a tick-breaker trip"
tags:
  - nats
  - liveness
  - fail-closed
  - circuit-breaker
  - fund-loss
  - slot_status
---

# The backend kept selling coins after the game server stopped

## What was wrong

`slot_status` (game server → NATS every ~30 ticks ≈ 1s) is the **only** signal the Go backend
has that the game server exists. `Handler.SubscribeSlotStatus` consumed it to refresh the coin
caps and never recorded *when* the last one arrived.

So when the game server went away, nothing in the backend noticed:

1. `h.coinCount` and `h.slotCounts` froze at their final reading.
2. Every cap check (`coinCount >= maxActiveCoins`, per-slot space) kept passing against that
   frozen snapshot.
3. The balance debit committed.
4. The command published to `game.main.cmd.batch_insert` — a subject with **no subscriber**.
   There is no JetStream on this path, so NATS core dropped it on the floor.
5. The client received `batch_insert_ack` reporting success.

The player paid, the coins never existed, and nothing anywhere logged an error. Every deploy,
restart, and crash of the game server had been opening this window.

**Four paths, not one.** The WS handler was the obvious one; the audit found three more:

| Path | What it spent |
|---|---|
| WS `batch_insert` | balance |
| HTTP `POST /v1/game/batch-insert` | balance (and it never checked the caps at all) |
| bot scheduler insert | bot ledger rows + heat share |
| 5 scroll abilities (`shock`/`tornado`/`explosion`/`lightning`/`super_push`) | inventory items |

## Root cause chain

```
game server stops publishing slot_status
  → backend's cached coinCount/slotCounts freeze (no timestamp, no TTL)
    → cap checks pass against stale data
      → debit commits
        → NATS core publish to a subject with 0 subscribers = silent drop
          → success ack sent to a player who got nothing
```

The load-bearing wrong assumption was **"a successful publish means someone will act on it."**
With NATS core and no JetStream, `Publish` returning nil only means the bytes reached the broker.

## Diagnostics that worked

Reading the subscription callback and asking what happens when it simply *stops being called* —
the bug is an absence, so it does not appear in any log, trace, or metric. Grepping for the
producer settled the design:

```bash
grep -rn "slot_status" game/server/src/          # → GameLoop.ts:412, inside runTick()
grep -rn "ProcessBatchInsert" backend/ --include=*.go | grep -v _test   # → found paths 2, 3
grep -n "func (h \*Handler) handle" backend/business/web/ws/handler.go  # → the 5 abilities
```

`slot_status` being emitted *inside* `runTick()` is what made the fix cheap: a stopped game loop
stops the heartbeat by construction. No new protocol, no health endpoint, no probe.

## The fix

Two halves, in two branches, that only work together.

**Backend (`fix/backend-game-server-liveness-gate`)** — `ws.GameLiveness`, an atomic
last-heartbeat timestamp touched by the `slot_status` subscriber, stale after 5s (five missed
heartbeats). All four paths check it *before* spending anything. Fail-closed: the zero value
**and a nil pointer** both read dead, so a backend that has never heard from a game server, or
one wired up wrong, refuses rather than assuming the best. Rationale, the 5s choice, and the
rejected alternatives are in ADR **D-006**.

The ability gate lives inside `consumeScroll` — the one function all five handlers funnel
through — so a sixth ability inherits it without anyone remembering to add it.

**Game server (`fix/server-tick-and-sync`)** — the tick breaker now retries once instead of
leaving the room dark permanently. Trip → stop → wait 10s (deliberately past the backend's 5s
TTL, so nothing is being sold while it is down) → one restart with the table intact → if it
trips again, hand off to the graceful shutdown and let the supervisor start clean.

Restart-in-place is tried first because **the table is memory-only**: `GameState` has no
persistence, so a process restart comes back empty and vaporises coins players already paid to
place. Those coins are platform inventory, not unresolved player bets — nobody is owed a refund
— but they are still value on the floor.

## What the tests caught that review did not

Three defects surfaced only when the breaker tests drove the real sequence:

- `stop()` cleared the pending restart timer *after* its `if (!this.running) return`. A SIGTERM
  during the dark window returned early, and the timer fired afterwards and restarted the loop
  on a process that was trying to leave.
- `tick()` had no not-running guard. After the terminal trip it called the shutdown handler
  again on every firing.
- `drain()` completes via `drainCheck()` at the end of a tick, so on a stopped loop it only ever
  resolved on its 60s timeout — stalling every shutdown that followed a breaker trip.

## Watch items

- `coinpusher_game_unavailable_rejects_total{path}` — nonzero means the game server is gone and
  players are being turned away. **Alert on this.** It is the only signal that used to be silent.
- `coinpusher_game_tick_breaker_trips_total` / `_restarts_total` — a trip that is not followed by
  a restart means the process left.
- **Deploy order changed.** The gate is fail-closed, so deploying the backend while the game
  server is down means *nobody can insert coins*. That is the intended behaviour, but it makes
  game-server-first the required deploy order, and it means an API brought up standalone (local
  dev, a smoke test box) cannot take inserts at all.
- Still open, deliberately not fixed here: HTTP `batch-insert` never enforced `maxActiveCoins` or
  the per-slot cap, so it can overfill the table while the game server is *healthy*. Recorded in
  D-006's consequences.

## Traps for next time

- **A silent drop needs a liveness check, not better error handling.** There was no error to
  handle. Every `if err != nil` on that path was already correct.
- **Mutation-test the wiring, not just the logic.** Removing `h.liveness.Touch()` from the
  subscriber left every liveness test green, because they all drove the gate directly. The
  callback body had to be extracted (`applySlotStatus`) before the real path could be tested.
- **`git checkout -- <file>` is not a mutation revert** when the file has uncommitted work. It
  restores from HEAD and takes the fix with it. Twice in this session that silently reverted the
  work being tested and turned the next probe into a false "KILLED". Commit first, or copy the
  file.
- **Not every surviving mutation is a weak test.** Deleting the `last == 0` guard in `Live()`
  survived because epoch 1970 is already far outside any sane TTL — the mutation is equivalent,
  not uncovered. The same guard in `LastSeen()` is load-bearing, and mutating *that* was killed.

## Related

- `docs/decisions.md` D-006 · `docs/solutions/game-server/tick-and-sync-audit-2026-08-02.md`
- `backend/business/web/ws/{liveness,handler}.go` · `backend/business/core/bot/scheduler.go`
- `backend/app/services/api/handlers/v1/gamegrp/gamegrp.go` · `game/server/src/game/GameLoop.ts`
- Prior art on the same NATS path: `docs/solutions/infrastructure/nats-zombie-subscription-triple-command-2026-07-23.md`
