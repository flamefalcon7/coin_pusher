package deposit

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/shopspring/decimal"

	"github.com/flamefalcon/coin-pusher/backend/business/core/accounting"
	"github.com/flamefalcon/coin-pusher/backend/business/core/user"
	v1 "github.com/flamefalcon/coin-pusher/backend/business/web/v1"
	"github.com/flamefalcon/coin-pusher/backend/foundation/wallet"
)

// ---------------------------------------------------------------------------
// Mock storer
// ---------------------------------------------------------------------------

type mockStorer struct {
	queryAddressByAccountFn     func(ctx context.Context, accountID uuid.UUID, chain string) (DepositAddress, error)
	queryAddressByAddressFn     func(ctx context.Context, chain, address string) (DepositAddress, error)
	queryAllAddressesFn         func(ctx context.Context, chain string) ([]DepositAddress, error)
	createAddressFn             func(ctx context.Context, addr DepositAddress) error
	nextDerivationIndexFn       func(ctx context.Context, chain string) (int, error)
	acquireAdvisoryLockFn       func(ctx context.Context, key int64) error
	createDepositFn             func(ctx context.Context, dep Deposit) error
	queryDepositByTxHashFn      func(ctx context.Context, txHash string) (Deposit, error)
	queryDepositsByAccountFn    func(ctx context.Context, accountID uuid.UUID) ([]Deposit, error)
	createWithdrawRequestFn     func(ctx context.Context, wr WithdrawRequest) error
	queryWithdrawRequestsFn     func(ctx context.Context, accountID uuid.UUID) ([]WithdrawRequest, error)
	updateWithdrawStatusFn      func(ctx context.Context, requestID uuid.UUID, status string, txHash, errorMsg *string) error
	queryDailyWithdrawTotalFn   func(ctx context.Context, accountID uuid.UUID) (decimal.Decimal, error)
	queryWithdrawByStatusFn     func(ctx context.Context, statuses []string, limit int) ([]WithdrawRequest, error)
	queryWithdrawForUpdateFn    func(ctx context.Context, requestID uuid.UUID) (WithdrawRequest, error)
	createSweepFn               func(ctx context.Context, s Sweep) error
	updateSweepStatusFn         func(ctx context.Context, sweepID uuid.UUID, status string, sweepTxHash *string, gasFundTxHash *string, errorMsg *string) error
	claimApprovedWithdrawalsFn  func(ctx context.Context, limit int) ([]WithdrawRequest, error)
	hasActiveSweepFn            func(ctx context.Context, depositAddressID uuid.UUID) (bool, error)
	querySweepsByStatusFn       func(ctx context.Context, statuses []string, limit int) ([]Sweep, error)
}

func (m *mockStorer) QueryAddressByAccount(ctx context.Context, accountID uuid.UUID, chain string) (DepositAddress, error) {
	if m.queryAddressByAccountFn != nil {
		return m.queryAddressByAccountFn(ctx, accountID, chain)
	}
	return DepositAddress{}, v1.NewNotFoundError()
}

func (m *mockStorer) QueryAddressByAddress(ctx context.Context, chain, address string) (DepositAddress, error) {
	if m.queryAddressByAddressFn != nil {
		return m.queryAddressByAddressFn(ctx, chain, address)
	}
	return DepositAddress{}, v1.NewNotFoundError()
}

func (m *mockStorer) QueryAllAddresses(ctx context.Context, chain string) ([]DepositAddress, error) {
	if m.queryAllAddressesFn != nil {
		return m.queryAllAddressesFn(ctx, chain)
	}
	return nil, nil
}

func (m *mockStorer) CreateAddress(ctx context.Context, addr DepositAddress) error {
	if m.createAddressFn != nil {
		return m.createAddressFn(ctx, addr)
	}
	return nil
}

func (m *mockStorer) NextDerivationIndex(ctx context.Context, chain string) (int, error) {
	if m.nextDerivationIndexFn != nil {
		return m.nextDerivationIndexFn(ctx, chain)
	}
	return 0, nil
}

func (m *mockStorer) AcquireAdvisoryLock(ctx context.Context, key int64) error {
	if m.acquireAdvisoryLockFn != nil {
		return m.acquireAdvisoryLockFn(ctx, key)
	}
	return nil
}

func (m *mockStorer) CreateDeposit(ctx context.Context, dep Deposit) error {
	if m.createDepositFn != nil {
		return m.createDepositFn(ctx, dep)
	}
	return nil
}

func (m *mockStorer) QueryDepositByTxHash(ctx context.Context, txHash string) (Deposit, error) {
	if m.queryDepositByTxHashFn != nil {
		return m.queryDepositByTxHashFn(ctx, txHash)
	}
	return Deposit{}, v1.NewNotFoundError()
}

func (m *mockStorer) QueryDepositsByAccount(ctx context.Context, accountID uuid.UUID) ([]Deposit, error) {
	if m.queryDepositsByAccountFn != nil {
		return m.queryDepositsByAccountFn(ctx, accountID)
	}
	return nil, nil
}

func (m *mockStorer) CreateWithdrawRequest(ctx context.Context, wr WithdrawRequest) error {
	if m.createWithdrawRequestFn != nil {
		return m.createWithdrawRequestFn(ctx, wr)
	}
	return nil
}

func (m *mockStorer) QueryWithdrawRequestsByAccount(ctx context.Context, accountID uuid.UUID) ([]WithdrawRequest, error) {
	if m.queryWithdrawRequestsFn != nil {
		return m.queryWithdrawRequestsFn(ctx, accountID)
	}
	return nil, nil
}

func (m *mockStorer) UpdateWithdrawRequestStatus(ctx context.Context, requestID uuid.UUID, status string, txHash, errorMsg *string) error {
	if m.updateWithdrawStatusFn != nil {
		return m.updateWithdrawStatusFn(ctx, requestID, status, txHash, errorMsg)
	}
	return nil
}

func (m *mockStorer) QueryDailyWithdrawTotal(ctx context.Context, accountID uuid.UUID) (decimal.Decimal, error) {
	if m.queryDailyWithdrawTotalFn != nil {
		return m.queryDailyWithdrawTotalFn(ctx, accountID)
	}
	return decimal.Zero, nil
}

