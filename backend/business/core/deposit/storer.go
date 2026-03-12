package deposit

import (
	"context"

	"github.com/google/uuid"
	"github.com/shopspring/decimal"
)

// Storer interface declares the core database operations for deposits/withdrawals.
type Storer interface {
	// Deposit address operations.
	QueryAddressByAccount(ctx context.Context, accountID uuid.UUID, chain string) (DepositAddress, error)
	QueryAddressByAddress(ctx context.Context, chain, address string) (DepositAddress, error)
	QueryAllAddresses(ctx context.Context, chain string) ([]DepositAddress, error)
	CreateAddress(ctx context.Context, addr DepositAddress) error
	NextDerivationIndex(ctx context.Context, chain string) (int, error)
	AcquireAdvisoryLock(ctx context.Context, key int64) error

	// Deposit operations.
	CreateDeposit(ctx context.Context, dep Deposit) error
	QueryDepositByTxHash(ctx context.Context, txHash string) (Deposit, error)
	QueryDepositsByAccount(ctx context.Context, accountID uuid.UUID) ([]Deposit, error)

	// Withdrawal operations.
	CreateWithdrawRequest(ctx context.Context, wr WithdrawRequest) error
	QueryWithdrawRequestsByAccount(ctx context.Context, accountID uuid.UUID) ([]WithdrawRequest, error)
	UpdateWithdrawRequestStatus(ctx context.Context, requestID uuid.UUID, status string, txHash, errorMsg *string) error
	QueryDailyWithdrawTotal(ctx context.Context, accountID uuid.UUID) (decimal.Decimal, error)
	QueryWithdrawRequestsByStatus(ctx context.Context, statuses []string, limit int) ([]WithdrawRequest, error)
	QueryWithdrawRequestForUpdate(ctx context.Context, requestID uuid.UUID) (WithdrawRequest, error)
	ClaimApprovedWithdrawals(ctx context.Context, limit int) ([]WithdrawRequest, error)
	HasActiveSweep(ctx context.Context, depositAddressID uuid.UUID) (bool, error)

	// Sweep operations.
	CreateSweep(ctx context.Context, s Sweep) error
	UpdateSweepStatus(ctx context.Context, sweepID uuid.UUID, status string, sweepTxHash *string, gasFundTxHash *string, errorMsg *string) error
	QuerySweepsByStatus(ctx context.Context, statuses []string, limit int) ([]Sweep, error)

	// Counting operations (metrics).
	CountApprovedWithdrawals(ctx context.Context) (int, error)
	CountActiveSweeps(ctx context.Context) (int, error)
	CountDepositAddresses(ctx context.Context, chain string) (int, error)
}
