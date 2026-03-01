package progress

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/shopspring/decimal"
	"go.uber.org/zap"
)

// ---------------------------------------------------------------------------
// Mock Storer
// ---------------------------------------------------------------------------

type mockStorer struct {
	queryEnabledByMetricFn           func(ctx context.Context, metricType string, now time.Time) ([]Progress, error)
	upsertAccountProgressFn          func(ctx context.Context, accountID, progressID uuid.UUID, delta decimal.Decimal) (*AccountProgress, error)
	markAchievedFn                   func(ctx context.Context, accountID, progressID uuid.UUID, achievedAt time.Time) error
	queryClaimableFn                 func(ctx context.Context, accountID, progressID uuid.UUID, now time.Time) (*ClaimableEntry, error)
	markDisbursedFn                  func(ctx context.Context, accountID, progressID uuid.UUID, disbursedAt time.Time) error
	queryExpirableFn                 func(ctx context.Context, now time.Time, limit int) ([]ExpirableEntry, error)
	markExpiredFn                    func(ctx context.Context, accountID, progressID uuid.UUID, now time.Time) error
	createProgressFn                 func(ctx context.Context, p Progress) error
	updateProgressFn                 func(ctx context.Context, p Progress) error
	queryProgressByIDFn              func(ctx context.Context, progressID uuid.UUID) (Progress, error)
	queryAllProgressFn               func(ctx context.Context) ([]Progress, error)
	queryUserProgressFn              func(ctx context.Context, accountID uuid.UUID) ([]UserProgressView, error)
	queryAccountProgressByProgressFn func(ctx context.Context, progressID uuid.UUID) ([]AccountProgress, error)
}

func (m *mockStorer) CreateProgress(ctx context.Context, p Progress) error {
	if m.createProgressFn != nil {
		return m.createProgressFn(ctx, p)
	}
	return nil
}

func (m *mockStorer) UpdateProgress(ctx context.Context, p Progress) error {
	if m.updateProgressFn != nil {
		return m.updateProgressFn(ctx, p)
	}
	return nil
}

func (m *mockStorer) QueryProgressByID(ctx context.Context, progressID uuid.UUID) (Progress, error) {
	if m.queryProgressByIDFn != nil {
		return m.queryProgressByIDFn(ctx, progressID)
	}
	return Progress{}, nil
}

func (m *mockStorer) QueryAllProgress(ctx context.Context) ([]Progress, error) {
	if m.queryAllProgressFn != nil {
		return m.queryAllProgressFn(ctx)
	}
	return nil, nil
}

func (m *mockStorer) QueryEnabledByMetric(ctx context.Context, metricType string, now time.Time) ([]Progress, error) {
	if m.queryEnabledByMetricFn != nil {
		return m.queryEnabledByMetricFn(ctx, metricType, now)
	}
	return nil, nil
}

func (m *mockStorer) UpsertAccountProgress(ctx context.Context, accountID, progressID uuid.UUID, delta decimal.Decimal) (*AccountProgress, error) {
	if m.upsertAccountProgressFn != nil {
		return m.upsertAccountProgressFn(ctx, accountID, progressID, delta)
	}
	return nil, nil
}

func (m *mockStorer) MarkAchieved(ctx context.Context, accountID, progressID uuid.UUID, achievedAt time.Time) error {
	if m.markAchievedFn != nil {
		return m.markAchievedFn(ctx, accountID, progressID, achievedAt)
	}
	return nil
}

func (m *mockStorer) QueryClaimable(ctx context.Context, accountID, progressID uuid.UUID, now time.Time) (*ClaimableEntry, error) {
	if m.queryClaimableFn != nil {
		return m.queryClaimableFn(ctx, accountID, progressID, now)
	}
	return nil, nil
}

func (m *mockStorer) MarkDisbursed(ctx context.Context, accountID, progressID uuid.UUID, disbursedAt time.Time) error {
	if m.markDisbursedFn != nil {
		return m.markDisbursedFn(ctx, accountID, progressID, disbursedAt)
	}
	return nil
}

func (m *mockStorer) QueryExpirable(ctx context.Context, now time.Time, limit int) ([]ExpirableEntry, error) {
	if m.queryExpirableFn != nil {
		return m.queryExpirableFn(ctx, now, limit)
	}
	return nil, nil
}

func (m *mockStorer) MarkExpired(ctx context.Context, accountID, progressID uuid.UUID, now time.Time) error {
	if m.markExpiredFn != nil {
		return m.markExpiredFn(ctx, accountID, progressID, now)
	}
	return nil
}

func (m *mockStorer) QueryUserProgress(ctx context.Context, accountID uuid.UUID) ([]UserProgressView, error) {
	if m.queryUserProgressFn != nil {
		return m.queryUserProgressFn(ctx, accountID)
	}
	return nil, nil
}

