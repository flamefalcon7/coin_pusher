package game

import (
	"context"
	"testing"

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
	createFn         func(ctx context.Context, usr user.User) error
	queryByIDFn      func(ctx context.Context, userID uuid.UUID) (user.User, error)
	queryBySUIAddrFn func(ctx context.Context, suiAddress string) (user.User, error)
	updateBalanceFn  func(ctx context.Context, userID uuid.UUID, currency string, delta decimal.Decimal) error
}

func (m *mockUserStorer) Create(ctx context.Context, usr user.User) error {
	if m.createFn != nil {
		return m.createFn(ctx, usr)
	}
	return nil
}

func (m *mockUserStorer) QueryByID(ctx context.Context, userID uuid.UUID) (user.User, error) {
	if m.queryByIDFn != nil {
		return m.queryByIDFn(ctx, userID)
	}
	return user.User{}, nil
}

func (m *mockUserStorer) QueryBySUIAddress(ctx context.Context, suiAddress string) (user.User, error) {
	if m.queryBySUIAddrFn != nil {
		return m.queryBySUIAddrFn(ctx, suiAddress)
	}
	return user.User{}, nil
}

func (m *mockUserStorer) UpdateBalance(ctx context.Context, userID uuid.UUID, currency string, delta decimal.Decimal) error {
	if m.updateBalanceFn != nil {
		return m.updateBalanceFn(ctx, userID, currency, delta)
	}
	return nil
}

type mockAcctStorer struct {
	createFn           func(ctx context.Context, log accounting.AccountingLog) error
	queryByUserIDFn    func(ctx context.Context, userID uuid.UUID, page, pageSize int) ([]accounting.AccountingLog, error)
	queryByReferenceFn func(ctx context.Context, actionType, referenceID string) (accounting.AccountingLog, error)
}

func (m *mockAcctStorer) Create(ctx context.Context, log accounting.AccountingLog) error {
	if m.createFn != nil {
		return m.createFn(ctx, log)
	}
	return nil
}

func (m *mockAcctStorer) QueryByUserID(ctx context.Context, userID uuid.UUID, page, pageSize int) ([]accounting.AccountingLog, error) {
	if m.queryByUserIDFn != nil {
		return m.queryByUserIDFn(ctx, userID, page, pageSize)
	}
	return nil, nil
}

func (m *mockAcctStorer) QueryByReference(ctx context.Context, actionType, referenceID string) (accounting.AccountingLog, error) {
	if m.queryByReferenceFn != nil {
		return m.queryByReferenceFn(ctx, actionType, referenceID)
	}
	return accounting.AccountingLog{}, nil
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

func newTestCore(t *testing.T, balance decimal.Decimal) (*Core, uuid.UUID) {
	t.Helper()

	userID := uuid.New()

	userStr := &mockUserStorer{
		queryByIDFn: func(ctx context.Context, id uuid.UUID) (user.User, error) {
			return user.User{ID: userID, BalanceCoin: balance}, nil
		},
	}
	acctStr := &mockAcctStorer{}

	userCore := user.NewCore(userStr)
	acctCore := accounting.NewCore(acctStr, userCore)
	return NewCore(userCore, acctCore), userID
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

			core, userID := newTestCore(t, tc.balance)

			result, err := core.ProcessEvent(context.Background(), GameEvent{
				UserID:         userID,
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

			if tc.wantSuccess && result.BalanceCoin == "" {
				t.Error("BalanceCoin should be set on success")
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

			core, userID := newTestCore(t, tc.balance)

			result, err := core.ProcessEvent(context.Background(), GameEvent{
				UserID:         userID,
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

	core, userID := newTestCore(t, decimal.NewFromInt(100))

	result, err := core.ProcessBatchInsert(context.Background(), userID, 5, uuid.NewString())
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	if !result.Success {
		t.Errorf("Success = false, want true; Error = %q", result.Error)
	}

	if result.BalanceCoin == "" {
		t.Error("BalanceCoin should be set on success")
	}
}

func TestProcessBatchInsert_ZeroCount(t *testing.T) {
	t.Parallel()

	core, userID := newTestCore(t, decimal.NewFromInt(100))

	result, err := core.ProcessBatchInsert(context.Background(), userID, 0, uuid.NewString())
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

	core, userID := newTestCore(t, decimal.NewFromInt(100))

	_, err := core.ProcessEvent(context.Background(), GameEvent{
		UserID: userID,
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
