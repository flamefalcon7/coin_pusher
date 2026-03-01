// Package progress provides the progress/promotion domain logic.
package progress

import (
	"time"

	"github.com/google/uuid"
	"github.com/shopspring/decimal"
)

// Progress represents an admin-defined promotion definition.
type Progress struct {
	ProgressID    uuid.UUID       `db:"progress_id" json:"progress_id"`
	Title         string          `db:"title" json:"title"`
	Description   string          `db:"description" json:"description"`
	MetricType    string          `db:"metric_type" json:"metric_type"`
	Threshold     decimal.Decimal `db:"threshold" json:"threshold"`
	RewardType    string          `db:"reward_type" json:"reward_type"`
	RewardAmount  decimal.Decimal `db:"reward_amount" json:"reward_amount"`
	DisburseDelay time.Duration   `db:"disburse_delay" json:"disburse_delay"`
	ClaimDeadline *time.Duration  `db:"claim_deadline" json:"claim_deadline"` // nil = no expiration
	ActiveFrom    *time.Time      `db:"active_from" json:"active_from"`
	ActiveUntil   *time.Time      `db:"active_until" json:"active_until"`
	Enabled       bool            `db:"enabled" json:"enabled"`
	CreatedAt     time.Time       `db:"created_at" json:"created_at"`
	UpdatedAt     time.Time       `db:"updated_at" json:"updated_at"`
}

// NewProgress contains information needed to create a new progress definition.
type NewProgress struct {
	Title         string          `json:"title"`
	Description   string          `json:"description"`
	MetricType    string          `json:"metric_type"`
	Threshold     decimal.Decimal `json:"threshold"`
	RewardType    string          `json:"reward_type"`
	RewardAmount  decimal.Decimal `json:"reward_amount"`
	DisburseDelay time.Duration   `json:"disburse_delay"`
	ClaimDeadline *time.Duration  `json:"claim_deadline"`
	ActiveFrom    *time.Time      `json:"active_from"`
	ActiveUntil   *time.Time      `json:"active_until"`
}

// UpdateProgress contains fields that can be updated on a progress definition.
type UpdateProgress struct {
	Title         *string          `json:"title"`
	Description   *string          `json:"description"`
	MetricType    *string          `json:"metric_type"`
	Threshold     *decimal.Decimal `json:"threshold"`
	RewardType    *string          `json:"reward_type"`
	RewardAmount  *decimal.Decimal `json:"reward_amount"`
	DisburseDelay *time.Duration   `json:"disburse_delay"`
	ClaimDeadline *time.Duration   `json:"claim_deadline"`
	ActiveFrom    *time.Time       `json:"active_from"`
	ActiveUntil   *time.Time       `json:"active_until"`
	Enabled       *bool            `json:"enabled"`
}

// AccountProgress represents per-user tracking for a progress definition.
type AccountProgress struct {
	AccountID    uuid.UUID       `db:"account_id" json:"account_id"`
	ProgressID   uuid.UUID       `db:"progress_id" json:"progress_id"`
	CurrentValue decimal.Decimal `db:"current_value" json:"current_value"`
	Status       string          `db:"status" json:"status"`
	AchievedAt   *time.Time      `db:"achieved_at" json:"achieved_at"`
	DisbursedAt  *time.Time      `db:"disbursed_at" json:"disbursed_at"`
	CreatedAt    time.Time       `db:"created_at" json:"created_at"`
	UpdatedAt    time.Time       `db:"updated_at" json:"updated_at"`
}

// ClaimableEntry represents a row that can be claimed by the user (achieved + past disburse_delay).
type ClaimableEntry struct {
	AccountID    uuid.UUID       `db:"account_id"`
	ProgressID   uuid.UUID       `db:"progress_id"`
	RewardType   string          `db:"reward_type"`
	RewardAmount decimal.Decimal `db:"reward_amount"`
	AchievedAt   time.Time       `db:"achieved_at"`
	ClaimableAt  time.Time       `db:"claimable_at"`
}

// ExpirableEntry represents a row that has passed its claim_deadline and should be expired.
type ExpirableEntry struct {
	AccountID  uuid.UUID `db:"account_id"`
	ProgressID uuid.UUID `db:"progress_id"`
	AchievedAt time.Time `db:"achieved_at"`
	ExpiresAt  time.Time `db:"expires_at"`
}

// UserProgressView is a joined view of progress + account_progress for a user.
type UserProgressView struct {
	ProgressID    uuid.UUID       `db:"progress_id" json:"progress_id"`
	Title         string          `db:"title" json:"title"`
	Description   string          `db:"description" json:"description"`
	MetricType    string          `db:"metric_type" json:"metric_type"`
	Threshold     decimal.Decimal `db:"threshold" json:"threshold"`
	RewardType    string          `db:"reward_type" json:"reward_type"`
	RewardAmount  decimal.Decimal `db:"reward_amount" json:"reward_amount"`
	CurrentValue  decimal.Decimal `db:"current_value" json:"current_value"`
	Status        string          `db:"status" json:"status"`
	AchievedAt    *time.Time      `db:"achieved_at" json:"achieved_at"`
	DisbursedAt   *time.Time      `db:"disbursed_at" json:"disbursed_at"`
	DisburseDelay time.Duration   `db:"-" json:"-"`
	ClaimDeadline *time.Duration  `db:"-" json:"-"`
}

// Status constants for account_progress.
const (
	StatusActive    = "active"
	StatusAchieved  = "achieved"
	StatusDisbursed = "disbursed"
	StatusExpired   = "expired"
)
