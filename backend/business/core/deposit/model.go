// Package deposit provides deposit and withdrawal domain logic.
package deposit

import (
	"time"

	"github.com/google/uuid"
	"github.com/shopspring/decimal"
)

// DepositAddress represents a per-user, per-chain HD-derived deposit address.
type DepositAddress struct {
	AddressID       uuid.UUID `db:"address_id" json:"address_id"`
	AccountID       uuid.UUID `db:"account_id" json:"account_id"`
	Chain           string    `db:"chain" json:"chain"`
	Address         string    `db:"address" json:"address"`
	DerivationIndex int       `db:"derivation_index" json:"derivation_index"`
	CreatedAt       time.Time `db:"created_at" json:"created_at"`
}

// Deposit represents an on-chain deposit record.
type Deposit struct {
	DepositID   uuid.UUID       `db:"deposit_id" json:"deposit_id"`
	AccountID   uuid.UUID       `db:"account_id" json:"account_id"`
	Chain       string          `db:"chain" json:"chain"`
	Amount      decimal.Decimal `db:"amount" json:"amount"`
	TxHash      string          `db:"tx_hash" json:"tx_hash"`
	BlockNumber int64           `db:"block_number" json:"block_number"`
	FromAddress string          `db:"from_address" json:"from_address"`
	Status      string          `db:"status" json:"status"`
	CreatedAt   time.Time       `db:"created_at" json:"created_at"`
}

// WithdrawRequest represents a withdrawal request record.
type WithdrawRequest struct {
	RequestID   uuid.UUID        `db:"request_id" json:"request_id"`
	AccountID   uuid.UUID        `db:"account_id" json:"account_id"`
	AmountCash  decimal.Decimal  `db:"amount_cash" json:"amount_cash"`
	AmountUSDC  decimal.Decimal  `db:"amount_usdc" json:"amount_usdc"`
	FeeUSDC     decimal.Decimal  `db:"fee_usdc" json:"fee_usdc"`
	Chain       string           `db:"chain" json:"chain"`
	ToAddress   string           `db:"to_address" json:"to_address"`
	Status      string           `db:"status" json:"status"`
	TxHash      *string          `db:"tx_hash" json:"tx_hash"`
	ErrorMsg    *string          `db:"error_msg" json:"error_msg"`
	ReviewedBy  *uuid.UUID       `db:"reviewed_by" json:"reviewed_by"`
	CreatedAt   time.Time        `db:"created_at" json:"created_at"`
	SubmittedAt *time.Time       `db:"submitted_at" json:"submitted_at"`
	ConfirmedAt *time.Time       `db:"confirmed_at" json:"confirmed_at"`
}

// Withdrawal fee (flat, Phase 1).
var WithdrawalFee = decimal.NewFromFloat(0.50)

// MinWithdrawal is the minimum withdrawal amount.
var MinWithdrawal = decimal.NewFromInt(1)

// MinDeposit is the minimum deposit amount.
var MinDeposit = decimal.NewFromInt(1)

// Base USDC contract address.
const USDCContractBase = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"

// Default chain.
const DefaultChain = "base"

// Default chain ID.
const DefaultChainID = 8453
