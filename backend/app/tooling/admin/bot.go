// Admin subcommands for the bot subsystem (`admin bot ...`).
//
// Surfaces every operator action documented in the play-bot plan:
//   - seed:        provision the 20-bot pool + default bot_config rows
//   - list:        per-bot snapshot (balance, last insert, today's P/L)
//   - stats:       aggregate insert/reward/refill since a given window
//   - pause:       restart-durable per-bot pause (writes bot_paused_accounts)
//   - resume:      remove pause flag
//   - kill-switch: flip global ConfigKeyKillSwitch
//   - refill:      manual balance_play credit via bot.Core.RefillBalance
//   - config:      show / set bot_config rows with per-key validation
//
// Mirrors the dispatcher shape in dlq.go: plain stdlib, no cobra, errors
// returned with context for main.go to log+exit.
//
// See docs/plans/2026-04-16-001-feat-play-bot-plan.md (Unit 6).
package main

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"math/big"
	"os"
	"sort"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jmoiron/sqlx"
	"github.com/shopspring/decimal"

	"github.com/flamefalcon/coin-pusher/backend/business/core/accounting"
	"github.com/flamefalcon/coin-pusher/backend/business/core/accounting/stores/ledgerdb"
	"github.com/flamefalcon/coin-pusher/backend/business/core/bot"
	"github.com/flamefalcon/coin-pusher/backend/business/core/bot/stores/botdb"
	"github.com/flamefalcon/coin-pusher/backend/business/core/user"
	"github.com/flamefalcon/coin-pusher/backend/business/core/user/stores/userdb"
	"github.com/flamefalcon/coin-pusher/backend/foundation/database"
)

// botCmd dispatches `admin bot <sub>` subcommands.
func botCmd(db *sqlx.DB) error {
	if len(os.Args) < 3 {
		return fmt.Errorf("usage: admin bot <seed|list|stats|pause|resume|kill-switch|refill|config>")
	}
	switch os.Args[2] {
	case "seed":
		return botSeed(db)
	case "list":
		return botList(db)
	case "stats":
		return botStats(db)
	case "pause":
		return botPause(db)
	case "resume":
		return botResume(db)
	case "kill-switch":
		return botKillSwitch(db)
	case "refill":
		return botRefill(db)
	case "config":
		return botConfigCmd(db)
	default:
		return fmt.Errorf("unknown bot subcommand: %s", os.Args[2])
	}
}

// ---------------------------------------------------------------------------
// constructors
// ---------------------------------------------------------------------------

// newBotCore wires a tx-capable bot.Core for admin operations. The accounting
// core uses the same StorerFactory pattern as api/main.go so RefillBalance can
// run inside execTx.
func newBotCore(db *sqlx.DB) *bot.Core {
	userCore := user.NewCore(userdb.NewStore(db))
	acctCore := accounting.NewCore(
		db,
		ledgerdb.NewStore(db),
		userCore,
		func(dbtx database.DBTX) accounting.Storer { return ledgerdb.NewStore(dbtx) },
		func(dbtx database.DBTX) user.Storer { return userdb.NewStore(dbtx) },
	)
	return bot.NewCore(db, botdb.NewStore(db), acctCore)
}

// ---------------------------------------------------------------------------
// seed
// ---------------------------------------------------------------------------

// botSeedTotal is the bot pool size enforced by the seeder. 20 = 8 named +
// 12 anonymous (display_name=NULL). Idempotent: re-running after the pool is
// at-or-above this size is a no-op.
const botSeedTotal = 20

// curatedDisplayNames are the 8 hand-picked names the seeder tries first.
// Each name is pre-checked against accounts.display_name (case-insensitive
// unique index per schema.sql:40); collisions are skipped with a log line and
// the bot is created with display_name=NULL instead.
var curatedDisplayNames = []string{
	"CoinDropMaster",
	"0xPusher",
	"jackpot_hunter",
	"VitalikFan",
	"SatoshiFTW",
	"CascadeKing",
	"RektLord",
	"diamond_hands",
}

