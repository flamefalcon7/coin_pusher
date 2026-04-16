//go:build integration

// Integration tests for the bot sqlx Store.
//
// Exercises the three correctness-critical surfaces that unit tests with
// mocks can only approximate:
//   - bot_config upsert semantics (insert-then-update via ON CONFLICT)
//   - QueryBotAccounts / QueryBotAccountByID role filtering against real
//     schema joins — an integration test catches column name drift and
//     JOIN typos that a mock would silently paper over
//   - SumRefillsSince aggregation across day boundaries — the scheduler's
//     daily-cap enforcement depends on this; an off-by-one in the UTC
//     truncation would leak refills across days
//
// Skipped when Postgres is unavailable. Run with:
//
//	docker compose -f docker-compose.dev.yml up -d postgres
//	go test -tags=integration ./backend/business/core/bot/stores/botdb/...

package botdb_test

import (
	"context"
	"fmt"
	"os"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jmoiron/sqlx"
	_ "github.com/lib/pq"
	"github.com/shopspring/decimal"

	"github.com/flamefalcon/coin-pusher/backend/business/core/accounting"
	"github.com/flamefalcon/coin-pusher/backend/business/core/bot/stores/botdb"
	"github.com/flamefalcon/coin-pusher/backend/business/core/user"
)

func setupBotIntegration(t *testing.T) (*sqlx.DB, func()) {
	t.Helper()
	pgDSN := os.Getenv("OUTBOX_TEST_PG_DSN")
	if pgDSN == "" {
		pgDSN = "postgres://postgres:postgres@localhost:5432/coinpusher?sslmode=disable"
	}

	db, err := sqlx.Connect("postgres", pgDSN)
	if err != nil {
		t.Skipf("Postgres unavailable (%v) — skipping integration test", err)
	}

	// Ensure the required tables exist.
	for _, q := range []string{
		`SELECT 1 FROM accounts LIMIT 0`,
		`SELECT 1 FROM auth_providers LIMIT 0`,
		`SELECT 1 FROM accounting_logs LIMIT 0`,
		`SELECT 1 FROM bot_config LIMIT 0`,
	} {
		if _, err := db.Exec(q); err != nil {
			db.Close()
			t.Skipf("schema missing (%v) — run admin migrate first", err)
		}
	}

	// Tag all seed rows with a per-run suffix to avoid cross-run collisions.
	runTag := uuid.New().String()[:8]

	cleanup := func() {
		// Best-effort cleanup in dependency order. bot_paused_accounts must
		// be cleared before accounts (FK constraint) since this PR added the
		// reference.
		db.Exec(`DELETE FROM bot_paused_accounts WHERE account_id IN (SELECT account_id FROM accounts WHERE referral_code LIKE $1)`, "BOTI"+runTag[:4]+"%")
		db.Exec(`DELETE FROM accounting_logs WHERE reference_id LIKE $1`, "bot-integ-"+runTag+"%")
		db.Exec(`DELETE FROM auth_providers WHERE provider_uid LIKE $1`, "bot-integ-"+runTag+"%")
		db.Exec(`DELETE FROM accounts WHERE referral_code LIKE $1`, "BOTI"+runTag[:4]+"%")
		db.Exec(`DELETE FROM bot_config WHERE config_key LIKE $1`, "test_"+runTag+"%")
		db.Close()
	}

	t.Setenv("BOT_INTEG_RUN_TAG", runTag)
	return db, cleanup
}

func runTag(t *testing.T) string {
	t.Helper()
	tag := os.Getenv("BOT_INTEG_RUN_TAG")
	if tag == "" {
		t.Fatal("BOT_INTEG_RUN_TAG not set (setup not called?)")
	}
	return tag
}

