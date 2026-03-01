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

// AcctStorerFactory builds an accounting.Storer bound to the given DBTX.
type AcctStorerFactory func(database.DBTX) accounting.Storer

// TxFunc is a function that runs inside a database transaction.
// The Storer passed to it is bound to the transaction.
type TxFunc func(ctx context.Context, txStorer Storer) error

// TxRunner executes fn inside a database transaction.
type TxRunner func(ctx context.Context, fn TxFunc) error

// txStores holds tx-bound instances used inside execTx.
type txStores struct {
	storer    Storer
	userCore  *user.Core
	acctStore accounting.Storer
}

// MetricRecorder is a callback for recording metric events to the progress system.
type MetricRecorder func(ctx context.Context, accountID uuid.UUID, metricType string, delta decimal.Decimal) error

// Core manages the set of APIs for deposit/withdrawal access.
type Core struct {
	db              *sqlx.DB
	storer          Storer
	wallet          *wallet.Wallet
	acctCore        *accounting.Core
	userCore        *user.Core
	newStorer       StorerFactory
	newUserStorer   UserStorerFactory
	newAcctStorer   AcctStorerFactory
	defaultAcctStore accounting.Storer // for test mode (db==nil)
	runTx           TxRunner
	metricRecorder  MetricRecorder
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
	newAcctStorer AcctStorerFactory,
) *Core {
	c := &Core{
		db:            db,
		storer:        storer,
		wallet:        w,
		acctCore:      acctCore,
		userCore:      userCore,
		newStorer:     newStorer,
		newUserStorer: newUserStorer,
		newAcctStorer: newAcctStorer,
	}
	c.runTx = func(ctx context.Context, fn TxFunc) error {
		return database.ExecTx(ctx, db, func(tx *sqlx.Tx) error {
			return fn(ctx, newStorer(tx))
		})
	}
	return c
}

// SetMetricRecorder sets the callback for recording metric events.
func (c *Core) SetMetricRecorder(fn MetricRecorder) {
	c.metricRecorder = fn
}

