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
func (c *Core) ProcessDeposit(ctx context.Context, userID uuid.UUID, amount decimal.Decimal, currency, referenceID string) error {
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
		UserID:      userID,
		ActionType:  ActionDeposit,
		Amount:      amount,
		Currency:    currency,
		ReferenceID: referenceID,
		CreatedAt:   now,
	}

	if err := c.storer.Create(ctx, log); err != nil {
		return fmt.Errorf("creating deposit log: %w", err)
	}

	// Credit user balance.
	switch currency {
	case CurrencyUSDC:
		return c.userCore.IncrementUSDCBalance(ctx, userID, amount)
	case CurrencyCoin:
		return c.userCore.IncrementCoinBalance(ctx, userID, amount)
	default:
		return fmt.Errorf("unknown currency: %s", currency)
	}
}

// ProcessGameInsert handles a coin insertion game event.
// Debits the user's coin balance and creates a ledger entry.
func (c *Core) ProcessGameInsert(ctx context.Context, userID uuid.UUID, coinCount int, referenceID string) error {
	amount := decimal.NewFromInt(int64(coinCount))

	// Debit user balance.
	if err := c.userCore.DecrementCoinBalance(ctx, userID, amount); err != nil {
		return err
	}

	now := time.Now().UTC()
	log := AccountingLog{
		LogID:       uuid.New(),
		UserID:      userID,
		ActionType:  ActionGameInsert,
		Amount:      amount,
		Currency:    CurrencyCoin,
		ReferenceID: referenceID,
		CreatedAt:   now,
	}

	if err := c.storer.Create(ctx, log); err != nil {
		return fmt.Errorf("creating game insert log: %w", err)
	}

	return nil
}

// ProcessGameReward handles a game reward event (coins pushed off edge).
// Credits the user's coin balance and creates a ledger entry.
func (c *Core) ProcessGameReward(ctx context.Context, userID uuid.UUID, coinCount int, referenceID string) error {
	amount := decimal.NewFromInt(int64(coinCount))

	if err := c.userCore.IncrementCoinBalance(ctx, userID, amount); err != nil {
		return err
	}

	now := time.Now().UTC()
	log := AccountingLog{
		LogID:       uuid.New(),
		UserID:      userID,
		ActionType:  ActionGameReward,
		Amount:      amount,
		Currency:    CurrencyCoin,
		ReferenceID: referenceID,
		CreatedAt:   now,
	}

	if err := c.storer.Create(ctx, log); err != nil {
		return fmt.Errorf("creating game reward log: %w", err)
	}

	return nil
}
