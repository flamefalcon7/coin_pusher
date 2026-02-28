# Security Audit Report

**Date**: 2026-02-28
**Scope**: Full codebase — Go backend, TypeScript game server, TypeScript client, shared protocol
**Codebase**: ~28K lines across 120+ source files

---

## Summary

| Severity | Count | Key Themes |
|----------|-------|------------|
| P0 | 8 (1 fixed) | Free coin injection, auth bypass, pprof exposure, ~~admin commands unguarded~~, reward system broken, CSRF via WS, weak HD wallet KDF, deposit double-credit |
| P1 | 19 | Predictable RNG, NATS fragility, token leakage, timing attacks, missing rate limits, float64 financials, reorg handling, fire-and-forget NATS |

---

## P0 Findings (Critical — Must Fix Before Launch)

### P0-1: Free Coins — `coin_insert` and `spawn_stack` Do Not Debit Balance

**Location**: `backend/business/web/ws/handler.go:184-248`

`handleCoinInsert` and `handleSpawnStack` publish directly to NATS with **zero balance debit**. Only `handleBatchInsert` calls `ProcessBatchInsert` to debit `balance_play`.

```go
func (h *Handler) handleCoinInsert(c *Connection, msg ClientMessage) {
    if !c.CanInsertCoin() {
        return
    }
    // No balance check, no accounting
    cmd := NATSCoinInsertCmd{
        UserID: c.userID,
        X:      x,
        Y:      spawnHeight,
        Z:      backWallZ,
    }
    h.nc.Publish(TopicCoinInsert(h.room), data)
}
```

- `coin_insert`: 50ms cooldown = 20 free coins/sec
- `spawn_stack` with cylinder: 240 free coins per message (30 levels x 8 per level)
- These coins participate in shared physics — when they fall off the front edge, they generate rewards

**Impact**: Unlimited free coin injection. A malicious player can flood the board with free coins, pushing other coins off the front edge to generate cash rewards credited to their balance. This is a direct money-printing vulnerability in a real-money game.

**Recommendation**: `handleCoinInsert` and `handleSpawnStack` must debit `balance_play` before publishing to NATS, identical to how `handleBatchInsert` works. If the debit fails (insufficient funds), reject the command.

---

### P0-2: Dev-Mode Login Endpoint Exposed in Production Without Guard

**Location**: `backend/app/services/api/main.go:590`

```go
mux.Post("/v1/auth/login", mid.Errors(log, userGrp.Login)) // dev mode only ← comment only
```

The comment says "dev mode only", but the route is registered **unconditionally** — there is no check of `cfg.Auth.DevMode`. The `Login` handler accepts arbitrary `provider_type` and `provider_uid`, calls `FindOrCreate`, and issues a JWT, completely bypassing wallet signature verification.

**Impact**: Complete authentication bypass. An attacker can authenticate as any wallet address by sending `{"provider_type":"wallet","provider_uid":"0xVICTIM"}`, then call `/v1/withdraw` to steal funds.

**Recommendation**:
```go
if cfg.Auth.DevMode {
    mux.Post("/v1/auth/login", mid.Errors(log, userGrp.Login))
}
```

---

### P0-3: Debug/pprof Endpoints Exposed on Public API Mux

**Location**: `backend/app/services/api/main.go:577`

```go
debug.Routes(mux, db) // Registered on public port 4000
```

The pprof endpoints (`/debug/pprof/*`) are unauthenticated and registered on the public API mux:
- `/debug/pprof/` — heap profiles, goroutine dumps
- `/debug/pprof/cmdline` — command-line arguments (may expose secrets)
- `/debug/pprof/profile` — CPU profiling (DoS vector)
- `/debug/pprof/trace` — execution tracing

**Impact**: Heap dumps can contain the HD wallet master seed (`wallet.masterKey`), JWT signing keys, database credentials, and user session data. Compromising the master seed means all deposit addresses and the hot wallet are compromised — total loss of funds.

**Recommendation**: Remove `debug.Routes(mux, db)` from `buildAPIMux`. The debug server on port 4010 already serves these routes and should be firewalled to internal access only.

---

