// Package inventorydb provides PostgreSQL storage for the inventory domain.
package inventorydb

import (
	"context"
	"database/sql"
	"errors"
	"fmt"

	"github.com/google/uuid"

	"github.com/flamefalcon/coin-pusher/backend/business/core/inventory"
	v1 "github.com/flamefalcon/coin-pusher/backend/business/web/v1"
	"github.com/flamefalcon/coin-pusher/backend/foundation/database"
)

// Store manages the PostgreSQL interactions for inventory.
type Store struct {
	db database.DBTX
}

// NewStore constructs a Store for inventory database operations.
func NewStore(db database.DBTX) *Store {
	return &Store{db: db}
}

// EnsureInventory creates an inventory row if it doesn't exist.
// If devDefaults is non-nil, the row is seeded with those values.
func (s *Store) EnsureInventory(ctx context.Context, accountID uuid.UUID, devDefaults *inventory.DevDefaults) error {
	if devDefaults != nil {
		const q = `INSERT INTO inventory (account_id, key_coins, scroll_shock, scroll_tornado, scroll_explosion, scroll_lightning, scroll_super_push, megaspeaker)
			VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT DO NOTHING`
		if _, err := s.db.ExecContext(ctx, q, accountID,
			devDefaults.KeyCoins, devDefaults.ScrollShock, devDefaults.ScrollTornado,
			devDefaults.ScrollExplosion, devDefaults.ScrollLightning, devDefaults.ScrollSuperPush,
			devDefaults.Megaspeaker,
		); err != nil {
			return fmt.Errorf("ensuring inventory row (dev): %w", err)
		}
		return nil
	}

	const q = `INSERT INTO inventory (account_id) VALUES ($1) ON CONFLICT DO NOTHING`
	if _, err := s.db.ExecContext(ctx, q, accountID); err != nil {
		return fmt.Errorf("ensuring inventory row: %w", err)
	}
	return nil
}

// CreditKeyCoins increments key_coins for an account.
func (s *Store) CreditKeyCoins(ctx context.Context, accountID uuid.UUID, count int) error {
	const q = `UPDATE inventory SET key_coins = key_coins + $2, updated_at = NOW() WHERE account_id = $1`

	res, err := s.db.ExecContext(ctx, q, accountID, count)
	if err != nil {
		return fmt.Errorf("crediting key coins: %w", err)
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		return v1.NewRequestError(v1.ErrNotFound, 404)
	}
	return nil
}

// GetInventory retrieves the inventory for an account.
func (s *Store) GetInventory(ctx context.Context, accountID uuid.UUID) (inventory.Inventory, error) {
	const q = `SELECT * FROM inventory WHERE account_id = $1`

	var inv inventory.Inventory
	if err := s.db.GetContext(ctx, &inv, q, accountID); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return inventory.Inventory{}, v1.NewRequestError(v1.ErrNotFound, 404)
		}
		return inventory.Inventory{}, fmt.Errorf("selecting inventory: %w", err)
	}
	return inv, nil
}

// DecrementKeyCoins decrements key_coins by count. Fails if insufficient.
func (s *Store) DecrementKeyCoins(ctx context.Context, accountID uuid.UUID, count int) error {
	const q = `UPDATE inventory SET key_coins = key_coins - $2, updated_at = NOW()
		WHERE account_id = $1 AND key_coins >= $2`

	res, err := s.db.ExecContext(ctx, q, accountID, count)
	if err != nil {
		return fmt.Errorf("decrementing key coins: %w", err)
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		return v1.NewRequestError(fmt.Errorf("not enough key coins (need %d)", count), 400)
	}
	return nil
}