func (m *mockStorer) QueryAccountProgressByProgressID(ctx context.Context, progressID uuid.UUID) ([]AccountProgress, error) {
	if m.queryAccountProgressByProgressFn != nil {
		return m.queryAccountProgressByProgressFn(ctx, progressID)
	}
	return nil, nil
}

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

func newTestCore(s Storer) *Core {
	return &Core{
		log:    zap.NewNop().Sugar(),
		storer: s,
	}
}

// ---------------------------------------------------------------------------
// RecordMetric — below threshold
// ---------------------------------------------------------------------------

func TestRecordMetric_BelowThreshold(t *testing.T) {
	t.Parallel()

	accountID := uuid.New()
	progressID := uuid.New()
	var achievedCalled bool

	s := &mockStorer{
		queryEnabledByMetricFn: func(ctx context.Context, metricType string, now time.Time) ([]Progress, error) {
			if metricType != "game_insert_count" {
				t.Errorf("metricType = %q, want game_insert_count", metricType)
			}
			return []Progress{
				{ProgressID: progressID, Threshold: decimal.NewFromInt(100)},
			}, nil
		},
		upsertAccountProgressFn: func(ctx context.Context, aid, pid uuid.UUID, delta decimal.Decimal) (*AccountProgress, error) {
			return &AccountProgress{
				AccountID: aid, ProgressID: pid,
				CurrentValue: decimal.NewFromInt(50),
				Status:       StatusActive,
			}, nil
		},
		markAchievedFn: func(ctx context.Context, aid, pid uuid.UUID, at time.Time) error {
			achievedCalled = true
			return nil
		},
	}

	c := newTestCore(s)
	err := c.RecordMetric(context.Background(), accountID, "game_insert_count", decimal.NewFromInt(10))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if achievedCalled {
		t.Error("MarkAchieved should NOT be called when below threshold")
	}
}

// ---------------------------------------------------------------------------
// RecordMetric — reaches threshold exactly
// ---------------------------------------------------------------------------

func TestRecordMetric_ReachesThreshold(t *testing.T) {
	t.Parallel()

	accountID := uuid.New()
	progressID := uuid.New()
	var achievedCalled bool
	var achievedPID uuid.UUID

	s := &mockStorer{
		queryEnabledByMetricFn: func(ctx context.Context, metricType string, now time.Time) ([]Progress, error) {
			return []Progress{
				{ProgressID: progressID, Threshold: decimal.NewFromInt(100)},
			}, nil
		},
		upsertAccountProgressFn: func(ctx context.Context, aid, pid uuid.UUID, delta decimal.Decimal) (*AccountProgress, error) {
			return &AccountProgress{
				AccountID: aid, ProgressID: pid,
				CurrentValue: decimal.NewFromInt(100),
				Status:       StatusActive,
			}, nil
		},
		markAchievedFn: func(ctx context.Context, aid, pid uuid.UUID, at time.Time) error {
			achievedCalled = true
			achievedPID = pid
			return nil
		},
	}

	c := newTestCore(s)
	err := c.RecordMetric(context.Background(), accountID, "game_insert_count", decimal.NewFromInt(50))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !achievedCalled {
		t.Error("MarkAchieved should be called when threshold met")
	}
	if achievedPID != progressID {
		t.Errorf("achieved progressID = %v, want %v", achievedPID, progressID)
	}
}

// ---------------------------------------------------------------------------
// RecordMetric — exceeds threshold
// ---------------------------------------------------------------------------

func TestRecordMetric_ExceedsThreshold(t *testing.T) {
	t.Parallel()

	progressID := uuid.New()
	var achievedCalled bool

	s := &mockStorer{
		queryEnabledByMetricFn: func(ctx context.Context, metricType string, now time.Time) ([]Progress, error) {
			return []Progress{
				{ProgressID: progressID, Threshold: decimal.NewFromInt(100)},
			}, nil
		},
		upsertAccountProgressFn: func(ctx context.Context, aid, pid uuid.UUID, delta decimal.Decimal) (*AccountProgress, error) {
			return &AccountProgress{
				AccountID: aid, ProgressID: pid,
				CurrentValue: decimal.NewFromInt(150),
				Status:       StatusActive,
			}, nil
		},
		markAchievedFn: func(ctx context.Context, aid, pid uuid.UUID, at time.Time) error {
			achievedCalled = true
			return nil
		},
	}

	c := newTestCore(s)
	err := c.RecordMetric(context.Background(), uuid.New(), "game_insert_count", decimal.NewFromInt(80))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !achievedCalled {
		t.Error("MarkAchieved should be called when above threshold")
	}
}

