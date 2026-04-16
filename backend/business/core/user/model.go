// Package user provides the account domain logic.
package user

import (
	"time"

	"github.com/google/uuid"
	"github.com/shopspring/decimal"
)

// Account represents an account in the system.
type Account struct {
	ID                   uuid.UUID       `db:"account_id" json:"account_id"`
	DisplayName          *string         `db:"display_name" json:"display_name"`
	BalanceUSDC          decimal.Decimal `db:"balance_usdc" json:"balance_usdc"`
	BalancePlay          decimal.Decimal `db:"balance_play" json:"balance_play"`
	BalanceCash          decimal.Decimal `db:"balance_cash" json:"balance_cash"`
	Role                 string          `db:"role" json:"role"`
	ReferralCode         string          `db:"referral_code" json:"referral_code"`
	ReferralCodeCustomized bool          `db:"referral_code_customized" json:"referral_code_customized"`
	ReferredBy           *uuid.UUID      `db:"referred_by" json:"referred_by,omitempty"`
	ReferralRewardPaid   bool            `db:"referral_reward_paid" json:"-"`
	LifetimeDepositUSDC  decimal.Decimal `db:"lifetime_deposit_usdc" json:"lifetime_deposit_usdc"`
	TOTPSecret           string          `db:"totp_secret" json:"-"`
	WithdrawLockedUntil  *time.Time      `db:"withdraw_locked_until" json:"-"`
	CreatedAt            time.Time       `db:"created_at" json:"created_at"`
	UpdatedAt            time.Time       `db:"updated_at" json:"updated_at"`
}

// NewAccount contains information needed to create a new account.
type NewAccount struct {
	ProviderType string // "wallet", "email", "google"
	ProviderUID  string // wallet address or email
	ReferralCode string // optional: referrer's code
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

// NewAccountWithMeta contains information needed to create a new account with metadata.
type NewAccountWithMeta struct {
	ProviderType string
	ProviderUID  string
	MetadataJSON string
	ReferralCode string // optional: referrer's code
}

// Currency types for balance operations.
const (
	CurrencyUSDC = "USDC"
	CurrencyPlay = "PLAY"
	CurrencyCash = "CASH"
)

// Role values for accounts.role. 'bot' is reserved for server-controlled NPC
// accounts provisioned exclusively via `admin bot seed` — the generic
// `admin set-role` CLI rejects it to prevent accidental promotion.
const (
	RoleUser  = "user"
	RoleAdmin = "admin"
	RoleBot   = "bot"
)

// Provider types for auth_providers.provider_type. 'bot' accounts never
// authenticate externally; the login pipeline rejects this provider type at
// multiple layers (see user.FindOrCreate, user.VerifyWalletLogin, and the
// Authenticate middleware).
const (
	ProviderTypeWallet = "wallet"
	ProviderTypeEmail  = "email"
	ProviderTypeGoogle = "google"
	ProviderTypeBot    = "bot"
)

// UpdateBalance describes an atomic balance change.
type UpdateBalance struct {
	AccountID uuid.UUID
	Currency  string // "USDC", "PLAY", or "CASH"
	Amount    decimal.Decimal
}
