package accounting

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/shopspring/decimal"

	"github.com/flamefalcon/coin-pusher/backend/business/core/user"
	v1 "github.com/flamefalcon/coin-pusher/backend/business/web/v1"
)

// Core manages the set of APIs for accounting access.
type Core struct {
	storer   Storer
	userCore *user.Core
}

// NewCore constructs an accounting Core.
func NewCore(storer Storer, userCore *user.Core) *Core {
	return &Core{
		storer:   storer,
		userCore: userCore,
	}
}

// ProcessDeposit handles an on-chain deposit event idempotently.
// The reference_id (tx hash) ensures each deposit is only applied once.
func (c *Core) ProcessDeposit(ctx context.Context, accountID uuid.UUID, amount decimal.Decimal, currency, referenceID string) error {
	// Check if this deposit was already processed.
	_, err := c.storer.QueryByReference(ctx, ActionDeposit, referenceID)
	if err == nil {
		// Already processed — idempotent success.
		return nil
	}
	if !errors.Is(err, v1.ErrNotFound) {
		return fmt.Errorf("checking reference: %w", err)
	}

	// Create accounting log.
	now := time.Now().UTC()
	log := AccountingLog{
		LogID:       uuid.New(),
		AccountID:   accountID,
		ActionType:  ActionDeposit,
		Amount:      amount,
		Currency:    currency,
		ReferenceID: referenceID,
		CreatedAt:   now,
	}

	if err := c.storer.Create(ctx, log); err != nil {
		return fmt.Errorf("creating deposit log: %w", err)
	}

	// Credit account balance.
	switch currency {
	case CurrencyUSDC:
		return c.userCore.IncrementUSDCBalance(ctx, accountID, amount)
	case CurrencyPlay:
		return c.userCore.IncrementPlayBalance(ctx, accountID, amount)
	case CurrencyCash:
		return c.userCore.IncrementCashBalance(ctx, accountID, amount)
	default:
		return fmt.Errorf("unknown currency: %s", currency)
	}
}

// ProcessGameInsert handles a coin insertion game event.
// Debits the account's play balance and creates a ledger entry.
// Returns the new balance_play value.
func (c *Core) ProcessGameInsert(ctx context.Context, accountID uuid.UUID, coinCount int, referenceID string) (decimal.Decimal, error) {
	amount := decimal.NewFromInt(int64(coinCount))

	// Debit account play balance.
	newPlay, err := c.userCore.DecrementPlayBalance(ctx, accountID, amount)
	if err != nil {
		return decimal.Zero, err
	}

	now := time.Now().UTC()
	log := AccountingLog{
		LogID:       uuid.New(),
		AccountID:   accountID,
		ActionType:  ActionGameInsert,
		Amount:      amount,
		Currency:    CurrencyPlay,
		ReferenceID: referenceID,
		CreatedAt:   now,
	}

	if err := c.storer.Create(ctx, log); err != nil {
		return decimal.Zero, fmt.Errorf("creating game insert log: %w", err)
	}

	return newPlay, nil
}

// ProcessGameReward handles a game reward event (coins distributed via heat shares).
// Credits the account's cash balance and creates a ledger entry.
func (c *Core) ProcessGameReward(ctx context.Context, accountID uuid.UUID, amount decimal.Decimal, referenceID string) error {
	if err := c.userCore.IncrementCashBalance(ctx, accountID, amount); err != nil {
		return err
	}

	now := time.Now().UTC()
	log := AccountingLog{
		LogID:       uuid.New(),
		AccountID:   accountID,
		ActionType:  ActionGameReward,
		Amount:      amount,
		Currency:    CurrencyCash,
		ReferenceID: referenceID,
		CreatedAt:   now,
	}

	if err := c.storer.Create(ctx, log); err != nil {
		return fmt.Errorf("creating game reward log: %w", err)
	}

	return nil
}
