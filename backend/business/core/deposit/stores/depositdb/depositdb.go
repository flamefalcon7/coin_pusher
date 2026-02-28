// Package depositdb provides PostgreSQL storage for the deposit domain.
package depositdb

import (
	"context"
	"database/sql"
	"errors"
	"fmt"

	"github.com/google/uuid"

	"github.com/flamefalcon/coin-pusher/backend/business/core/deposit"
	v1 "github.com/flamefalcon/coin-pusher/backend/business/web/v1"
	"github.com/flamefalcon/coin-pusher/backend/foundation/database"
)

// Store manages the PostgreSQL interactions for deposits.
type Store struct {
	db database.DBTX
}

// NewStore constructs a Store for deposit database operations.
func NewStore(db database.DBTX) *Store {
	return &Store{db: db}
}

// =========================================================================
// Deposit Addresses
// =========================================================================

// QueryAddressByAccount retrieves a deposit address by account ID and chain.
func (s *Store) QueryAddressByAccount(ctx context.Context, accountID uuid.UUID, chain string) (deposit.DepositAddress, error) {
	const q = `SELECT * FROM deposit_addresses WHERE account_id = $1 AND chain = $2`

	var addr deposit.DepositAddress
	if err := s.db.GetContext(ctx, &addr, q, accountID, chain); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return deposit.DepositAddress{}, v1.NewRequestError(v1.ErrNotFound, 404)
		}
		return deposit.DepositAddress{}, fmt.Errorf("selecting deposit address by account[%s]: %w", accountID, err)
	}

	return addr, nil
}

// QueryAddressByAddress retrieves a deposit address by chain and address.
func (s *Store) QueryAddressByAddress(ctx context.Context, chain, address string) (deposit.DepositAddress, error) {
	const q = `SELECT * FROM deposit_addresses WHERE chain = $1 AND address = $2`

	var addr deposit.DepositAddress
	if err := s.db.GetContext(ctx, &addr, q, chain, address); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return deposit.DepositAddress{}, v1.NewRequestError(v1.ErrNotFound, 404)
		}
		return deposit.DepositAddress{}, fmt.Errorf("selecting deposit address by address[%s]: %w", address, err)
	}

	return addr, nil
}

// QueryAllAddresses retrieves all deposit addresses for a chain.
func (s *Store) QueryAllAddresses(ctx context.Context, chain string) ([]deposit.DepositAddress, error) {
	const q = `SELECT * FROM deposit_addresses WHERE chain = $1 ORDER BY derivation_index`

	var addrs []deposit.DepositAddress
	if err := s.db.SelectContext(ctx, &addrs, q, chain); err != nil {
		return nil, fmt.Errorf("selecting all deposit addresses: %w", err)
	}

	return addrs, nil
}

// CreateAddress inserts a new deposit address.
func (s *Store) CreateAddress(ctx context.Context, addr deposit.DepositAddress) error {
	const q = `
		INSERT INTO deposit_addresses (address_id, account_id, chain, address, derivation_index, created_at)
		VALUES ($1, $2, $3, $4, $5, $6)`

	if _, err := s.db.ExecContext(ctx, q,
		addr.AddressID, addr.AccountID, addr.Chain,
		addr.Address, addr.DerivationIndex, addr.CreatedAt,
	); err != nil {
		return fmt.Errorf("inserting deposit address: %w", err)
	}

	return nil
}

// NextDerivationIndex returns the next available derivation index for a chain.
func (s *Store) NextDerivationIndex(ctx context.Context, chain string) (int, error) {
	const q = `SELECT COALESCE(MAX(derivation_index), -1) + 1 FROM deposit_addresses WHERE chain = $1`

	var idx int
	if err := s.db.QueryRowContext(ctx, q, chain).Scan(&idx); err != nil {
		return 0, fmt.Errorf("selecting next derivation index: %w", err)
	}

	return idx, nil
}

// AcquireAdvisoryLock acquires a transaction-scoped advisory lock.
// The lock is automatically released when the transaction commits or rolls back.
func (s *Store) AcquireAdvisoryLock(ctx context.Context, key int64) error {
	const q = `SELECT pg_advisory_xact_lock($1)`

	if _, err := s.db.ExecContext(ctx, q, key); err != nil {
		return fmt.Errorf("acquiring advisory lock: %w", err)
	}

	return nil
}

