package accounting

import (
	"context"
	"errors"
	"testing"
	"time"

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
	queryByAccountIDFn func(ctx context.Context, accountID uuid.UUID, page, pageSize int) ([]AccountingLog, error)
	queryByReferenceFn func(ctx context.Context, actionType, referenceID string) (AccountingLog, error)
}

func (m *mockAcctStorer) Create(ctx context.Context, log AccountingLog) error {
	if m.createFn != nil {
		return m.createFn(ctx, log)
	}
	return nil
}

func (m *mockAcctStorer) QueryByAccountID(ctx context.Context, accountID uuid.UUID, page, pageSize int) ([]AccountingLog, error) {
	if m.queryByAccountIDFn != nil {
		return m.queryByAccountIDFn(ctx, accountID, page, pageSize)
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
	createFn             func(ctx context.Context, acct user.Account) error
	createAuthProviderFn func(ctx context.Context, ap user.AuthProvider) error
	queryByIDFn          func(ctx context.Context, accountID uuid.UUID) (user.Account, error)
	queryByProviderFn    func(ctx context.Context, providerType, providerUID string) (user.Account, error)
	updateBalanceFn      func(ctx context.Context, accountID uuid.UUID, currency string, delta decimal.Decimal) error
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

func (m *mockUserStorer) QueryByProvider(ctx context.Context, providerType, providerUID string) (user.Account, error) {
	if m.queryByProviderFn != nil {
		return m.queryByProviderFn(ctx, providerType, providerUID)
	}
	return user.Account{}, nil
}

func (m *mockUserStorer) UpdateBalance(ctx context.Context, accountID uuid.UUID, currency string, delta decimal.Decimal) error {
	if m.updateBalanceFn != nil {
		return m.updateBalanceFn(ctx, accountID, currency, delta)
	}
	return nil
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

// ---------------------------------------------------------------------------
// ProcessDeposit
// ---------------------------------------------------------------------------

func TestProcessDeposit(t *testing.T) {
	t.Parallel()

	accountID := uuid.New()

	tests := []struct {
		name     string
		acctStr  *mockAcctStorer
		userStr  *mockUserStorer
		currency string
		wantErr  bool
	}{
		{
			name: "new PLAY deposit",
			acctStr: &mockAcctStorer{
				queryByReferenceFn: func(ctx context.Context, actionType, referenceID string) (AccountingLog, error) {
					return AccountingLog{}, v1.NewNotFoundError()
				},
			},
			userStr:  &mockUserStorer{},
			currency: CurrencyPlay,
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
			currency: CurrencyPlay,
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
			currency: CurrencyPlay,
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
			currency: CurrencyPlay,
			wantErr:  true,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()

			userCore := user.NewCore(tc.userStr)
			core := NewCore(tc.acctStr, userCore)

			err := core.ProcessDeposit(context.Background(), accountID, decimal.NewFromInt(100), tc.currency, "tx-hash-123")

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

	accountID := uuid.New()

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
				queryByIDFn: func(ctx context.Context, id uuid.UUID) (user.Account, error) {
					return user.Account{ID: accountID, BalancePlay: tc.balance}, nil
				},
			}
			acctStr := &mockAcctStorer{}

			userCore := user.NewCore(userStr)
			core := NewCore(acctStr, userCore)

			err := core.ProcessGameInsert(context.Background(), accountID, tc.count, "ref-123")

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
// ProcessGameReward
// ---------------------------------------------------------------------------

func TestProcessGameReward(t *testing.T) {
	t.Parallel()

	accountID := uuid.New()

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
	err := core.ProcessGameReward(context.Background(), accountID, amount, "ref-reward-1")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	if updatedCurrency != "CASH" {
		t.Errorf("currency = %q, want CASH", updatedCurrency)
	}
	if !updatedDelta.Equal(amount) {
		t.Errorf("delta = %s, want %s", updatedDelta, amount)
	}
}
