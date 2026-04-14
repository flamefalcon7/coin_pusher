//go:build integration

// Integration tests for the accounting↔outbox atomicity contract.
//
// The core invariant under test: when ProcessGameInsert's OutboxWriter
// callback returns an error, the enclosing tx rolls back — leaving the
// user's balance unchanged, no accounting_logs entries, and no nats_outbox
// row. A regression here would produce the exact failure mode the outbox
// was designed to prevent: a coin debited with no event delivered, and no
// refund path because the refund hook never fires (the transaction
// appeared to succeed from the handler's perspective).
//
// The sqlmock-based unit tests in accounting_test.go verify that the error
// PROPAGATES from the writer, but they run with db=nil (no real tx), so a
// regression where the callback ran BEFORE the balance/log writes and
// returned an error would still "pass" — the balance updates would never
// happen in the mock setup. Only a real Postgres tx can prove atomicity.
//
// Skipped when Postgres is unavailable. Run with:
//
//	docker compose -f docker-compose.dev.yml up -d postgres
//	go test -tags=integration ./backend/business/core/accounting/...

package accounting

import (
	"context"
	"errors"
	"fmt"
	"os"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jmoiron/sqlx"
	_ "github.com/lib/pq"
	"github.com/shopspring/decimal"

	"github.com/flamefalcon/coin-pusher/backend/business/core/accounting/stores/ledgerdb"
	"github.com/flamefalcon/coin-pusher/backend/business/core/user"
	"github.com/flamefalcon/coin-pusher/backend/business/core/user/stores/userdb"
	"github.com/flamefalcon/coin-pusher/backend/foundation/database"
)

func setupAtomicityIntegration(t *testing.T) (*sqlx.DB, uuid.UUID, func()) {
	t.Helper()
	pgDSN := os.Getenv("OUTBOX_TEST_PG_DSN")
	if pgDSN == "" {
		pgDSN = "postgres://postgres:postgres@localhost:5432/coinpusher?sslmode=disable"
	}

	db, err := sqlx.Connect("postgres", pgDSN)
	if err != nil {
		t.Skipf("Postgres unavailable (%v) — skipping integration test", err)
	}

	// Ensure the schema is present.
	if _, err := db.Exec(`SELECT 1 FROM accounts LIMIT 0`); err != nil {
		db.Close()
		t.Skipf("accounts table missing (%v) — run admin migrate first", err)
	}
	if _, err := db.Exec(`SELECT 1 FROM nats_outbox LIMIT 0`); err != nil {
		db.Close()
		t.Skipf("nats_outbox missing (%v) — run admin migrate first", err)
	}

	// Create a throwaway test account with a known balance.
	accountID := uuid.New()
	if _, err := db.Exec(`
		INSERT INTO accounts (id, email, wallet_address, balance_play, balance_cash, role, created_at)
		VALUES ($1, $2, $3, $4, $5, 'user', NOW())
	`, accountID, fmt.Sprintf("atomicity-%s@test", accountID), fmt.Sprintf("0x%x", accountID[:]),
		decimal.NewFromInt(100), decimal.Zero); err != nil {
		db.Close()
		t.Fatalf("seed account: %v", err)
	}

	cleanup := func() {
		// Order matters — FK cascade will clean children but be explicit.
		db.Exec(`DELETE FROM nats_outbox WHERE reference_id LIKE 'atomic-%'`)
		db.Exec(`DELETE FROM accounting_logs WHERE account_id = $1`, accountID)
		db.Exec(`DELETE FROM accounts WHERE id = $1`, accountID)
		db.Close()
	}
	return db, accountID, cleanup
}

