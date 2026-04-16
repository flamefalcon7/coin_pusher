package game

import (
	"context"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/shopspring/decimal"

	"github.com/flamefalcon/coin-pusher/backend/business/core/accounting"
	"github.com/flamefalcon/coin-pusher/backend/business/core/user"
	v1 "github.com/flamefalcon/coin-pusher/backend/business/web/v1"
)

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

type mockUserStorer struct {
	createFn             func(ctx context.Context, acct user.Account) error
	createAuthProviderFn func(ctx context.Context, ap user.AuthProvider) error
	queryByIDFn          func(ctx context.Context, accountID uuid.UUID) (user.Account, error)
	queryByProviderFn    func(ctx context.Context, providerType, providerUID string) (user.Account, error)
	updateBalanceFn      func(ctx context.Context, accountID uuid.UUID, currency string, delta decimal.Decimal) (decimal.Decimal, error)
}

func (m *mockUserStorer) Create(ctx context.Context, acct user.Account) error {
	if m.createFn != nil {
		return m.createFn(ctx, acct)
	}
	return nil
}

func (m *mockUserStorer) CreateAuthProvider(ctx context.Context, ap user.AuthProvider) error {
	if m.createAuthProviderFn != nil {
		return m.createAuthProviderFn(ctx, ap)
	}
	return nil
}

func (m *mockUserStorer) QueryByID(ctx context.Context, accountID uuid.UUID) (user.Account, error) {
	if m.queryByIDFn != nil {
		return m.queryByIDFn(ctx, accountID)
	}
	return user.Account{}, nil
}

func (m *mockUserStorer) QueryByIDForUpdate(ctx context.Context, accountID uuid.UUID) (user.Account, error) {
	if m.queryByIDFn != nil {
		return m.queryByIDFn(ctx, accountID)
	}
	return user.Account{}, nil
}

func (m *mockUserStorer) QueryByProvider(ctx context.Context, providerType, providerUID string) (user.Account, error) {
	if m.queryByProviderFn != nil {
		return m.queryByProviderFn(ctx, providerType, providerUID)
	}
	return user.Account{}, nil
}

func (m *mockUserStorer) UpdateBalance(ctx context.Context, accountID uuid.UUID, currency string, delta decimal.Decimal) (decimal.Decimal, error) {
	if m.updateBalanceFn != nil {
		return m.updateBalanceFn(ctx, accountID, currency, delta)
	}
	return decimal.Zero, nil
}

func (m *mockUserStorer) CreateNonce(ctx context.Context, nonce, address string, expiresAt time.Time) error {
	return nil
}

func (m *mockUserStorer) ConsumeNonce(ctx context.Context, nonce string) (user.NonceRecord, error) {
	return user.NonceRecord{}, nil
}

func (m *mockUserStorer) PurgeExpiredNonces(ctx context.Context) (int64, error) {
	return 0, nil
}

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
	// Default: no prior entry. Refund idempotency guard would treat nil-error
	// as "already processed" — returning ErrNotFound matches real storer
	// miss semantics so roundtrip tests don't accidentally short-circuit.
	return accounting.AccountingLog{}, v1.NewNotFoundError()
}

func (m *mockAcctStorer) QueryAllByReference(_ context.Context, _, _ string) ([]accounting.AccountingLog, error) {
	return nil, nil
}

func (m *mockAcctStorer) SumByActionSince(_ context.Context, _ string, _ time.Time) (decimal.Decimal, error) {
	return decimal.Zero, nil
}

func (m *mockAcctStorer) SumByPlayerSince(_ context.Context, _ string, _ time.Time) ([]accounting.PlayerSum, error) {
	return nil, nil
}

func (m *mockAcctStorer) SumByActionSinceExcludingRole(_ context.Context, _, _ string, _ time.Time) (decimal.Decimal, error) {
	return decimal.Zero, nil
}

func (m *mockAcctStorer) SumByPlayerSinceExcludingRole(_ context.Context, _, _ string, _ time.Time) ([]accounting.PlayerSum, error) {
	return nil, nil
}

