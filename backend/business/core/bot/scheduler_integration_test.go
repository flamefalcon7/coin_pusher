//go:build integration

// Integration tests for the bot Scheduler. These exercise the
// payment-adjacent invariants the outbox retro
// (docs/solutions/integration-issues/batch-insert-outbox-2026-04-14.md)
// flagged as non-negotiable for any goroutine that writes to
// accounting_logs + nats_outbox.
//
// The unit tests in scheduler_test.go cover behavioral logic with stubbed
// dependencies — kill switch, EMA hysteresis, session lifecycle, daily cap.
// What only a real Postgres can prove:
//
//   - End-to-end atomicity: scheduler tick → gameCore.ProcessBatchInsert →
//     accounting_logs row + nats_outbox row commit together.
//   - Multi-instance lock semantics: two schedulers pointing at the same DB,
//     only one acquires pg_try_advisory_lock.
//   - Graceful shutdown: ctx cancel mid-tick exits within 1s, no panic.
//
// Skipped when Postgres is unavailable (local laptops without docker compose
// up). Run with:
//
//	docker compose -f docker-compose.dev.yml up -d postgres
//	go test -tags=integration ./backend/business/core/bot/...

// External test package mirrors the accounting/atomicity_integration_test.go
// pattern: ledgerdb imports accounting for Storer/model types, so a test
// inside package bot cannot import ledgerdb. bot_test lets us wire real
// stores.
package bot_test

import (
	"context"
	"errors"
	"fmt"
	"math/rand"
	"os"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jmoiron/sqlx"
	_ "github.com/lib/pq"
	"github.com/shopspring/decimal"
	"go.uber.org/zap"

	"github.com/flamefalcon/coin-pusher/backend/business/core/accounting"
	"github.com/flamefalcon/coin-pusher/backend/business/core/accounting/stores/ledgerdb"
	"github.com/flamefalcon/coin-pusher/backend/business/core/bot"
	"github.com/flamefalcon/coin-pusher/backend/business/core/bot/stores/botdb"
	"github.com/flamefalcon/coin-pusher/backend/business/core/game"
	"github.com/flamefalcon/coin-pusher/backend/business/core/heat"
	"github.com/flamefalcon/coin-pusher/backend/business/core/user"
	"github.com/flamefalcon/coin-pusher/backend/business/core/user/stores/userdb"
	"github.com/flamefalcon/coin-pusher/backend/business/web/ws"
	"github.com/flamefalcon/coin-pusher/backend/foundation/database"
)

// liveGate returns a game-server liveness gate that reads as alive. The
// scheduler refuses to insert while the gate is stale (D-006), so tests whose
// subject is the insert itself must supply one.
func liveGate() *ws.GameLiveness {
	l := ws.NewGameLiveness(ws.GameLivenessTTL)
	l.Touch()
	return l
}

// fixedPlayerCounter satisfies bot.PlayerCounter with a constant value;
// used to drive the scheduler's crowd-scale lookup deterministically.
type fixedPlayerCounter int

func (f fixedPlayerCounter) ActiveRealPlayerCount() int { return int(f) }

// frozenClock satisfies bot.Clock with a fixed time. Tests don't need wall
// time advancement here — one tick is enough to write a ledger row.
type frozenClock struct{ t time.Time }

func (f frozenClock) Now() time.Time { return f.t }

