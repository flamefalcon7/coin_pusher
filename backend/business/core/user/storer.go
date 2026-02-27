package user

import (
	"context"
	"time"

	"github.com/google/uuid"
	"github.com/shopspring/decimal"
)

// Storer interface declares the core database operations for accounts.
type Storer interface {
	Create(ctx context.Context, acct Account) error
	CreateAuthProvider(ctx context.Context, ap AuthProvider) error
	QueryByID(ctx context.Context, accountID uuid.UUID) (Account, error)
	QueryByProvider(ctx context.Context, providerType, providerUID string) (Account, error)
	UpdateBalance(ctx context.Context, accountID uuid.UUID, currency string, delta decimal.Decimal) (decimal.Decimal, error)

	// Nonce operations for wallet login.
	CreateNonce(ctx context.Context, nonce, address string, expiresAt time.Time) error
	ConsumeNonce(ctx context.Context, nonce string) (NonceRecord, error)
	PurgeExpiredNonces(ctx context.Context) (int64, error)
}
