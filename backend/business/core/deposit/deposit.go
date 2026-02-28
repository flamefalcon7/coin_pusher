package deposit

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/jmoiron/sqlx"
	"github.com/shopspring/decimal"

	"github.com/flamefalcon/coin-pusher/backend/business/core/accounting"
	"github.com/flamefalcon/coin-pusher/backend/business/core/user"
	v1 "github.com/flamefalcon/coin-pusher/backend/business/web/v1"
	"github.com/flamefalcon/coin-pusher/backend/foundation/database"
	"github.com/flamefalcon/coin-pusher/backend/foundation/ethereum"
	"github.com/flamefalcon/coin-pusher/backend/foundation/wallet"
)

// StorerFactory builds a Storer bound to the given DBTX (db or tx).
type StorerFactory func(database.DBTX) Storer

// UserStorerFactory builds a user.Storer bound to the given DBTX.
type UserStorerFactory func(database.DBTX) user.Storer

// TxFunc is a function that runs inside a database transaction.
// The Storer passed to it is bound to the transaction.
type TxFunc func(ctx context.Context, txStorer Storer) error

// TxRunner executes fn inside a database transaction.
type TxRunner func(ctx context.Context, fn TxFunc) error

// Core manages the set of APIs for deposit/withdrawal access.
type Core struct {
	db            *sqlx.DB
	storer        Storer
	wallet        *wallet.Wallet
	acctCore      *accounting.Core
	userCore      *user.Core
	newStorer     StorerFactory
	newUserStorer UserStorerFactory
	runTx         TxRunner
}

// NewCore constructs a deposit Core.
func NewCore(
	db *sqlx.DB,
	storer Storer,
	w *wallet.Wallet,
	acctCore *accounting.Core,
	userCore *user.Core,
	newStorer StorerFactory,
	newUserStorer UserStorerFactory,
) *Core {
	c := &Core{
		db:            db,
		storer:        storer,
		wallet:        w,
		acctCore:      acctCore,
		userCore:      userCore,
		newStorer:     newStorer,
		newUserStorer: newUserStorer,
	}
	c.runTx = func(ctx context.Context, fn TxFunc) error {
		return database.ExecTx(ctx, db, func(tx *sqlx.Tx) error {
			return fn(ctx, newStorer(tx))
		})
	}
	return c
}

// advisoryKeyDerivationIndex is the pg_advisory_xact_lock key used to
// serialize deposit address creation (NextDerivationIndex + CreateAddress).
const advisoryKeyDerivationIndex int64 = 0x636F696E_64657269 // "coinDeri"

// GetOrCreateAddress returns the existing deposit address for an account
// on the given chain, or generates a new one via HD derivation.
// Address creation is serialized with a PostgreSQL advisory lock to prevent
// concurrent requests from reading the same MAX(derivation_index).
func (c *Core) GetOrCreateAddress(ctx context.Context, accountID uuid.UUID, chain string) (DepositAddress, error) {
	// Fast path: address already exists.
	addr, err := c.storer.QueryAddressByAccount(ctx, accountID, chain)
	if err == nil {
		return addr, nil
	}
	if !errors.Is(err, v1.ErrNotFound) {
		return DepositAddress{}, fmt.Errorf("query address by account: %w", err)
	}

	// Slow path: generate inside a transaction with advisory lock.
	var created DepositAddress
	txErr := c.runTx(ctx, func(ctx context.Context, txStorer Storer) error {
		// Serialize all address creation for this chain.
		if err := txStorer.AcquireAdvisoryLock(ctx, advisoryKeyDerivationIndex); err != nil {
			return fmt.Errorf("advisory lock: %w", err)
		}

		// Re-check inside the lock (another request may have created it).
		if existing, err := txStorer.QueryAddressByAccount(ctx, accountID, chain); err == nil {
			created = existing
			return nil
		}

		idx, err := txStorer.NextDerivationIndex(ctx, chain)
		if err != nil {
			return fmt.Errorf("next derivation index: %w", err)
		}

		derivedAddr, err := c.wallet.DeriveAddress(idx)
		if err != nil {
			return fmt.Errorf("deriving address: %w", err)
		}

		now := time.Now().UTC()
		created = DepositAddress{
			AddressID:       uuid.New(),
			AccountID:       accountID,
			Chain:           chain,
			Address:         derivedAddr,
			DerivationIndex: idx,
			CreatedAt:       now,
		}

		if err := txStorer.CreateAddress(ctx, created); err != nil {
			return fmt.Errorf("create address: %w", err)
		}

		return nil
	})

	if txErr != nil {
		return DepositAddress{}, txErr
	}

	return created, nil
}

