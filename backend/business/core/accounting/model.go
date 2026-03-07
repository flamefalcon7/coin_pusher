// Package accounting provides ledger and accounting domain logic.
package accounting

import (
	"time"

	"github.com/google/uuid"
	"github.com/shopspring/decimal"
)

// Action types for accounting log entries.
const (
	ActionDeposit          = "DEPOSIT"
	ActionExchangePlay     = "EXCHANGE_PLAY"
	ActionExchangeCashPlay = "EXCHANGE_CASH_PLAY"
	ActionGameInsert       = "GAME_INSERT"
	ActionGameInsertRefund = "GAME_INSERT_REFUND"
	ActionGameReward       = "GAME_REWARD"
	ActionChestReward      = "CHEST_REWARD"
	ActionWithdraw          = "WITHDRAW"
	ActionWithdrawRefund    = "WITHDRAW_REFUND"
	ActionWithdrawFee       = "WITHDRAW_FEE"
	ActionWithdrawFeeRefund = "WITHDRAW_FEE_REFUND"
	ActionProgressReward    = "PROGRESS_REWARD"
	ActionReferralReward    = "REFERRAL_REWARD"
)

// Currency types.
const (
	CurrencyUSDC = "USDC"
	CurrencyPlay = "PLAY"
	CurrencyCash = "CASH"
)

// AccountingLog represents a single ledger entry.
type AccountingLog struct {
	LogID       uuid.UUID       `db:"log_id" json:"log_id"`
	AccountID   uuid.UUID       `db:"account_id" json:"account_id"`
	ActionType  string          `db:"action_type" json:"action_type"`
	Amount      decimal.Decimal `db:"amount" json:"amount"`
	Currency    string          `db:"currency" json:"currency"`
	ReferenceID string          `db:"reference_id" json:"reference_id"`
	CreatedAt   time.Time       `db:"created_at" json:"created_at"`
}

// NewLog contains information needed to create a new accounting entry.
type NewLog struct {
	AccountID   uuid.UUID
	ActionType  string
	Amount      decimal.Decimal
	Currency    string
	ReferenceID string
}