// defaultBotConfig is the canonical first-deploy config block. Seeded if-missing
// (UPSERT on the table is not used here — we want existing operator-set values
// to win on re-seed, so we INSERT only when the row is absent).
var defaultBotConfig = map[string]string{
	bot.ConfigKeyKillSwitch:      "off",
	bot.ConfigKeyRefillAmount:    "1000",
	bot.ConfigKeyRefillThreshold: "100",
	bot.ConfigKeyDailyCap:        "50000",
	bot.ConfigKeyCrowdScale:      `{"0":3,"1":4,"2":4,"3":3,"4":3,"5":2}`,
}

func botSeed(db *sqlx.DB) error {
	ctx := context.Background()

	// Idempotency gate: if the pool is already at-or-above target, skip
	// account creation entirely. Config seeding still runs (defensive: cheap
	// + safe via INSERT...ON CONFLICT DO NOTHING).
	var existing int
	if err := db.GetContext(ctx, &existing,
		`SELECT COUNT(*) FROM accounts WHERE role = $1`, user.RoleBot,
	); err != nil {
		return fmt.Errorf("count existing bots: %w", err)
	}

	if existing >= botSeedTotal {
		fmt.Printf("bot seed already complete (%d bots present, target %d) — skipping account creation\n",
			existing, botSeedTotal)
	} else {
		toCreate := botSeedTotal - existing
		fmt.Printf("seeding %d bot accounts (%d already present, target %d)\n",
			toCreate, existing, botSeedTotal)

		// Pre-check curated names against existing accounts so the create
		// path doesn't have to handle the unique-violation race. We always
		// try named bots first (up to 8 minus already-taken names), then
		// fill the remainder with anonymous bots.
		availableNames, err := filterAvailableNames(ctx, db, curatedDisplayNames)
		if err != nil {
			return fmt.Errorf("filter available names: %w", err)
		}

		// Decide name assignments for this seed batch. We don't try to
		// detect which named bots already exist — operators re-seeding
		// after manual deletes will simply get whatever names are still
		// free, and the pool will reach 20 regardless.
		nameQueue := availableNames
		created := 0
		for created < toCreate {
			var name *string
			if len(nameQueue) > 0 && created < len(availableNames) {
				n := nameQueue[0]
				nameQueue = nameQueue[1:]
				name = &n
			}
			// else: anonymous bot (display_name=NULL).

			if err := createBotAccount(ctx, db, name); err != nil {
				return fmt.Errorf("create bot %d: %w", created+1, err)
			}
			created++
		}

		fmt.Printf("seeded %d bot accounts\n", created)
		if skipped := len(curatedDisplayNames) - len(availableNames); skipped > 0 {
			fmt.Printf("note: %d curated display_name(s) collided with existing users and were skipped\n",
				skipped)
		}
	}

	// Default config rows — INSERT ... ON CONFLICT DO NOTHING so an operator's
	// hand-tuned values are never clobbered by re-seed.
	keys := make([]string, 0, len(defaultBotConfig))
	for k := range defaultBotConfig {
		keys = append(keys, k)
	}
	sort.Strings(keys)

	configCreated := 0
	for _, k := range keys {
		res, err := db.ExecContext(ctx, `
			INSERT INTO bot_config (config_key, config_value, updated_at)
			VALUES ($1, $2, NOW())
			ON CONFLICT (config_key) DO NOTHING
		`, k, defaultBotConfig[k])
		if err != nil {
			return fmt.Errorf("insert default config %s: %w", k, err)
		}
		n, _ := res.RowsAffected()
		if n > 0 {
			configCreated++
		}
	}
	fmt.Printf("bot_config: %d/%d default rows inserted (others already present)\n",
		configCreated, len(defaultBotConfig))

	return nil
}