func (m *mockAcctStorer) InsertOutboxRow(_ context.Context, _ string, _ []byte, _ string) error {
	return nil
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

func newTestCore(t *testing.T, balance decimal.Decimal) (*Core, uuid.UUID) {
	t.Helper()
	// Backwards-compat helper — treats `balance` as play balance, cash=0.
	core, id, _ := newTestCoreWithBalances(t, balance, decimal.Zero)
	return core, id
}

// newTestCoreWithBalances builds a Core whose in-memory account starts with
// the given play and cash balances. The returned snapshot func returns the
// current in-memory (play, cash) state so tests can assert post-conditions
// without mocking every layer.
func newTestCoreWithBalances(t *testing.T, play, cash decimal.Decimal) (*Core, uuid.UUID, func() (decimal.Decimal, decimal.Decimal)) {
	t.Helper()

	accountID := uuid.New()
	curPlay := play
	curCash := cash

	userStr := &mockUserStorer{
		queryByIDFn: func(_ context.Context, _ uuid.UUID) (user.Account, error) {
			return user.Account{ID: accountID, BalancePlay: curPlay, BalanceCash: curCash}, nil
		},
		updateBalanceFn: func(_ context.Context, _ uuid.UUID, currency string, delta decimal.Decimal) (decimal.Decimal, error) {
			switch currency {
			case user.CurrencyPlay:
				newBal := curPlay.Add(delta)
				if newBal.IsNegative() {
					return decimal.Zero, v1.NewInsufficientFundError(currency, delta.Abs(), curPlay)
				}
				curPlay = newBal
				return curPlay, nil
			case user.CurrencyCash:
				newBal := curCash.Add(delta)
				if newBal.IsNegative() {
					return decimal.Zero, v1.NewInsufficientFundError(currency, delta.Abs(), curCash)
				}
				curCash = newBal
				return curCash, nil
			}
			return decimal.Zero, v1.NewInsufficientFundError(currency, delta.Abs(), decimal.Zero)
		},
	}
	acctStr := &mockAcctStorer{}

	userCore := user.NewCore(userStr)
	acctCore := accounting.NewCore(nil, acctStr, userCore, nil, nil)
	snapshot := func() (decimal.Decimal, decimal.Decimal) { return curPlay, curCash }
	return NewCore(userCore, acctCore), accountID, snapshot
}

// ---------------------------------------------------------------------------
// ProcessEvent: INSERT_COIN
// ---------------------------------------------------------------------------

func TestProcessEvent_InsertCoin(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name        string
		coinCount   int
		balance     decimal.Decimal
		wantSuccess bool
	}{
		{
			name:        "default count (0 becomes 1)",
			coinCount:   0,
			balance:     decimal.NewFromInt(100),
			wantSuccess: true,
		},
		{
			name:        "explicit count",
			coinCount:   5,
			balance:     decimal.NewFromInt(100),
			wantSuccess: true,
		},
		{
			name:        "insufficient balance",
			coinCount:   1,
			balance:     decimal.Zero,
			wantSuccess: false,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()

			core, accountID := newTestCore(t, tc.balance)

			result, err := core.ProcessEvent(context.Background(), GameEvent{
				UserID:         accountID,
				Type:           EventInsertCoin,
				CoinCount:      tc.coinCount,
				IdempotencyKey: uuid.NewString(),
			})
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}

			if result.Success != tc.wantSuccess {
				t.Errorf("Success = %v, want %v", result.Success, tc.wantSuccess)
			}

			if tc.wantSuccess && result.BalancePlay == "" {
				t.Error("BalancePlay should be set on success")
			}

			if !tc.wantSuccess && result.Error == "" {
				t.Error("Error should be set on failure")
			}
		})
	}
}

// ---------------------------------------------------------------------------
// ProcessEvent: SPAWN_STACK
// ---------------------------------------------------------------------------

