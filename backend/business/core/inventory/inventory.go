package inventory

import (
	"context"
	"crypto/rand"
	"fmt"
	"math/big"
	"time"

	"github.com/google/uuid"
	"github.com/jmoiron/sqlx"

	v1 "github.com/flamefalcon/coin-pusher/backend/business/web/v1"
	"github.com/flamefalcon/coin-pusher/backend/foundation/database"
)

// StorerFactory builds a Storer bound to the given DBTX (db or tx).
type StorerFactory func(database.DBTX) Storer

// Core manages the set of APIs for inventory access.
type Core struct {
	db          *sqlx.DB
	storer      Storer
	newStorer   StorerFactory
	devDefaults *DevDefaults
}

// NewCore constructs an inventory Core.
func NewCore(db *sqlx.DB, storer Storer, newStorer StorerFactory) *Core {
	return &Core{
		db:        db,
		storer:    storer,
		newStorer: newStorer,
	}
}

// SetDevDefaults sets initial inventory values for dev/test mode.
func (c *Core) SetDevDefaults(d DevDefaults) {
	c.devDefaults = &d
}

// EnsureInventory creates an inventory row for the account if it doesn't exist.
func (c *Core) EnsureInventory(ctx context.Context, accountID uuid.UUID) error {
	if err := c.storer.EnsureInventory(ctx, accountID, c.devDefaults); err != nil {
		return fmt.Errorf("ensure inventory: %w", err)
	}
	return nil
}

// CreditKeyCoins adds key coins to an account's inventory.
func (c *Core) CreditKeyCoins(ctx context.Context, accountID uuid.UUID, count int) error {
	if err := c.storer.EnsureInventory(ctx, accountID, c.devDefaults); err != nil {
		return fmt.Errorf("ensure inventory: %w", err)
	}
	if err := c.storer.CreditKeyCoins(ctx, accountID, count); err != nil {
		return fmt.Errorf("credit key coins: %w", err)
	}
	return nil
}

// GetInventory returns the full inventory for an account.
func (c *Core) GetInventory(ctx context.Context, accountID uuid.UUID) (Inventory, error) {
	if err := c.storer.EnsureInventory(ctx, accountID, c.devDefaults); err != nil {
		return Inventory{}, fmt.Errorf("ensure inventory: %w", err)
	}
	inv, err := c.storer.GetInventory(ctx, accountID)
	if err != nil {
		return Inventory{}, fmt.Errorf("get inventory: %w", err)
	}
	return inv, nil
}

// OpenChestResult contains the result of opening a chest.
type OpenChestResult struct {
	ScrollType  string `json:"scroll_type"`
	ScrollCount int    `json:"scroll_count"`
	BalancePlay string `json:"balance_play,omitempty"`
}

// OpenChest consumes KeyCoinsPerChest key coins and awards a random item.
func (c *Core) OpenChest(ctx context.Context, accountID uuid.UUID) (OpenChestResult, error) {
	scrollType, err := rollScrollType()
	if err != nil {
		return OpenChestResult{}, fmt.Errorf("rolling scroll type: %w", err)
	}

	// For play_coins, determine the coin amount up-front.
	rewardCount := 1
	if scrollType == ItemPlayCoins {
		amt, err := rollPlayCoinsAmount()
		if err != nil {
			return OpenChestResult{}, fmt.Errorf("rolling play coins amount: %w", err)
		}
		rewardCount = amt
	}

	var result OpenChestResult
	txErr := database.ExecTx(ctx, c.db, func(tx *sqlx.Tx) error {
		txStorer := c.newStorer(tx)

		if err := txStorer.EnsureInventory(ctx, accountID, c.devDefaults); err != nil {
			return fmt.Errorf("ensure inventory: %w", err)
		}

		if err := txStorer.DecrementKeyCoins(ctx, accountID, KeyCoinsPerChest); err != nil {
			return err
		}

		var balancePlay string
		switch scrollType {
		case ItemMegaspeaker:
			if err := txStorer.IncrementMegaspeaker(ctx, accountID); err != nil {
				return fmt.Errorf("increment megaspeaker: %w", err)
			}
		case ItemPlayCoins:
			newBal, err := txStorer.CreditPlayBalance(ctx, accountID, rewardCount)
			if err != nil {
				return fmt.Errorf("credit play balance: %w", err)
			}
			balancePlay = newBal
		default:
			if err := txStorer.IncrementScroll(ctx, accountID, scrollType); err != nil {
				return fmt.Errorf("increment scroll: %w", err)
			}
		}

		co := ChestOpen{
			OpenID:      uuid.New(),
			AccountID:   accountID,
			ScrollType:  scrollType,
			ScrollCount: rewardCount,
			CreatedAt:   time.Now().UTC(),
		}
		if err := txStorer.CreateChestOpen(ctx, co); err != nil {
			return fmt.Errorf("create chest open log: %w", err)
		}

		result = OpenChestResult{
			ScrollType:  scrollType,
			ScrollCount: rewardCount,
			BalancePlay: balancePlay,
		}
		return nil
	})

	if txErr != nil {
		return OpenChestResult{}, txErr
	}
	return result, nil
}

// CreditScroll adds 1 scroll of the given type to an account's inventory.
func (c *Core) CreditScroll(ctx context.Context, accountID uuid.UUID, scrollType string) error {
	if !validScrollType(scrollType) {
		return v1.NewRequestError(fmt.Errorf("invalid scroll type: %s", scrollType), 400)
	}
	if err := c.storer.EnsureInventory(ctx, accountID, c.devDefaults); err != nil {
		return fmt.Errorf("ensure inventory: %w", err)
	}
	if err := c.storer.IncrementScroll(ctx, accountID, scrollType); err != nil {
		return fmt.Errorf("credit scroll %s: %w", scrollType, err)
	}
	return nil
}

// ConsumeScroll decrements a specific scroll type. Returns error if none available.
func (c *Core) ConsumeScroll(ctx context.Context, accountID uuid.UUID, scrollType string) error {
	if !validScrollType(scrollType) {
		return v1.NewRequestError(fmt.Errorf("invalid scroll type: %s", scrollType), 400)
	}
	if err := c.storer.DecrementScroll(ctx, accountID, scrollType); err != nil {
		return err
	}
	return nil
}

// ConsumeMegaspeaker decrements 1 megaspeaker charge. Returns error if none available.
func (c *Core) ConsumeMegaspeaker(ctx context.Context, accountID uuid.UUID) error {
	if err := c.storer.DecrementMegaspeaker(ctx, accountID); err != nil {
		return err
	}
	return nil
}

// rollScrollType picks a random scroll type using weighted random selection.
func rollScrollType() (string, error) {
	n, err := rand.Int(rand.Reader, big.NewInt(int64(TotalWeight)))
	if err != nil {
		return "", err
	}
	roll := int(n.Int64())

	cumulative := 0
	for _, sw := range ScrollWeights {
		cumulative += sw.Weight
		if roll < cumulative {
			return sw.Type, nil
		}
	}
	// Should never reach here, but default to last entry.
	return ScrollWeights[len(ScrollWeights)-1].Type, nil
}

// validScrollType returns true for scroll types that map to dedicated inventory
// columns (scroll_shock, scroll_tornado, etc.). Megaspeaker and play_coins are
// NOT scrolls — they have their own increment/credit paths.
func validScrollType(t string) bool {
	switch t {
	case ScrollShock, ScrollTornado, ScrollExplosion, ScrollLightning, ScrollSuperPush:
		return true
	}
	return false
}