// ---------------------------------------------------------------------------
// RecordMetric — already achieved, no double achieve
// ---------------------------------------------------------------------------

func TestRecordMetric_AlreadyAchieved(t *testing.T) {
	t.Parallel()

	var achievedCalled bool

	s := &mockStorer{
		queryEnabledByMetricFn: func(ctx context.Context, metricType string, now time.Time) ([]Progress, error) {
			return []Progress{
				{ProgressID: uuid.New(), Threshold: decimal.NewFromInt(100)},
			}, nil
		},
		upsertAccountProgressFn: func(ctx context.Context, aid, pid uuid.UUID, delta decimal.Decimal) (*AccountProgress, error) {
			return nil, nil // nil = row not updated (already achieved/disbursed)
		},
		markAchievedFn: func(ctx context.Context, aid, pid uuid.UUID, at time.Time) error {
			achievedCalled = true
			return nil
		},
	}

	c := newTestCore(s)
	err := c.RecordMetric(context.Background(), uuid.New(), "game_insert_count", decimal.NewFromInt(10))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if achievedCalled {
		t.Error("MarkAchieved should NOT be called when upsert returns nil")
	}
}

// ---------------------------------------------------------------------------
// RecordMetric — multiple progress defs, only one meets threshold
// ---------------------------------------------------------------------------

func TestRecordMetric_MultipleProgressDefs(t *testing.T) {
	t.Parallel()

	p1 := uuid.New()
	p2 := uuid.New()
	var achievedIDs []uuid.UUID

	s := &mockStorer{
		queryEnabledByMetricFn: func(ctx context.Context, metricType string, now time.Time) ([]Progress, error) {
			return []Progress{
				{ProgressID: p1, Threshold: decimal.NewFromInt(50)},
				{ProgressID: p2, Threshold: decimal.NewFromInt(200)},
			}, nil
		},
		upsertAccountProgressFn: func(ctx context.Context, aid, pid uuid.UUID, delta decimal.Decimal) (*AccountProgress, error) {
			return &AccountProgress{
				AccountID: aid, ProgressID: pid,
				CurrentValue: decimal.NewFromInt(100), // p1: 100>=50, p2: 100<200
				Status:       StatusActive,
			}, nil
		},
		markAchievedFn: func(ctx context.Context, aid, pid uuid.UUID, at time.Time) error {
			achievedIDs = append(achievedIDs, pid)
			return nil
		},
	}

	c := newTestCore(s)
	err := c.RecordMetric(context.Background(), uuid.New(), "game_insert_count", decimal.NewFromInt(100))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(achievedIDs) != 1 {
		t.Fatalf("expected 1 achieved, got %d", len(achievedIDs))
	}
	if achievedIDs[0] != p1 {
		t.Errorf("achieved = %v, want %v", achievedIDs[0], p1)
	}
}

// ---------------------------------------------------------------------------
// RecordMetric — no matching defs
// ---------------------------------------------------------------------------

func TestRecordMetric_NoMatchingDefs(t *testing.T) {
	t.Parallel()

	s := &mockStorer{
		queryEnabledByMetricFn: func(ctx context.Context, metricType string, now time.Time) ([]Progress, error) {
			return nil, nil
		},
	}

	c := newTestCore(s)
	err := c.RecordMetric(context.Background(), uuid.New(), "unknown_metric", decimal.NewFromInt(1))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
}

// ---------------------------------------------------------------------------
// RecordMetric — upsert error on one def, continues to next
// ---------------------------------------------------------------------------

func TestRecordMetric_UpsertError_Continues(t *testing.T) {
	t.Parallel()

	p1 := uuid.New()
	p2 := uuid.New()
	var upsertCalls int

	s := &mockStorer{
		queryEnabledByMetricFn: func(ctx context.Context, metricType string, now time.Time) ([]Progress, error) {
			return []Progress{
				{ProgressID: p1, Threshold: decimal.NewFromInt(10)},
				{ProgressID: p2, Threshold: decimal.NewFromInt(10)},
			}, nil
		},
		upsertAccountProgressFn: func(ctx context.Context, aid, pid uuid.UUID, delta decimal.Decimal) (*AccountProgress, error) {
			upsertCalls++
			if pid == p1 {
				return nil, errors.New("db error")
			}
			return &AccountProgress{
				AccountID: aid, ProgressID: pid,
				CurrentValue: decimal.NewFromInt(5), Status: StatusActive,
			}, nil
		},
	}

	c := newTestCore(s)
	err := c.RecordMetric(context.Background(), uuid.New(), "test", decimal.NewFromInt(5))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if upsertCalls != 2 {
		t.Errorf("upsertCalls = %d, want 2 (should continue after error)", upsertCalls)
	}
}