// seedBotAccount inserts accounts + auth_providers rows representing a bot.
// Returns the newly created account_id.
func seedBotAccount(t *testing.T, db *sqlx.DB, displayName *string, providerUIDSuffix string) uuid.UUID {
	t.Helper()
	tag := runTag(t)
	id := uuid.New()
	referralCode := fmt.Sprintf("BOTI%s%s", tag[:4], id.String()[:4])

	if _, err := db.Exec(`
		INSERT INTO accounts (account_id, display_name, role, referral_code)
		VALUES ($1, $2, $3, $4)
	`, id, displayName, user.RoleBot, referralCode); err != nil {
		t.Fatalf("seed account: %v", err)
	}

	providerUID := fmt.Sprintf("bot-integ-%s-%s", tag, providerUIDSuffix)
	if _, err := db.Exec(`
		INSERT INTO auth_providers (provider_id, account_id, provider_type, provider_uid)
		VALUES ($1, $2, $3, $4)
	`, uuid.New(), id, user.ProviderTypeBot, providerUID); err != nil {
		t.Fatalf("seed auth_provider: %v", err)
	}

	return id
}

// seedRealAccount inserts a non-bot account for filter-correctness testing.
func seedRealAccount(t *testing.T, db *sqlx.DB) uuid.UUID {
	t.Helper()
	tag := runTag(t)
	id := uuid.New()
	referralCode := fmt.Sprintf("BOTI%s%s", tag[:4], id.String()[:4])

	if _, err := db.Exec(`
		INSERT INTO accounts (account_id, role, referral_code)
		VALUES ($1, $2, $3)
	`, id, user.RoleUser, referralCode); err != nil {
		t.Fatalf("seed real account: %v", err)
	}
	return id
}

// ---------------------------------------------------------------------------
// Config CRUD
// ---------------------------------------------------------------------------

func TestIntegration_UpsertConfig_InsertThenUpdate(t *testing.T) {
	db, cleanup := setupBotIntegration(t)
	defer cleanup()

	tag := runTag(t)
	key := "test_" + tag + "_key1"

	store := botdb.NewStore(db)
	ctx := context.Background()

	// Insert.
	if err := store.UpsertConfig(ctx, key, "first"); err != nil {
		t.Fatalf("first upsert: %v", err)
	}
	all, err := store.QueryConfigAll(ctx)
	if err != nil {
		t.Fatalf("query all: %v", err)
	}
	if all[key] != "first" {
		t.Errorf("after insert, got %q, want %q", all[key], "first")
	}

	// Update (same key).
	if err := store.UpsertConfig(ctx, key, "second"); err != nil {
		t.Fatalf("second upsert: %v", err)
	}
	all, err = store.QueryConfigAll(ctx)
	if err != nil {
		t.Fatalf("query all 2: %v", err)
	}
	if all[key] != "second" {
		t.Errorf("after update, got %q, want %q", all[key], "second")
	}
}

// ---------------------------------------------------------------------------
// Bot account listing
// ---------------------------------------------------------------------------

func TestIntegration_QueryBotAccounts_FiltersByRole(t *testing.T) {
	db, cleanup := setupBotIntegration(t)
	defer cleanup()

	named := "IntegBotNamed-" + runTag(t)
	botID1 := seedBotAccount(t, db, &named, "listed-a")
	botID2 := seedBotAccount(t, db, nil, "listed-b")
	realID := seedRealAccount(t, db)

	store := botdb.NewStore(db)
	bots, err := store.QueryBotAccounts(context.Background())
	if err != nil {
		t.Fatalf("query: %v", err)
	}

	got := map[uuid.UUID]bool{}
	for _, b := range bots {
		got[b.AccountID] = true
	}

	if !got[botID1] {
		t.Errorf("expected bot %s in result", botID1)
	}
	if !got[botID2] {
		t.Errorf("expected bot %s in result", botID2)
	}
	if got[realID] {
		t.Errorf("real account %s must NOT appear in bot list", realID)
	}
}

