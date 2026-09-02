> **ARCHIVED 2026-09-02.** Optimization plan from early 2026. Priorities 1 and 2 are done (`Connection.CanBatchInsert`, single-tx `ProcessGameInsert`); priority 3 premise changed (`GetShareForUser` was rewritten allocation-free); priorities 4 and 5 were never built and NATS delivery moved to the transactional outbox (`business/core/outbox`). Kept for history only.

# Backend Optimization Plan

## Context

The primary bottleneck is the `batch_insert` hot path — the most frequently called operation in the system. A user inserting coins triggers a full database transaction chain with no rate limiting and redundant queries. This document outlines optimizations in priority order, from lowest-cost/highest-impact to infrastructure-level changes.

---

## Priority 1: batch_insert Rate Limiting

**Problem:** `handleBatchInsert` has zero rate limiting. A user with 1000 coins can spam `batch_insert(count=1)` and generate unbounded PG load. Other WS operations (`coin_insert` 50ms, `shock` 2s, etc.) all have cooldowns.

**Impact:** Unbounded DB writes per user per second.

**Fix:** Add a `CanBatchInsert()` cooldown on `Connection` (200ms = max 5 DB writes/sec/user).

**Files:**
- `backend/business/web/ws/connection.go` — add `lastBatchInsert` field + `CanBatchInsert()` method
- `backend/business/web/ws/handler.go` — guard `handleBatchInsert` with `CanBatchInsert()`

**Effort:** ~10 lines of code, zero risk.

---

## Priority 2: Reduce PG Round-Trips in ProcessBatchInsert

**Problem:** Each `batch_insert` triggers 6 PG round-trips hitting the same row 3 times:

```
handleBatchInsert
  → gameCore.ProcessBatchInsert
    → acctCore.ProcessGameInsert
      → userCore.DecrementPlayBalance
        → storer.QueryByID()           ← SELECT (balance check)
        → storer.UpdateBalance()        ← BEGIN + SELECT FOR UPDATE + UPDATE + COMMIT
      → storer.Create()                 ← INSERT accounting_log
    → userCore.QueryByID()              ← SELECT (read back balance for response)
```

**Fix (3 steps):**

### 2a. Single-statement atomic debit (eliminate SELECT FOR UPDATE)

Replace the `SELECT FOR UPDATE` + `UPDATE` pattern with:

```sql
UPDATE accounts
SET balance_play = balance_play - $2, updated_at = NOW()
WHERE account_id = $1 AND balance_play >= $2
RETURNING balance_play;
```

`rows affected = 0` means insufficient funds. This removes the need for `DecrementPlayBalance` to pre-read the balance, and the `RETURNING` clause eliminates the final `QueryByID`.

### 2b. Merge accounting_log INSERT into the same transaction

Currently the debit (`UpdateBalance`) and the ledger entry (`ledgerdb.Create`) are separate operations. If the debit succeeds but the log INSERT fails, the ledger is inconsistent. Combine them into one transaction.

### 2c. Introduce a `DebitAndLog` method

Create a single method that does the atomic debit + log in one transaction:

```sql
BEGIN;
  UPDATE accounts SET balance_play = balance_play - $2 ... WHERE ... AND balance_play >= $2 RETURNING balance_play;
  INSERT INTO accounting_logs (...) VALUES (...);
COMMIT;
```

**Result:**

| | Before | After |
|---|---|---|
| PG round-trips | 6 | 2 (within 1 tx) |
| Transactions | 1 tx + 2 standalone | 1 tx |
| Row lock hold time | SELECT FOR UPDATE → UPDATE → COMMIT | UPDATE (implicit) → INSERT → COMMIT |
| Atomicity | Debit and log in separate ops | Atomic guarantee |

**Files:**
- `backend/business/core/user/stores/userdb/userdb.go` — new `DebitAndLog()` or refactored `UpdateBalance` with `RETURNING`
- `backend/business/core/user/storer.go` — update interface
- `backend/business/core/accounting/accounting.go` — `ProcessGameInsert` uses single-tx method
- `backend/business/core/game/game.go` — `ProcessBatchInsert` no longer calls `QueryByID` after debit

**Effort:** Medium. Requires new DB method + updating the call chain. Low risk with tests.

---

## Priority 3: Cache GetShares Result (Eliminate O(N) on Hot Path)

**Problem:** `GetShareForUser(userID)` calls `GetShares()` internally, which iterates all active players. This is called on every `batch_insert` to return `heat_share` in the ack response.

```
50 users × 5 inserts/sec = 250 calls/sec to GetShares()
Each call iterates all 50 players = 12,500 iterations/sec
```

This is purely for UI feedback — the share value doesn't need to be real-time.

**Fix:** The heat broadcast goroutine already calls `GetShares()` at 1 Hz. Cache that result and have `GetShareForUser` read from cache instead of recomputing.

```go
type HeatCache struct {
    shares map[uuid.UUID]float64
    mu     sync.RWMutex
}

// Called by 1 Hz goroutine
func (hc *HeatCache) Update(shares []PlayerShare) { ... }

// Called by handleBatchInsert — O(1) map lookup
func (hc *HeatCache) GetShareForUser(userID uuid.UUID) float64 { ... }
```

