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
			core := NewCore(nil, tc.acctStr, userCore, nil, nil)

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
		count   int
		mockBal decimal.Decimal
		mockErr error
		wantErr bool
	}{
		{
			name:    "sufficient balance",
			count:   5,
			mockBal: decimal.NewFromInt(95),
			wantErr: false,
		},
		{
			name:    "insufficient balance",
			count:   5,
			mockErr: v1.NewInsufficientFundError("PLAY", decimal.NewFromInt(5), decimal.NewFromInt(2)),
			wantErr: true,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()

			userStr := &mockUserStorer{
				updateBalanceFn: func(ctx context.Context, id uuid.UUID, currency string, delta decimal.Decimal) (decimal.Decimal, error) {
					if tc.mockErr != nil {
						return decimal.Zero, tc.mockErr
					}
					return tc.mockBal, nil
				},
			}
			acctStr := &mockAcctStorer{}

			userCore := user.NewCore(userStr)
			core := NewCore(nil, acctStr, userCore, nil, nil)

			newPlay, err := core.ProcessGameInsert(context.Background(), accountID, tc.count, "ref-123")

			if tc.wantErr && err == nil {
				t.Fatal("expected error, got nil")
			}
			if !tc.wantErr && err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if !tc.wantErr && !newPlay.Equal(tc.mockBal) {
				t.Errorf("newPlay = %s, want %s", newPlay, tc.mockBal)
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
		updateBalanceFn: func(ctx context.Context, id uuid.UUID, currency string, delta decimal.Decimal) (decimal.Decimal, error) {
			updatedCurrency = currency
			updatedDelta = delta
			return decimal.Zero, nil
		},
	}
	acctStr := &mockAcctStorer{}

	userCore := user.NewCore(userStr)
	core := NewCore(nil, acctStr, userCore, nil, nil)

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
