// Package userdb provides PostgreSQL storage for the account domain.
package userdb

import (
	"context"
	"database/sql"
	"errors"
	"fmt"

	"github.com/google/uuid"
	"github.com/shopspring/decimal"

	"github.com/flamefalcon/coin-pusher/backend/business/core/user"
	v1 "github.com/flamefalcon/coin-pusher/backend/business/web/v1"
	"github.com/flamefalcon/coin-pusher/backend/foundation/database"
)

// Store manages the PostgreSQL interactions for accounts.
type Store struct {
	db database.DBTX
}

// NewStore constructs a Store for account database operations.
func NewStore(db database.DBTX) *Store {
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

// SetRole updates the role of an account.
func (s *Store) SetRole(ctx context.Context, accountID uuid.UUID, role string) error {
	const q = `UPDATE accounts SET role = $2, updated_at = NOW() WHERE account_id = $1`

	result, err := s.db.ExecContext(ctx, q, accountID, role)
	if err != nil {
		return fmt.Errorf("updating role: %w", err)
	}

	rows, err := result.RowsAffected()
	if err != nil {
		return fmt.Errorf("checking rows affected: %w", err)
	}

	if rows == 0 {
		return v1.NewRequestError(v1.ErrNotFound, 404)
	}

	return nil
}

// UpdateBalance atomically updates an account's balance using a single
// UPDATE ... RETURNING statement. Returns the updated balance_play value.
// On insufficient funds (negative result), returns ErrInsufficientFund.
func (s *Store) UpdateBalance(ctx context.Context, accountID uuid.UUID, currency string, delta decimal.Decimal) (decimal.Decimal, error) {
	var q string
	switch currency {
	case "USDC":
		q = `UPDATE accounts SET balance_usdc = balance_usdc + $2, updated_at = NOW()
			WHERE account_id = $1 AND balance_usdc + $2 >= 0
			RETURNING balance_play`
	case "PLAY":
		q = `UPDATE accounts SET balance_play = balance_play + $2, updated_at = NOW()
			WHERE account_id = $1 AND balance_play + $2 >= 0
			RETURNING balance_play`
	case "CASH":
		q = `UPDATE accounts SET balance_cash = balance_cash + $2, updated_at = NOW()
			WHERE account_id = $1 AND balance_cash + $2 >= 0
			RETURNING balance_play`
	default:
		return decimal.Zero, fmt.Errorf("unknown currency: %s", currency)
	}

	var balPlay decimal.Decimal
	err := s.db.QueryRowContext(ctx, q, accountID, delta).Scan(&balPlay)
	if err == nil {
		return balPlay, nil
	}

	if !errors.Is(err, sql.ErrNoRows) {
		return decimal.Zero, fmt.Errorf("updating balance: %w", err)
	}

	// No rows returned: either account doesn't exist or insufficient funds.
	const existsQ = `SELECT EXISTS(SELECT 1 FROM accounts WHERE account_id = $1)`
	var exists bool
	if err := s.db.QueryRowContext(ctx, existsQ, accountID).Scan(&exists); err != nil {
		return decimal.Zero, fmt.Errorf("checking account existence: %w", err)
	}

	if !exists {
		return decimal.Zero, v1.NewRequestError(v1.ErrNotFound, 404)
	}

	return decimal.Zero, v1.NewRequestError(v1.ErrInsufficientFund, 402)
}
