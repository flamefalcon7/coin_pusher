package sponsor

import (
	"context"
	"time"

	"github.com/google/uuid"
	"github.com/shopspring/decimal"
)

// Storer interface declares the core database operations for the sponsor domain.
type Storer interface {
	Create(ctx context.Context, camp Campaign) error
	QueryByID(ctx context.Context, campaignID uuid.UUID) (Campaign, error)
	QueryActive(ctx context.Context) ([]Campaign, error)
	DecrementPool(ctx context.Context, campaignID uuid.UUID, amount decimal.Decimal) (decimal.Decimal, error)
	CreditBalance(ctx context.Context, campaignID, accountID uuid.UUID, amount decimal.Decimal) error
	CreateRewardLog(ctx context.Context, log RewardLog) error
	QueryBalancesByAccount(ctx context.Context, accountID uuid.UUID) ([]SponsorBalance, error)
	UpdateStatus(ctx context.Context, campaignID uuid.UUID, status string) error
	QueryByAccount(ctx context.Context, accountID uuid.UUID) ([]Campaign, error)
	CreateQuota(ctx context.Context, entry QuotaEntry) error
	ConsumeQuota(ctx context.Context, quotaID uuid.UUID, coinsSpawned int) error
	QueryStaleQuotas(ctx context.Context, olderThan time.Time) ([]QuotaEntry, error)
	RefundQuota(ctx context.Context, quotaID uuid.UUID) error
}
