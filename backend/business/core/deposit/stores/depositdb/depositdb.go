// Package depositdb provides PostgreSQL storage for the deposit domain.
package depositdb

import (
	"context"
	"database/sql"
	"errors"
	"fmt"

	"github.com/google/uuid"
	"github.com/lib/pq"
	"github.com/shopspring/decimal"

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
// Automatically sets submitted_at when status becomes 'submitted'
// and confirmed_at when status becomes 'confirmed'.
func (s *Store) UpdateWithdrawRequestStatus(ctx context.Context, requestID uuid.UUID, status string, txHash, errorMsg *string) error {
	const q = `
		UPDATE withdraw_requests
		SET status = $2,
		    tx_hash = COALESCE($3, tx_hash),
		    error_msg = COALESCE($4, error_msg),
		    submitted_at = CASE WHEN $2 = 'submitted' AND submitted_at IS NULL THEN NOW() ELSE submitted_at END,
		    confirmed_at = CASE WHEN $2 = 'confirmed' AND confirmed_at IS NULL THEN NOW() ELSE confirmed_at END
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

// QueryDailyWithdrawTotal returns the sum of gross USDC (amount_usdc + fee_usdc)
// for non-rejected withdrawal requests created in the last 24 hours.
func (s *Store) QueryDailyWithdrawTotal(ctx context.Context, accountID uuid.UUID) (decimal.Decimal, error) {
	const q = `
		SELECT COALESCE(SUM(amount_usdc + fee_usdc), 0)
		FROM withdraw_requests
		WHERE account_id = $1
		  AND status NOT IN ('rejected', 'failed', 'refunded')
		  AND created_at > NOW() - INTERVAL '24 hours'`

	var total decimal.Decimal
	if err := s.db.QueryRowContext(ctx, q, accountID).Scan(&total); err != nil {
		return decimal.Zero, fmt.Errorf("querying daily withdraw total: %w", err)
	}

	return total, nil
}

// QueryWithdrawRequestsByStatus retrieves withdrawal requests by status list, oldest first.
func (s *Store) QueryWithdrawRequestsByStatus(ctx context.Context, statuses []string, limit int) ([]deposit.WithdrawRequest, error) {
	// Build IN clause manually since sqlx doesn't support slice args easily with DBTX.
	if len(statuses) == 0 {
		return nil, nil
	}

	q := `SELECT * FROM withdraw_requests WHERE status IN (`
	args := make([]any, 0, len(statuses)+1)
	for i, s := range statuses {
		if i > 0 {
			q += ","
		}
		q += fmt.Sprintf("$%d", i+1)
		args = append(args, s)
	}
	q += fmt.Sprintf(") ORDER BY created_at ASC LIMIT $%d", len(statuses)+1)
	args = append(args, limit)

	var wrs []deposit.WithdrawRequest
	if err := s.db.SelectContext(ctx, &wrs, q, args...); err != nil {
		return nil, fmt.Errorf("selecting withdraw requests by status: %w", err)
	}

	return wrs, nil
}

// QueryWithdrawRequestForUpdate retrieves a single withdraw request with FOR UPDATE lock.
func (s *Store) QueryWithdrawRequestForUpdate(ctx context.Context, requestID uuid.UUID) (deposit.WithdrawRequest, error) {
	const q = `SELECT * FROM withdraw_requests WHERE request_id = $1 FOR UPDATE`

	var wr deposit.WithdrawRequest
	if err := s.db.GetContext(ctx, &wr, q, requestID); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return deposit.WithdrawRequest{}, v1.NewRequestError(v1.ErrNotFound, 404)
		}
		return deposit.WithdrawRequest{}, fmt.Errorf("selecting withdraw request for update[%s]: %w", requestID, err)
	}

	return wr, nil
}

// ClaimApprovedWithdrawals atomically transitions approved withdrawals to
// 'submitted' status and returns them. Uses FOR UPDATE SKIP LOCKED to prevent
// concurrent executor instances from claiming the same rows.
func (s *Store) ClaimApprovedWithdrawals(ctx context.Context, limit int) ([]deposit.WithdrawRequest, error) {
	const q = `
		UPDATE withdraw_requests
		SET status = 'submitted',
		    submitted_at = CASE WHEN submitted_at IS NULL THEN NOW() ELSE submitted_at END
		WHERE request_id IN (
			SELECT request_id FROM withdraw_requests
			WHERE status = 'approved'
			ORDER BY created_at ASC
			LIMIT $1
			FOR UPDATE SKIP LOCKED
		)
		RETURNING *`

	var wrs []deposit.WithdrawRequest
	if err := s.db.SelectContext(ctx, &wrs, q, limit); err != nil {
		return nil, fmt.Errorf("claiming approved withdrawals: %w", err)
	}

	return wrs, nil
}

// HasActiveSweep returns true if there is already a sweep in progress
// (pending, gas_funded, or submitted) for the given deposit address.
func (s *Store) HasActiveSweep(ctx context.Context, depositAddressID uuid.UUID) (bool, error) {
	const q = `
		SELECT EXISTS(
			SELECT 1 FROM sweeps
			WHERE deposit_address_id = $1
			  AND status IN ('pending', 'gas_funded', 'submitted')
		)`

	var exists bool
	if err := s.db.QueryRowContext(ctx, q, depositAddressID).Scan(&exists); err != nil {
		return false, fmt.Errorf("checking active sweep: %w", err)
	}

	return exists, nil
}

// =========================================================================
// Sweeps
// =========================================================================

// CreateSweep inserts a new sweep record.
func (s *Store) CreateSweep(ctx context.Context, sw deposit.Sweep) error {
	const q = `
		INSERT INTO sweeps (sweep_id, deposit_address_id, account_id, chain, from_address, to_address, amount_usdc, gas_fund_tx_hash, sweep_tx_hash, status, created_at)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`

	if _, err := s.db.ExecContext(ctx, q,
		sw.SweepID, sw.DepositAddressID, sw.AccountID, sw.Chain,
		sw.FromAddress, sw.ToAddress, sw.AmountUSDC,
		sw.GasFundTxHash, sw.SweepTxHash, sw.Status, sw.CreatedAt,
	); err != nil {
		return fmt.Errorf("inserting sweep: %w", err)
	}

	return nil
}

// UpdateSweepStatus updates the status of a sweep record.
func (s *Store) UpdateSweepStatus(ctx context.Context, sweepID uuid.UUID, status string, sweepTxHash *string, gasFundTxHash *string, errorMsg *string) error {
	const q = `
		UPDATE sweeps
		SET status = $2,
		    sweep_tx_hash = COALESCE($3, sweep_tx_hash),
		    gas_fund_tx_hash = COALESCE($4, gas_fund_tx_hash),
		    error_msg = COALESCE($5, error_msg),
		    confirmed_at = CASE WHEN $2 = 'confirmed' AND confirmed_at IS NULL THEN NOW() ELSE confirmed_at END
		WHERE sweep_id = $1`

	result, err := s.db.ExecContext(ctx, q, sweepID, status, sweepTxHash, gasFundTxHash, errorMsg)
	if err != nil {
		return fmt.Errorf("updating sweep status: %w", err)
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

// QuerySweepsByStatus returns sweeps matching any of the given statuses.
func (s *Store) QuerySweepsByStatus(ctx context.Context, statuses []string, limit int) ([]deposit.Sweep, error) {
	q := `SELECT * FROM sweeps WHERE status = ANY($1) ORDER BY created_at ASC LIMIT $2`

	var sweeps []deposit.Sweep
	if err := s.db.SelectContext(ctx, &sweeps, q, pq.Array(statuses), limit); err != nil {
		return nil, fmt.Errorf("querying sweeps by status: %w", err)
	}

	return sweeps, nil
}

// =========================================================================
// Counting (metrics)
// =========================================================================

// CountApprovedWithdrawals returns the number of approved (queued) withdrawal requests.
func (s *Store) CountApprovedWithdrawals(ctx context.Context) (int, error) {
	const q = `SELECT count(*) FROM withdraw_requests WHERE status = 'approved'`

	var count int
	if err := s.db.QueryRowContext(ctx, q).Scan(&count); err != nil {
		return 0, fmt.Errorf("counting approved withdrawals: %w", err)
	}

	return count, nil
}

// CountActiveSweeps returns the number of sweeps in non-terminal statuses.
func (s *Store) CountActiveSweeps(ctx context.Context) (int, error) {
	const q = `SELECT count(*) FROM sweeps WHERE status NOT IN ('confirmed', 'failed')`

	var count int
	if err := s.db.QueryRowContext(ctx, q).Scan(&count); err != nil {
		return 0, fmt.Errorf("counting active sweeps: %w", err)
	}

	return count, nil
}

// CountDepositAddresses returns the total number of deposit addresses for a chain.
func (s *Store) CountDepositAddresses(ctx context.Context, chain string) (int, error) {
	const q = `SELECT count(*) FROM deposit_addresses WHERE chain = $1`

	var count int
	if err := s.db.QueryRowContext(ctx, q, chain).Scan(&count); err != nil {
		return 0, fmt.Errorf("counting deposit addresses: %w", err)
	}

	return count, nil
}