// scrollColumn returns the column name for a scroll type.
func scrollColumn(scrollType string) (string, error) {
	switch scrollType {
	case inventory.ScrollShock:
		return "scroll_shock", nil
	case inventory.ScrollTornado:
		return "scroll_tornado", nil
	case inventory.ScrollExplosion:
		return "scroll_explosion", nil
	case inventory.ScrollLightning:
		return "scroll_lightning", nil
	case inventory.ScrollSuperPush:
		return "scroll_super_push", nil
	default:
		return "", fmt.Errorf("unknown scroll type: %s", scrollType)
	}
}

// IncrementScroll increments the scroll column by 1.
func (s *Store) IncrementScroll(ctx context.Context, accountID uuid.UUID, scrollType string) error {
	col, err := scrollColumn(scrollType)
	if err != nil {
		return err
	}

	q := fmt.Sprintf(`UPDATE inventory SET %s = %s + 1, updated_at = NOW() WHERE account_id = $1`, col, col)

	if _, err := s.db.ExecContext(ctx, q, accountID); err != nil {
		return fmt.Errorf("incrementing scroll %s: %w", scrollType, err)
	}
	return nil
}

// DecrementScroll decrements the scroll column by 1. Fails if count is 0.
func (s *Store) DecrementScroll(ctx context.Context, accountID uuid.UUID, scrollType string) error {
	col, err := scrollColumn(scrollType)
	if err != nil {
		return err
	}

	q := fmt.Sprintf(`UPDATE inventory SET %s = %s - 1, updated_at = NOW() WHERE account_id = $1 AND %s > 0`, col, col, col)

	res, err := s.db.ExecContext(ctx, q, accountID)
	if err != nil {
		return fmt.Errorf("decrementing scroll %s: %w", scrollType, err)
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		return v1.NewRequestError(fmt.Errorf("no %s scroll available", scrollType), 400)
	}
	return nil
}

// IncrementMegaspeaker increments megaspeaker count by 1.
func (s *Store) IncrementMegaspeaker(ctx context.Context, accountID uuid.UUID) error {
	const q = `UPDATE inventory SET megaspeaker = megaspeaker + 1, updated_at = NOW() WHERE account_id = $1`

	if _, err := s.db.ExecContext(ctx, q, accountID); err != nil {
		return fmt.Errorf("incrementing megaspeaker: %w", err)
	}
	return nil
}

// DecrementMegaspeaker decrements megaspeaker count by 1. Fails if count is 0.
func (s *Store) DecrementMegaspeaker(ctx context.Context, accountID uuid.UUID) error {
	const q = `UPDATE inventory SET megaspeaker = megaspeaker - 1, updated_at = NOW() WHERE account_id = $1 AND megaspeaker > 0`

	res, err := s.db.ExecContext(ctx, q, accountID)
	if err != nil {
		return fmt.Errorf("decrementing megaspeaker: %w", err)
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		return v1.NewRequestError(fmt.Errorf("no megaspeaker charges available"), 400)
	}
	return nil
}

// CreditPlayBalance atomically adds play coins to the account's balance_play
// within the current transaction. Returns the new balance as a string.
func (s *Store) CreditPlayBalance(ctx context.Context, accountID uuid.UUID, amount int) (string, error) {
	const q = `UPDATE accounts SET balance_play = balance_play + $2, updated_at = NOW()
		WHERE account_id = $1
		RETURNING balance_play`

	var newBalance string
	if err := s.db.QueryRowContext(ctx, q, accountID, amount).Scan(&newBalance); err != nil {
		return "", fmt.Errorf("crediting play balance: %w", err)
	}
	return newBalance, nil
}

// CreateChestOpen inserts a chest open log entry.
func (s *Store) CreateChestOpen(ctx context.Context, co inventory.ChestOpen) error {
	const q = `INSERT INTO chest_opens (open_id, account_id, scroll_type, scroll_count, created_at)
		VALUES ($1, $2, $3, $4, $5)`

	if _, err := s.db.ExecContext(ctx, q, co.OpenID, co.AccountID, co.ScrollType, co.ScrollCount, co.CreatedAt); err != nil {
		return fmt.Errorf("inserting chest open: %w", err)
	}
	return nil
}