func (m *mockStorer) QueryWithdrawRequestsByStatus(ctx context.Context, statuses []string, limit int) ([]WithdrawRequest, error) {
	if m.queryWithdrawByStatusFn != nil {
		return m.queryWithdrawByStatusFn(ctx, statuses, limit)
	}
	return nil, nil
}

func (m *mockStorer) QueryWithdrawRequestForUpdate(ctx context.Context, requestID uuid.UUID) (WithdrawRequest, error) {
	if m.queryWithdrawForUpdateFn != nil {
		return m.queryWithdrawForUpdateFn(ctx, requestID)
	}
	return WithdrawRequest{}, v1.NewNotFoundError()
}

func (m *mockStorer) CreateSweep(ctx context.Context, s Sweep) error {
	if m.createSweepFn != nil {
		return m.createSweepFn(ctx, s)
	}
	return nil
}

func (m *mockStorer) UpdateSweepStatus(ctx context.Context, sweepID uuid.UUID, status string, sweepTxHash *string, gasFundTxHash *string, errorMsg *string) error {
	if m.updateSweepStatusFn != nil {
		return m.updateSweepStatusFn(ctx, sweepID, status, sweepTxHash, gasFundTxHash, errorMsg)
	}
	return nil
}

func (m *mockStorer) ClaimApprovedWithdrawals(ctx context.Context, limit int) ([]WithdrawRequest, error) {
	if m.claimApprovedWithdrawalsFn != nil {
		return m.claimApprovedWithdrawalsFn(ctx, limit)
	}
	return nil, nil
}

func (m *mockStorer) HasActiveSweep(ctx context.Context, depositAddressID uuid.UUID) (bool, error) {
	if m.hasActiveSweepFn != nil {
		return m.hasActiveSweepFn(ctx, depositAddressID)
	}
	return false, nil
}

func (m *mockStorer) QuerySweepsByStatus(ctx context.Context, statuses []string, limit int) ([]Sweep, error) {
	if m.querySweepsByStatusFn != nil {
		return m.querySweepsByStatusFn(ctx, statuses, limit)
	}
	return nil, nil
}

func (m *mockStorer) CountApprovedWithdrawals(ctx context.Context) (int, error) {
	return 0, nil
}

func (m *mockStorer) CountActiveSweeps(ctx context.Context) (int, error) {
	return 0, nil
}

func (m *mockStorer) CountDepositAddresses(ctx context.Context, chain string) (int, error) {
	return 0, nil
}

// ---------------------------------------------------------------------------
// Mock accounting storer
// ---------------------------------------------------------------------------

type mockAcctStorer struct {
	createFn           func(ctx context.Context, log accounting.AccountingLog) error
	queryByAccountIDFn func(ctx context.Context, accountID uuid.UUID, page, pageSize int) ([]accounting.AccountingLog, error)
	queryByReferenceFn func(ctx context.Context, actionType, referenceID string) (accounting.AccountingLog, error)
}

func (m *mockAcctStorer) Create(ctx context.Context, log accounting.AccountingLog) error {
	if m.createFn != nil {
		return m.createFn(ctx, log)
	}
	return nil
}

func (m *mockAcctStorer) QueryByAccountID(ctx context.Context, accountID uuid.UUID, page, pageSize int) ([]accounting.AccountingLog, error) {
	if m.queryByAccountIDFn != nil {
		return m.queryByAccountIDFn(ctx, accountID, page, pageSize)
	}
	return nil, nil
}

func (m *mockAcctStorer) QueryByReference(ctx context.Context, actionType, referenceID string) (accounting.AccountingLog, error) {
	if m.queryByReferenceFn != nil {
		return m.queryByReferenceFn(ctx, actionType, referenceID)
	}
	return accounting.AccountingLog{}, v1.NewNotFoundError()
}

func (m *mockAcctStorer) SumByActionSince(_ context.Context, _ string, _ time.Time) (decimal.Decimal, error) {
	return decimal.Zero, nil
}

func (m *mockAcctStorer) SumByPlayerSince(_ context.Context, _ string, _ time.Time) ([]accounting.PlayerSum, error) {
	return nil, nil
}

// ---------------------------------------------------------------------------
// Mock user storer
// ---------------------------------------------------------------------------

type mockUserStorer struct {
	queryByIDFn     func(ctx context.Context, accountID uuid.UUID) (user.Account, error)
	updateBalanceFn func(ctx context.Context, accountID uuid.UUID, currency string, delta decimal.Decimal) (decimal.Decimal, error)
}

func (m *mockUserStorer) Create(ctx context.Context, acct user.Account) error        { return nil }
func (m *mockUserStorer) CreateAuthProvider(ctx context.Context, ap user.AuthProvider) error {
	return nil
}
func (m *mockUserStorer) QueryByProvider(ctx context.Context, providerType, providerUID string) (user.Account, error) {
	return user.Account{}, nil
}
func (m *mockUserStorer) CreateNonce(ctx context.Context, nonce, address string, expiresAt time.Time) error {
	return nil
}
func (m *mockUserStorer) ConsumeNonce(ctx context.Context, nonce string) (user.NonceRecord, error) {
	return user.NonceRecord{}, nil
}
func (m *mockUserStorer) PurgeExpiredNonces(ctx context.Context) (int64, error) { return 0, nil }
func (m *mockUserStorer) SetRole(ctx context.Context, accountID uuid.UUID, role string) error {
	return nil
}
func (m *mockUserStorer) QueryByReferralCode(_ context.Context, _ string) (user.Account, error) {
	return user.Account{}, nil
}
func (m *mockUserStorer) SetDisplayName(_ context.Context, _ uuid.UUID, _ string) error { return nil }
func (m *mockUserStorer) SetReferralCode(_ context.Context, _ uuid.UUID, _ string) error {
	return nil
}
func (m *mockUserStorer) SetReferredBy(_ context.Context, _, _ uuid.UUID) error { return nil }
func (m *mockUserStorer) IncrementLifetimeDeposit(_ context.Context, _ uuid.UUID, _ decimal.Decimal) error {
	return nil
}
func (m *mockUserStorer) MarkReferralRewardPaid(_ context.Context, _ uuid.UUID) error { return nil }
func (m *mockUserStorer) CountReferrals(_ context.Context, _ uuid.UUID) (int, error)  { return 0, nil }
func (m *mockUserStorer) QueryWalletAddress(_ context.Context, _ uuid.UUID) (string, error) {
	return "", nil
}

