// Package userdb provides PostgreSQL storage for the user domain.
package userdb

import (
	"context"
	"database/sql"
	"errors"
	"fmt"

	"github.com/google/uuid"
	"github.com/jmoiron/sqlx"
	"github.com/shopspring/decimal"

	"github.com/flamefalcon/coin-pusher/backend/business/core/user"
	v1 "github.com/flamefalcon/coin-pusher/backend/business/web/v1"
)

// Store manages the PostgreSQL interactions for users.
type Store struct {
	db *sqlx.DB
}

// NewStore constructs a Store for user database operations.
func NewStore(db *sqlx.DB) *Store {
	return &Store{db: db}
}

// Create inserts a new user into the database.
func (s *Store) Create(ctx context.Context, usr user.User) error {
	const q = `
		INSERT INTO users (user_id, name, sui_address, zklogin_sub, balance_coin, balance_usdc, created_at, updated_at)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`

	if _, err := s.db.ExecContext(ctx, q,
		usr.ID, usr.Name, usr.SUIAddress, usr.ZKLoginSub,
		usr.BalanceCoin, usr.BalanceUSDC, usr.CreatedAt, usr.UpdatedAt,
	); err != nil {
		return fmt.Errorf("inserting user: %w", err)
	}

	return nil
}

// QueryByID retrieves a user by their ID.
func (s *Store) QueryByID(ctx context.Context, userID uuid.UUID) (user.User, error) {
	const q = `SELECT * FROM users WHERE user_id = $1`

	var usr user.User
	if err := s.db.GetContext(ctx, &usr, q, userID); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return user.User{}, v1.NewRequestError(v1.ErrNotFound, 404)
		}
		return user.User{}, fmt.Errorf("selecting user by id[%s]: %w", userID, err)
	}

	return usr, nil
}

// QueryBySUIAddress retrieves a user by their SUI wallet address.
func (s *Store) QueryBySUIAddress(ctx context.Context, suiAddress string) (user.User, error) {
	const q = `SELECT * FROM users WHERE sui_address = $1`

	var usr user.User
	if err := s.db.GetContext(ctx, &usr, q, suiAddress); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return user.User{}, v1.NewRequestError(v1.ErrNotFound, 404)
		}
		return user.User{}, fmt.Errorf("selecting user by sui_address[%s]: %w", suiAddress, err)
	}

	return usr, nil
}

// UpdateBalance atomically updates a user's balance using SELECT FOR UPDATE.
func (s *Store) UpdateBalance(ctx context.Context, userID uuid.UUID, currency string, delta decimal.Decimal) error {
	tx, err := s.db.BeginTxx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin tx: %w", err)
	}
	defer tx.Rollback()

	// Lock the row.
	const lockQ = `SELECT balance_coin, balance_usdc FROM users WHERE user_id = $1 FOR UPDATE`
	var balCoin, balUSDC decimal.Decimal
	if err := tx.QueryRowContext(ctx, lockQ, userID).Scan(&balCoin, &balUSDC); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return v1.NewRequestError(v1.ErrNotFound, 404)
		}
		return fmt.Errorf("lock user row: %w", err)
	}

	// Check for negative result.
	switch currency {
	case "COIN":
		if balCoin.Add(delta).IsNegative() {
			return v1.NewRequestError(v1.ErrInsufficientFund, 402)
		}
	case "USDC":
		if balUSDC.Add(delta).IsNegative() {
			return v1.NewRequestError(v1.ErrInsufficientFund, 402)
		}
	default:
		return fmt.Errorf("unknown currency: %s", currency)
	}

	// Apply update.
	var updateQ string
	switch currency {
	case "COIN":
		updateQ = `UPDATE users SET balance_coin = balance_coin + $2, updated_at = NOW() WHERE user_id = $1`
	case "USDC":
		updateQ = `UPDATE users SET balance_usdc = balance_usdc + $2, updated_at = NOW() WHERE user_id = $1`
	}

	if _, err := tx.ExecContext(ctx, updateQ, userID, delta); err != nil {
		return fmt.Errorf("updating balance: %w", err)
	}

	return tx.Commit()
}