// filterAvailableNames returns the subset of names from the candidate pool
// that no existing account currently uses (case-insensitive — matches the
// LOWER(display_name) unique index defined in schema.sql:40).
//
// Logs which names were skipped so operators can grep for collisions in CLI
// output.
func filterAvailableNames(ctx context.Context, db *sqlx.DB, candidates []string) ([]string, error) {
	available := make([]string, 0, len(candidates))
	for _, name := range candidates {
		var exists bool
		if err := db.GetContext(ctx, &exists,
			`SELECT EXISTS(SELECT 1 FROM accounts WHERE LOWER(display_name) = LOWER($1))`,
			name,
		); err != nil {
			return nil, fmt.Errorf("checking display_name %q: %w", name, err)
		}
		if exists {
			fmt.Printf("  skipping curated name %q (already taken by an existing account)\n", name)
			continue
		}
		available = append(available, name)
	}
	return available, nil
}

// createBotAccount inserts one accounts row + matching auth_providers row in
// a single tx. Provider UID is a fresh UUID so it cannot collide with a real
// 0x-wallet address, and the provider_type is 'bot' which the login pipeline
// rejects at every layer (Unit 4).
//
// Referral code: bots need NOT NULL, unique referral codes (schema.sql:19). We
// generate a "bot-XXXXXXXX" code with random base32-ish chars; collision is
// astronomically unlikely but the unique index would catch it and surface a
// clear error.
func createBotAccount(ctx context.Context, db *sqlx.DB, displayName *string) error {
	tx, err := db.BeginTxx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin tx: %w", err)
	}
	defer tx.Rollback() //nolint:errcheck

	accountID := uuid.New()
	providerUID := uuid.New().String() // distinct namespace from real wallet hex

	referralCode, err := generateBotReferralCode()
	if err != nil {
		return fmt.Errorf("generate referral code: %w", err)
	}

	if _, err := tx.ExecContext(ctx, `
		INSERT INTO accounts (account_id, display_name, role, referral_code)
		VALUES ($1, $2, $3, $4)
	`, accountID, displayName, user.RoleBot, referralCode); err != nil {
		return fmt.Errorf("insert account: %w", err)
	}

	if _, err := tx.ExecContext(ctx, `
		INSERT INTO auth_providers (account_id, provider_type, provider_uid)
		VALUES ($1, $2, $3)
	`, accountID, user.ProviderTypeBot, providerUID); err != nil {
		return fmt.Errorf("insert auth provider: %w", err)
	}

	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit: %w", err)
	}

	if displayName != nil {
		fmt.Printf("  created bot %s (display_name=%q)\n", accountID, *displayName)
	} else {
		fmt.Printf("  created bot %s (anonymous)\n", accountID)
	}
	return nil
}

// generateBotReferralCode produces a "bot-XXXXXXXX" referral code. The bot-
// prefix makes it obvious in audit dumps that the code belongs to a bot
// account, and the 8-char random suffix matches the entropy of
// user.generateReferralCode (re-implemented here because that function is
// unexported and the admin CLI is not the right place to widen the user
// package's surface).
func generateBotReferralCode() (string, error) {
	const charset = "abcdefghjklmnpqrstuvwxyz23456789" // no 0/o/1/i/l confusion (mirrors user.go)
	b := make([]byte, 8)
	for i := range b {
		n, err := rand.Int(rand.Reader, big.NewInt(int64(len(charset))))
		if err != nil {
			return "", err
		}
		b[i] = charset[n.Int64()]
	}
	return "bot-" + string(b), nil
}

// ---------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------

// onlineWindow defines how recently a bot must have inserted to be considered
// "online" by the admin CLI. The scheduler's true online/offline state lives
// in-memory and is not visible to the admin process; this is a best-effort
// proxy from the ledger.
const onlineWindow = 2 * time.Minute

type botListRow struct {
	AccountID    uuid.UUID       `db:"account_id"`
	DisplayName  *string         `db:"display_name"`
	BalancePlay  decimal.Decimal `db:"balance_play"`
	BalanceCash  decimal.Decimal `db:"balance_cash"`
	Total        decimal.Decimal `db:"total"`
	LastInsertAt sql.NullTime    `db:"last_insert_at"`
	TodayInsert  decimal.Decimal `db:"today_insert"`
	TodayReward  decimal.Decimal `db:"today_reward"`
}