### P0-4: ~~Admin Commands Have No Authorization Check~~ — FIXED

**Status**: Fixed (2026-03-01)

**Location**: `backend/business/web/ws/handler.go`, `backend/business/web/ws/connection.go`

**Fix implemented**:
- Added `role` column to `accounts` table (default `'user'`)
- JWT `Claims` now includes `Role` field, populated from DB at login
- `Connection` struct carries `role` from JWT claims, exposes `IsAdmin() bool`
- All four admin commands (`spawn_stack`, `clear_all`, `fill_platform`, `update_scene_objects`) are guarded with `if !c.IsAdmin() { return }`
- Admin CLI `set-role` subcommand to promote accounts: `admin set-role <uuid> admin`
- Non-admin users sending admin commands are silently ignored

**Verification**: `TestIsAdmin` (4 subtests), `TestGenerateToken_AdminRole`, `TestAuthenticate_AdminRole`

---

### P0-5: Reward System Completely Non-Functional — Despawn Event Format Mismatch

**Location**:
- Game server: `game/server/src/nats/NATSClient.ts:358-361`
- Backend: `backend/app/services/api/main.go:336-360`
- Backend relay: `backend/business/web/ws/relay.go:59-66`

The game server publishes coin despawn events in this format:
```json
{"coins":[{"id":42,"zone":"front","owner_id":"..."}],"tick":100}
```

The backend expects a completely different format:
```go
var evt struct {
    Zone      string `json:"zone"`      // ← always "" (field doesn't exist at top level)
    CoinCount int    `json:"coin_count"` // ← always 0 (field doesn't exist)
}
```

The JSON unmarshal succeeds (no error) but `evt.Zone == ""` ≠ `"front"`, so every despawn event is silently discarded. `ProcessGameReward` is never called. Additionally, the relay only logs reward events:

```go
sub, err = rl.nc.Subscribe(TopicReward(rl.room), func(msg *nats.Msg) {
    rl.log.Infow("reward event received", "data_len", len(msg.Data))
})
```

