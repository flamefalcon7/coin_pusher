package deposit

import (
	"context"

	"github.com/google/uuid"
)

// Storer interface declares the core database operations for deposits/withdrawals.
type Storer interface {
	// Deposit address operations.
	QueryAddressByAccount(ctx context.Context, accountID uuid.UUID, chain string) (DepositAddress, error)
	QueryAddressByAddress(ctx context.Context, chain, address string) (DepositAddress, error)
	QueryAllAddresses(ctx context.Context, chain string) ([]DepositAddress, error)
	CreateAddress(ctx context.Context, addr DepositAddress) error
	NextDerivationIndex(ctx context.Context, chain string) (int, error)

	// Deposit operations.
	CreateDeposit(ctx context.Context, dep Deposit) error
	QueryDepositByTxHash(ctx context.Context, txHash string) (Deposit, error)
	QueryDepositsByAccount(ctx context.Context, accountID uuid.UUID) ([]Deposit, error)

	// Withdrawal operations.
	CreateWithdrawRequest(ctx context.Context, wr WithdrawRequest) error
	QueryWithdrawRequestsByAccount(ctx context.Context, accountID uuid.UUID) ([]WithdrawRequest, error)
	UpdateWithdrawRequestStatus(ctx context.Context, requestID uuid.UUID, status string, txHash, errorMsg *string) error
}
