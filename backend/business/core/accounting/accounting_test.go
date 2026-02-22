package accounting

import (
	"context"
	"errors"
	"testing"

	"github.com/google/uuid"
	"github.com/shopspring/decimal"

	"github.com/flamefalcon/coin-pusher/backend/business/core/user"
	v1 "github.com/flamefalcon/coin-pusher/backend/business/web/v1"
)

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

type mockAcctStorer struct {
	createFn           func(ctx context.Context, log AccountingLog) error
	queryByUserIDFn    func(ctx context.Context, userID uuid.UUID, page, pageSize int) ([]AccountingLog, error)
	queryByReferenceFn func(ctx context.Context, actionType, referenceID string) (AccountingLog, error)
}

func (m *mockAcctStorer) Create(ctx context.Context, log AccountingLog) error {
	if m.createFn != nil {
		return m.createFn(ctx, log)
	}
	return nil
}

func (m *mockAcctStorer) QueryByUserID(ctx context.Context, userID uuid.UUID, page, pageSize int) ([]AccountingLog, error) {
	if m.queryByUserIDFn != nil {
		return m.queryByUserIDFn(ctx, userID, page, pageSize)
	}
	return nil, nil
}

func (m *mockAcctStorer) QueryByReference(ctx context.Context, actionType, referenceID string) (AccountingLog, error) {
	if m.queryByReferenceFn != nil {
		return m.queryByReferenceFn(ctx, actionType, referenceID)
	}
	return AccountingLog{}, nil
}

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

// ---------------------------------------------------------------------------
// ProcessDeposit
// ---------------------------------------------------------------------------

func TestProcessDeposit(t *testing.T) {
	t.Parallel()

	userID := uuid.New()

	tests := []struct {
		name     string
		acctStr  *mockAcctStorer
		userStr  *mockUserStorer
		currency string
		wantErr  bool
	}{
		{
			name: "new COIN deposit",
			acctStr: &mockAcctStorer{
				queryByReferenceFn: func(ctx context.Context, actionType, referenceID string) (AccountingLog, error) {
					return AccountingLog{}, v1.NewNotFoundError()
				},
			},
			userStr:  &mockUserStorer{},
			currency: CurrencyCoin,
			wantErr:  false,
		},
		{
			name: "new USDC deposit",
			acctStr: &mockAcctStorer{
				queryByReferenceFn: func(ctx context.Context, actionType, referenceID string) (AccountingLog, error) {
					return AccountingLog{}, v1.NewNotFoundError()
				},
			},
			userStr:  &mockUserStorer{},
			currency: CurrencyUSDC,
			wantErr:  false,
		},
		{
			name: "idempotent - already processed",
			acctStr: &mockAcctStorer{
				queryByReferenceFn: func(ctx context.Context, actionType, referenceID string) (AccountingLog, error) {
					return AccountingLog{LogID: uuid.New()}, nil
				},
			},
			userStr:  &mockUserStorer{},
			currency: CurrencyCoin,
			wantErr:  false,
		},
		{
			name: "storer query error propagates",
			acctStr: &mockAcctStorer{
				queryByReferenceFn: func(ctx context.Context, actionType, referenceID string) (AccountingLog, error) {
					return AccountingLog{}, errors.New("db error")
				},
			},
			userStr:  &mockUserStorer{},
			currency: CurrencyCoin,
			wantErr:  true,
		},
		{
			name: "create log error propagates",
			acctStr: &mockAcctStorer{
				queryByReferenceFn: func(ctx context.Context, actionType, referenceID string) (AccountingLog, error) {
					return AccountingLog{}, v1.NewNotFoundError()
				},
				createFn: func(ctx context.Context, log AccountingLog) error {
					return errors.New("insert failed")
				},
			},
			userStr:  &mockUserStorer{},
			currency: CurrencyCoin,
			wantErr:  true,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()

			userCore := user.NewCore(tc.userStr)
			core := NewCore(tc.acctStr, userCore)

			err := core.ProcessDeposit(context.Background(), userID, decimal.NewFromInt(100), tc.currency, "tx-hash-123")

			if tc.wantErr && err == nil {
				t.Fatal("expected error, got nil")
			}
			if !tc.wantErr && err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
		})
	}
}

// ---------------------------------------------------------------------------
// ProcessGameInsert
// ---------------------------------------------------------------------------

func TestProcessGameInsert(t *testing.T) {
	t.Parallel()

	userID := uuid.New()

	tests := []struct {
		name    string
		balance decimal.Decimal
		count   int
		wantErr bool
	}{
		{
			name:    "sufficient balance",
			balance: decimal.NewFromInt(100),
			count:   5,
			wantErr: false,
		},
		{
			name:    "insufficient balance",
			balance: decimal.NewFromInt(2),
			count:   5,
			wantErr: true,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()

			userStr := &mockUserStorer{
				queryByIDFn: func(ctx context.Context, id uuid.UUID) (user.User, error) {
					return user.User{ID: userID, BalanceCoin: tc.balance}, nil
				},
			}
			acctStr := &mockAcctStorer{}

			userCore := user.NewCore(userStr)
			core := NewCore(acctStr, userCore)

			err := core.ProcessGameInsert(context.Background(), userID, tc.count, "ref-123")

			if tc.wantErr && err == nil {
				t.Fatal("expected error, got nil")
			}
			if !tc.wantErr && err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
		})
	}
}

// ---------------------------------------------------------------------------
// ProcessHeatReward
// ---------------------------------------------------------------------------

func TestProcessHeatReward(t *testing.T) {
	t.Parallel()

	userID := uuid.New()

	var updatedCurrency string
	var updatedDelta decimal.Decimal

	userStr := &mockUserStorer{
		updateBalanceFn: func(ctx context.Context, id uuid.UUID, currency string, delta decimal.Decimal) error {
			updatedCurrency = currency
			updatedDelta = delta
			return nil
		},
	}
	acctStr := &mockAcctStorer{}

	userCore := user.NewCore(userStr)
	core := NewCore(acctStr, userCore)

	amount := decimal.NewFromFloat(10.5)
	err := core.ProcessHeatReward(context.Background(), userID, amount, "ref-reward-1")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	if updatedCurrency != "COIN" {
		t.Errorf("currency = %q, want COIN", updatedCurrency)
	}
	if !updatedDelta.Equal(amount) {
		t.Errorf("delta = %s, want %s", updatedDelta, amount)
	}
}
