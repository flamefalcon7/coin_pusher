// Package userdb provides PostgreSQL storage for the account domain.
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

// Store manages the PostgreSQL interactions for accounts.
type Store struct {
	db *sqlx.DB
}

// NewStore constructs a Store for account database operations.
func NewStore(db *sqlx.DB) *Store {
	return &Store{db: db}
}

// Create inserts a new account into the database.
func (s *Store) Create(ctx context.Context, acct user.Account) error {
	const q = `
		INSERT INTO accounts (account_id, display_name, balance_usdc, balance_play, balance_cash, created_at, updated_at)
		VALUES ($1, $2, $3, $4, $5, $6, $7)`

	if _, err := s.db.ExecContext(ctx, q,
		acct.ID, acct.DisplayName,
		acct.BalanceUSDC, acct.BalancePlay, acct.BalanceCash,
		acct.CreatedAt, acct.UpdatedAt,
	); err != nil {
		return fmt.Errorf("inserting account: %w", err)
	}

	return nil
}

// CreateAuthProvider inserts a new auth provider linked to an account.
func (s *Store) CreateAuthProvider(ctx context.Context, ap user.AuthProvider) error {
	const q = `
		INSERT INTO auth_providers (provider_id, account_id, provider_type, provider_uid, metadata_json, created_at)
		VALUES ($1, $2, $3, $4, $5, $6)`

	if _, err := s.db.ExecContext(ctx, q,
		ap.ProviderID, ap.AccountID, ap.ProviderType, ap.ProviderUID,
		ap.MetadataJSON, ap.CreatedAt,
	); err != nil {
		return fmt.Errorf("inserting auth provider: %w", err)
	}

	return nil
}

// QueryByID retrieves an account by its ID.
func (s *Store) QueryByID(ctx context.Context, accountID uuid.UUID) (user.Account, error) {
	const q = `SELECT * FROM accounts WHERE account_id = $1`

	var acct user.Account
	if err := s.db.GetContext(ctx, &acct, q, accountID); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return user.Account{}, v1.NewRequestError(v1.ErrNotFound, 404)
		}
		return user.Account{}, fmt.Errorf("selecting account by id[%s]: %w", accountID, err)
	}

	return acct, nil
}

// QueryByProvider retrieves an account by its auth provider type and UID.
func (s *Store) QueryByProvider(ctx context.Context, providerType, providerUID string) (user.Account, error) {
	const q = `
		SELECT a.* FROM accounts a
		JOIN auth_providers ap ON a.account_id = ap.account_id
		WHERE ap.provider_type = $1 AND ap.provider_uid = $2`

	var acct user.Account
	if err := s.db.GetContext(ctx, &acct, q, providerType, providerUID); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return user.Account{}, v1.NewRequestError(v1.ErrNotFound, 404)
		}
		return user.Account{}, fmt.Errorf("selecting account by provider[%s:%s]: %w", providerType, providerUID, err)
	}

	return acct, nil
}

// UpdateBalance atomically updates an account's balance using SELECT FOR UPDATE.
func (s *Store) UpdateBalance(ctx context.Context, accountID uuid.UUID, currency string, delta decimal.Decimal) error {
	tx, err := s.db.BeginTxx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin tx: %w", err)
	}
	defer tx.Rollback()

	// Lock the row.
	const lockQ = `SELECT balance_usdc, balance_play, balance_cash FROM accounts WHERE account_id = $1 FOR UPDATE`
	var balUSDC, balPlay, balCash decimal.Decimal
	if err := tx.QueryRowContext(ctx, lockQ, accountID).Scan(&balUSDC, &balPlay, &balCash); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return v1.NewRequestError(v1.ErrNotFound, 404)
		}
		return fmt.Errorf("lock account row: %w", err)
	}

	// Check for negative result.
	switch currency {
	case "USDC":
		if balUSDC.Add(delta).IsNegative() {
			return v1.NewRequestError(v1.ErrInsufficientFund, 402)
		}
	case "PLAY":
		if balPlay.Add(delta).IsNegative() {
			return v1.NewRequestError(v1.ErrInsufficientFund, 402)
		}
	case "CASH":
		if balCash.Add(delta).IsNegative() {
			return v1.NewRequestError(v1.ErrInsufficientFund, 402)
		}
	default:
		return fmt.Errorf("unknown currency: %s", currency)
	}

	// Apply update.
	var updateQ string
	switch currency {
	case "USDC":
		updateQ = `UPDATE accounts SET balance_usdc = balance_usdc + $2, updated_at = NOW() WHERE account_id = $1`
	case "PLAY":
		updateQ = `UPDATE accounts SET balance_play = balance_play + $2, updated_at = NOW() WHERE account_id = $1`
	case "CASH":
		updateQ = `UPDATE accounts SET balance_cash = balance_cash + $2, updated_at = NOW() WHERE account_id = $1`
	}

	if _, err := tx.ExecContext(ctx, updateQ, accountID, delta); err != nil {
		return fmt.Errorf("updating balance: %w", err)
	}

	return tx.Commit()
}