// setupSchedulerIntegration spins up real cores backed by Postgres, seeds
// one bot account with sufficient balance to fire an insert, and returns
// the scheduler plus cleanup. Skips if Postgres is unavailable.
func setupSchedulerIntegration(t *testing.T) (
	scheduler *bot.Scheduler,
	db *sqlx.DB,
	botID uuid.UUID,
	cleanup func(),
) {
	t.Helper()

	pgDSN := os.Getenv("OUTBOX_TEST_PG_DSN")
	if pgDSN == "" {
		pgDSN = "postgres://postgres:postgres@localhost:5432/coinpusher?sslmode=disable"
	}

	var err error
	db, err = sqlx.Connect("postgres", pgDSN)
	if err != nil {
		t.Skipf("Postgres unavailable (%v) — skipping integration test", err)
	}

	for _, q := range []string{
		`SELECT 1 FROM accounts LIMIT 0`,
		`SELECT 1 FROM auth_providers LIMIT 0`,
		`SELECT 1 FROM accounting_logs LIMIT 0`,
		`SELECT 1 FROM nats_outbox LIMIT 0`,
		`SELECT 1 FROM bot_config LIMIT 0`,
	} {
		if _, err := db.Exec(q); err != nil {
			db.Close()
			t.Skipf("schema missing (%v) — run admin migrate first", err)
		}
	}

	runTag := uuid.New().String()[:8]

	// Seed one bot account with starting balance so insert path doesn't gate
	// on refill.
	botID = uuid.New()
	displayName := "SchedTest-" + runTag
	if _, err := db.Exec(`
		INSERT INTO accounts (account_id, display_name, role, balance_play, balance_cash, referral_code)
		VALUES ($1, $2, $3, $4, $5, $6)
	`, botID, displayName, user.RoleBot,
		decimal.NewFromInt(500), decimal.Zero,
		fmt.Sprintf("BOTI%s%s", runTag[:4], botID.String()[:4]),
	); err != nil {
		db.Close()
		t.Fatalf("seed bot account: %v", err)
	}

	if _, err := db.Exec(`
		INSERT INTO auth_providers (provider_id, account_id, provider_type, provider_uid)
		VALUES ($1, $2, $3, $4)
	`, uuid.New(), botID, user.ProviderTypeBot,
		fmt.Sprintf("bot-integ-%s", runTag),
	); err != nil {
		db.Exec(`DELETE FROM accounts WHERE account_id = $1`, botID)
		db.Close()
		t.Fatalf("seed auth_provider: %v", err)
	}

	// Wire production cores.
	userStorer := userdb.NewStore(db)
	userCore := user.NewCore(userStorer)
	acctCore := accounting.NewCore(
		db,
		ledgerdb.NewStore(db),
		userCore,
		func(dbtx database.DBTX) accounting.Storer { return ledgerdb.NewStore(dbtx) },
		func(dbtx database.DBTX) user.Storer { return userdb.NewStore(dbtx) },
	)
	gameCore := game.NewCore(userCore, acctCore)
	heatEngine := heat.New()
	botCore := bot.NewCore(db, botdb.NewStore(db), acctCore)

	scheduler = bot.NewScheduler(bot.SchedulerDeps{
		BotCore:       botCore,
		GameCore:      gameCore,
		AcctCore:      acctCore,
		HeatEngine:    heatEngine,
		PlayerCounter: fixedPlayerCounter(0),
		Clock:         frozenClock{t: time.Now()},
		RNG:           rand.New(rand.NewSource(42)),
		Log:           zap.NewNop().Sugar(),
		DB:            db,
		// These tests assert that inserts commit; without a live gate the
		// scheduler correctly refuses to insert at all and every atomicity
		// assertion below would pass vacuously on zero rows.
		Liveness: liveGate(),
	})

	cleanup = func() {
		db.Exec(`DELETE FROM nats_outbox WHERE reference_id LIKE $1`, "bot:"+botID.String()+"%")
		db.Exec(`DELETE FROM nats_outbox WHERE reference_id LIKE $1`, "bot-refill:"+botID.String()+"%")
		db.Exec(`DELETE FROM accounting_logs WHERE account_id = $1`, botID)
		db.Exec(`DELETE FROM auth_providers WHERE account_id = $1`, botID)
		db.Exec(`DELETE FROM accounts WHERE account_id = $1`, botID)
		db.Close()
	}
	return scheduler, db, botID, cleanup
}

// TestIntegration_SchedulerInsertWritesLedgerAndOutbox is the load-bearing
// atomicity test. It loads a real bot pool, forces one bot online + ready,
// and triggers a single insert path through the production gameCore. After
// the insert returns success, both an accounting_logs row AND a nats_outbox
// row must exist for the same reference_id — the very invariant the outbox
// retro flagged as non-negotiable for payment-adjacent goroutines.
func TestIntegration_SchedulerInsertWritesLedgerAndOutbox(t *testing.T) {
	sched, db, botID, cleanup := setupSchedulerIntegration(t)
	defer cleanup()

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	// Drive one insert via the public entry point: load the bot pool,
	// force the single bot online, and call the package-internal helper
	// to fire one insert directly. Going through Scheduler.Run would
	// require waiting tickInterval=5s; for a deterministic CI test we
	// reach into the test seam exposed by bot.LoadAndFireOneInsertForTest.
	now := time.Now()
	if err := bot.LoadAndFireOneInsertForTest(sched, ctx, botID, now); err != nil {
		t.Fatalf("force-fire insert: %v", err)
	}

	// Wait briefly for any post-commit notify to settle.
	time.Sleep(50 * time.Millisecond)

	// Assert: at least one accounting_logs row with action_type=GAME_INSERT
	// exists for this bot, with a bot:<id>:* reference_id.
	var logCount int
	if err := db.GetContext(ctx, &logCount, `
		SELECT COUNT(*)
		FROM accounting_logs
		WHERE account_id = $1
		  AND action_type = $2
		  AND reference_id LIKE $3
	`, botID, accounting.ActionGameInsert, "bot:"+botID.String()+":%"); err != nil {
		t.Fatalf("count accounting_logs: %v", err)
	}
	if logCount == 0 {
		t.Fatal("ATOMICITY VIOLATION: no accounting_logs row written by scheduler insert")
	}

	// Assert: matching nats_outbox row exists for the same ref_id.
	var outboxCount int
	if err := db.GetContext(ctx, &outboxCount, `
		SELECT COUNT(*)
		FROM nats_outbox
		WHERE reference_id LIKE $1
	`, "bot:"+botID.String()+":%"); err != nil {
		t.Fatalf("count nats_outbox: %v", err)
	}
	if outboxCount == 0 {
		t.Fatal("ATOMICITY VIOLATION: accounting_logs row exists but no nats_outbox row")
	}
}

