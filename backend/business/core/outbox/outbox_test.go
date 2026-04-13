package outbox

import (
	"context"
	"errors"
	"regexp"
	"sync"
	"testing"
	"time"

	"github.com/DATA-DOG/go-sqlmock"
	"github.com/jmoiron/sqlx"
	"github.com/lib/pq"
	"go.uber.org/zap"
)

// ---------------------------------------------------------------------------
// Mock publisher
// ---------------------------------------------------------------------------

type mockPub struct {
	mu sync.Mutex
	// published records every successful publish in order.
	published []pubRecord
	// failOn returns an error for subjects matching the predicate — the
	// matching call is considered a failure.
	failOn func(subject string, data []byte) error
}

type pubRecord struct {
	Subject string
	Payload []byte
}

func (m *mockPub) Publish(subject string, data []byte) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.failOn != nil {
		if err := m.failOn(subject, data); err != nil {
			return err
		}
	}
	cp := make([]byte, len(data))
	copy(cp, data)
	m.published = append(m.published, pubRecord{Subject: subject, Payload: cp})
	return nil
}

func (m *mockPub) count() int {
	m.mu.Lock()
	defer m.mu.Unlock()
	return len(m.published)
}

func (m *mockPub) records() []pubRecord {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := make([]pubRecord, len(m.published))
	copy(out, m.published)
	return out
}

// newTestDB returns a sqlmock-backed *sqlx.DB + the mock controller.
func newTestDB(t *testing.T) (*sqlx.DB, sqlmock.Sqlmock) {
	t.Helper()
	raw, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	t.Cleanup(func() { raw.Close() })
	return sqlx.NewDb(raw, "sqlmock"), mock
}

func silentLogger() *zap.SugaredLogger {
	return zap.NewNop().Sugar()
}

// selectQueryRegex matches the drainer's SELECT query loosely — we don't want
// whitespace-fragile tests.
var selectQueryRegex = regexp.MustCompile(`SELECT id, subject, payload, reference_id, created_at, attempt_count`)
var deleteQueryRegex = regexp.MustCompile(`DELETE FROM nats_outbox WHERE id = ANY`)
var bumpQueryRegex = regexp.MustCompile(`UPDATE nats_outbox\s+SET attempt_count = \$1`)

// ---------------------------------------------------------------------------
// drainOnce — happy paths
// ---------------------------------------------------------------------------

func TestDrainOnce_EmptyOutbox(t *testing.T) {
	t.Parallel()
	db, mock := newTestDB(t)
	pub := &mockPub{}
	cfg := Config{BatchSize: 100, MaxAttempts: 10}

	emptyRows := sqlmock.NewRows([]string{"id", "subject", "payload", "reference_id", "created_at", "attempt_count"})
	mock.ExpectQuery(selectQueryRegex.String()).
		WithArgs(10, 100).
		WillReturnRows(emptyRows)

	if err := drainOnce(context.Background(), db, pub, silentLogger(), cfg); err != nil {
		t.Fatalf("drainOnce: %v", err)
	}
	if pub.count() != 0 {
		t.Errorf("expected 0 publishes, got %d", pub.count())
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Errorf("mock expectations: %v", err)
	}
}

func TestDrainOnce_SingleSubjectAllPublished(t *testing.T) {
	t.Parallel()
	db, mock := newTestDB(t)
	pub := &mockPub{}
	cfg := Config{BatchSize: 100, MaxAttempts: 10}

	now := time.Now()
	rows := sqlmock.NewRows([]string{"id", "subject", "payload", "reference_id", "created_at", "attempt_count"}).
		AddRow(int64(1), "game.main.cmd.batch_insert", []byte("payload-1"), "ref-1", now, 0).
		AddRow(int64(2), "game.main.cmd.batch_insert", []byte("payload-2"), "ref-2", now, 0).
		AddRow(int64(3), "game.main.cmd.batch_insert", []byte("payload-3"), "ref-3", now, 0)
	mock.ExpectQuery(selectQueryRegex.String()).WithArgs(10, 100).WillReturnRows(rows)
	mock.ExpectExec(deleteQueryRegex.String()).
		WithArgs(pq.Array([]int64{1, 2, 3})).
		WillReturnResult(sqlmock.NewResult(0, 3))

	if err := drainOnce(context.Background(), db, pub, silentLogger(), cfg); err != nil {
		t.Fatalf("drainOnce: %v", err)
	}
	recs := pub.records()
	if len(recs) != 3 {
		t.Fatalf("expected 3 publishes, got %d", len(recs))
	}
	for i, r := range recs {
		if r.Subject != "game.main.cmd.batch_insert" {
			t.Errorf("rec[%d].Subject = %q", i, r.Subject)
		}
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Errorf("mock expectations: %v", err)
	}
}