// =========================================================================
// Deposits
// =========================================================================

// CreateDeposit inserts a new deposit record.
func (s *Store) CreateDeposit(ctx context.Context, dep deposit.Deposit) error {
	const q = `
		INSERT INTO deposits (deposit_id, account_id, chain, amount, tx_hash, block_number, from_address, status, created_at)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`

	if _, err := s.db.ExecContext(ctx, q,
		dep.DepositID, dep.AccountID, dep.Chain, dep.Amount,
		dep.TxHash, dep.BlockNumber, dep.FromAddress,
		dep.Status, dep.CreatedAt,
	); err != nil {
		return fmt.Errorf("inserting deposit: %w", err)
	}

	return nil
}

// QueryDepositByTxHash retrieves a deposit by transaction hash.
func (s *Store) QueryDepositByTxHash(ctx context.Context, txHash string) (deposit.Deposit, error) {
	const q = `SELECT * FROM deposits WHERE tx_hash = $1`

	var dep deposit.Deposit
	if err := s.db.GetContext(ctx, &dep, q, txHash); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return deposit.Deposit{}, v1.NewRequestError(v1.ErrNotFound, 404)
		}
		return deposit.Deposit{}, fmt.Errorf("selecting deposit by tx_hash[%s]: %w", txHash, err)
	}

	return dep, nil
}

// QueryDepositsByAccount retrieves all deposits for an account.
func (s *Store) QueryDepositsByAccount(ctx context.Context, accountID uuid.UUID) ([]deposit.Deposit, error) {
	const q = `SELECT * FROM deposits WHERE account_id = $1 ORDER BY created_at DESC`

	var deps []deposit.Deposit
	if err := s.db.SelectContext(ctx, &deps, q, accountID); err != nil {
		return nil, fmt.Errorf("selecting deposits by account[%s]: %w", accountID, err)
	}

	return deps, nil
}

// =========================================================================
// Withdrawals
// =========================================================================

// CreateWithdrawRequest inserts a new withdrawal request.
func (s *Store) CreateWithdrawRequest(ctx context.Context, wr deposit.WithdrawRequest) error {
	const q = `
		INSERT INTO withdraw_requests (request_id, account_id, amount_cash, amount_usdc, fee_usdc, chain, to_address, status, created_at)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`

	if _, err := s.db.ExecContext(ctx, q,
		wr.RequestID, wr.AccountID, wr.AmountCash, wr.AmountUSDC,
		wr.FeeUSDC, wr.Chain, wr.ToAddress, wr.Status, wr.CreatedAt,
	); err != nil {
		return fmt.Errorf("inserting withdraw request: %w", err)
	}

	return nil
}

// QueryWithdrawRequestsByAccount retrieves all withdrawal requests for an account.
func (s *Store) QueryWithdrawRequestsByAccount(ctx context.Context, accountID uuid.UUID) ([]deposit.WithdrawRequest, error) {
	const q = `SELECT * FROM withdraw_requests WHERE account_id = $1 ORDER BY created_at DESC`

	var wrs []deposit.WithdrawRequest
	if err := s.db.SelectContext(ctx, &wrs, q, accountID); err != nil {
		return nil, fmt.Errorf("selecting withdraw requests by account[%s]: %w", accountID, err)
	}

	return wrs, nil
}

// UpdateWithdrawRequestStatus updates the status of a withdrawal request.
func (s *Store) UpdateWithdrawRequestStatus(ctx context.Context, requestID uuid.UUID, status string, txHash, errorMsg *string) error {
	const q = `
		UPDATE withdraw_requests
		SET status = $2, tx_hash = COALESCE($3, tx_hash), error_msg = COALESCE($4, error_msg)
		WHERE request_id = $1`

	result, err := s.db.ExecContext(ctx, q, requestID, status, txHash, errorMsg)
	if err != nil {
		return fmt.Errorf("updating withdraw request status: %w", err)
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