func botList(db *sqlx.DB) error {
	jsonOut := false
	for _, a := range os.Args[3:] {
		if a == "--json" {
			jsonOut = true
		}
	}

	ctx := context.Background()

	// Single SQL pass: account snapshot + last insert timestamp + today's
	// per-bot insert/reward totals. Today is UTC-bucketed to match
	// bot.Core.DailyRefillTotal semantics.
	const q = `
		SELECT
			a.account_id,
			a.display_name,
			a.balance_play,
			a.balance_cash,
			(a.balance_play + a.balance_cash) AS total,
			(SELECT MAX(created_at) FROM accounting_logs
				WHERE account_id = a.account_id AND action_type = 'GAME_INSERT'
			) AS last_insert_at,
			COALESCE((SELECT SUM(amount) FROM accounting_logs
				WHERE account_id = a.account_id
					AND action_type = 'GAME_INSERT'
					AND created_at >= DATE_TRUNC('day', NOW() AT TIME ZONE 'UTC')
			), 0) AS today_insert,
			COALESCE((SELECT SUM(amount) FROM accounting_logs
				WHERE account_id = a.account_id
					AND action_type IN ('GAME_REWARD','CHEST_REWARD')
					AND created_at >= DATE_TRUNC('day', NOW() AT TIME ZONE 'UTC')
			), 0) AS today_reward
		FROM accounts a
		WHERE a.role = $1
		ORDER BY a.created_at ASC`

	var rows []botListRow
	if err := db.SelectContext(ctx, &rows, q, user.RoleBot); err != nil {
		return fmt.Errorf("query bot list: %w", err)
	}

	if jsonOut {
		return printBotListJSON(rows)
	}
	return printBotListTable(rows)
}

func printBotListTable(rows []botListRow) error {
	if len(rows) == 0 {
		fmt.Println("no bot accounts found (run `admin bot seed` first)")
		return nil
	}

	now := time.Now().UTC()
	fmt.Printf("=== bots (%d) ===\n", len(rows))
	fmt.Printf("  %-38s %-20s %-8s %12s %12s %12s\n",
		"account_id", "display_name", "status", "total", "today_in", "today_pl")
	for _, r := range rows {
		name := "(anonymous)"
		if r.DisplayName != nil {
			name = *r.DisplayName
		}
		status := "offline"
		if r.LastInsertAt.Valid && now.Sub(r.LastInsertAt.Time) < onlineWindow {
			status = "online"
		}
		pl := r.TodayReward.Sub(r.TodayInsert)
		fmt.Printf("  %-38s %-20s %-8s %12s %12s %12s\n",
			r.AccountID, truncate(name, 20), status,
			r.Total.StringFixed(2),
			r.TodayInsert.StringFixed(2),
			pl.StringFixed(2),
		)
	}
	return nil
}

func printBotListJSON(rows []botListRow) error {
	type jsonRow struct {
		AccountID    string  `json:"account_id"`
		DisplayName  *string `json:"display_name"`
		BalancePlay  string  `json:"balance_play"`
		BalanceCash  string  `json:"balance_cash"`
		Total        string  `json:"total"`
		LastInsertAt *string `json:"last_insert_at"`
		Online       bool    `json:"online"`
		TodayInsert  string  `json:"today_insert"`
		TodayReward  string  `json:"today_reward"`
		TodayPL      string  `json:"today_pl"`
	}

	now := time.Now().UTC()
	out := make([]jsonRow, 0, len(rows))
	for _, r := range rows {
		jr := jsonRow{
			AccountID:   r.AccountID.String(),
			DisplayName: r.DisplayName,
			BalancePlay: r.BalancePlay.String(),
			BalanceCash: r.BalanceCash.String(),
			Total:       r.Total.String(),
			TodayInsert: r.TodayInsert.String(),
			TodayReward: r.TodayReward.String(),
			TodayPL:     r.TodayReward.Sub(r.TodayInsert).String(),
		}
		if r.LastInsertAt.Valid {
			s := r.LastInsertAt.Time.UTC().Format(time.RFC3339)
			jr.LastInsertAt = &s
			jr.Online = now.Sub(r.LastInsertAt.Time) < onlineWindow
		}
		out = append(out, jr)
	}

	b, err := json.MarshalIndent(out, "", "  ")
	if err != nil {
		return fmt.Errorf("marshal: %w", err)
	}
	fmt.Println(string(b))
	return nil
}