**Impact**: `balance_cash` has no legitimate inflow path via gameplay. The entire revenue loop (coins fall off front edge → user earns CASH → user withdraws USDC) is broken. This also masks P0-1 (free coins don't generate rewards either, so the exploit is currently dormant but becomes critical the moment this is fixed).

**Recommendation**: Align the backend subscriber to match the game server's event format:
```go
var evt struct {
    Coins []struct {
        ID      int    `json:"id"`
        Zone    string `json:"zone"`
        OwnerID string `json:"owner_id"`
    } `json:"coins"`
    Tick int `json:"tick"`
}
```
Then iterate over `evt.Coins`, count front-edge despawns, and call `ProcessGameReward`.

---

### P0-6: WebSocket Upgrader Accepts All Origins

**Location**: `backend/business/web/ws/handler.go:33-37`

```go
var upgrader = websocket.Upgrader{
    ReadBufferSize:  1024,
    WriteBufferSize: 1024,
    CheckOrigin:     func(r *http.Request) bool { return true },
}
```

Combined with JWT token passed as URL query parameter, this enables Cross-Site WebSocket Hijacking (CSWSH). A malicious website can establish a WebSocket connection and perform actions as the victim user.

**Impact**: If an attacker obtains a user's JWT (which is in URL query strings, server logs, browser history), they can control the user's game session from any domain — including spending balance and triggering withdrawals.

**Recommendation**: Validate the origin against configured CORS origins:
```go
CheckOrigin: func(r *http.Request) bool {
    origin := r.Header.Get("Origin")
    return isAllowedOrigin(origin)
},
```

---

### P0-7: HD Wallet Derivation Uses Weak Non-Standard KDF

**Location**: `backend/foundation/wallet/wallet.go:39-51`

```go
func (w *Wallet) DerivePrivateKey(index int) (*ecdsa.PrivateKey, error) {
    buf := make([]byte, len(w.masterKey)+8)
    copy(buf, w.masterKey)
    binary.BigEndian.PutUint64(buf[len(w.masterKey):], uint64(index))
    childSeed := crypto.Keccak256(buf)
    key, err := crypto.ToECDSA(childSeed)
    // ...
}
```

Custom key derivation: `childKey = Keccak256(masterKey || index)`. Not BIP-32/BIP-44. No HMAC, no key stretching, single hash iteration.

**Impact**: All user deposit addresses are derived from a single master seed. The simplicity of this scheme (compared to BIP-32) makes it easier to reverse-engineer the master key if any child private key is compromised, potentially compromising ALL deposit addresses and the hot wallet.

**Recommendation**: Use standard BIP-32/BIP-44 HD key derivation (e.g., `github.com/btcsuite/btcutil/hdkeychain`).

---

### P0-8: Deposit Idempotency Check Outside Transaction — TOCTOU Double-Credit

**Location**: `backend/business/core/accounting/accounting.go:76-84`

```go
func (c *Core) ProcessDeposit(ctx context.Context, accountID uuid.UUID, amount decimal.Decimal, currency, referenceID string) error {
    // Check outside transaction
    _, err := c.storer.QueryByReference(ctx, ActionDeposit, referenceID)
    if err == nil {
        return nil // Already processed
    }
    // ... then starts transaction and creates log + credits balance
```

Two concurrent calls with the same `referenceID` can both pass the check before either creates the accounting log. The unique index on `accounting_logs(action_type, reference_id)` provides a safety net, but the recovery path in `deposit.go:177-185` uses a separate transaction, creating a window for double-credit.

**Impact**: Under concurrent processing of the same tx_hash (e.g., indexer restart), a deposit could be credited twice.

**Recommendation**: Move the idempotency check inside the transaction, or use `INSERT ... ON CONFLICT DO NOTHING` and check rows affected.

---

## P1 Findings (High — Strongly Recommended Before Launch)

### P1-1: Slot Machine and Jackpot Wheel Use `Math.random()`

**Location**: `game/server/src/game/GameLoop.ts:796-800` (slot machine), `GameLoop.ts:877` (wheel)

```typescript
const reels: [SlotSymbol, SlotSymbol, SlotSymbol] = [
    symbols[Math.floor(Math.random() * symbols.length)],
    symbols[Math.floor(Math.random() * symbols.length)],
    symbols[Math.floor(Math.random() * symbols.length)],
];
```

`Math.random()` uses xorshift128+ in V8, which is predictable given enough observations. In a real-money game, an attacker who observes the sequence of random outcomes can reconstruct the PRNG state and predict future jackpot outcomes.

**Recommendation**: Use `crypto.randomInt()` for all game-outcome-affecting random numbers.

---

### P1-2: NATS `JSON.parse()` Without try/catch — Single Bad Message Kills Subscription

**Location**: `game/server/src/nats/NATSClient.ts:92-101` (all 11 subscription methods)

```typescript
for await (const msg of sub) {
    const cmd = JSON.parse(sc.decode(msg.data)) as CoinInsertCommand;
    handler(cmd);
}
```

No try/catch. If any malformed message arrives, `JSON.parse` throws, terminating the `for await` loop permanently. That subscription channel is dead for the lifetime of the process.

**Impact**: A single malformed NATS message permanently disables the affected game command channel (e.g., all coin drops stop working).

**Recommendation**: Wrap each handler body in try/catch.

---

### P1-3: WebSocket Token Exposed in URL Query Parameter

**Location**: `game/client/src/net/WebSocketClient.ts:28` (client), `backend/business/web/ws/handler.go:78` (server)

```typescript
const wsUrl = this.token ? `${this.url}?token=${this.token}` : this.url;
```

JWT tokens appear in server access logs, proxy logs, browser history, and HTTP Referer headers. The token is valid for 24 hours and grants full account access including withdrawals.

**Recommendation**: Send token as first WebSocket message after connection, not in URL.

---

### P1-4: GameSecret Comparison Vulnerable to Timing Attack

**Location**: `backend/business/web/mid/auth.go:46`

```go
if secret == "" || secret != apiKey {
```

Standard string equality short-circuits on first differing byte. An attacker can progressively brute-force the API key by measuring response times.

**Recommendation**: Use `crypto/subtle.ConstantTimeCompare`.

---

### P1-5: Default Game API Key is `dev-secret`

**Location**: `backend/app/services/api/main.go:87`

```go
Game struct {
    APIKey string `conf:"default:dev-secret,mask"`
}
```

No production guard prevents running with this default. Anyone who reads the source code can call `POST /v1/game/event` to fabricate game events.

**Recommendation**: Add a production guard:
```go
if cfg.Game.APIKey == "dev-secret" && !cfg.Auth.DevMode {
    return fmt.Errorf("BACKEND_GAME_APIKEY must be set in production")
}
```

---

### P1-6: No Request Body Size Limit

**Location**: `backend/business/web/v1/v1.go:36`

```go
func Decode(r *http.Request, val any) error {
    decoder := json.NewDecoder(r.Body) // No MaxBytesReader
```

An attacker can send multi-GB request bodies to cause OOM crashes.

**Recommendation**: Apply `http.MaxBytesReader(nil, r.Body, 1<<20)` (1MB limit).

---

### P1-7: No Maximum Batch Insert Size

**Location**: `backend/app/services/api/handlers/v1/gamegrp/gamegrp.go:73`, `backend/business/web/ws/handler.go:439`

Both the HTTP and WS handlers only check `count > 0` with no upper bound. The HTTP endpoint has no slot cap at all. A user could send `count: 2147483647`.

**Recommendation**: Add per-request maximum (e.g., `maxBatchCount = 100`).

---

### P1-8: Reward Accumulator Uses `float64`

**Location**: `backend/app/services/api/main.go:333`

```go
rewardAccum := make(map[uuid.UUID]float64)
```

Game rewards in a real-money system (USDC) are accumulated using float64 arithmetic. Over many small amounts, floating-point rounding errors accumulate.

**Recommendation**: Use `shopspring/decimal` for the reward accumulator.

---

### P1-9: Wallet Master Seed Held in Memory for Entire Process Lifetime

**Location**: `backend/foundation/wallet/wallet.go:34`

```go
type Wallet struct {
    masterKey []byte
}
```

The master seed persists in memory for the entire lifetime of both the API server and executor process. Combined with P0-3 (pprof exposure), the seed can be extracted via heap dump.

**Recommendation**: Use HSM/KMS for production signing. At minimum, fix P0-3 as immediate mitigation.

---

### P1-10: Withdrawal Has No `SELECT FOR UPDATE` — Daily Limit Bypass

**Location**: `backend/business/core/deposit/deposit.go:280-310`

`QueryByID` reads the account row without `FOR UPDATE`. Under READ COMMITTED, two concurrent withdrawal requests can both pass the daily limit check.

**Recommendation**: Use `SELECT ... FOR UPDATE` on the account row inside `RequestWithdrawal`.

---

### P1-11: Transaction Isolation Level Is Default (READ COMMITTED)

**Location**: `backend/foundation/database/tx.go:31`

```go
tx, err := db.BeginTxx(ctx, nil) // nil = default READ COMMITTED
```

For financial transactions, this allows non-repeatable reads within a transaction.

**Recommendation**: Use `SERIALIZABLE` or `REPEATABLE READ` for financial operations, or use explicit row-level locks.

---

### P1-12: Indexer Does Not Handle Chain Reorganizations

**Location**: `backend/app/tooling/indexer/main.go:214-229`

```go
header, err := client.HeaderByNumber(ctx, nil) // latest, not finalized
```

The indexer processes events from `latest` blocks without waiting for finality. On Base (OP-Stack L2), blocks become final after the L1 finality window. A reorganization could remove a deposit transaction after it has been credited.

**Recommendation**: Use `eth_getBlockByNumber("finalized")` or implement a confirmation delay.

---

### P1-13: `UpdateBalance` Returns Wrong Column

**Location**: `backend/business/core/user/stores/userdb/userdb.go:97-114`

```go
case "USDC":
    q = `UPDATE accounts SET balance_usdc = balance_usdc + $2 ...
        RETURNING balance_play`    // ← should be balance_usdc
case "CASH":
    q = `UPDATE accounts SET balance_cash = balance_cash + $2 ...
        RETURNING balance_play`    // ← should be balance_cash
```

USDC and CASH updates return `balance_play` instead of the correct column. Currently callers discard the return value, but this is a latent bug.

**Recommendation**: Fix each SQL to return the correct column.

---

### P1-14: NATS Publish Is Fire-and-Forget — Paid Actions Can Be Lost

**Location**: `backend/business/web/ws/handler.go:505`, `backend/app/services/api/handlers/v1/gamegrp/gamegrp.go:109`

The flow is: (1) debit `balance_play` via DB, (2) publish to NATS (fire-and-forget). If step 2 fails, the user's balance is debited but coins are never spawned. The `nc.Publish` error return is not checked.

**Recommendation**: Check `nc.Publish` error. If it fails, refund the debited balance. Consider NATS JetStream or an outbox pattern.

---

### P1-15: `FindOrCreate` Has No Transaction Protection

**Location**: `backend/business/core/user/user.go:36-75`

The check-then-create is not wrapped in a transaction. Two concurrent logins for the same wallet can both pass `QueryByProvider` and both create accounts. The `accounts` table gets an orphaned row.

**Recommendation**: Wrap in a transaction. Use `INSERT ... ON CONFLICT` or retry on unique violation.

---

### P1-16: No Rate Limiting on Authentication Endpoints

**Location**: `backend/app/services/api/main.go:588-590`

No rate limiting on `/v1/auth/nonce` (writes to DB on every call) or `/v1/auth/wallet/login`. An attacker can flood the nonce table.

**Recommendation**: Add per-IP rate limiting (e.g., 10 nonce requests/min, 5 login attempts/min).

---

### P1-17: Indexer Block Cursor Advances on Partial Failure

**Location**: `backend/app/tooling/indexer/main.go:301-312`

```go
for _, vLog := range evtLogs {
    if err := depositCore.ProcessDeposit(...); err != nil {
        log.Errorw("process deposit error", ...)
        continue  // ← continues, does NOT stop
    }
}
*lastBlock = toBlock  // ← cursor advances past failed deposits
```

If a deposit fails to process (transient DB error), it is permanently skipped because the cursor advances past the entire block range.

**Recommendation**: Stop advancing cursor on failure, or maintain a "failed deposits" retry queue.

---

### P1-18: CORS Wildcard Fallback

**Location**: `backend/app/services/api/main.go:558-571`

When `CORSOrigins == "*"`, defaults to `[]string{"https://*", "http://*"}`. The `https://*` pattern in go-chi/cors matches ALL HTTPS origins. While there is a production guard, a misconfiguration like `CORS_ORIGINS=https://*` bypasses it.

**Recommendation**: Validate that configured origins are specific domain names, reject wildcard patterns in production.

---

### P1-19: Readiness Endpoint Leaks Internal Error Details

**Location**: `backend/app/services/api/handlers/debug/debug.go:37-44`

Since debug routes are on the public mux (P0-3), the readiness endpoint returns raw database error messages including hostnames, ports, and connection details.

**Recommendation**: Return generic "not ready" on the public mux. Detailed errors only on internal debug server.

---

## Recommended Fix Priority

### Immediate (Day 1)

| Priority | Finding | Fix |
|----------|---------|-----|
| 1st | P0-2 | Add `DevMode` guard to `/v1/auth/login` |
| 2nd | P0-3 | Remove `debug.Routes(mux, db)` from public mux |
| ~~3rd~~ | ~~P0-4~~ | ~~Remove or gate admin commands behind role check~~ — **FIXED** |
| 4th | P0-1 | Add balance debit to `coin_insert` and `spawn_stack` |

### This Week

| Priority | Finding | Fix |
|----------|---------|-----|
| 5th | P0-5 | Align despawn JSON format, implement `ProcessGameReward` call |
| 6th | P0-6 | WebSocket origin validation |
| 7th | P0-8 | Move deposit idempotency check inside transaction |
| 8th | P1-3/4/5 | Token out of URL, constant-time compare, production API key guard |

### Before Launch

| Priority | Finding | Fix |
|----------|---------|-----|
| 9th | P0-7 | Migrate to BIP-32 HD wallet |
| 10th+ | All P1 | All remaining P1 items |
