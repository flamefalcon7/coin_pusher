// Package user provides the account domain logic.
package user

import (
	"time"

	"github.com/google/uuid"
	"github.com/shopspring/decimal"
)

// Account represents an account in the system.
type Account struct {
	ID                  uuid.UUID       `db:"account_id" json:"account_id"`
	DisplayName         string          `db:"display_name" json:"display_name"`
	BalanceUSDC         decimal.Decimal `db:"balance_usdc" json:"balance_usdc"`
	BalancePlay         decimal.Decimal `db:"balance_play" json:"balance_play"`
	BalanceCash         decimal.Decimal `db:"balance_cash" json:"balance_cash"`
	Role                string          `db:"role" json:"role"`
	TOTPSecret          string          `db:"totp_secret" json:"-"`
	WithdrawLockedUntil *time.Time      `db:"withdraw_locked_until" json:"-"`
	CreatedAt           time.Time       `db:"created_at" json:"created_at"`
	UpdatedAt           time.Time       `db:"updated_at" json:"updated_at"`
}

// NewAccount contains information needed to create a new account.
type NewAccount struct {
	DisplayName  string
	ProviderType string // "wallet", "email", "google"
	ProviderUID  string // wallet address or email
}

// AuthProvider represents a login method linked to an account.
type AuthProvider struct {
	ProviderID   uuid.UUID `db:"provider_id" json:"provider_id"`
	AccountID    uuid.UUID `db:"account_id" json:"account_id"`
	ProviderType string    `db:"provider_type" json:"provider_type"`
	ProviderUID  string    `db:"provider_uid" json:"provider_uid"`
	MetadataJSON string    `db:"metadata_json" json:"metadata_json"`
	CreatedAt    time.Time `db:"created_at" json:"created_at"`
}

// NonceRecord represents a nonce stored for auth challenges.
type NonceRecord struct {
	Nonce     string    `db:"nonce"`
	Address   string    `db:"address"`
	ExpiresAt time.Time `db:"expires_at"`
	CreatedAt time.Time `db:"created_at"`
}

// NewAccount contains information needed to create a new account with metadata.
type NewAccountWithMeta struct {
	DisplayName  string
	ProviderType string
	ProviderUID  string
	MetadataJSON string
}

// Currency types for balance operations.
const (
	CurrencyUSDC = "USDC"
	CurrencyPlay = "PLAY"
	CurrencyCash = "CASH"
)

// UpdateBalance describes an atomic balance change.
type UpdateBalance struct {
	AccountID uuid.UUID
	Currency  string // "USDC", "PLAY", or "CASH"
	Amount    decimal.Decimal
}