// execTx runs fn inside a database transaction with all tx-bound stores.
// When db is nil (unit tests), fn receives the default (mock) stores directly.
func (c *Core) execTx(ctx context.Context, fn func(s txStores) error) error {
	if c.db == nil {
		return fn(txStores{storer: c.storer, userCore: c.userCore, acctStore: c.defaultAcctStore})
	}

	return database.ExecTx(ctx, c.db, func(tx *sqlx.Tx) error {
		s := txStores{
			storer:    c.newStorer(tx),
			userCore:  user.NewCore(c.newUserStorer(tx)),
			acctStore: c.newAcctStorer(tx),
		}
		return fn(s)
	})
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
// All operations (idempotency check, deposit record, accounting log, balance credit)
// happen in a single transaction to prevent TOCTOU double-credit.
// Idempotent: if a deposit with the same tx_hash already exists, it verifies
// the accounting log also exists and re-credits if missing.
func (c *Core) ProcessDeposit(ctx context.Context, accountID uuid.UUID, amount decimal.Decimal, txHash string, blockNumber int64, fromAddress string) error {
	err := c.execTx(ctx, func(s txStores) error {
		// Idempotency check inside tx to prevent TOCTOU race.
		_, err := s.storer.QueryDepositByTxHash(ctx, txHash)
		if err == nil {
			// Deposit record exists. Verify accounting log also exists.
			// If not, the previous attempt crashed between deposit insert and credit.
			_, acctErr := s.acctStore.QueryByReference(ctx, accounting.ActionDeposit, txHash)
			if acctErr == nil {
				return nil // Both exist — fully processed.
			}
			if !errors.Is(acctErr, v1.ErrNotFound) {
				return fmt.Errorf("checking accounting log: %w", acctErr)
			}
			// Accounting log missing — re-create it and credit balance below.
		} else if !errors.Is(err, v1.ErrNotFound) {
			return fmt.Errorf("query deposit by tx_hash: %w", err)
		} else {
			// No deposit record — create it.
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
			if err := s.storer.CreateDeposit(ctx, dep); err != nil {
				return fmt.Errorf("create deposit: %w", err)
			}
		}

		// Create accounting log + credit balance in same tx.
		now := time.Now().UTC()
		depositLog := accounting.AccountingLog{
			LogID:       uuid.New(),
			AccountID:   accountID,
			ActionType:  accounting.ActionDeposit,
			Amount:      amount,
			Currency:    accounting.CurrencyPlay,
			ReferenceID: txHash,
			CreatedAt:   now,
		}
		if err := s.acctStore.Create(ctx, depositLog); err != nil {
			return fmt.Errorf("creating deposit accounting log: %w", err)
		}

		if err := s.userCore.IncrementPlayBalance(ctx, accountID, amount); err != nil {
			return fmt.Errorf("crediting play balance: %w", err)
		}

		// Track lifetime deposit (inside tx — crash-safe).
		if err := s.userCore.IncrementLifetimeDeposit(ctx, accountID, amount); err != nil {
			return fmt.Errorf("incrementing lifetime deposit: %w", err)
		}

		// Referral reward: 10% of first deposit to referrer.
		// The preceding UPDATE already row-locks the depositor, so concurrent
		// deposits on the same account are serialized here.
		acct, qErr := s.userCore.QueryByID(ctx, accountID)
		if qErr != nil {
			return fmt.Errorf("querying account for referral: %w", qErr)
		}

		if acct.ReferredBy != nil && !acct.ReferralRewardPaid {
			reward := amount.Mul(decimal.NewFromFloat(0.10))
			refID := fmt.Sprintf("referral:%s", accountID)

			rewardLog := accounting.AccountingLog{
				LogID:       uuid.New(),
				AccountID:   *acct.ReferredBy,
				ActionType:  accounting.ActionReferralReward,
				Amount:      reward,
				Currency:    accounting.CurrencyPlay,
				ReferenceID: refID,
				CreatedAt:   now,
			}

			if err := s.acctStore.Create(ctx, rewardLog); err != nil {
				return fmt.Errorf("creating referral reward log: %w", err)
			}

			if err := s.userCore.IncrementPlayBalance(ctx, *acct.ReferredBy, reward); err != nil {
				return fmt.Errorf("crediting referrer balance: %w", err)
			}

			if err := s.userCore.MarkReferralRewardPaid(ctx, accountID); err != nil {
				return fmt.Errorf("marking referral reward paid: %w", err)
			}
		}

		return nil
	})
	if err != nil {
		return err
	}

	// Record deposit metric for progress system (after tx succeeds).
	if c.metricRecorder != nil {
		if mrErr := c.metricRecorder(ctx, accountID, "deposit_usdc", amount); mrErr != nil {
			// Log but don't fail the primary operation.
			_ = mrErr
		}
	}

	return nil
}

// RequestWithdrawal validates and creates a withdrawal request.
// Steps:
// 1. Validate to_address format (EIP-55)
// 2. Check withdraw_locked_until
// 3. Check balance_cash >= amount (minimum 1 USDC)
// 4. Check daily withdraw limit ($500/day)
// 5. Calculate fee (flat 0.50 USDC for Phase 1)
// 6. Debit balance_cash by amount
// 7. Create WITHDRAW + WITHDRAW_FEE accounting logs
// 8. Create withdraw_request record (auto-approve ≤ $100, else pending)
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

	// Determine status: auto-approve ≤ $100, else pending (requires manual review).
	status := "pending"
	if amount.LessThanOrEqual(AutoApproveThreshold) {
		status = "approved"
	}

	now := time.Now().UTC()
	requestID := uuid.New()
	wr := WithdrawRequest{
		RequestID:  requestID,
		AccountID:  accountID,
		AmountCash: amount,
		AmountUSDC: netAmount,
		FeeUSDC:    fee,
		Chain:      chain,
		ToAddress:  normalizedAddr,
		Status:     status,
		CreatedAt:  now,
	}

	// Execute in a transaction: lock check + daily limit check + debit balance + accounting logs + create request.
	txErr := c.execTx(ctx, func(s txStores) error {
		// Check withdraw_locked_until inside the transaction to avoid TOCTOU race.
		acct, err := s.userCore.QueryByID(ctx, accountID)
		if err != nil {
			return fmt.Errorf("query account: %w", err)
		}
		if acct.WithdrawLockedUntil != nil && time.Now().Before(*acct.WithdrawLockedUntil) {
			return v1.NewRequestError(
				fmt.Errorf("withdrawals locked until %s", acct.WithdrawLockedUntil.Format(time.RFC3339)),
				403,
			)
		}

		// Daily withdraw limit check.
		dailyTotal, err := s.storer.QueryDailyWithdrawTotal(ctx, accountID)
		if err != nil {
			return fmt.Errorf("query daily total: %w", err)
		}
		if dailyTotal.Add(amount).GreaterThan(DailyWithdrawLimit) {
			return v1.NewRequestError(
				fmt.Errorf("daily withdrawal limit exceeded (limit: %s USDC, used: %s USDC)", DailyWithdrawLimit, dailyTotal),
				400,
			)
		}

		// Debit balance_cash atomically.
		_, debitErr := s.userCore.DecrementCashBalance(ctx, accountID, amount)
		if debitErr != nil {
			return debitErr
		}

		// WITHDRAW accounting log (net amount in CASH).
		refID := requestID.String()
		withdrawLog := accounting.AccountingLog{
			LogID:       uuid.New(),
			AccountID:   accountID,
			ActionType:  accounting.ActionWithdraw,
			Amount:      amount,
			Currency:    accounting.CurrencyCash,
			ReferenceID: refID,
			CreatedAt:   now,
		}
		if err := s.acctStore.Create(ctx, withdrawLog); err != nil {
			return fmt.Errorf("creating withdraw log: %w", err)
		}

		// WITHDRAW_FEE accounting log.
		feeLog := accounting.AccountingLog{
			LogID:       uuid.New(),
			AccountID:   accountID,
			ActionType:  accounting.ActionWithdrawFee,
			Amount:      fee,
			Currency:    accounting.CurrencyCash,
			ReferenceID: refID,
			CreatedAt:   now,
		}
		if err := s.acctStore.Create(ctx, feeLog); err != nil {
			return fmt.Errorf("creating withdraw fee log: %w", err)
		}

		// Create withdraw request record.
		if err := s.storer.CreateWithdrawRequest(ctx, wr); err != nil {
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

// QueryApprovedWithdrawals returns approved withdrawal requests (oldest first).
func (c *Core) QueryApprovedWithdrawals(ctx context.Context, limit int) ([]WithdrawRequest, error) {
	return c.storer.QueryWithdrawRequestsByStatus(ctx, []string{"approved"}, limit)
}

// ClaimApprovedWithdrawals atomically transitions approved withdrawals to
// 'submitted' and returns them. Uses FOR UPDATE SKIP LOCKED so concurrent
// executor instances never claim the same rows.
func (c *Core) ClaimApprovedWithdrawals(ctx context.Context, limit int) ([]WithdrawRequest, error) {
	return c.storer.ClaimApprovedWithdrawals(ctx, limit)
}

// QuerySubmittedWithdrawals returns submitted withdrawal requests (for recovery).
func (c *Core) QuerySubmittedWithdrawals(ctx context.Context, limit int) ([]WithdrawRequest, error) {
	return c.storer.QueryWithdrawRequestsByStatus(ctx, []string{"submitted"}, limit)
}

// HasActiveSweep checks if there is already a sweep in progress for a deposit address.
func (c *Core) HasActiveSweep(ctx context.Context, depositAddressID uuid.UUID) (bool, error) {
	return c.storer.HasActiveSweep(ctx, depositAddressID)
}

// UpdateWithdrawStatus updates the status of a withdrawal request.
func (c *Core) UpdateWithdrawStatus(ctx context.Context, requestID uuid.UUID, status string, txHash, errorMsg *string) error {
	return c.storer.UpdateWithdrawRequestStatus(ctx, requestID, status, txHash, errorMsg)
}

// RefundFailedWithdrawal marks a withdraw request as failed and refunds balance_cash.
// All operations happen in a single transaction.
func (c *Core) RefundFailedWithdrawal(ctx context.Context, requestID uuid.UUID, errMsg string) error {
	return c.execTx(ctx, func(s txStores) error {
		// Lock the request.
		wr, err := s.storer.QueryWithdrawRequestForUpdate(ctx, requestID)
		if err != nil {
			return fmt.Errorf("lock withdraw request: %w", err)
		}

		// Only refund if not already failed/refunded.
		if wr.Status == "failed" || wr.Status == "refunded" {
			return nil
		}

		// Update status to failed.
		if err := s.storer.UpdateWithdrawRequestStatus(ctx, requestID, "failed", nil, &errMsg); err != nil {
			return fmt.Errorf("update status to failed: %w", err)
		}

		// Refund balance_cash.
		if err := s.userCore.IncrementCashBalance(ctx, wr.AccountID, wr.AmountCash); err != nil {
			return fmt.Errorf("refund cash balance: %w", err)
		}

		// WITHDRAW_REFUND accounting log (full amount).
		now := time.Now().UTC()
		refID := requestID.String()
		refundLog := accounting.AccountingLog{
			LogID:       uuid.New(),
			AccountID:   wr.AccountID,
			ActionType:  accounting.ActionWithdrawRefund,
			Amount:      wr.AmountCash,
			Currency:    accounting.CurrencyCash,
			ReferenceID: refID,
			CreatedAt:   now,
		}
		if err := s.acctStore.Create(ctx, refundLog); err != nil {
			return fmt.Errorf("creating refund log: %w", err)
		}

		// WITHDRAW_FEE_REFUND accounting log (fee reversal for clean audit trail).
		feeRefundLog := accounting.AccountingLog{
			LogID:       uuid.New(),
			AccountID:   wr.AccountID,
			ActionType:  accounting.ActionWithdrawFeeRefund,
			Amount:      wr.FeeUSDC,
			Currency:    accounting.CurrencyCash,
			ReferenceID: refID,
			CreatedAt:   now,
		}
		if err := s.acctStore.Create(ctx, feeRefundLog); err != nil {
			return fmt.Errorf("creating fee refund log: %w", err)
		}

		return nil
	})
}

// QueryRecoverableSweeps returns sweeps in non-terminal active statuses (for recovery).
func (c *Core) QueryRecoverableSweeps(ctx context.Context, limit int) ([]Sweep, error) {
	return c.storer.QuerySweepsByStatus(ctx, []string{"pending", "gas_funded", "submitted"}, limit)
}

// CreateSweep records a new sweep operation.
func (c *Core) CreateSweep(ctx context.Context, s Sweep) error {
	return c.storer.CreateSweep(ctx, s)
}

// UpdateSweepStatus updates a sweep record's status.
func (c *Core) UpdateSweepStatus(ctx context.Context, sweepID uuid.UUID, status string, sweepTxHash *string, gasFundTxHash *string, errorMsg *string) error {
	return c.storer.UpdateSweepStatus(ctx, sweepID, status, sweepTxHash, gasFundTxHash, errorMsg)
}