**Result:** `GetShares()` drops from 250/sec to 1/sec. `batch_insert` hot path does a single O(1) map lookup instead of O(N) iteration.

**Files:**
- `backend/business/core/heat/heat.go` — add cache struct and methods
- `backend/app/services/api/main.go` — heat broadcast goroutine updates cache
- `backend/business/web/ws/handler.go` — read from cache instead of `heatEngine.GetShareForUser()`

**Effort:** Small. Pure in-process change.

---

## Priority 4: Go-Layer Write Coalescing (Per-User Debounce)

**Problem:** Even with rate limiting (Priority 1), each user still generates up to 5 DB writes/sec. With 100 concurrent users, that's 500 tx/sec hitting PG.

**Fix:** Buffer `batch_insert` requests per-user in a Go channel. Flush once per 200ms window, merging multiple inserts into a single DB transaction.

```
User sends: batch_insert(3), batch_insert(5), batch_insert(2) within 200ms
Go buffers: → single ProcessBatchInsert(10) → 1 DB transaction
```

**Result:** DB writes capped at 5/sec/user regardless of client behavior, and multiple inserts within the same window are merged.

**Files:**
- New coalescing buffer in `ws/handler.go` or a dedicated `batcher` package
- Adjust `handleBatchInsert` to push into buffer instead of calling `gameCore` directly

**Effort:** Medium. Needs careful goroutine lifecycle management. Consider timeout + max-batch-size semantics.

---

## Priority 5: Redis for Horizontal Scaling

**When:** When deploying multiple Go backend instances behind a load balancer.

**Problem:** Several in-memory states break with multiple instances:

| State | Problem with N instances |
|---|---|
| HeatEngine | Each instance tracks only its own users' heat. `GetShares()` returns different results per instance → unfair reward distribution |
| Ability cooldowns | User reconnects to different instance → cooldown resets → can spam abilities |
| slotCounts | Optimistic increment is per-instance → slots can exceed cap temporarily (self-heals via game server correction every 1s) |

**What goes into Redis:**

### 5a. HeatEngine → Redis

Use Lua scripts for atomic read-modify-write (prevents lost updates from concurrent instances):

```lua
-- AddHeat: atomic decay + add
local raw = tonumber(redis.call('HGET', KEYS[1], 'raw') or '0')
local ts  = tonumber(redis.call('HGET', KEYS[1], 'ts') or ARGV[2])
local dt = ARGV[2] - ts
if dt > 0 and raw > 0 then
    raw = raw * math.exp(-tonumber(ARGV[3]) * dt)
end
raw = raw + tonumber(ARGV[1])
redis.call('HSET', KEYS[1], 'raw', tostring(raw), 'ts', ARGV[2])
redis.call('EXPIRE', KEYS[1], 600)
return tostring(raw)
```

GetShares also via Lua script, called once per second (see Priority 3 caching pattern). Maintain a `heat:index` SET of active user IDs for iteration.

### 5b. Ability cooldowns → Redis

```
SET cooldown:{userId}:{ability} 1 EX {seconds} NX
```

Single atomic command. NX ensures only one instance succeeds. TTL auto-cleans.

### 5c. What stays in-memory

- **slotCounts:** Self-corrects every 1s from game server broadcast. Acceptable drift.
- **Hub snapshot:** Per-instance cache. Each instance caches independently.
- **GetShares cache:** Per-instance read cache of the Redis-computed shares (1 Hz refresh).

**What does NOT go into Redis:**

- **Balances:** Must stay in PG for ACID guarantees. Financial data requires durability.
- **Accounting logs:** Append-only ledger, PG is the right store.

### 5c. NATS Queue Groups

Alongside Redis, NATS subscriptions that perform writes must use queue groups so only one instance processes each event:

```go
// Before: every instance processes every despawn
nc.Subscribe("game.main.evt.coin_despawn", handler)

// After: only one instance in the "backend" group processes each despawn
nc.QueueSubscribe("game.main.evt.coin_despawn", "backend", handler)
```

Applies to: `evt.coin_despawn` (reward distribution), heat_update publish, reward flush.

Does NOT apply to (all instances must receive): `state_delta`, `despawn`, `snapshot`, `coin_spawn`, `slot_status`, and other client-broadcast topics.

**Effort:** High. Requires Redis infrastructure, Lua scripts, refactoring HeatEngine interface, NATS subscription changes. Well-defined scope though.

---

## Summary

| Priority | Change | PG Load Reduction | Effort | Requires New Infra |
|---|---|---|---|---|
| 1 | batch_insert rate limit | Unbounded → 5/sec/user | ~10 lines | No |
| 2 | SQL optimization (RETURNING + single tx) | 6 → 2 round-trips/insert | Medium | No |
| 3 | Cache GetShares | 250 → 1 call/sec | Small | No |
| 4 | Write coalescing | 5 → 1 tx/sec/user | Medium | No |
| 5 | Redis + NATS queue groups | Enables horizontal scaling | High | Redis |

Priorities 1-3 should be done together as a single pass — they're low risk and address the most pressing bottlenecks. Priority 4 is a good follow-up if PG remains a bottleneck at higher concurrency. Priority 5 is gated on the decision to run multiple backend instances.
