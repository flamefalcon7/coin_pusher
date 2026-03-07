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
	return accounting.AccountingLog{}, nil
}

func (m *mockAcctStorer) SumByActionSince(_ context.Context, _ string, _ time.Time) (decimal.Decimal, error) {
	return decimal.Zero, nil
}

func (m *mockAcctStorer) SumByPlayerSince(_ context.Context, _ string, _ time.Time) ([]accounting.PlayerSum, error) {
	return nil, nil
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

func newTestCore(t *testing.T, balance decimal.Decimal) (*Core, uuid.UUID) {
	t.Helper()

	accountID := uuid.New()
	currentBalance := balance

	userStr := &mockUserStorer{
		updateBalanceFn: func(ctx context.Context, id uuid.UUID, currency string, delta decimal.Decimal) (decimal.Decimal, error) {
			newBal := currentBalance.Add(delta)
			if newBal.IsNegative() {
				return decimal.Zero, v1.NewInsufficientFundError(currency, delta.Abs(), currentBalance)
			}
			currentBalance = newBal
			return currentBalance, nil
		},
	}
	acctStr := &mockAcctStorer{}

	userCore := user.NewCore(userStr)
	acctCore := accounting.NewCore(nil, acctStr, userCore, nil, nil)
	return NewCore(userCore, acctCore), accountID
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

	result, err := core.ProcessBatchInsert(context.Background(), accountID, 5, uuid.NewString())
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

	result, err := core.ProcessBatchInsert(context.Background(), accountID, 0, uuid.NewString())
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	if result.Success {
		t.Error("Success = true for zero count, want false")
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
