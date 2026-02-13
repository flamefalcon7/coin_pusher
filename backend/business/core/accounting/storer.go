package accounting

import (
	"context"

	"github.com/google/uuid"
)

// Storer interface declares the core database operations for accounting.
type Storer interface {
	Create(ctx context.Context, log AccountingLog) error
	QueryByUserID(ctx context.Context, userID uuid.UUID, page, pageSize int) ([]AccountingLog, error)
	QueryByReference(ctx context.Context, actionType, referenceID string) (AccountingLog, error)
}