func TestProcessEvent_SpawnStack(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name        string
		stackType   string
		balance     decimal.Decimal
		wantSuccess bool
		wantCost    int
	}{
		{
			name:        "wall (cost=72)",
			stackType:   "wall",
			balance:     decimal.NewFromInt(1000),
			wantSuccess: true,
			wantCost:    72,
		},
		{
			name:        "tower (cost=10)",
			stackType:   "tower",
			balance:     decimal.NewFromInt(1000),
			wantSuccess: true,
			wantCost:    10,
		},
		{
			name:        "pyramid (cost=300)",
			stackType:   "pyramid",
			balance:     decimal.NewFromInt(1000),
			wantSuccess: true,
			wantCost:    300,
		},
		{
			name:        "cylinder (cost=80)",
			stackType:   "cylinder",
			balance:     decimal.NewFromInt(1000),
			wantSuccess: true,
			wantCost:    80,
		},
		{
			name:        "unknown stack type",
			stackType:   "hexagon",
			balance:     decimal.NewFromInt(1000),
			wantSuccess: false,
		},
		{
			name:        "insufficient balance for wall",
			stackType:   "wall",
			balance:     decimal.NewFromInt(10),
			wantSuccess: false,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()

			core, accountID := newTestCore(t, tc.balance)

			result, err := core.ProcessEvent(context.Background(), GameEvent{
				UserID:         accountID,
				Type:           EventSpawnStack,
				StackType:      tc.stackType,
				IdempotencyKey: uuid.NewString(),
			})
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}

			if result.Success != tc.wantSuccess {
				t.Errorf("Success = %v, want %v", result.Success, tc.wantSuccess)
			}

			if !tc.wantSuccess && result.Error == "" {
				t.Error("Error should be set on failure")
			}
		})
	}
}

// ---------------------------------------------------------------------------
// ProcessBatchInsert
// ---------------------------------------------------------------------------

func TestProcessBatchInsert(t *testing.T) {
	t.Parallel()

	core, accountID := newTestCore(t, decimal.NewFromInt(100))

	result, err := core.ProcessBatchInsert(context.Background(), accountID, 5, uuid.NewString(), nil)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	if !result.Success {
		t.Errorf("Success = false, want true; Error = %q", result.Error)
	}

	if result.BalancePlay == "" {
		t.Error("BalancePlay should be set on success")
	}
}

func TestProcessBatchInsert_ZeroCount(t *testing.T) {
	t.Parallel()

	core, accountID := newTestCore(t, decimal.NewFromInt(100))

	result, err := core.ProcessBatchInsert(context.Background(), accountID, 0, uuid.NewString(), nil)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	if result.Success {
		t.Error("Success = true for zero count, want false")
	}
}

func TestProcessBatchInsert_MixedSplit(t *testing.T) {
	t.Parallel()

	// play=2, cash=10; insert 5 → play-first draws 2 from play + 3 from cash.
	core, accountID, snapshot := newTestCoreWithBalances(t, decimal.NewFromInt(2), decimal.NewFromInt(10))

	result, err := core.ProcessBatchInsert(context.Background(), accountID, 5, "ref-mixed", nil)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !result.Success {
		t.Fatalf("expected success, got error=%q", result.Error)
	}
	if result.BalancePlay != "0" {
		t.Errorf("BalancePlay = %q, want 0", result.BalancePlay)
	}
	if result.BalanceCash != "7" {
		t.Errorf("BalanceCash = %q, want 7", result.BalanceCash)
	}
	if result.PlayDebited != "2" {
		t.Errorf("PlayDebited = %q, want 2", result.PlayDebited)
	}
	if result.CashDebited != "3" {
		t.Errorf("CashDebited = %q, want 3", result.CashDebited)
	}

	p, c := snapshot()
	if !p.Equal(decimal.NewFromInt(0)) || !c.Equal(decimal.NewFromInt(7)) {
		t.Errorf("in-memory balances = (%s, %s), want (0, 7)", p, c)
	}
}

