// Package bot provides the bot domain: server-controlled NPC accounts that
// insert coins into the shared platform to avoid the empty-board feel at low
// real-player counts. Config is key-value state read per scheduler tick; bot
// accounts are differentiated from real users by accounts.role='bot' AND
// auth_providers.provider_type='bot'. Never authenticates externally.
package bot

import (
	"errors"
	"time"

	"github.com/google/uuid"
	"github.com/shopspring/decimal"
)

// Runtime-configurable bot_config keys. These are the ONLY keys the admin CLI
// is expected to write. Behavioral parameters (insert interval, amount bounds,
// session length) are intentionally Go-level constants in the scheduler — not
// DB rows — so they can't be tuned out of a tested range without a deploy.
//
// See docs/plans/2026-04-16-001-feat-play-bot-plan.md (decision D9).
const (
	ConfigKeyKillSwitch      = "kill_switch"
	ConfigKeyRefillAmount    = "refill_amount"
	ConfigKeyRefillThreshold = "refill_threshold"
	ConfigKeyDailyCap        = "daily_global_refill_cap"
	ConfigKeyCrowdScale      = "crowd_scale"
)

// Sentinel errors.
var (
	// ErrConfigNotFound is returned by Core.GetConfig when no row exists for
	// the requested key. Callers MUST treat this as "no value set" rather than
	// "empty string" — the two are not equivalent for config semantics.
	ErrConfigNotFound = errors.New("bot config key not found")

	// ErrNotABot is returned when an operation (refill, pause, etc.) targets
	// an account whose role is not 'bot'. Defensive guard against admin CLI
	// typos and scheduler bugs that might ever reach a real-user account.
	ErrNotABot = errors.New("account is not a bot")
)

// Bot describes a single bot account as joined from accounts +
// auth_providers (provider_type='bot'). It intentionally exposes only the
// fields the scheduler + admin CLI need — not the full Account struct — to
// keep the surface narrow.
type Bot struct {
	AccountID   uuid.UUID       `db:"account_id"`
	DisplayName *string         `db:"display_name"`
	ProviderUID string          `db:"provider_uid"`
	BalancePlay decimal.Decimal `db:"balance_play"`
	BalanceCash decimal.Decimal `db:"balance_cash"`
	CreatedAt   time.Time       `db:"created_at"`
}

// Config is a single row from bot_config.
type Config struct {
	ConfigKey   string    `db:"config_key"`
	ConfigValue string    `db:"config_value"`
	UpdatedAt   time.Time `db:"updated_at"`
}