func TestIntegration_QueryBotAccountByID(t *testing.T) {
	db, cleanup := setupBotIntegration(t)
	defer cleanup()

	name := "IntegByID-" + runTag(t)
	botID := seedBotAccount(t, db, &name, "byid-a")
	realID := seedRealAccount(t, db)

	store := botdb.NewStore(db)

	// Happy path.
	b, err := store.QueryBotAccountByID(context.Background(), botID)
	if err != nil {
		t.Fatalf("query bot: %v", err)
	}
	if b.AccountID != botID {
		t.Errorf("got %s, want %s", b.AccountID, botID)
	}
	if b.DisplayName == nil || *b.DisplayName != name {
		t.Errorf("display_name mismatch")
	}

	// Non-bot account must 404.
	if _, err := store.QueryBotAccountByID(context.Background(), realID); err == nil {
		t.Error("expected error when querying a real (role=user) account by ID, got nil")
	}

	// Missing account must 404.
	if _, err := store.QueryBotAccountByID(context.Background(), uuid.New()); err == nil {
		t.Error("expected error for missing account_id, got nil")
	}
}

// ---------------------------------------------------------------------------
// SumRefillsSince — day boundary correctness
// ---------------------------------------------------------------------------

func TestIntegration_SumRefillsSince_AcrossDays(t *testing.T) {
	db, cleanup := setupBotIntegration(t)
	defer cleanup()

	name := "IntegSum-" + runTag(t)
	botID := seedBotAccount(t, db, &name, "sum")
	tag := runTag(t)

	now := time.Now().UTC()
	yesterday := now.Add(-25 * time.Hour)
	earlierToday := now.Add(-1 * time.Hour)

	// Insert 3 ledger rows: 1 from yesterday (should be excluded), 2 from
	// today (should be summed).
	rows := []struct {
		ref       string
		amount    int64
		createdAt time.Time
	}{
		{"bot-integ-" + tag + "-yday", 5000, yesterday},
		{"bot-integ-" + tag + "-today-1", 700, earlierToday},
		{"bot-integ-" + tag + "-today-2", 300, now},
	}

	for _, r := range rows {
		if _, err := db.Exec(`
			INSERT INTO accounting_logs (log_id, account_id, action_type, amount, currency, reference_id, created_at)
			VALUES ($1, $2, $3, $4, $5, $6, $7)
		`, uuid.New(), botID, accounting.ActionBotRefill,
			decimal.NewFromInt(r.amount), accounting.CurrencyPlay,
			r.ref, r.createdAt); err != nil {
			t.Fatalf("seed ledger row %s: %v", r.ref, err)
		}
	}

	store := botdb.NewStore(db)

	// Sum since start of today UTC — should include only today's 2 rows.
	startOfToday := now.Truncate(24 * time.Hour)
	total, err := store.SumRefillsSince(context.Background(), startOfToday)
	if err != nil {
		t.Fatalf("sum: %v", err)
	}
	if !total.Equal(decimal.NewFromInt(1000)) {
		t.Errorf("sum since start of today = %s, want 1000 (yesterday=5000 must be excluded)", total)
	}

	// Sum since 2 days ago — should include all 3 rows.
	twoDaysAgo := now.Add(-48 * time.Hour)
	total2, err := store.SumRefillsSince(context.Background(), twoDaysAgo)
	if err != nil {
		t.Fatalf("sum 2d: %v", err)
	}
	if !total2.Equal(decimal.NewFromInt(6000)) {
		t.Errorf("sum since 2d ago = %s, want 6000", total2)
	}
}

// TestIntegration_SumRefillsSince_EmptyReturnsZero verifies COALESCE semantics:
// a SUM over zero rows must return decimal.Zero, not a NULL/scan error.
func TestIntegration_SumRefillsSince_EmptyReturnsZero(t *testing.T) {
	db, cleanup := setupBotIntegration(t)
	defer cleanup()

	store := botdb.NewStore(db)

	// Distant future — guaranteed no rows.
	future := time.Now().UTC().Add(100 * 24 * time.Hour)
	total, err := store.SumRefillsSince(context.Background(), future)
	if err != nil {
		t.Fatalf("sum empty: %v", err)
	}
	if !total.Equal(decimal.Zero) {
		t.Errorf("empty sum = %s, want 0", total)
	}
}