// TestIntegration_OutboxWriterFailureRollsBackBalance is the load-bearing
// atomicity test. Constructs a real accounting.Core wired to real stores
// and a real Postgres, then calls ProcessGameInsert with an OutboxWriter
// that deliberately returns an error. Asserts that after the call:
//  1. Balance is unchanged from the seeded value
//  2. No accounting_logs entry was created
//  3. No nats_outbox row was created
// A regression in tx scoping (e.g., a partial COMMIT, or the writer running
// outside the tx) fails any of these three assertions.
func TestIntegration_OutboxWriterFailureRollsBackBalance(t *testing.T) {
	db, accountID, cleanup := setupAtomicityIntegration(t)
	defer cleanup()

	// Wire the real core using the production factory signatures — both
	// ledgerdb.NewStore and userdb.NewStore accept database.DBTX, which is
	// satisfied by both *sqlx.DB and *sqlx.Tx, so the same constructor serves
	// top-level and tx-bound calls.
	acctStorer := ledgerdb.NewStore(db)
	userStorer := userdb.NewStore(db)
	userCore := user.NewCore(userStorer)

	core := NewCore(
		db,
		acctStorer,
		userCore,
		func(dbtx database.DBTX) Storer { return ledgerdb.NewStore(dbtx) },
		func(dbtx database.DBTX) user.Storer { return userdb.NewStore(dbtx) },
	)

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	// Snapshot the balance before.
	var balanceBefore decimal.Decimal
	if err := db.GetContext(ctx, &balanceBefore,
		`SELECT balance_play FROM accounts WHERE id = $1`, accountID,
	); err != nil {
		t.Fatalf("snapshot balance: %v", err)
	}
	if !balanceBefore.Equal(decimal.NewFromInt(100)) {
		t.Fatalf("unexpected initial balance: got %s, want 100", balanceBefore)
	}

	// Call ProcessGameInsert with a writer that always fails.
	failingWriter := func(_ context.Context, _ Storer) error {
		return errors.New("simulated nats_outbox INSERT failure")
	}

	refID := "atomic-fail-" + uuid.NewString()
	_, _, _, _, err := core.ProcessGameInsert(ctx, accountID, 5, refID, failingWriter)
	if err == nil {
		t.Fatal("expected ProcessGameInsert to return error, got nil")
	}

	// Invariant 1: balance unchanged.
	var balanceAfter decimal.Decimal
	if err := db.GetContext(ctx, &balanceAfter,
		`SELECT balance_play FROM accounts WHERE id = $1`, accountID,
	); err != nil {
		t.Fatalf("read balance after: %v", err)
	}
	if !balanceAfter.Equal(balanceBefore) {
		t.Errorf("ATOMICITY VIOLATION: balance changed from %s to %s despite writer failure",
			balanceBefore, balanceAfter)
	}

	// Invariant 2: no accounting_logs row for this reference_id.
	var logCount int
	if err := db.GetContext(ctx, &logCount,
		`SELECT COUNT(*) FROM accounting_logs WHERE reference_id = $1`, refID,
	); err != nil {
		t.Fatalf("count logs: %v", err)
	}
	if logCount != 0 {
		t.Errorf("ATOMICITY VIOLATION: %d accounting_logs row(s) created despite writer failure", logCount)
	}

	// Invariant 3: no nats_outbox row (though the writer itself errored
	// before doing an INSERT, this also guards against a future bug that
	// does the INSERT then returns an error anyway).
	var outboxCount int
	if err := db.GetContext(ctx, &outboxCount,
		`SELECT COUNT(*) FROM nats_outbox WHERE reference_id = $1`, refID,
	); err != nil {
		t.Fatalf("count outbox: %v", err)
	}
	if outboxCount != 0 {
		t.Errorf("ATOMICITY VIOLATION: %d nats_outbox row(s) created despite writer failure", outboxCount)
	}
}

// TestIntegration_OutboxWriterSuccessCommitsAll is the positive-case
// counterpart: when the writer succeeds, all three artifacts land
// together. Guards against a regression where the tx was committed
// twice or the writer's INSERT ran outside the tx boundary.
func TestIntegration_OutboxWriterSuccessCommitsAll(t *testing.T) {
	db, accountID, cleanup := setupAtomicityIntegration(t)
	defer cleanup()

	acctStorer := ledgerdb.NewStore(db)
	userStorer := userdb.NewStore(db)
	userCore := user.NewCore(userStorer)

	core := NewCore(
		db,
		acctStorer,
		userCore,
		func(dbtx database.DBTX) Storer { return ledgerdb.NewStore(dbtx) },
		func(dbtx database.DBTX) user.Storer { return userdb.NewStore(dbtx) },
	)

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	refID := "atomic-ok-" + uuid.NewString()
	realWriter := func(ctx context.Context, s Storer) error {
		return s.InsertOutboxRow(ctx, "test.atomic", []byte(`{"ok":true}`), refID)
	}

	_, _, _, _, err := core.ProcessGameInsert(ctx, accountID, 5, refID, realWriter)
	if err != nil {
		t.Fatalf("ProcessGameInsert: %v", err)
	}

	// All three artifacts must be present.
	var balanceAfter decimal.Decimal
	if err := db.GetContext(ctx, &balanceAfter,
		`SELECT balance_play FROM accounts WHERE id = $1`, accountID,
	); err != nil {
		t.Fatalf("balance: %v", err)
	}
	if !balanceAfter.Equal(decimal.NewFromInt(95)) {
		t.Errorf("balance should be 95 after 5-coin insert, got %s", balanceAfter)
	}

	var logCount int
	if err := db.GetContext(ctx, &logCount,
		`SELECT COUNT(*) FROM accounting_logs WHERE reference_id = $1`, refID,
	); err != nil {
		t.Fatalf("count logs: %v", err)
	}
	if logCount != 1 {
		t.Errorf("expected 1 accounting_logs row, got %d", logCount)
	}

	var outboxCount int
	if err := db.GetContext(ctx, &outboxCount,
		`SELECT COUNT(*) FROM nats_outbox WHERE reference_id = $1`, refID,
	); err != nil {
		t.Fatalf("count outbox: %v", err)
	}
	if outboxCount != 1 {
		t.Errorf("expected 1 nats_outbox row, got %d", outboxCount)
	}
}
