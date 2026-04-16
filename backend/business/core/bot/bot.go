package bot

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/jmoiron/sqlx"
	"github.com/shopspring/decimal"

	"github.com/flamefalcon/coin-pusher/backend/business/core/accounting"
	v1 "github.com/flamefalcon/coin-pusher/backend/business/web/v1"
)

// Core manages bot domain operations: config CRUD, bot-account queries, and
// the policy layer around refilling bot balance_play.
//
// Unlike accounting.Core (tx-capable with StorerFactory + UserStorerFactory),
// bot.Core does not own a transaction boundary of its own. The only write
// that spans multiple tables — RefillBalance — delegates to
// accounting.Core.ProcessBotRefill, which runs its own execTx. Config and
// account queries are single-table reads/upserts; no cross-table atomicity
// concern.
//
// In unit tests, pass nil for db and use the storer + acctCore to inject
// mocks. acctCore may also be nil in read-only tests that don't exercise
// RefillBalance.
type Core struct {
	db       *sqlx.DB
	storer   Storer
	acctCore *accounting.Core
}

// NewCore constructs a bot Core. db is kept on the struct for future storer
// construction from tx boundaries the scheduler owns; present uses only need
// the injected storer + acctCore.
func NewCore(db *sqlx.DB, storer Storer, acctCore *accounting.Core) *Core {
	return &Core{
		db:       db,
		storer:   storer,
		acctCore: acctCore,
	}
}

// GetConfig returns the value for a bot_config key. Returns ErrConfigNotFound
// if the key has no row — callers MUST NOT treat this as an empty-string
// default.
func (c *Core) GetConfig(ctx context.Context, key string) (string, error) {
	all, err := c.storer.QueryConfigAll(ctx)
	if err != nil {
		return "", fmt.Errorf("query bot config: %w", err)
	}
	val, ok := all[key]
	if !ok {
		return "", ErrConfigNotFound
	}
	return val, nil
}

// SetConfig upserts a bot_config row. Value is stored verbatim — the caller
// is responsible for serializing structured values (e.g., crowd_scale as
// JSON) and for validating the key is one of the known ConfigKey* consts.
func (c *Core) SetConfig(ctx context.Context, key, value string) error {
	if err := c.storer.UpsertConfig(ctx, key, value); err != nil {
		return fmt.Errorf("upsert bot config %s: %w", key, err)
	}
	return nil
}

// ListAllBots returns every bot account. The result is suitable for the
// scheduler's initial pool and for admin CLI `bot list`. Scheduler holds the
// returned slice in memory; admin CLI formats it for display.
func (c *Core) ListAllBots(ctx context.Context) ([]Bot, error) {
	bots, err := c.storer.QueryBotAccounts(ctx)
	if err != nil {
		return nil, fmt.Errorf("list bots: %w", err)
	}
	return bots, nil
}

// GetBot returns the bot with the given account_id. The storer returns a
// wrapped v1.ErrNotFound when the account doesn't exist OR when it exists
// but is not role='bot' — the two cases are deliberately indistinguishable
// from the caller's perspective.
func (c *Core) GetBot(ctx context.Context, accountID uuid.UUID) (Bot, error) {
	b, err := c.storer.QueryBotAccountByID(ctx, accountID)
	if err != nil {
		return Bot{}, fmt.Errorf("get bot %s: %w", accountID, err)
	}
	return b, nil
}

// DailyRefillTotal returns the sum of BOT_REFILL amounts credited since the
// start of the current UTC day. Scheduler compares this against
// ConfigKeyDailyCap to gate the refill pass.
//
// UTC is the canonical day boundary: operator/server timezones must not
// influence when "today" resets, and Postgres's DATE_TRUNC with timezone
// shifts is a known source of off-by-one bugs.
func (c *Core) DailyRefillTotal(ctx context.Context) (decimal.Decimal, error) {
	startOfDay := time.Now().UTC().Truncate(24 * time.Hour)
	total, err := c.storer.SumRefillsSince(ctx, startOfDay)
	if err != nil {
		return decimal.Zero, fmt.Errorf("sum daily bot refills: %w", err)
	}
	return total, nil
}

// RefillBalance validates the target is a bot account, then delegates to
// accounting.Core.ProcessBotRefill to perform the atomic ledger write +
// balance credit. Returns the new balance_play.
//
// Validation layers:
//  1. amount must be > 0 (also checked inside ProcessBotRefill as defense
//     in depth).
//  2. Account must exist with role='bot'; ErrNotABot otherwise. Closes the
//     class of "scheduler bug sends refill to real user" at the policy
//     boundary.
//  3. referenceID uniqueness is enforced by the DB index on
//     (action_type, reference_id, currency). On duplicate, ProcessBotRefill
//     treats it as idempotent replay and returns the current balance.
func (c *Core) RefillBalance(ctx context.Context, accountID uuid.UUID, amount decimal.Decimal, referenceID string) (decimal.Decimal, error) {
	if amount.Sign() <= 0 {
		return decimal.Zero, fmt.Errorf("refill amount must be positive: %s", amount)
	}
	if referenceID == "" {
		return decimal.Zero, fmt.Errorf("refill reference_id must be non-empty")
	}
	if c.acctCore == nil {
		return decimal.Zero, fmt.Errorf("bot core missing accounting core dependency")
	}

	// Verify role='bot'. If the storer returns NotFound we treat it as
	// ErrNotABot — caller can't distinguish "doesn't exist" from "exists but
	// not a bot" and shouldn't need to.
	if _, err := c.storer.QueryBotAccountByID(ctx, accountID); err != nil {
		if errors.Is(err, v1.ErrNotFound) {
			return decimal.Zero, ErrNotABot
		}
		return decimal.Zero, fmt.Errorf("verify bot account %s: %w", accountID, err)
	}

	newPlay, err := c.acctCore.ProcessBotRefill(ctx, accountID, amount, referenceID)
	if err != nil {
		return decimal.Zero, fmt.Errorf("process bot refill: %w", err)
	}
	return newPlay, nil
}

