package game

import (
	"context"
	"fmt"

	"github.com/google/uuid"

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

	if err := c.acctCore.ProcessGameInsert(ctx, evt.UserID, count, evt.IdempotencyKey); err != nil {
		return GameEventResult{Success: false, Error: err.Error()}, nil
	}

	usr, err := c.userCore.QueryByID(ctx, evt.UserID)
	if err != nil {
		return GameEventResult{Success: false, Error: err.Error()}, nil
	}

	return GameEventResult{
		Success:     true,
		BalanceCoin: usr.BalanceCoin.String(),
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
	if err := c.acctCore.ProcessGameInsert(ctx, evt.UserID, cost, refKey); err != nil {
		return GameEventResult{Success: false, Error: err.Error()}, nil
	}

	usr, err := c.userCore.QueryByID(ctx, evt.UserID)
	if err != nil {
		return GameEventResult{Success: false, Error: err.Error()}, nil
	}

	return GameEventResult{
		Success:     true,
		BalanceCoin: usr.BalanceCoin.String(),
	}, nil
}

// ProcessBatchInsert debits the user's balance for a batch coin insert.
// Returns the result including the updated balance.
func (c *Core) ProcessBatchInsert(ctx context.Context, userID uuid.UUID, coinCount int, referenceID string) (GameEventResult, error) {
	if coinCount <= 0 {
		return GameEventResult{Success: false, Error: "coin count must be positive"}, nil
	}

	if err := c.acctCore.ProcessGameInsert(ctx, userID, coinCount, referenceID); err != nil {
		return GameEventResult{Success: false, Error: err.Error()}, nil
	}

	usr, err := c.userCore.QueryByID(ctx, userID)
	if err != nil {
		return GameEventResult{Success: false, Error: err.Error()}, nil
	}

	return GameEventResult{
		Success:     true,
		BalanceCoin: usr.BalanceCoin.String(),
	}, nil
}
