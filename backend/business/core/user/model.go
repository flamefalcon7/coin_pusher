// Package user provides the user domain logic.
package user

import (
	"time"

	"github.com/google/uuid"
	"github.com/shopspring/decimal"
)

// User represents a user in the system.
type User struct {
	ID          uuid.UUID       `db:"user_id" json:"user_id"`
	Name        string          `db:"name" json:"name"`
	SUIAddress  string          `db:"sui_address" json:"sui_address"`
	ZKLoginSub  string          `db:"zklogin_sub" json:"-"`
	BalanceCoin decimal.Decimal `db:"balance_coin" json:"balance_coin"`
	BalanceUSDC decimal.Decimal `db:"balance_usdc" json:"balance_usdc"`
	CreatedAt   time.Time       `db:"created_at" json:"created_at"`
	UpdatedAt   time.Time       `db:"updated_at" json:"updated_at"`
}

// NewUser contains information needed to create a new user.
type NewUser struct {
	SUIAddress string
	Name       string
}

// UpdateBalance describes an atomic balance change.
type UpdateBalance struct {
	UserID   uuid.UUID
	Currency string // "COIN" or "USDC"
	Amount   decimal.Decimal
}