// ---------------------------------------------------------------------------
// stats
// ---------------------------------------------------------------------------

func botStats(db *sqlx.DB) error {
	since := 24 * time.Hour
	args := os.Args[3:]
	for i := 0; i < len(args); i++ {
		if args[i] == "--since" && i+1 < len(args) {
			d, err := time.ParseDuration(args[i+1])
			if err != nil {
				return fmt.Errorf("invalid --since duration %q: %w", args[i+1], err)
			}
			if d <= 0 {
				return fmt.Errorf("--since must be positive, got %s", d)
			}
			since = d
			i++
		}
	}

	ctx := context.Background()
	cutoff := time.Now().UTC().Add(-since)

	type stats struct {
		InsertTotal decimal.Decimal `db:"insert_total"`
		RewardTotal decimal.Decimal `db:"reward_total"`
		RefillTotal decimal.Decimal `db:"refill_total"`
	}

	const q = `
		SELECT
			COALESCE(SUM(CASE WHEN l.action_type = 'GAME_INSERT' THEN l.amount END), 0) AS insert_total,
			COALESCE(SUM(CASE WHEN l.action_type IN ('GAME_REWARD','CHEST_REWARD') THEN l.amount END), 0) AS reward_total,
			COALESCE(SUM(CASE WHEN l.action_type = 'BOT_REFILL' THEN l.amount END), 0) AS refill_total
		FROM accounting_logs l
		JOIN accounts a ON a.account_id = l.account_id
		WHERE a.role = $1 AND l.created_at >= $2`

	var s stats
	if err := db.GetContext(ctx, &s, q, user.RoleBot, cutoff); err != nil {
		return fmt.Errorf("query bot stats: %w", err)
	}

	netFlow := s.RewardTotal.Sub(s.InsertTotal)

	fmt.Printf("=== bot stats (last %s, since %s) ===\n",
		since, cutoff.Format(time.RFC3339))
	fmt.Printf("  GAME_INSERT total:  %s\n", s.InsertTotal.StringFixed(2))
	fmt.Printf("  REWARD total:       %s  (GAME_REWARD + CHEST_REWARD)\n", s.RewardTotal.StringFixed(2))
	fmt.Printf("  net flow (rew-ins): %s\n", netFlow.StringFixed(2))
	fmt.Printf("  BOT_REFILL total:   %s\n", s.RefillTotal.StringFixed(2))
	return nil
}

// ---------------------------------------------------------------------------
// pause / resume
// ---------------------------------------------------------------------------

func botPause(db *sqlx.DB) error {
	if len(os.Args) < 4 {
		return fmt.Errorf("usage: admin bot pause <account_id>")
	}
	accountID, err := uuid.Parse(os.Args[3])
	if err != nil {
		return fmt.Errorf("invalid account_id: %w", err)
	}

	ctx := context.Background()

	// Pre-validate role='bot' for a clear error message before we touch
	// bot_paused_accounts. The FK ensures referential integrity but the
	// generic FK error would be opaque to operators.
	var role string
	if err := db.GetContext(ctx, &role,
		`SELECT role FROM accounts WHERE account_id = $1`, accountID,
	); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return fmt.Errorf("account %s not found", accountID)
		}
		return fmt.Errorf("query account: %w", err)
	}
	if role != user.RoleBot {
		return fmt.Errorf("account %s is role=%q, not 'bot' — refusing to pause", accountID, role)
	}

	res, err := db.ExecContext(ctx, `
		INSERT INTO bot_paused_accounts (account_id)
		VALUES ($1)
		ON CONFLICT (account_id) DO NOTHING
	`, accountID)
	if err != nil {
		return fmt.Errorf("insert pause: %w", err)
	}

	n, _ := res.RowsAffected()
	if n == 0 {
		fmt.Printf("bot %s was already paused\n", accountID)
	} else {
		fmt.Printf("bot %s paused (scheduler will pick up within 5s)\n", accountID)
	}
	return nil
}

