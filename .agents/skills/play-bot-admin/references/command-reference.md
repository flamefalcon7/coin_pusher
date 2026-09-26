# `admin bot` Command Reference

Full reference for the `admin bot` subcommand surface. Source: `backend/app/tooling/admin/bot.go`.

All examples assume `cd backend && go run ./app/tooling/admin/` prefix (dev) or `docker exec coin_pusher-backend-1 /bin/admin` (prod).

---

## `seed`

```
admin bot seed
```

**Purpose:** Provision 20 bot accounts (8 with curated `display_name`, 12 with `display_name=NULL`) and seed default `bot_config` rows.

**Behavior:**
- Idempotent: skips if 20 accounts with `role='bot'` already exist.
- Inserts `accounts` rows with `role='bot'`.
- Inserts `auth_providers` rows with `provider_type='bot'` (NOT `'wallet'`).
- Pre-checks the curated display_name pool against existing users; falls back if collision.
- Writes default `bot_config` if rows missing: `kill_switch=off`, `refill_amount=1000`, `refill_threshold=100`, `daily_global_refill_cap=50000`, `crowd_scale={"0":3,"1":4,"2":4,"3":3,"4":3,"5":2}`.

**Curated display names:**
```
CoinDropMaster, 0xPusher, jackpot_hunter, VitalikFan,
SatoshiFTW, CascadeKing, RektLord, diamond_hands
```

**When to run:** First deploy only. After that, only if explicitly confirmed.

**Failure recovery:** If exits non-zero mid-way, run `admin bot list` to inspect state. Do NOT re-run blindly.

---

## `list`

```
admin bot list
admin bot list --json
```

**Purpose:** Show all bot accounts and their state.

**Columns:**
- `account_id` (UUID)
- `display_name` (`(anonymous)` if NULL)
- `status` — `online` if the last insert (`accounting_logs`) is under 2 min old, else `offline`
- `total` — balance
- `today_in` — today's insert total
- `today_pl` — today's reward − insert

`--json` also returns `balance_play`, `balance_cash`, `last_insert_at`, `online`, `today_reward`.

**Notes:**
- Reads from DB only. Does NOT consult scheduler in-memory state (admin is a separate process).
- Use `--json` for piping/parsing.

---

## `stats`

```
admin bot stats
admin bot stats --since 24h
admin bot stats --since 168h
admin bot stats --since 30m
admin bot stats --since 24h --json
```

**Purpose:** Aggregate bot economic activity since a duration.

**Default:** `--since 24h`.

**Output** (also available as `--json`):
- `GAME_INSERT total` — bot inserts in the window
- `REWARD total` — GAME_REWARD + CHEST_REWARD credited to bots
- `net flow (rew-ins)` — reward − insert, from the bots' side (negative = house gained)
- `BOT_REFILL total`

The CLI does not print its SQL. The query is one row of `SUM(CASE WHEN action_type = … THEN amount END)` per total over bot accounts since the cutoff (`botStats` in `bot.go`).

**Edge cases:** Empty window returns zeros, not an error.

---

## `pause <account_id>`

```
admin bot pause a1b2c3d4-e5f6-7890-abcd-ef1234567890
```

**Purpose:** Take a single bot offline persistently.

**Behavior:**
- Inserts `account_id` into `bot_paused_accounts` table (single-column primary key).
- Survives backend restarts.
- Scheduler reads this set per-tick (5s cache); paused bots are skipped.

**Errors:**
- Invalid UUID → CLI rejects.
- account not found, or `role` is not `bot` → rejects (direct `SELECT role FROM accounts` check).

---

## `resume <account_id>`

```
admin bot resume a1b2c3d4-e5f6-7890-abcd-ef1234567890
```

**Purpose:** Lift per-bot pause.

**Behavior:** Deletes `account_id` from `bot_paused_accounts`. Bot becomes eligible for online transition at next tick. No role check: an id that isn't paused prints a no-op message.

**NOTE:** This does NOT lift the global `kill_switch`. Use `kill-switch off` for that.

---

## `kill-switch on|off`

```
admin bot kill-switch on
admin bot kill-switch off
```

**Purpose:** Global emergency stop / restart.

**Behavior:**
- `on`: writes `bot_config.kill_switch = "on"`. At next 5s tick, scheduler takes ALL bots offline and skips inserts. Refills also halt.
- `off`: writes `bot_config.kill_switch = "off"`. Scheduler resumes normal operation at next tick.

**Persistence:** Survives restarts (it's a DB row).

**Reversibility:** Fully reversible with zero data loss.

**Effect on individually-paused bots:** Per-bot `pause` state is independent; lifting kill switch will NOT un-pause individually-paused bots.

---

## `refill <account_id> <amount>`

```
admin bot refill a1b2c3d4-e5f6-7890-abcd-ef1234567890 500
```

**Purpose:** Manually credit play coins to a bot.

**Behavior:**
- Wraps `bot.Core.RefillBalance` → `accounting.Core.ProcessBotRefill`.
- Writes `ActionBotRefill` ledger row.
- Credits `balance_play` (NOT `balance_cash`).
- `reference_id` format: `bot-refill-manual:<account_id>:<unix_nano>` (distinct from scheduler's `bot-refill:<account_id>:<yyyymmddUTC>`).
- Counts toward `daily_global_refill_cap` like scheduler refills.

**Errors:**
- account_id not a bot → `ErrNotABot`.
- Amount ≤ 0 → validation error.
- No daily-cap error: the CLI does not check `daily_global_refill_cap` (only the scheduler does).

**Operator guidance:** Amounts > 1000 should require explicit user confirmation. Always check today's cap usage first (see SKILL.md MUST DO).

---

## `config show`

```
admin bot config show
admin bot config show --json
```

**Purpose:** Print all rows from `bot_config`.

**Output:** Each row shows `config_key`, `config_value`, `updated_at`.

**Use:** Always run before `config set` so the operator sees the current state.

---

## `config set <key> <value>`

```
admin bot config set refill_amount 2000
admin bot config set refill_threshold 150
admin bot config set daily_global_refill_cap 80000
admin bot config set crowd_scale '{"0":3,"1":5,"2":5,"3":4,"4":3,"5":2}'
```

**Purpose:** Update a single config row.

**Validation (CLI layer):**
- Known key check (rejects unknown keys).
- Value format check per key:
  - `refill_amount`, `refill_threshold`, `daily_global_refill_cap` → integer.
  - `crowd_scale` → valid JSON object with integer values.
  - `kill_switch` → accepted (`on`/`off` only), but prefer the `kill-switch` subcommand.

**Hot reload:** Scheduler re-reads via memory cache (5s TTL). No restart needed; max 5s staleness.

**Economy keys (operator must confirm changes to these):**
- `refill_amount` — directly scales house spend per refill.
- `daily_global_refill_cap` — circuit breaker; raising it removes a safety net.
- `crowd_scale` — alters bot active count, which changes board density and heat denominator.

---

## Exit Codes

- `0` — success.
- `1` — any error (CLI parse error, DB error, validation error). The error message is on stderr.

Never mask non-zero exits. Surface them to the operator verbatim.

---

## Related (NOT covered by this skill)

The following `admin` subcommands exist but are NOT part of the play-bot operator surface:

- `admin migrate` — schema migration (separate concern).
- `admin seed` (top-level) — DB seed file (NOT bot seed).
- `admin set-role` — promote/demote `user`/`admin`. **Cannot promote to `bot`** (intentional security boundary).
- `admin outbox status` — outbox drainer health.
- `admin dlq ...` — DLQ ops.

If the operator asks about these, defer to a different skill or explain they're out of scope for the bot operator role.