// ---------------------------------------------------------------------------
// ClaimReward — not claimable (nil result)
// ---------------------------------------------------------------------------

func TestClaimReward_NotClaimable(t *testing.T) {
	t.Parallel()

	s := &mockStorer{
		queryClaimableFn: func(ctx context.Context, aid, pid uuid.UUID, now time.Time) (*ClaimableEntry, error) {
			return nil, nil
		},
	}

	c := newTestCore(s)
	err := c.ClaimReward(context.Background(), uuid.New(), uuid.New())
	if err == nil {
		t.Fatal("expected error for not-claimable entry")
	}
}

// ---------------------------------------------------------------------------
// ClaimReward — query error propagates
// ---------------------------------------------------------------------------

func TestClaimReward_QueryError(t *testing.T) {
	t.Parallel()

	s := &mockStorer{
		queryClaimableFn: func(ctx context.Context, aid, pid uuid.UUID, now time.Time) (*ClaimableEntry, error) {
			return nil, errors.New("db connection lost")
		},
	}

	c := newTestCore(s)
	err := c.ClaimReward(context.Background(), uuid.New(), uuid.New())
	if err == nil {
		t.Fatal("expected error when query fails")
	}
}

// ---------------------------------------------------------------------------
// ExpireOverdue — no entries
// ---------------------------------------------------------------------------

func TestExpireOverdue_NoEntries(t *testing.T) {
	t.Parallel()

	s := &mockStorer{
		queryExpirableFn: func(ctx context.Context, now time.Time, limit int) ([]ExpirableEntry, error) {
			return nil, nil
		},
	}

	c := newTestCore(s)
	n, err := c.ExpireOverdue(context.Background(), time.Now(), 100)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if n != 0 {
		t.Errorf("expired = %d, want 0", n)
	}
}

// ---------------------------------------------------------------------------
// ExpireOverdue — expires multiple entries
// ---------------------------------------------------------------------------

func TestExpireOverdue_ExpiresEntries(t *testing.T) {
	t.Parallel()

	e1 := ExpirableEntry{AccountID: uuid.New(), ProgressID: uuid.New()}
	e2 := ExpirableEntry{AccountID: uuid.New(), ProgressID: uuid.New()}
	var expiredIDs []uuid.UUID

	s := &mockStorer{
		queryExpirableFn: func(ctx context.Context, now time.Time, limit int) ([]ExpirableEntry, error) {
			return []ExpirableEntry{e1, e2}, nil
		},
		markExpiredFn: func(ctx context.Context, aid, pid uuid.UUID, now time.Time) error {
			expiredIDs = append(expiredIDs, pid)
			return nil
		},
	}

	c := newTestCore(s)
	n, err := c.ExpireOverdue(context.Background(), time.Now(), 100)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if n != 2 {
		t.Errorf("expired = %d, want 2", n)
	}
	if len(expiredIDs) != 2 {
		t.Fatalf("markExpired calls = %d, want 2", len(expiredIDs))
	}
}

// ---------------------------------------------------------------------------
// ExpireOverdue — mark error on one entry, continues to next
// ---------------------------------------------------------------------------

func TestExpireOverdue_MarkError_Continues(t *testing.T) {
	t.Parallel()

	e1 := ExpirableEntry{AccountID: uuid.New(), ProgressID: uuid.New()}
	e2 := ExpirableEntry{AccountID: uuid.New(), ProgressID: uuid.New()}

	s := &mockStorer{
		queryExpirableFn: func(ctx context.Context, now time.Time, limit int) ([]ExpirableEntry, error) {
			return []ExpirableEntry{e1, e2}, nil
		},
		markExpiredFn: func(ctx context.Context, aid, pid uuid.UUID, now time.Time) error {
			if pid == e1.ProgressID {
				return errors.New("db error")
			}
			return nil
		},
	}

	c := newTestCore(s)
	n, err := c.ExpireOverdue(context.Background(), time.Now(), 100)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if n != 1 {
		t.Errorf("expired = %d, want 1 (first failed, second succeeded)", n)
	}
}

// ---------------------------------------------------------------------------
// ExpireOverdue — query error propagates
// ---------------------------------------------------------------------------

func TestExpireOverdue_QueryError(t *testing.T) {
	t.Parallel()

	s := &mockStorer{
		queryExpirableFn: func(ctx context.Context, now time.Time, limit int) ([]ExpirableEntry, error) {
			return nil, errors.New("db error")
		},
	}

	c := newTestCore(s)
	_, err := c.ExpireOverdue(context.Background(), time.Now(), 100)
	if err == nil {
		t.Fatal("expected error when query fails")
	}
}