func TestRefundBatchInsert_IdempotentReplay(t *testing.T) {
	t.Parallel()

	// Exercises the full WS/HTTP refund-split path at the game.Core layer:
	// insert splits, refund applies exact split with deterministic key, and
	// a retried refund with the same key is a no-op. The in-memory mock is
	// wired to simulate a persisted ledger row after the first refund so the
	// idempotency guard in ProcessGameInsertRefund actually fires and the
	// balance-invariant assertion pins the contract.
	accountID := uuid.New()
	curPlay := decimal.NewFromInt(2)
	curCash := decimal.NewFromInt(10)

	// Track whether the first refund's ledger entries have landed; once set,
	// QueryByReference returns a persisted row and the idempotency guard
	// short-circuits the second call.
	var refundPersisted bool
	var refundRef = "insert-ref-unit4" + accounting.RefundKeySuffix
	// Track credit writes so we can assert the replay issues zero increments.
	var creditCalls int

	userStr := &mockUserStorer{
		queryByIDFn: func(_ context.Context, _ uuid.UUID) (user.Account, error) {
			return user.Account{ID: accountID, BalancePlay: curPlay, BalanceCash: curCash}, nil
		},
		updateBalanceFn: func(_ context.Context, _ uuid.UUID, currency string, delta decimal.Decimal) (decimal.Decimal, error) {
			if delta.Sign() > 0 {
				creditCalls++
			}
			switch currency {
			case user.CurrencyPlay:
				newBal := curPlay.Add(delta)
				if newBal.IsNegative() {
					return decimal.Zero, v1.NewInsufficientFundError(currency, delta.Abs(), curPlay)
				}
				curPlay = newBal
				return curPlay, nil
			case user.CurrencyCash:
				newBal := curCash.Add(delta)
				if newBal.IsNegative() {
					return decimal.Zero, v1.NewInsufficientFundError(currency, delta.Abs(), curCash)
				}
				curCash = newBal
				return curCash, nil
			}
			return decimal.Zero, v1.NewInsufficientFundError(currency, delta.Abs(), decimal.Zero)
		},
	}
	acctStr := &mockAcctStorer{
		queryByReferenceFn: func(_ context.Context, action, ref string) (accounting.AccountingLog, error) {
			// Simulate the real storer: once the refund entries exist, a
			// second refund attempt's idempotency guard must see a hit.
			if refundPersisted && action == accounting.ActionGameInsertRefund && ref == refundRef {
				return accounting.AccountingLog{ActionType: action, ReferenceID: ref}, nil
			}
			return accounting.AccountingLog{}, v1.NewNotFoundError()
		},
	}

	userCore := user.NewCore(userStr)
	acctCore := accounting.NewCore(nil, acctStr, userCore, nil, nil)
	core := NewCore(userCore, acctCore)

	insertResult, err := core.ProcessBatchInsert(context.Background(), accountID, 5, "insert-ref-unit4", nil)
	if err != nil {
		t.Fatalf("insert: %v", err)
	}
	if !insertResult.Success {
		t.Fatalf("insert failed: %s", insertResult.Error)
	}

	playDeb, _ := decimal.NewFromString(insertResult.PlayDebited)
	cashDeb, _ := decimal.NewFromString(insertResult.CashDebited)
	if !playDeb.Equal(decimal.NewFromInt(2)) || !cashDeb.Equal(decimal.NewFromInt(3)) {
		t.Fatalf("expected split (2, 3), got (%s, %s)", playDeb, cashDeb)
	}

	creditCalls = 0 // reset after insert's debits

	// First refund: mock reports no prior entry → guard falls through, credits apply.
	r1, err := core.RefundBatchInsert(context.Background(), accountID, playDeb, cashDeb, refundRef)
	if err != nil {
		t.Fatalf("first refund: %v", err)
	}
	if !r1.Success {
		t.Fatalf("first refund failed: %s", r1.Error)
	}
	if !curPlay.Equal(decimal.NewFromInt(2)) || !curCash.Equal(decimal.NewFromInt(10)) {
		t.Errorf("after first refund balances = (%s, %s), want (2, 10)", curPlay, curCash)
	}
	firstRefundCredits := creditCalls
	if firstRefundCredits != 2 {
		t.Errorf("first refund should issue 2 credit writes (play + cash), got %d", firstRefundCredits)
	}

	// Flip the switch: subsequent QueryByReference sees the "persisted" row.
	refundPersisted = true
	creditCalls = 0

	// Second refund with the same key. The idempotency guard in
	// ProcessGameInsertRefund must see the existing row and short-circuit:
	// zero credit writes, balances unchanged.
	r2, err := core.RefundBatchInsert(context.Background(), accountID, playDeb, cashDeb, refundRef)
	if err != nil {
		t.Fatalf("second refund (replay): %v", err)
	}
	if !r2.Success {
		t.Fatalf("replay reported failure: %s", r2.Error)
	}
	if creditCalls != 0 {
		t.Errorf("idempotent replay should issue zero credit writes, got %d", creditCalls)
	}
	if !curPlay.Equal(decimal.NewFromInt(2)) || !curCash.Equal(decimal.NewFromInt(10)) {
		t.Errorf("after replay balances = (%s, %s), want (2, 10) — the guard was bypassed", curPlay, curCash)
	}
}