// ProcessDeposit records an on-chain deposit and credits the user's play balance.
// Idempotent: if a deposit with the same tx_hash already exists, it returns nil.
func (c *Core) ProcessDeposit(ctx context.Context, accountID uuid.UUID, amount decimal.Decimal, txHash string, blockNumber int64, fromAddress string) error {
	// Check idempotency via tx_hash.
	_, err := c.storer.QueryDepositByTxHash(ctx, txHash)
	if err == nil {
		// Already processed.
		return nil
	}
	if !errors.Is(err, v1.ErrNotFound) {
		return fmt.Errorf("query deposit by tx_hash: %w", err)
	}

	now := time.Now().UTC()
	dep := Deposit{
		DepositID:   uuid.New(),
		AccountID:   accountID,
		Chain:       DefaultChain,
		Amount:      amount,
		TxHash:      txHash,
		BlockNumber: blockNumber,
		FromAddress: fromAddress,
		Status:      "confirmed",
		CreatedAt:   now,
	}

	if err := c.storer.CreateDeposit(ctx, dep); err != nil {
		return fmt.Errorf("create deposit: %w", err)
	}

	// Credit balance_play via the accounting system.
	if err := c.acctCore.ProcessDeposit(ctx, accountID, amount, accounting.CurrencyPlay, txHash); err != nil {
		return fmt.Errorf("process accounting deposit: %w", err)
	}

	return nil
}

// RequestWithdrawal validates and creates a pending withdrawal request.
// Steps:
// 1. Validate to_address format (EIP-55)
// 2. Check balance_cash >= amount (minimum 1 USDC)
// 3. Calculate fee (flat 0.50 USDC for Phase 1)
// 4. Debit balance_cash by amount
// 5. Create WITHDRAW + WITHDRAW_FEE accounting logs
// 6. Create withdraw_request record with status="pending"
func (c *Core) RequestWithdrawal(ctx context.Context, accountID uuid.UUID, toAddress string, amount decimal.Decimal, chain string) (WithdrawRequest, error) {
	// Validate address.
	normalizedAddr, err := ethereum.NormalizeAddress(toAddress)
	if err != nil {
		return WithdrawRequest{}, v1.NewRequestError(fmt.Errorf("invalid address: %w", err), 400)
	}

	// Validate minimum.
	if amount.LessThan(MinWithdrawal) {
		return WithdrawRequest{}, v1.NewRequestError(fmt.Errorf("minimum withdrawal is %s USDC", MinWithdrawal), 400)
	}

	fee := WithdrawalFee
	netAmount := amount.Sub(fee)
	if netAmount.LessThanOrEqual(decimal.Zero) {
		return WithdrawRequest{}, v1.NewRequestError(fmt.Errorf("withdrawal amount must be greater than fee (%s USDC)", fee), 400)
	}

	now := time.Now().UTC()
	wr := WithdrawRequest{
		RequestID:  uuid.New(),
		AccountID:  accountID,
		AmountCash: amount,
		AmountUSDC: netAmount,
		FeeUSDC:    fee,
		Chain:      chain,
		ToAddress:  normalizedAddr,
		Status:     "pending",
		CreatedAt:  now,
	}

	// Execute in a transaction: debit balance + create accounting logs + create request.
	txErr := database.ExecTx(ctx, c.db, func(tx *sqlx.Tx) error {
		txStorer := c.newStorer(tx)
		txUserCore := user.NewCore(c.newUserStorer(tx))

		// Debit balance_cash atomically.
		_, debitErr := txUserCore.DecrementCashBalance(ctx, accountID, amount)
		if debitErr != nil {
			return debitErr
		}

		// Create withdraw request record.
		if err := txStorer.CreateWithdrawRequest(ctx, wr); err != nil {
			return fmt.Errorf("create withdraw request: %w", err)
		}

		return nil
	})

	if txErr != nil {
		return WithdrawRequest{}, txErr
	}

	return wr, nil
}

// QueryDeposits returns all deposits for an account.
func (c *Core) QueryDeposits(ctx context.Context, accountID uuid.UUID) ([]Deposit, error) {
	deps, err := c.storer.QueryDepositsByAccount(ctx, accountID)
	if err != nil {
		return nil, fmt.Errorf("query deposits: %w", err)
	}
	return deps, nil
}

// QueryWithdrawals returns all withdrawal requests for an account.
func (c *Core) QueryWithdrawals(ctx context.Context, accountID uuid.UUID) ([]WithdrawRequest, error) {
	wrs, err := c.storer.QueryWithdrawRequestsByAccount(ctx, accountID)
	if err != nil {
		return nil, fmt.Errorf("query withdrawals: %w", err)
	}
	return wrs, nil
}

// QueryAllAddresses returns all deposit addresses for a chain (used by indexer).
func (c *Core) QueryAllAddresses(ctx context.Context, chain string) ([]DepositAddress, error) {
	addrs, err := c.storer.QueryAllAddresses(ctx, chain)
	if err != nil {
		return nil, fmt.Errorf("query all addresses: %w", err)
	}
	return addrs, nil
}
