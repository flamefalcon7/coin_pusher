package deposit

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/shopspring/decimal"

	v1 "github.com/flamefalcon/coin-pusher/backend/business/web/v1"
	"github.com/flamefalcon/coin-pusher/backend/foundation/wallet"
)

// ---------------------------------------------------------------------------
// Mock storer
// ---------------------------------------------------------------------------

type mockStorer struct {
	queryAddressByAccountFn  func(ctx context.Context, accountID uuid.UUID, chain string) (DepositAddress, error)
	queryAddressByAddressFn  func(ctx context.Context, chain, address string) (DepositAddress, error)
	queryAllAddressesFn      func(ctx context.Context, chain string) ([]DepositAddress, error)
	createAddressFn          func(ctx context.Context, addr DepositAddress) error
	nextDerivationIndexFn    func(ctx context.Context, chain string) (int, error)
	createDepositFn          func(ctx context.Context, dep Deposit) error
	queryDepositByTxHashFn   func(ctx context.Context, txHash string) (Deposit, error)
	queryDepositsByAccountFn func(ctx context.Context, accountID uuid.UUID) ([]Deposit, error)
	createWithdrawRequestFn  func(ctx context.Context, wr WithdrawRequest) error
	queryWithdrawRequestsFn  func(ctx context.Context, accountID uuid.UUID) ([]WithdrawRequest, error)
	updateWithdrawStatusFn   func(ctx context.Context, requestID uuid.UUID, status string, txHash, errorMsg *string) error
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

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

func newTestWallet() *wallet.Wallet {
	w, err := wallet.New("deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef")
	if err != nil {
		panic(err)
	}
	return w
}

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

	storer := &mockStorer{
		queryAddressByAccountFn: func(ctx context.Context, id uuid.UUID, chain string) (DepositAddress, error) {
			return DepositAddress{}, v1.NewNotFoundError()
		},
		nextDerivationIndexFn: func(ctx context.Context, chain string) (int, error) {
			return 7, nil
		},
		createAddressFn: func(ctx context.Context, addr DepositAddress) error {
			createdAddr = addr
			return nil
		},
	}

	core := &Core{storer: storer, wallet: newTestWallet()}
	addr, err := core.GetOrCreateAddress(context.Background(), accountID, "base")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
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
	// Address should be a valid EIP-55 format.
	if len(addr.Address) != 42 || addr.Address[:2] != "0x" {
		t.Errorf("address format invalid: %q", addr.Address)
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

func TestGetOrCreateAddress_DerivationError(t *testing.T) {
	t.Parallel()

	storer := &mockStorer{
		queryAddressByAccountFn: func(ctx context.Context, id uuid.UUID, chain string) (DepositAddress, error) {
			return DepositAddress{}, v1.NewNotFoundError()
		},
		nextDerivationIndexFn: func(ctx context.Context, chain string) (int, error) {
			return 0, errors.New("index query failed")
		},
	}

	core := &Core{storer: storer, wallet: newTestWallet()}
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

	// If deposit with same tx_hash already exists, return nil (no double-credit).
	storer := &mockStorer{
		queryDepositByTxHashFn: func(ctx context.Context, txHash string) (Deposit, error) {
			return Deposit{DepositID: uuid.New()}, nil // already exists
		},
	}

	core := &Core{storer: storer}
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

	core := &Core{storer: storer}
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

	core := &Core{storer: storer}
	err := core.ProcessDeposit(context.Background(), uuid.New(), decimal.NewFromInt(50), "0xfail", 100, "0xfrom")
	if err == nil {
		t.Fatal("expected error, got nil")
	}
}

func TestProcessDeposit_RecordsCorrectFields(t *testing.T) {
	t.Parallel()

	accountID := uuid.New()
	var recorded Deposit

	storer := &mockStorer{
		queryDepositByTxHashFn: func(ctx context.Context, txHash string) (Deposit, error) {
			return Deposit{}, v1.NewNotFoundError()
		},
		createDepositFn: func(ctx context.Context, dep Deposit) error {
			recorded = dep
			return nil
		},
	}

	// This will panic on acctCore.ProcessDeposit since acctCore is nil,
	// but we can verify the deposit record was created correctly before that.
	// Use recover to catch the nil pointer.
	core := &Core{storer: storer}
	func() {
		defer func() { recover() }()
		_ = core.ProcessDeposit(context.Background(), accountID, decimal.NewFromFloat(25.5), "0xabc", 12345, "0xsender")
	}()

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
}

// ---------------------------------------------------------------------------
// RequestWithdrawal — validation (before ExecTx)
// ---------------------------------------------------------------------------

func TestRequestWithdrawal_InvalidAddress(t *testing.T) {
	t.Parallel()

	core := &Core{storer: &mockStorer{}}
	_, err := core.RequestWithdrawal(context.Background(), uuid.New(), "not-an-address", decimal.NewFromInt(10), "base")
	if err == nil {
		t.Fatal("expected error for invalid address")
	}
}

func TestRequestWithdrawal_BelowMinimum(t *testing.T) {
	t.Parallel()

	core := &Core{storer: &mockStorer{}}
	_, err := core.RequestWithdrawal(
		context.Background(),
		uuid.New(),
		"0x0000000000000000000000000000000000000001",
		decimal.NewFromFloat(0.50),
		"base",
	)
	if err == nil {
		t.Fatal("expected error for below-minimum withdrawal")
	}
}

func TestRequestWithdrawal_NetAmountZero(t *testing.T) {
	t.Parallel()

	// Amount = 1 USDC, fee = 0.50, net = 0.50 — should pass min check.
	// Amount = fee exactly → net = 0 → should fail.
	core := &Core{storer: &mockStorer{}}
	_, err := core.RequestWithdrawal(
		context.Background(),
		uuid.New(),
		"0x0000000000000000000000000000000000000001",
		WithdrawalFee,
		"base",
	)
	// 0.50 < 1 USDC min → fails at minimum check
	if err == nil {
		t.Fatal("expected error when amount is too low")
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