func botResume(db *sqlx.DB) error {
	if len(os.Args) < 4 {
		return fmt.Errorf("usage: admin bot resume <account_id>")
	}
	accountID, err := uuid.Parse(os.Args[3])
	if err != nil {
		return fmt.Errorf("invalid account_id: %w", err)
	}

	res, err := db.ExecContext(context.Background(),
		`DELETE FROM bot_paused_accounts WHERE account_id = $1`, accountID)
	if err != nil {
		return fmt.Errorf("delete pause: %w", err)
	}

	n, _ := res.RowsAffected()
	if n == 0 {
		fmt.Printf("bot %s was not paused (no-op)\n", accountID)
	} else {
		fmt.Printf("bot %s resumed (scheduler will pick up within 5s)\n", accountID)
	}
	return nil
}

// ---------------------------------------------------------------------------
// kill-switch
// ---------------------------------------------------------------------------

func botKillSwitch(db *sqlx.DB) error {
	if len(os.Args) < 4 {
		return fmt.Errorf("usage: admin bot kill-switch <on|off>")
	}
	val := os.Args[3]
	if val != "on" && val != "off" {
		return fmt.Errorf("kill-switch value must be 'on' or 'off', got %q", val)
	}

	core := newBotCore(db)
	if err := core.SetConfig(context.Background(), bot.ConfigKeyKillSwitch, val); err != nil {
		return fmt.Errorf("set kill_switch: %w", err)
	}
	fmt.Printf("kill_switch = %q (scheduler propagates within ~5s tick)\n", val)
	return nil
}

// ---------------------------------------------------------------------------
// refill
// ---------------------------------------------------------------------------

func botRefill(db *sqlx.DB) error {
	if len(os.Args) < 5 {
		return fmt.Errorf("usage: admin bot refill <account_id> <amount>")
	}
	accountID, err := uuid.Parse(os.Args[3])
	if err != nil {
		return fmt.Errorf("invalid account_id: %w", err)
	}
	amount, err := decimal.NewFromString(os.Args[4])
	if err != nil {
		return fmt.Errorf("invalid amount %q: %w", os.Args[4], err)
	}
	if amount.Sign() <= 0 {
		return fmt.Errorf("amount must be positive, got %s", amount)
	}

	// Manual reference_id distinct from scheduler's daily-bucket key. unix_nano
	// keeps it unique across consecutive admin invocations.
	referenceID := fmt.Sprintf("bot-refill-manual:%s:%d", accountID, time.Now().UnixNano())

	core := newBotCore(db)
	newPlay, err := core.RefillBalance(context.Background(), accountID, amount, referenceID)
	if err != nil {
		return fmt.Errorf("refill: %w", err)
	}
	fmt.Printf("refilled bot %s with %s PLAY (reference_id=%s); new balance_play=%s\n",
		accountID, amount.String(), referenceID, newPlay.String())
	return nil
}

// ---------------------------------------------------------------------------
// config
// ---------------------------------------------------------------------------

func botConfigCmd(db *sqlx.DB) error {
	if len(os.Args) < 4 {
		return fmt.Errorf("usage: admin bot config <show|set>")
	}
	switch os.Args[3] {
	case "show":
		return botConfigShow(db)
	case "set":
		return botConfigSet(db)
	default:
		return fmt.Errorf("unknown config subcommand: %s", os.Args[3])
	}
}