// ---------------------------------------------------------------------------
// Per-subject stop-on-fail (R2)
// ---------------------------------------------------------------------------

func TestDrainOnce_PerSubjectStopOnFailDoesNotBlockOtherSubjects(t *testing.T) {
	t.Parallel()
	db, mock := newTestDB(t)
	cfg := Config{BatchSize: 100, MaxAttempts: 10}

	pub := &mockPub{
		// Fail only on subject A; subject B should still drain.
		failOn: func(subject string, _ []byte) error {
			if subject == "game.room-a.cmd.batch_insert" {
				return errors.New("nats down for room-a")
			}
			return nil
		},
	}

	now := time.Now()
	rows := sqlmock.NewRows([]string{"id", "subject", "payload", "reference_id", "created_at", "attempt_count"}).
		AddRow(int64(1), "game.room-a.cmd.batch_insert", []byte("a-1"), "ref-a-1", now, 0).
		AddRow(int64(2), "game.room-a.cmd.batch_insert", []byte("a-2"), "ref-a-2", now, 0).
		AddRow(int64(3), "game.room-b.cmd.batch_insert", []byte("b-1"), "ref-b-1", now, 0).
		AddRow(int64(4), "game.room-b.cmd.batch_insert", []byte("b-2"), "ref-b-2", now, 0)
	mock.ExpectQuery(selectQueryRegex.String()).WithArgs(10, 100).WillReturnRows(rows)
	// Bump attempt_count on id=1 (the failed row).
	mock.ExpectExec(bumpQueryRegex.String()).
		WithArgs(1, "nats down for room-a", int64(1)).
		WillReturnResult(sqlmock.NewResult(0, 1))
	// Delete the successful rows from room-b: ids 3, 4.
	mock.ExpectExec(deleteQueryRegex.String()).
		WithArgs(pq.Array([]int64{3, 4})).
		WillReturnResult(sqlmock.NewResult(0, 2))

	if err := drainOnce(context.Background(), db, pub, silentLogger(), cfg); err != nil {
		t.Fatalf("drainOnce: %v", err)
	}
	// Expect 2 publishes (both room-b rows). room-a id=1 failed so id=2
	// stays queued (order preservation). room-a id=2 is NOT published.
	recs := pub.records()
	if len(recs) != 2 {
		t.Fatalf("expected 2 publishes (room-b only), got %d: %+v", len(recs), recs)
	}
	for _, r := range recs {
		if r.Subject != "game.room-b.cmd.batch_insert" {
			t.Errorf("unexpected publish of %q", r.Subject)
		}
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Errorf("mock expectations: %v", err)
	}
}

// ---------------------------------------------------------------------------
// DLQ exile (R3 bounded retry)
// ---------------------------------------------------------------------------

