package accounting

import (
	"context"
	"time"

	"github.com/google/uuid"
	"github.com/shopspring/decimal"
)

// Storer interface declares the core database operations for accounting.
type Storer interface {
	Create(ctx context.Context, log AccountingLog) error
	QueryByAccountID(ctx context.Context, accountID uuid.UUID, page, pageSize int) ([]AccountingLog, error)
	QueryByReference(ctx context.Context, actionType, referenceID string) (AccountingLog, error)
	SumByActionSince(ctx context.Context, actionType string, since time.Time) (decimal.Decimal, error)
	SumByPlayerSince(ctx context.Context, actionType string, since time.Time) ([]PlayerSum, error)
}

// PlayerSum holds the aggregate amount for a single player.
type PlayerSum struct {
	AccountID uuid.UUID       `db:"account_id"`
	Total     decimal.Decimal `db:"total"`
}
