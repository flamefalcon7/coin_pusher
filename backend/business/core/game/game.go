package game

import (
	"context"
	"fmt"

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
	case EventReward:
		return c.processReward(ctx, evt)
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

func (c *Core) processReward(ctx context.Context, evt GameEvent) (GameEventResult, error) {
	count := evt.CoinCount
	if count <= 0 {
		count = 1
	}

	if err := c.acctCore.ProcessGameReward(ctx, evt.UserID, count, evt.IdempotencyKey); err != nil {
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