func botConfigShow(db *sqlx.DB) error {
	type row struct {
		Key       string    `db:"config_key"`
		Value     string    `db:"config_value"`
		UpdatedAt time.Time `db:"updated_at"`
	}
	var rows []row
	if err := db.SelectContext(context.Background(), &rows,
		`SELECT config_key, config_value, updated_at FROM bot_config ORDER BY config_key ASC`,
	); err != nil {
		return fmt.Errorf("select bot_config: %w", err)
	}

	if len(rows) == 0 {
		fmt.Println("bot_config is empty (run `admin bot seed` to install defaults)")
		return nil
	}
	fmt.Printf("=== bot_config (%d rows) ===\n", len(rows))
	fmt.Printf("  %-26s %-50s %s\n", "key", "value", "updated_at")
	for _, r := range rows {
		fmt.Printf("  %-26s %-50s %s\n",
			r.Key, truncate(r.Value, 50), r.UpdatedAt.Format(time.RFC3339))
	}
	return nil
}

// botConfigAllowedKeys is the validation allowlist for `config set`. Mirrors
// bot.ConfigKey* exactly so the CLI catches typos before they hit the DB and
// silently inflate the config table with dead rows the scheduler will never
// read.
var botConfigAllowedKeys = map[string]bool{
	bot.ConfigKeyKillSwitch:      true,
	bot.ConfigKeyRefillAmount:    true,
	bot.ConfigKeyRefillThreshold: true,
	bot.ConfigKeyDailyCap:        true,
	bot.ConfigKeyCrowdScale:      true,
}

func botConfigSet(db *sqlx.DB) error {
	if len(os.Args) < 6 {
		return fmt.Errorf("usage: admin bot config set <key> <value>")
	}
	key := os.Args[4]
	value := os.Args[5]

	if !botConfigAllowedKeys[key] {
		return fmt.Errorf("unknown config key %q (allowed: %s)",
			key, strings.Join(allowedKeysSorted(), ", "))
	}

	if err := validateConfigValue(key, value); err != nil {
		return fmt.Errorf("invalid value for %s: %w", key, err)
	}

	core := newBotCore(db)
	if err := core.SetConfig(context.Background(), key, value); err != nil {
		return fmt.Errorf("set config: %w", err)
	}
	fmt.Printf("bot_config[%s] = %q\n", key, value)
	return nil
}

func allowedKeysSorted() []string {
	out := make([]string, 0, len(botConfigAllowedKeys))
	for k := range botConfigAllowedKeys {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

// validateConfigValue enforces per-key value-format invariants. The
// DB column is TEXT (the scheduler is the canonical interpreter), so the CLI
// is the only place these checks happen — silent typos here would land in
// production unnoticed until the scheduler crashed parsing them.
func validateConfigValue(key, value string) error {
	switch key {
	case bot.ConfigKeyKillSwitch:
		if value != "on" && value != "off" {
			return fmt.Errorf("must be 'on' or 'off'")
		}
		return nil

	case bot.ConfigKeyRefillAmount,
		bot.ConfigKeyRefillThreshold,
		bot.ConfigKeyDailyCap:
		d, err := decimal.NewFromString(value)
		if err != nil {
			return fmt.Errorf("must parse as decimal: %w", err)
		}
		if d.Sign() <= 0 {
			return fmt.Errorf("must be > 0, got %s", d)
		}
		return nil

	case bot.ConfigKeyCrowdScale:
		// Expect: {"0":3,"1":4,"2":4,...} — string keys parsed as ints,
		// non-negative int values. JSON object enforces the shape.
		var raw map[string]int
		if err := json.Unmarshal([]byte(value), &raw); err != nil {
			return fmt.Errorf("must be JSON object with int values: %w", err)
		}
		if len(raw) == 0 {
			return fmt.Errorf("crowd_scale must have at least one bucket")
		}
		for k, v := range raw {
			if _, err := decimal.NewFromString(k); err != nil {
				return fmt.Errorf("bucket key %q must be an int", k)
			}
			if v < 0 {
				return fmt.Errorf("bucket %q value %d must be >= 0", k, v)
			}
		}
		return nil

	default:
		return fmt.Errorf("no validator registered for key %q (allowlist drift)", key)
	}
}
