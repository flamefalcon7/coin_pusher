package progress

import (
	"context"
	"time"

	"github.com/google/uuid"
	"github.com/shopspring/decimal"
)

// Storer interface declares the core database operations for progress.
type Storer interface {
	CreateProgress(ctx context.Context, p Progress) error
	UpdateProgress(ctx context.Context, p Progress) error
	QueryProgressByID(ctx context.Context, progressID uuid.UUID) (Progress, error)
	QueryAllProgress(ctx context.Context) ([]Progress, error)
	QueryEnabledByMetric(ctx context.Context, metricType string, now time.Time) ([]Progress, error)
	UpsertAccountProgress(ctx context.Context, accountID, progressID uuid.UUID, delta decimal.Decimal) (*AccountProgress, error)
	MarkAchieved(ctx context.Context, accountID, progressID uuid.UUID, achievedAt time.Time) error
	QueryClaimable(ctx context.Context, accountID, progressID uuid.UUID, now time.Time) (*ClaimableEntry, error)
	MarkDisbursed(ctx context.Context, accountID, progressID uuid.UUID, disbursedAt time.Time) error
	QueryExpirable(ctx context.Context, now time.Time, limit int) ([]ExpirableEntry, error)
	MarkExpired(ctx context.Context, accountID, progressID uuid.UUID, now time.Time) error
	QueryUserProgress(ctx context.Context, accountID uuid.UUID) ([]UserProgressView, error)
	QueryAccountProgressByProgressID(ctx context.Context, progressID uuid.UUID) ([]AccountProgress, error)
}
