package user

import (
	"context"

	"github.com/google/uuid"
	"github.com/shopspring/decimal"
)

// Storer interface declares the core database operations for users.
type Storer interface {
	Create(ctx context.Context, usr User) error
	QueryByID(ctx context.Context, userID uuid.UUID) (User, error)
	QueryBySUIAddress(ctx context.Context, suiAddress string) (User, error)
	UpdateBalance(ctx context.Context, userID uuid.UUID, currency string, delta decimal.Decimal) error
}