func TestRefundBatchInsert_RoundTrip(t *testing.T) {
	t.Parallel()

	// Start at play=2, cash=10. Insert 5 (play-first). Then refund exact split.
	core, accountID, snapshot := newTestCoreWithBalances(t, decimal.NewFromInt(2), decimal.NewFromInt(10))

	insertResult, err := core.ProcessBatchInsert(context.Background(), accountID, 5, "ref-roundtrip", nil)
	if err != nil {
		t.Fatalf("insert error: %v", err)
	}
	if !insertResult.Success {
		t.Fatalf("insert failed: %s", insertResult.Error)
	}

	playDeb, _ := decimal.NewFromString(insertResult.PlayDebited)
	cashDeb, _ := decimal.NewFromString(insertResult.CashDebited)

	refundResult, err := core.RefundBatchInsert(context.Background(), accountID, playDeb, cashDeb, "refund-ref-roundtrip")
	if err != nil {
		t.Fatalf("refund error: %v", err)
	}
	if !refundResult.Success {
		t.Fatalf("refund failed: %s", refundResult.Error)
	}

	// Both balances must be restored to their pre-insert values.
	p, c := snapshot()
	if !p.Equal(decimal.NewFromInt(2)) {
		t.Errorf("play after roundtrip = %s, want 2", p)
	}
	if !c.Equal(decimal.NewFromInt(10)) {
		t.Errorf("cash after roundtrip = %s, want 10", c)
	}
	if refundResult.BalancePlay != "2" || refundResult.BalanceCash != "10" {
		t.Errorf("refund result balances = (%s, %s), want (2, 10)", refundResult.BalancePlay, refundResult.BalanceCash)
	}
}

// ---------------------------------------------------------------------------
// ProcessEvent: Unknown type
// ---------------------------------------------------------------------------

func TestProcessEvent_UnknownType(t *testing.T) {
	t.Parallel()

	core, accountID := newTestCore(t, decimal.NewFromInt(100))

	_, err := core.ProcessEvent(context.Background(), GameEvent{
		UserID: accountID,
		Type:   "UNKNOWN_EVENT",
	})
	if err == nil {
		t.Fatal("expected error for unknown event type")
	}
}

// ---------------------------------------------------------------------------
// Verify StackCoinCosts map
// ---------------------------------------------------------------------------

func TestStackCoinCosts(t *testing.T) {
	t.Parallel()

	expected := map[string]int{
		"wall":     72,
		"tower":    10,
		"pyramid":  300,
		"cylinder": 80,
	}

	for name, cost := range expected {
		if got, ok := StackCoinCosts[name]; !ok {
			t.Errorf("StackCoinCosts missing %q", name)
		} else if got != cost {
			t.Errorf("StackCoinCosts[%q] = %d, want %d", name, got, cost)
		}
	}
}

// Ensure we don't import v1 unused — use it to verify error wrapping.
var _ = v1.ErrInsufficientFund