func TestDrainOnce_DLQExileAtMaxAttempts(t *testing.T) {
	t.Parallel()
	db, mock := newTestDB(t)
	cfg := Config{BatchSize: 100, MaxAttempts: 10}

	pub := &mockPub{
		failOn: func(_ string, _ []byte) error {
			return errors.New("poison pill")
		},
	}

	now := time.Now()
	rows := sqlmock.NewRows([]string{"id", "subject", "payload", "reference_id", "created_at", "attempt_count"}).
		// attempt_count = 9, publish fails → newAttempts = 10 ≥ max → DLQ.
		AddRow(int64(42), "game.main.cmd.batch_insert", []byte("doomed"), "ref-doom", now, 9)
	mock.ExpectQuery(selectQueryRegex.String()).WithArgs(10, 100).WillReturnRows(rows)

	// DLQ move is a tx: BEGIN, INSERT dlq, DELETE outbox, COMMIT.
	mock.ExpectBegin()
	mock.ExpectExec(`INSERT INTO nats_outbox_dlq`).
		WithArgs(int64(42), "game.main.cmd.batch_insert", []byte("doomed"), "ref-doom",
			sqlmock.AnyArg(), 10, "poison pill", "attempt_count=10 >= max").
		WillReturnResult(sqlmock.NewResult(1, 1))
	mock.ExpectExec(`DELETE FROM nats_outbox WHERE id = \$1`).
		WithArgs(int64(42)).
		WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectCommit()
	// No batch DELETE at end — nothing was successfully published.

	if err := drainOnce(context.Background(), db, pub, silentLogger(), cfg); err != nil {
		t.Fatalf("drainOnce: %v", err)
	}
	if pub.count() != 0 {
		t.Errorf("expected 0 publishes, got %d", pub.count())
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Errorf("mock expectations: %v", err)
	}
}

// ---------------------------------------------------------------------------
// Infra errors
// ---------------------------------------------------------------------------

func TestDrainOnce_SelectErrorIsReturned(t *testing.T) {
	t.Parallel()
	db, mock := newTestDB(t)
	pub := &mockPub{}
	cfg := Config{BatchSize: 100, MaxAttempts: 10}

	mock.ExpectQuery(selectQueryRegex.String()).
		WithArgs(10, 100).
		WillReturnError(errors.New("connection refused"))

	err := drainOnce(context.Background(), db, pub, silentLogger(), cfg)
	if err == nil {
		t.Fatal("expected error, got nil")
	}
	if pub.count() != 0 {
		t.Errorf("expected no publishes on select error, got %d", pub.count())
	}
}

// ---------------------------------------------------------------------------
// Panic recovery
// ---------------------------------------------------------------------------

type panickingPub struct{}

func (panickingPub) Publish(_ string, _ []byte) error {
	panic("simulated publish panic")
}

func TestRunDrainPass_PanicRecovered(t *testing.T) {
	t.Parallel()
	db, mock := newTestDB(t)
	cfg := Config{BatchSize: 100, MaxAttempts: 10}

	// One row to feed into the panicking publisher.
	now := time.Now()
	rows := sqlmock.NewRows([]string{"id", "subject", "payload", "reference_id", "created_at", "attempt_count"}).
		AddRow(int64(1), "game.main.cmd.batch_insert", []byte("boom"), "ref", now, 0)
	mock.ExpectQuery(selectQueryRegex.String()).WithArgs(10, 100).WillReturnRows(rows)

	// Should not panic the test.
	runDrainPass(context.Background(), db, panickingPub{}, silentLogger(), cfg)
	// After recovery, drainer is still alive — the fact that this function
	// returned at all is the assertion.
}

// ---------------------------------------------------------------------------
// Config defaults
// ---------------------------------------------------------------------------

func TestConfig_ApplyDefaults(t *testing.T) {
	t.Parallel()
	cfg := Config{}
	cfg.applyDefaults()
	if cfg.FallbackTick != 5*time.Second {
		t.Errorf("FallbackTick default = %s", cfg.FallbackTick)
	}
	if cfg.BatchSize != 100 {
		t.Errorf("BatchSize default = %d", cfg.BatchSize)
	}
	if cfg.MaxAttempts != 10 {
		t.Errorf("MaxAttempts default = %d", cfg.MaxAttempts)
	}
	if cfg.NotifyChannel != "outbox_new" {
		t.Errorf("NotifyChannel default = %q", cfg.NotifyChannel)
	}
	if cfg.TableSizeRefresh != 60*time.Second {
		t.Errorf("TableSizeRefresh default = %s", cfg.TableSizeRefresh)
	}
}
