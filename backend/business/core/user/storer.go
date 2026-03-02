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
	QueryByIDForUpdate(ctx context.Context, accountID uuid.UUID) (Account, error)
	QueryByProvider(ctx context.Context, providerType, providerUID string) (Account, error)
	UpdateBalance(ctx context.Context, accountID uuid.UUID, currency string, delta decimal.Decimal) (decimal.Decimal, error)
	SetRole(ctx context.Context, accountID uuid.UUID, role string) error

	// Referral + username operations.
	QueryByReferralCode(ctx context.Context, code string) (Account, error)
	SetDisplayName(ctx context.Context, accountID uuid.UUID, name string) error
	SetReferralCode(ctx context.Context, accountID uuid.UUID, code string) error
	SetReferredBy(ctx context.Context, accountID, referrerID uuid.UUID) error
	IncrementLifetimeDeposit(ctx context.Context, accountID uuid.UUID, amount decimal.Decimal) error
	MarkReferralRewardPaid(ctx context.Context, accountID uuid.UUID) error
	CountReferrals(ctx context.Context, accountID uuid.UUID) (int, error)

	// Wallet address lookup.
	QueryWalletAddress(ctx context.Context, accountID uuid.UUID) (string, error)

	// Nonce operations for wallet login.
	CreateNonce(ctx context.Context, nonce, address string, expiresAt time.Time) error
	ConsumeNonce(ctx context.Context, nonce string) (NonceRecord, error)
	PurgeExpiredNonces(ctx context.Context) (int64, error)
}