func (m *mockUserStorer) QueryByID(ctx context.Context, accountID uuid.UUID) (user.Account, error) {
	if m.queryByIDFn != nil {
		return m.queryByIDFn(ctx, accountID)
	}
	return user.Account{
		ID:          accountID,
		BalanceCash: decimal.NewFromInt(10000),
	}, nil
}

func (m *mockUserStorer) QueryByIDForUpdate(ctx context.Context, accountID uuid.UUID) (user.Account, error) {
	if m.queryByIDFn != nil {
		return m.queryByIDFn(ctx, accountID)
	}
	return user.Account{
		ID:          accountID,
		BalanceCash: decimal.NewFromInt(10000),
	}, nil
}

func (m *mockUserStorer) UpdateBalance(ctx context.Context, accountID uuid.UUID, currency string, delta decimal.Decimal) (decimal.Decimal, error) {
	if m.updateBalanceFn != nil {
		return m.updateBalanceFn(ctx, accountID, currency, delta)
	}
	return decimal.NewFromInt(100), nil
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

func newTestWallet() *wallet.Wallet {
	w, err := wallet.New("deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef")
	if err != nil {
		panic(err)
	}
	return w
}

// mockTxRunner returns a TxRunner that skips real DB transactions and calls
// fn directly with the provided mock storer.
func mockTxRunner(s Storer) TxRunner {
	return func(ctx context.Context, fn TxFunc) error {
		return fn(ctx, s)
	}
}

// newTestCore builds a Core with mocks suitable for tests.
// db=nil triggers test mode in execTx: uses default storer/userCore/acctStore.
func newTestCore(storer *mockStorer, userStorer *mockUserStorer, acctStorer *mockAcctStorer) *Core {
	uCore := user.NewCore(userStorer)
	return &Core{
		db:               nil, // triggers test mode in execTx
		storer:           storer,
		wallet:           newTestWallet(),
		acctCore:         accounting.NewCore(nil, acctStorer, uCore, nil, nil),
		userCore:         uCore,
		defaultAcctStore: acctStorer,
		runTx:            mockTxRunner(storer),
	}
}

// validAddr is a valid Ethereum address for tests.
const validAddr = "0x0000000000000000000000000000000000000001"

// ---------------------------------------------------------------------------
// GetOrCreateAddress
// ---------------------------------------------------------------------------

func TestGetOrCreateAddress_Existing(t *testing.T) {
	t.Parallel()

	accountID := uuid.New()
	existing := DepositAddress{
		AddressID: uuid.New(),
		AccountID: accountID,
		Chain:     "base",
		Address:   "0xExisting",
	}

	storer := &mockStorer{
		queryAddressByAccountFn: func(ctx context.Context, id uuid.UUID, chain string) (DepositAddress, error) {
			return existing, nil
		},
	}

	core := &Core{storer: storer}
	addr, err := core.GetOrCreateAddress(context.Background(), accountID, "base")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if addr.Address != "0xExisting" {
		t.Errorf("address = %q, want 0xExisting", addr.Address)
	}
}

func TestGetOrCreateAddress_CreatesNew(t *testing.T) {
	t.Parallel()

	accountID := uuid.New()
	var createdAddr DepositAddress
	var lockAcquired bool

	storer := &mockStorer{
		queryAddressByAccountFn: func(ctx context.Context, id uuid.UUID, chain string) (DepositAddress, error) {
			return DepositAddress{}, v1.NewNotFoundError()
		},
		acquireAdvisoryLockFn: func(ctx context.Context, key int64) error {
			lockAcquired = true
			if key != advisoryKeyDerivationIndex {
				t.Errorf("advisory lock key = %d, want %d", key, advisoryKeyDerivationIndex)
			}
			return nil
		},
		nextDerivationIndexFn: func(ctx context.Context, chain string) (int, error) {
			return 7, nil
		},
		createAddressFn: func(ctx context.Context, addr DepositAddress) error {
			createdAddr = addr
			return nil
		},
	}

	core := &Core{storer: storer, wallet: newTestWallet(), runTx: mockTxRunner(storer)}
	addr, err := core.GetOrCreateAddress(context.Background(), accountID, "base")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	if !lockAcquired {
		t.Error("advisory lock was not acquired")
	}
	if addr.DerivationIndex != 7 {
		t.Errorf("derivation_index = %d, want 7", addr.DerivationIndex)
	}
	if addr.AccountID != accountID {
		t.Errorf("account_id = %v, want %v", addr.AccountID, accountID)
	}
	if addr.Chain != "base" {
		t.Errorf("chain = %q, want base", addr.Chain)
	}
	if createdAddr.AddressID == uuid.Nil {
		t.Error("create should have been called with non-nil address_id")
	}
	if len(addr.Address) != 42 || addr.Address[:2] != "0x" {
		t.Errorf("address format invalid: %q", addr.Address)
	}
}

func TestGetOrCreateAddress_DoubleCheckInsideLock(t *testing.T) {
	t.Parallel()

	accountID := uuid.New()
	callCount := 0
	existing := DepositAddress{
		AddressID: uuid.New(),
		AccountID: accountID,
		Chain:     "base",
		Address:   "0xCreatedByOther",
	}

	storer := &mockStorer{
		queryAddressByAccountFn: func(ctx context.Context, id uuid.UUID, chain string) (DepositAddress, error) {
			callCount++
			if callCount == 1 {
				// First call (fast path): not found.
				return DepositAddress{}, v1.NewNotFoundError()
			}
			// Second call (inside lock): another request created it.
			return existing, nil
		},
	}

	core := &Core{storer: storer, wallet: newTestWallet(), runTx: mockTxRunner(storer)}
	addr, err := core.GetOrCreateAddress(context.Background(), accountID, "base")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if addr.Address != "0xCreatedByOther" {
		t.Errorf("address = %q, want 0xCreatedByOther (from double-check)", addr.Address)
	}
}

func TestGetOrCreateAddress_QueryError(t *testing.T) {
	t.Parallel()

	storer := &mockStorer{
		queryAddressByAccountFn: func(ctx context.Context, id uuid.UUID, chain string) (DepositAddress, error) {
			return DepositAddress{}, errors.New("db error")
		},
	}

	core := &Core{storer: storer}
	_, err := core.GetOrCreateAddress(context.Background(), uuid.New(), "base")
	if err == nil {
		t.Fatal("expected error, got nil")
	}
}

func TestGetOrCreateAddress_LockError(t *testing.T) {
	t.Parallel()

	storer := &mockStorer{
		queryAddressByAccountFn: func(ctx context.Context, id uuid.UUID, chain string) (DepositAddress, error) {
			return DepositAddress{}, v1.NewNotFoundError()
		},
		acquireAdvisoryLockFn: func(ctx context.Context, key int64) error {
			return errors.New("lock failed")
		},
	}

	core := &Core{storer: storer, wallet: newTestWallet(), runTx: mockTxRunner(storer)}
	_, err := core.GetOrCreateAddress(context.Background(), uuid.New(), "base")
	if err == nil {
		t.Fatal("expected error, got nil")
	}
}

func TestGetOrCreateAddress_DerivationIndexError(t *testing.T) {
	t.Parallel()

	storer := &mockStorer{
		queryAddressByAccountFn: func(ctx context.Context, id uuid.UUID, chain string) (DepositAddress, error) {
			return DepositAddress{}, v1.NewNotFoundError()
		},
		nextDerivationIndexFn: func(ctx context.Context, chain string) (int, error) {
			return 0, errors.New("index query failed")
		},
	}

	core := &Core{storer: storer, wallet: newTestWallet(), runTx: mockTxRunner(storer)}
	_, err := core.GetOrCreateAddress(context.Background(), uuid.New(), "base")
	if err == nil {
		t.Fatal("expected error, got nil")
	}
}

func TestGetOrCreateAddress_CreateError(t *testing.T) {
	t.Parallel()

	storer := &mockStorer{
		queryAddressByAccountFn: func(ctx context.Context, id uuid.UUID, chain string) (DepositAddress, error) {
			return DepositAddress{}, v1.NewNotFoundError()
		},
		nextDerivationIndexFn: func(ctx context.Context, chain string) (int, error) {
			return 0, nil
		},
		createAddressFn: func(ctx context.Context, addr DepositAddress) error {
			return errors.New("insert failed")
		},
	}

	core := &Core{storer: storer, wallet: newTestWallet(), runTx: mockTxRunner(storer)}
	_, err := core.GetOrCreateAddress(context.Background(), uuid.New(), "base")
	if err == nil {
		t.Fatal("expected error, got nil")
	}
}

// ---------------------------------------------------------------------------
// ProcessDeposit
// ---------------------------------------------------------------------------

func TestProcessDeposit_Idempotent(t *testing.T) {
	t.Parallel()

	// If deposit with same tx_hash already exists, verify accounting log
	// exists too (acctCore.ProcessDeposit is idempotent via QueryByReference).
	storer := &mockStorer{
		queryDepositByTxHashFn: func(ctx context.Context, txHash string) (Deposit, error) {
			return Deposit{DepositID: uuid.New()}, nil // already exists
		},
	}
	acctStorer := &mockAcctStorer{
		queryByReferenceFn: func(ctx context.Context, actionType, referenceID string) (accounting.AccountingLog, error) {
			// Accounting log already exists too.
			return accounting.AccountingLog{LogID: uuid.New()}, nil
		},
	}
	userStorer := &mockUserStorer{}

	core := newTestCore(storer, userStorer, acctStorer)
	err := core.ProcessDeposit(context.Background(), uuid.New(), decimal.NewFromInt(50), "0xdup", 100, "0xfrom")
	if err != nil {
		t.Fatalf("idempotent call should return nil, got: %v", err)
	}
}

func TestProcessDeposit_QueryError(t *testing.T) {
	t.Parallel()

	storer := &mockStorer{
		queryDepositByTxHashFn: func(ctx context.Context, txHash string) (Deposit, error) {
			return Deposit{}, errors.New("db connection lost")
		},
	}

	core := newTestCore(storer, &mockUserStorer{}, &mockAcctStorer{})
	err := core.ProcessDeposit(context.Background(), uuid.New(), decimal.NewFromInt(50), "0xerr", 100, "0xfrom")
	if err == nil {
		t.Fatal("expected error, got nil")
	}
}

func TestProcessDeposit_CreateDepositError(t *testing.T) {
	t.Parallel()

	storer := &mockStorer{
		queryDepositByTxHashFn: func(ctx context.Context, txHash string) (Deposit, error) {
			return Deposit{}, v1.NewNotFoundError()
		},
		createDepositFn: func(ctx context.Context, dep Deposit) error {
			return errors.New("insert failed")
		},
	}

	core := newTestCore(storer, &mockUserStorer{}, &mockAcctStorer{})
	err := core.ProcessDeposit(context.Background(), uuid.New(), decimal.NewFromInt(50), "0xfail", 100, "0xfrom")
	if err == nil {
		t.Fatal("expected error, got nil")
	}
}

func TestProcessDeposit_RecordsCorrectFields(t *testing.T) {
	t.Parallel()

	accountID := uuid.New()
	var recorded Deposit
	var createdLogs []accounting.AccountingLog
	var balanceUpdates []decimal.Decimal

	storer := &mockStorer{
		queryDepositByTxHashFn: func(ctx context.Context, txHash string) (Deposit, error) {
			return Deposit{}, v1.NewNotFoundError()
		},
		createDepositFn: func(ctx context.Context, dep Deposit) error {
			recorded = dep
			return nil
		},
	}
	acctStorer := &mockAcctStorer{
		createFn: func(ctx context.Context, log accounting.AccountingLog) error {
			createdLogs = append(createdLogs, log)
			return nil
		},
	}
	userStorer := &mockUserStorer{
		updateBalanceFn: func(ctx context.Context, id uuid.UUID, currency string, delta decimal.Decimal) (decimal.Decimal, error) {
			balanceUpdates = append(balanceUpdates, delta)
			return decimal.NewFromInt(100), nil
		},
	}

	core := newTestCore(storer, userStorer, acctStorer)
	err := core.ProcessDeposit(context.Background(), accountID, decimal.NewFromFloat(25.5), "0xabc", 12345, "0xsender")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	if recorded.AccountID != accountID {
		t.Errorf("account_id = %v, want %v", recorded.AccountID, accountID)
	}
	if !recorded.Amount.Equal(decimal.NewFromFloat(25.5)) {
		t.Errorf("amount = %s, want 25.5", recorded.Amount)
	}
	if recorded.TxHash != "0xabc" {
		t.Errorf("tx_hash = %q, want 0xabc", recorded.TxHash)
	}
	if recorded.BlockNumber != 12345 {
		t.Errorf("block_number = %d, want 12345", recorded.BlockNumber)
	}
	if recorded.FromAddress != "0xsender" {
		t.Errorf("from_address = %q, want 0xsender", recorded.FromAddress)
	}
	if recorded.Status != "confirmed" {
		t.Errorf("status = %q, want confirmed", recorded.Status)
	}
	if recorded.Chain != DefaultChain {
		t.Errorf("chain = %q, want %q", recorded.Chain, DefaultChain)
	}

	// Should have created 1 accounting log: DEPOSIT.
	if len(createdLogs) != 1 {
		t.Fatalf("expected 1 accounting log, got %d", len(createdLogs))
	}
	if createdLogs[0].ActionType != accounting.ActionDeposit {
		t.Errorf("action_type = %q, want DEPOSIT", createdLogs[0].ActionType)
	}

	// Play balance should be credited with USDC × ExchangeRate (25.5 × 10 = 255).
	if len(balanceUpdates) < 1 {
		t.Fatal("expected at least 1 balance update")
	}
	expectedPlay := decimal.NewFromFloat(25.5).Mul(ExchangeRate)
	if !balanceUpdates[0].Equal(expectedPlay) {
		t.Errorf("play balance credit = %s, want %s (USDC × %s)", balanceUpdates[0], expectedPlay, ExchangeRate)
	}
}

// ---------------------------------------------------------------------------
// RequestWithdrawal — validation (before ExecTx)
// ---------------------------------------------------------------------------

func TestRequestWithdrawal_InvalidAddress(t *testing.T) {
	t.Parallel()

	core := &Core{storer: &mockStorer{}, userCore: user.NewCore(&mockUserStorer{})}
	_, err := core.RequestWithdrawal(context.Background(), uuid.New(), "not-an-address", decimal.NewFromInt(10), "base")
	if err == nil {
		t.Fatal("expected error for invalid address")
	}
}

func TestRequestWithdrawal_BelowMinimum(t *testing.T) {
	t.Parallel()

	core := &Core{storer: &mockStorer{}, userCore: user.NewCore(&mockUserStorer{})}
	_, err := core.RequestWithdrawal(
		context.Background(),
		uuid.New(),
		validAddr,
		decimal.NewFromFloat(0.50),
		"base",
	)
	if err == nil {
		t.Fatal("expected error for below-minimum withdrawal")
	}
}

func TestRequestWithdrawal_NetAmountZero(t *testing.T) {
	t.Parallel()

	// Amount = fee exactly → net = 0 → should fail.
	core := &Core{storer: &mockStorer{}, userCore: user.NewCore(&mockUserStorer{})}
	_, err := core.RequestWithdrawal(
		context.Background(),
		uuid.New(),
		validAddr,
		WithdrawalFee,
		"base",
	)
	// 0.50 < 1 USDC min → fails at minimum check
	if err == nil {
		t.Fatal("expected error when amount is too low")
	}
}

func TestRequestWithdrawal_WithdrawLocked(t *testing.T) {
	t.Parallel()

	accountID := uuid.New()
	future := time.Now().Add(1 * time.Hour)

	userStorer := &mockUserStorer{
		queryByIDFn: func(ctx context.Context, id uuid.UUID) (user.Account, error) {
			return user.Account{
				ID:                  accountID,
				BalanceCash:         decimal.NewFromInt(100),
				WithdrawLockedUntil: &future,
			}, nil
		},
	}

	core := newTestCore(&mockStorer{}, userStorer, &mockAcctStorer{})
	_, err := core.RequestWithdrawal(context.Background(), accountID, validAddr, decimal.NewFromInt(10), "base")
	if err == nil {
		t.Fatal("expected error for locked withdrawals")
	}

	var reqErr *v1.RequestError
	if !errors.As(err, &reqErr) {
		t.Fatalf("expected RequestError, got %T: %v", err, err)
	}
	if reqErr.Status != 403 {
		t.Errorf("status = %d, want 403", reqErr.Status)
	}
}

func TestRequestWithdrawal_DailyLimitExceeded(t *testing.T) {
	t.Parallel()

	accountID := uuid.New()

	storer := &mockStorer{
		queryDailyWithdrawTotalFn: func(ctx context.Context, id uuid.UUID) (decimal.Decimal, error) {
			return decimal.NewFromInt(490), nil // already used $490 of $500 limit
		},
	}
	userStorer := &mockUserStorer{
		updateBalanceFn: func(ctx context.Context, id uuid.UUID, currency string, delta decimal.Decimal) (decimal.Decimal, error) {
			return decimal.NewFromInt(100), nil
		},
	}
	acctStorer := &mockAcctStorer{}

	core := newTestCore(storer, userStorer, acctStorer)

	// 200 cash = 20 USDC. $490 used + $20 = $510 > $500 limit
	_, err := core.RequestWithdrawal(context.Background(), accountID, validAddr, decimal.NewFromInt(200), "base")
	if err == nil {
		t.Fatal("expected error for daily limit exceeded")
	}
}

func TestRequestWithdrawal_AutoApprove(t *testing.T) {
	t.Parallel()

	accountID := uuid.New()
	var capturedWR WithdrawRequest
	var createdLogs []accounting.AccountingLog

	storer := &mockStorer{
		queryDailyWithdrawTotalFn: func(ctx context.Context, id uuid.UUID) (decimal.Decimal, error) {
			return decimal.Zero, nil
		},
		createWithdrawRequestFn: func(ctx context.Context, wr WithdrawRequest) error {
			capturedWR = wr
			return nil
		},
	}
	userStorer := &mockUserStorer{
		updateBalanceFn: func(ctx context.Context, id uuid.UUID, currency string, delta decimal.Decimal) (decimal.Decimal, error) {
			return decimal.NewFromInt(50), nil
		},
	}
	acctStorer := &mockAcctStorer{
		createFn: func(ctx context.Context, log accounting.AccountingLog) error {
			createdLogs = append(createdLogs, log)
			return nil
		},
	}

	core := newTestCore(storer, userStorer, acctStorer)

	// 50 cash = 5 USDC ≤ $100 threshold → auto-approved.
	wr, err := core.RequestWithdrawal(context.Background(), accountID, validAddr, decimal.NewFromInt(50), "base")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	if wr.Status != "approved" {
		t.Errorf("status = %q, want approved", wr.Status)
	}
	if capturedWR.Status != "approved" {
		t.Errorf("stored status = %q, want approved", capturedWR.Status)
	}

	// Should have created 2 accounting logs: WITHDRAW + WITHDRAW_FEE.
	if len(createdLogs) != 2 {
		t.Fatalf("expected 2 accounting logs, got %d", len(createdLogs))
	}

	var foundWithdraw, foundFee bool
	for _, log := range createdLogs {
		switch log.ActionType {
		case accounting.ActionWithdraw:
			foundWithdraw = true
			if !log.Amount.Equal(decimal.NewFromInt(50)) {
				t.Errorf("withdraw log amount = %s, want 50", log.Amount)
			}
		case accounting.ActionWithdrawFee:
			foundFee = true
			feeCash := WithdrawalFee.Mul(ExchangeRate)
			if !log.Amount.Equal(feeCash) {
				t.Errorf("fee log amount = %s, want %s (fee in cash coins)", log.Amount, feeCash)
			}
		}
	}
	if !foundWithdraw {
		t.Error("missing WITHDRAW accounting log")
	}
	if !foundFee {
		t.Error("missing WITHDRAW_FEE accounting log")
	}
}

func TestRequestWithdrawal_PendingAboveThreshold(t *testing.T) {
	t.Parallel()

	accountID := uuid.New()
	var capturedWR WithdrawRequest

	storer := &mockStorer{
		queryDailyWithdrawTotalFn: func(ctx context.Context, id uuid.UUID) (decimal.Decimal, error) {
			return decimal.Zero, nil
		},
		createWithdrawRequestFn: func(ctx context.Context, wr WithdrawRequest) error {
			capturedWR = wr
			return nil
		},
	}
	userStorer := &mockUserStorer{
		updateBalanceFn: func(ctx context.Context, id uuid.UUID, currency string, delta decimal.Decimal) (decimal.Decimal, error) {
			return decimal.NewFromInt(200), nil
		},
	}
	acctStorer := &mockAcctStorer{}

	core := newTestCore(storer, userStorer, acctStorer)

	// 1500 cash = 150 USDC > $100 threshold → pending.
	wr, err := core.RequestWithdrawal(context.Background(), accountID, validAddr, decimal.NewFromInt(1500), "base")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	if wr.Status != "pending" {
		t.Errorf("status = %q, want pending", wr.Status)
	}
	if capturedWR.Status != "pending" {
		t.Errorf("stored status = %q, want pending", capturedWR.Status)
	}
}

func TestRequestWithdrawal_FeeCalculation(t *testing.T) {
	t.Parallel()

	accountID := uuid.New()
	var capturedWR WithdrawRequest

	storer := &mockStorer{
		queryDailyWithdrawTotalFn: func(ctx context.Context, id uuid.UUID) (decimal.Decimal, error) {
			return decimal.Zero, nil
		},
		createWithdrawRequestFn: func(ctx context.Context, wr WithdrawRequest) error {
			capturedWR = wr
			return nil
		},
	}
	userStorer := &mockUserStorer{}
	acctStorer := &mockAcctStorer{}

	core := newTestCore(storer, userStorer, acctStorer)

	_, err := core.RequestWithdrawal(context.Background(), accountID, validAddr, decimal.NewFromInt(10), "base")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	// amount_cash = 10, 10/10 = 1 USDC, fee = 0.50, net = 0.50 USDC
	if !capturedWR.AmountCash.Equal(decimal.NewFromInt(10)) {
		t.Errorf("amount_cash = %s, want 10", capturedWR.AmountCash)
	}
	if !capturedWR.FeeUSDC.Equal(decimal.NewFromFloat(0.50)) {
		t.Errorf("fee_usdc = %s, want 0.50", capturedWR.FeeUSDC)
	}
	if !capturedWR.AmountUSDC.Equal(decimal.NewFromFloat(0.50)) {
		t.Errorf("amount_usdc = %s, want 0.50", capturedWR.AmountUSDC)
	}
}

// ---------------------------------------------------------------------------
// QueryApprovedWithdrawals
// ---------------------------------------------------------------------------

func TestQueryApprovedWithdrawals(t *testing.T) {
	t.Parallel()

	want := []WithdrawRequest{
		{RequestID: uuid.New(), Status: "approved"},
		{RequestID: uuid.New(), Status: "approved"},
	}

	var queriedStatuses []string
	var queriedLimit int
	storer := &mockStorer{
		queryWithdrawByStatusFn: func(ctx context.Context, statuses []string, limit int) ([]WithdrawRequest, error) {
			queriedStatuses = statuses
			queriedLimit = limit
			return want, nil
		},
	}

	core := &Core{storer: storer}
	got, err := core.QueryApprovedWithdrawals(context.Background(), 5)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(got) != 2 {
		t.Fatalf("got %d, want 2", len(got))
	}
	if len(queriedStatuses) != 1 || queriedStatuses[0] != "approved" {
		t.Errorf("statuses = %v, want [approved]", queriedStatuses)
	}
	if queriedLimit != 5 {
		t.Errorf("limit = %d, want 5", queriedLimit)
	}
}

// ---------------------------------------------------------------------------
// UpdateWithdrawStatus
// ---------------------------------------------------------------------------

func TestUpdateWithdrawStatus(t *testing.T) {
	t.Parallel()

	var updatedID uuid.UUID
	var updatedStatus string
	var updatedHash *string

	storer := &mockStorer{
		updateWithdrawStatusFn: func(ctx context.Context, requestID uuid.UUID, status string, txHash, errorMsg *string) error {
			updatedID = requestID
			updatedStatus = status
			updatedHash = txHash
			return nil
		},
	}

	core := &Core{storer: storer}
	reqID := uuid.New()
	hash := "0xabc123"
	err := core.UpdateWithdrawStatus(context.Background(), reqID, "confirmed", &hash, nil)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	if updatedID != reqID {
		t.Errorf("request_id = %v, want %v", updatedID, reqID)
	}
	if updatedStatus != "confirmed" {
		t.Errorf("status = %q, want confirmed", updatedStatus)
	}
	if updatedHash == nil || *updatedHash != "0xabc123" {
		t.Errorf("tx_hash = %v, want 0xabc123", updatedHash)
	}
}

// ---------------------------------------------------------------------------
// QueryDeposits / QueryWithdrawals
// ---------------------------------------------------------------------------

func TestQueryDeposits(t *testing.T) {
	t.Parallel()

	accountID := uuid.New()
	want := []Deposit{
		{DepositID: uuid.New(), AccountID: accountID, Amount: decimal.NewFromInt(10)},
		{DepositID: uuid.New(), AccountID: accountID, Amount: decimal.NewFromInt(20)},
	}

	storer := &mockStorer{
		queryDepositsByAccountFn: func(ctx context.Context, id uuid.UUID) ([]Deposit, error) {
			return want, nil
		},
	}

	core := &Core{storer: storer}
	got, err := core.QueryDeposits(context.Background(), accountID)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(got) != 2 {
		t.Fatalf("got %d deposits, want 2", len(got))
	}
}

func TestQueryWithdrawals(t *testing.T) {
	t.Parallel()

	accountID := uuid.New()
	now := time.Now()
	want := []WithdrawRequest{
		{RequestID: uuid.New(), AccountID: accountID, Status: "pending", CreatedAt: now},
	}

	storer := &mockStorer{
		queryWithdrawRequestsFn: func(ctx context.Context, id uuid.UUID) ([]WithdrawRequest, error) {
			return want, nil
		},
	}

	core := &Core{storer: storer}
	got, err := core.QueryWithdrawals(context.Background(), accountID)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(got) != 1 {
		t.Fatalf("got %d withdrawals, want 1", len(got))
	}
	if got[0].Status != "pending" {
		t.Errorf("status = %q, want pending", got[0].Status)
	}
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

func TestExchangeRate(t *testing.T) {
	t.Parallel()

	if !ExchangeRate.Equal(decimal.NewFromInt(10)) {
		t.Errorf("ExchangeRate = %s, want 10", ExchangeRate)
	}
}

// ---------------------------------------------------------------------------
// RefundFailedWithdrawal
// ---------------------------------------------------------------------------

func TestRefundFailedWithdrawal_HappyPath(t *testing.T) {
	t.Parallel()

	requestID := uuid.New()
	accountID := uuid.New()

	var updatedStatus string
	var updatedErrMsg *string
	var incrementedAmount decimal.Decimal
	var createdLogs []accounting.AccountingLog

	storer := &mockStorer{
		queryWithdrawForUpdateFn: func(ctx context.Context, id uuid.UUID) (WithdrawRequest, error) {
			return WithdrawRequest{
				RequestID:  requestID,
				AccountID:  accountID,
				AmountCash: decimal.NewFromInt(50),
				AmountUSDC: decimal.NewFromFloat(49.50),
				FeeUSDC:    decimal.NewFromFloat(0.50),
				Status:     "submitted",
			}, nil
		},
		updateWithdrawStatusFn: func(ctx context.Context, id uuid.UUID, status string, txHash, errMsg *string) error {
			updatedStatus = status
			updatedErrMsg = errMsg
			return nil
		},
	}
	userStorer := &mockUserStorer{
		updateBalanceFn: func(ctx context.Context, id uuid.UUID, currency string, delta decimal.Decimal) (decimal.Decimal, error) {
			incrementedAmount = delta
			return decimal.NewFromInt(100), nil
		},
	}
	acctStorer := &mockAcctStorer{
		createFn: func(ctx context.Context, log accounting.AccountingLog) error {
			createdLogs = append(createdLogs, log)
			return nil
		},
	}

	core := newTestCore(storer, userStorer, acctStorer)
	err := core.RefundFailedWithdrawal(context.Background(), requestID, "test error")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	if updatedStatus != "failed" {
		t.Errorf("status = %q, want failed", updatedStatus)
	}
	if updatedErrMsg == nil || *updatedErrMsg != "test error" {
		t.Errorf("error_msg = %v, want 'test error'", updatedErrMsg)
	}
	if !incrementedAmount.Equal(decimal.NewFromInt(50)) {
		t.Errorf("refunded amount = %s, want 50", incrementedAmount)
	}

	// Should have 2 accounting logs: WITHDRAW_REFUND + WITHDRAW_FEE_REFUND.
	if len(createdLogs) != 2 {
		t.Fatalf("expected 2 accounting logs, got %d", len(createdLogs))
	}

	var foundRefund, foundFeeRefund bool
	for _, log := range createdLogs {
		switch log.ActionType {
		case accounting.ActionWithdrawRefund:
			foundRefund = true
			if !log.Amount.Equal(decimal.NewFromInt(50)) {
				t.Errorf("refund log amount = %s, want 50", log.Amount)
			}
		case accounting.ActionWithdrawFeeRefund:
			foundFeeRefund = true
			feeCash := WithdrawalFee.Mul(ExchangeRate)
			if !log.Amount.Equal(feeCash) {
				t.Errorf("fee refund log amount = %s, want %s (fee in cash coins)", log.Amount, feeCash)
			}
		}
	}
	if !foundRefund {
		t.Error("missing WITHDRAW_REFUND accounting log")
	}
	if !foundFeeRefund {
		t.Error("missing WITHDRAW_FEE_REFUND accounting log")
	}
}

func TestRefundFailedWithdrawal_AlreadyFailed(t *testing.T) {
	t.Parallel()

	requestID := uuid.New()

	storer := &mockStorer{
		queryWithdrawForUpdateFn: func(ctx context.Context, id uuid.UUID) (WithdrawRequest, error) {
			return WithdrawRequest{
				RequestID: requestID,
				Status:    "failed", // already failed
			}, nil
		},
		updateWithdrawStatusFn: func(ctx context.Context, id uuid.UUID, status string, txHash, errMsg *string) error {
			t.Error("should not update status for already-failed request")
			return nil
		},
	}

	core := newTestCore(storer, &mockUserStorer{}, &mockAcctStorer{})
	err := core.RefundFailedWithdrawal(context.Background(), requestID, "duplicate refund")
	if err != nil {
		t.Fatalf("expected nil for already-failed, got: %v", err)
	}
}

func TestRefundFailedWithdrawal_AlreadyRefunded(t *testing.T) {
	t.Parallel()

	requestID := uuid.New()

	storer := &mockStorer{
		queryWithdrawForUpdateFn: func(ctx context.Context, id uuid.UUID) (WithdrawRequest, error) {
			return WithdrawRequest{
				RequestID: requestID,
				Status:    "refunded",
			}, nil
		},
	}

	core := newTestCore(storer, &mockUserStorer{}, &mockAcctStorer{})
	err := core.RefundFailedWithdrawal(context.Background(), requestID, "should noop")
	if err != nil {
		t.Fatalf("expected nil for already-refunded, got: %v", err)
	}
}

func TestRefundFailedWithdrawal_LockError(t *testing.T) {
	t.Parallel()

	storer := &mockStorer{
		queryWithdrawForUpdateFn: func(ctx context.Context, id uuid.UUID) (WithdrawRequest, error) {
			return WithdrawRequest{}, errors.New("db lock failed")
		},
	}

	core := newTestCore(storer, &mockUserStorer{}, &mockAcctStorer{})
	err := core.RefundFailedWithdrawal(context.Background(), uuid.New(), "error")
	if err == nil {
		t.Fatal("expected error, got nil")
	}
}

// ---------------------------------------------------------------------------
// ProcessDeposit — crash recovery (deposit exists, accounting log missing)
// ---------------------------------------------------------------------------

func TestProcessDeposit_CrashRecovery_MissingAccountingLog(t *testing.T) {
	t.Parallel()

	accountID := uuid.New()
	var creditedAmount decimal.Decimal
	var creditedCurrency string
	var logCreated bool

	storer := &mockStorer{
		queryDepositByTxHashFn: func(ctx context.Context, txHash string) (Deposit, error) {
			// Deposit record exists (was created before crash).
			return Deposit{DepositID: uuid.New(), AccountID: accountID, Amount: decimal.NewFromInt(25)}, nil
		},
	}
	acctStorer := &mockAcctStorer{
		queryByReferenceFn: func(ctx context.Context, actionType, referenceID string) (accounting.AccountingLog, error) {
			// Accounting log is MISSING — simulates crash between deposit insert and credit.
			return accounting.AccountingLog{}, v1.NewNotFoundError()
		},
		createFn: func(ctx context.Context, log accounting.AccountingLog) error {
			logCreated = true
			return nil
		},
	}
	userStorer := &mockUserStorer{
		updateBalanceFn: func(ctx context.Context, id uuid.UUID, currency string, delta decimal.Decimal) (decimal.Decimal, error) {
			creditedAmount = delta
			creditedCurrency = currency
			return decimal.NewFromInt(100), nil
		},
	}

	core := newTestCore(storer, userStorer, acctStorer)
	err := core.ProcessDeposit(context.Background(), accountID, decimal.NewFromInt(25), "0xcrash", 999, "0xfrom")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	if !logCreated {
		t.Error("expected accounting log to be created for crash recovery")
	}
	// Play balance should be credited with USDC × ExchangeRate (25 × 10 = 250).
	expectedPlay := decimal.NewFromInt(25).Mul(ExchangeRate)
	if !creditedAmount.Equal(expectedPlay) {
		t.Errorf("credited amount = %s, want %s", creditedAmount, expectedPlay)
	}
	if creditedCurrency != "PLAY" {
		t.Errorf("credited currency = %q, want PLAY", creditedCurrency)
	}
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

func TestConstants(t *testing.T) {
	t.Parallel()

	if !WithdrawalFee.Equal(decimal.NewFromFloat(0.50)) {
		t.Errorf("WithdrawalFee = %s, want 0.50", WithdrawalFee)
	}

	if !MinWithdrawal.Equal(decimal.NewFromInt(1)) {
		t.Errorf("MinWithdrawal = %s, want 1", MinWithdrawal)
	}

	if !MinDeposit.Equal(decimal.NewFromInt(1)) {
		t.Errorf("MinDeposit = %s, want 1", MinDeposit)
	}

	if USDCContractBase != "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" {
		t.Errorf("USDCContractBase = %q, unexpected", USDCContractBase)
	}

	if !AutoApproveThreshold.Equal(decimal.NewFromInt(100)) {
		t.Errorf("AutoApproveThreshold = %s, want 100", AutoApproveThreshold)
	}

	if !DailyWithdrawLimit.Equal(decimal.NewFromInt(500)) {
		t.Errorf("DailyWithdrawLimit = %s, want 500", DailyWithdrawLimit)
	}
}