// TestIntegration_AdvisoryLockSingleton verifies pg_try_advisory_lock
// semantics: when one scheduler holds the lock, a second scheduler against
// the same DB returns cleanly without ticking. Critical for safe rolling
// deploys where two API replicas may briefly co-exist.
func TestIntegration_AdvisoryLockSingleton(t *testing.T) {
	pgDSN := os.Getenv("OUTBOX_TEST_PG_DSN")
	if pgDSN == "" {
		pgDSN = "postgres://postgres:postgres@localhost:5432/coinpusher?sslmode=disable"
	}

	db1, err := sqlx.Connect("postgres", pgDSN)
	if err != nil {
		t.Skipf("Postgres unavailable (%v) — skipping", err)
	}
	defer db1.Close()
	db2, err := sqlx.Connect("postgres", pgDSN)
	if err != nil {
		t.Skipf("Postgres unavailable (%v) — skipping", err)
	}
	defer db2.Close()

	// Build two minimal schedulers — only db field matters for the lock test.
	mkSched := func(db *sqlx.DB) *bot.Scheduler {
		return bot.NewScheduler(bot.SchedulerDeps{
			BotCore: bot.NewCore(db, botdb.NewStore(db), nil),
			Log:     zap.NewNop().Sugar(),
			DB:      db,
			Clock:   frozenClock{t: time.Now()},
			RNG:     rand.New(rand.NewSource(0)),
		})
	}

	s1 := mkSched(db1)
	s2 := mkSched(db2)

	// First scheduler acquires the lock and starts ticking. Run in a
	// goroutine and cancel after assertions — the goroutine holds the lock
	// for the duration of ctx.
	ctx1, cancel1 := context.WithCancel(context.Background())
	defer cancel1()
	s1Done := make(chan error, 1)
	go func() { s1Done <- s1.Run(ctx1) }()

	// Give s1 a moment to acquire the lock + load pool.
	time.Sleep(200 * time.Millisecond)

	// Second scheduler must return WITHOUT acquiring the lock — Run should
	// log WARN and exit cleanly with nil error. Use a short ctx so even a
	// regression where s2 hangs in a tick loop is bounded.
	ctx2, cancel2 := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel2()
	if err := s2.Run(ctx2); err != nil {
		t.Errorf("s2.Run returned error %v; expected nil (lock-not-held happy path)", err)
	}

	// Stop s1.
	cancel1()
	select {
	case err := <-s1Done:
		if err != nil {
			t.Errorf("s1.Run returned %v on shutdown; expected nil", err)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("s1 did not shut down within 3s of cancel")
	}
}

// TestIntegration_GracefulShutdown verifies that cancel mid-tick returns
// from Run within 1 second and does not panic. This is the outbox retro's
// payment-adjacent shutdown invariant.
func TestIntegration_GracefulShutdown(t *testing.T) {
	sched, _, _, cleanup := setupSchedulerIntegration(t)
	defer cleanup()

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() {
		done <- sched.Run(ctx)
	}()

	// Let the scheduler start its first tick.
	time.Sleep(200 * time.Millisecond)

	// Cancel and time the exit.
	start := time.Now()
	cancel()
	select {
	case err := <-done:
		elapsed := time.Since(start)
		if elapsed > 1*time.Second {
			t.Errorf("graceful shutdown took %v, want < 1s", elapsed)
		}
		// Cancel-on-Run path should return nil (not ctx.Err()).
		if err != nil && !errors.Is(err, context.Canceled) {
			t.Errorf("Run returned %v on cancel; expected nil or context.Canceled", err)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("Run did not return within 3s of cancel — likely missing ctx.Done in select")
	}
}

// TestIntegration_RealMoneyGateRefuses asserts the fail-closed invariant:
// when BACKEND_REAL_MONEY_ENABLED=true, Run returns ErrRealMoneyEnabled
// immediately without acquiring the advisory lock or starting the tick.
func TestIntegration_RealMoneyGateRefuses(t *testing.T) {
	t.Setenv("BACKEND_REAL_MONEY_ENABLED", "true")

	sched, _, _, cleanup := setupSchedulerIntegration(t)
	defer cleanup()

	err := sched.Run(context.Background())
	if !errors.Is(err, bot.ErrRealMoneyEnabled) {
		t.Fatalf("Run with real-money on: got %v, want ErrRealMoneyEnabled", err)
	}
}
