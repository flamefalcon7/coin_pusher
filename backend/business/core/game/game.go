package game

import (
	"context"
	"fmt"

	"github.com/google/uuid"
	"github.com/shopspring/decimal"

	"github.com/flamefalcon/coin-pusher/backend/business/core/accounting"
	"github.com/flamefalcon/coin-pusher/backend/business/core/user"
)

// Core manages game event processing.
type Core struct {
	userCore *user.Core
	acctCore *accounting.Core
}

// NewCore constructs a game Core.
func NewCore(userCore *user.Core, acctCore *accounting.Core) *Core {
	return &Core{
		userCore: userCore,
		acctCore: acctCore,
	}
}

// ProcessEvent handles a game event from the game server, routing to the
// appropriate handler based on event type.
func (c *Core) ProcessEvent(ctx context.Context, evt GameEvent) (GameEventResult, error) {
	switch evt.Type {
	case EventInsertCoin:
		return c.processInsertCoin(ctx, evt)
	case EventSpawnStack:
		return c.processSpawnStack(ctx, evt)
	default:
		return GameEventResult{}, fmt.Errorf("unknown event type: %s", evt.Type)
	}
}

func (c *Core) processInsertCoin(ctx context.Context, evt GameEvent) (GameEventResult, error) {
	count := evt.CoinCount
	if count <= 0 {
		count = 1
	}

	playDeb, cashDeb, newPlay, newCash, err := c.acctCore.ProcessGameInsert(ctx, evt.UserID, count, evt.IdempotencyKey)
	if err != nil {
		return GameEventResult{Success: false, Error: err.Error()}, nil
	}

	return GameEventResult{
		Success:     true,
		BalancePlay: newPlay.String(),
		BalanceCash: newCash.String(),
		PlayDebited: playDeb.String(),
		CashDebited: cashDeb.String(),
	}, nil
}

func (c *Core) processSpawnStack(ctx context.Context, evt GameEvent) (GameEventResult, error) {
	cost, ok := StackCoinCosts[evt.StackType]
	if !ok {
		return GameEventResult{
			Success: false,
			Error:   fmt.Sprintf("unknown stack type: %s", evt.StackType),
		}, nil
	}

	refKey := evt.IdempotencyKey
	playDeb, cashDeb, newPlay, newCash, err := c.acctCore.ProcessGameInsert(ctx, evt.UserID, cost, refKey)
	if err != nil {
		return GameEventResult{Success: false, Error: err.Error()}, nil
	}

	return GameEventResult{
		Success:     true,
		BalancePlay: newPlay.String(),
		BalanceCash: newCash.String(),
		PlayDebited: playDeb.String(),
		CashDebited: cashDeb.String(),
	}, nil
}

// ProcessBatchInsert debits the account's balance for a batch coin insert
// using a play-first, cash-second priority. The returned result carries both
// new balances plus the split actually debited — the caller must retain the
// split if it may later need to refund (e.g., downstream publish failures).
func (c *Core) ProcessBatchInsert(ctx context.Context, accountID uuid.UUID, coinCount int, referenceID string) (GameEventResult, error) {
	if coinCount <= 0 {
		return GameEventResult{Success: false, Error: "coin count must be positive"}, nil
	}

	playDeb, cashDeb, newPlay, newCash, err := c.acctCore.ProcessGameInsert(ctx, accountID, coinCount, referenceID)
	if err != nil {
		return GameEventResult{Success: false, Error: err.Error()}, nil
	}

	return GameEventResult{
		Success:     true,
		BalancePlay: newPlay.String(),
		BalanceCash: newCash.String(),
		PlayDebited: playDeb.String(),
		CashDebited: cashDeb.String(),
	}, nil
}

// RefundBatchInsert reverses a prior batch insert by crediting each currency
// back by the exact amount originally debited. Caller must pass the split
// retained from the insert's GameEventResult.
func (c *Core) RefundBatchInsert(ctx context.Context, accountID uuid.UUID, playDebited, cashDebited decimal.Decimal, referenceID string) (GameEventResult, error) {
	newPlay, newCash, err := c.acctCore.ProcessGameInsertRefund(ctx, accountID, playDebited, cashDebited, referenceID)
	if err != nil {
		return GameEventResult{Success: false, Error: err.Error()}, nil
	}

	return GameEventResult{
		Success:     true,
		BalancePlay: newPlay.String(),
		BalanceCash: newCash.String(),
	}, nil
}
