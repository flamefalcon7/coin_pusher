package user

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/shopspring/decimal"

	v1 "github.com/flamefalcon/coin-pusher/backend/business/web/v1"
)

// ---------------------------------------------------------------------------
// Mock
// ---------------------------------------------------------------------------

type mockStorer struct {
	createFn              func(ctx context.Context, acct Account) error
	createAuthProviderFn  func(ctx context.Context, ap AuthProvider) error
	queryByIDFn           func(ctx context.Context, accountID uuid.UUID) (Account, error)
	queryByProviderFn     func(ctx context.Context, providerType, providerUID string) (Account, error)
	updateBalanceFn       func(ctx context.Context, accountID uuid.UUID, currency string, delta decimal.Decimal) error
	createNonceFn         func(ctx context.Context, nonce, address string, expiresAt time.Time) error
	consumeNonceFn        func(ctx context.Context, nonce string) (NonceRecord, error)
	purgeExpiredNoncesFn  func(ctx context.Context) (int64, error)
}

func (m *mockStorer) Create(ctx context.Context, acct Account) error {
	if m.createFn != nil {
		return m.createFn(ctx, acct)
	}
	return nil
}

func (m *mockStorer) CreateAuthProvider(ctx context.Context, ap AuthProvider) error {
	if m.createAuthProviderFn != nil {
		return m.createAuthProviderFn(ctx, ap)
	}
	return nil
}

func (m *mockStorer) QueryByID(ctx context.Context, accountID uuid.UUID) (Account, error) {
	if m.queryByIDFn != nil {
		return m.queryByIDFn(ctx, accountID)
	}
	return Account{}, nil
}

func (m *mockStorer) QueryByProvider(ctx context.Context, providerType, providerUID string) (Account, error) {
	if m.queryByProviderFn != nil {
		return m.queryByProviderFn(ctx, providerType, providerUID)
	}
	return Account{}, nil
}

func (m *mockStorer) UpdateBalance(ctx context.Context, accountID uuid.UUID, currency string, delta decimal.Decimal) error {
	if m.updateBalanceFn != nil {
		return m.updateBalanceFn(ctx, accountID, currency, delta)
	}
	return nil
}

func (m *mockStorer) CreateNonce(ctx context.Context, nonce, address string, expiresAt time.Time) error {
	if m.createNonceFn != nil {
		return m.createNonceFn(ctx, nonce, address, expiresAt)
	}
	return nil
}

func (m *mockStorer) ConsumeNonce(ctx context.Context, nonce string) (NonceRecord, error) {
	if m.consumeNonceFn != nil {
		return m.consumeNonceFn(ctx, nonce)
	}
	return NonceRecord{}, nil
}

func (m *mockStorer) PurgeExpiredNonces(ctx context.Context) (int64, error) {
	if m.purgeExpiredNoncesFn != nil {
		return m.purgeExpiredNoncesFn(ctx)
	}
	return 0, nil
}

// ---------------------------------------------------------------------------
// FindOrCreate
// ---------------------------------------------------------------------------

func TestFindOrCreate(t *testing.T) {
	t.Parallel()

	existingAcct := Account{
		ID:          uuid.New(),
		BalancePlay: decimal.NewFromInt(100),
	}

	tests := []struct {
		name    string
		storer  *mockStorer
		input   NewAccount
		wantErr bool
		check   func(t *testing.T, acct Account)
	}{
		{
			name: "account exists - returns it",
			storer: &mockStorer{
				queryByProviderFn: func(ctx context.Context, pt, uid string) (Account, error) {
					return existingAcct, nil
				},
			},
			input:   NewAccount{ProviderType: "wallet", ProviderUID: "0xexisting"},
			wantErr: false,
			check: func(t *testing.T, acct Account) {
				t.Helper()
				if acct.ID != existingAcct.ID {
					t.Errorf("ID = %v, want %v", acct.ID, existingAcct.ID)
				}
			},
		},
		{
			name: "account not found - creates new",
			storer: &mockStorer{
				queryByProviderFn: func(ctx context.Context, pt, uid string) (Account, error) {
					return Account{}, v1.NewNotFoundError()
				},
				createFn: func(ctx context.Context, acct Account) error {
					return nil
				},
			},
			input:   NewAccount{ProviderType: "wallet", ProviderUID: "0xnew", DisplayName: "alice"},
			wantErr: false,
			check: func(t *testing.T, acct Account) {
				t.Helper()
				if acct.DisplayName != "alice" {
					t.Errorf("DisplayName = %q, want %q", acct.DisplayName, "alice")
				}
				if acct.ID == uuid.Nil {
					t.Error("new account should have non-nil UUID")
				}
			},
		},
		{
			name: "storer error propagates",
			storer: &mockStorer{
				queryByProviderFn: func(ctx context.Context, pt, uid string) (Account, error) {
					return Account{}, errors.New("db connection lost")
				},
			},
			input:   NewAccount{ProviderType: "wallet", ProviderUID: "0xerr"},
			wantErr: true,
		},
		{
			name: "create error propagates",
			storer: &mockStorer{
				queryByProviderFn: func(ctx context.Context, pt, uid string) (Account, error) {
					return Account{}, v1.NewNotFoundError()
				},
				createFn: func(ctx context.Context, acct Account) error {
					return errors.New("insert failed")
				},
			},
			input:   NewAccount{ProviderType: "wallet", ProviderUID: "0xfail"},
			wantErr: true,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()

			core := NewCore(tc.storer)
			acct, err := core.FindOrCreate(context.Background(), tc.input)

			if tc.wantErr && err == nil {
				t.Fatal("expected error, got nil")
			}
			if !tc.wantErr && err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if tc.check != nil {
				tc.check(t, acct)
			}
		})
	}
}

// ---------------------------------------------------------------------------
// QueryByID
// ---------------------------------------------------------------------------

func TestQueryByID(t *testing.T) {
	t.Parallel()

	wantAcct := Account{ID: uuid.New(), DisplayName: "query-test"}

	tests := []struct {
		name    string
		storer  *mockStorer
		wantErr bool
	}{
		{
			name: "found",
			storer: &mockStorer{
				queryByIDFn: func(ctx context.Context, accountID uuid.UUID) (Account, error) {
					return wantAcct, nil
				},
			},
			wantErr: false,
		},
		{
			name: "not found",
			storer: &mockStorer{
				queryByIDFn: func(ctx context.Context, accountID uuid.UUID) (Account, error) {
					return Account{}, v1.NewNotFoundError()
				},
			},
			wantErr: true,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()

			core := NewCore(tc.storer)
			acct, err := core.QueryByID(context.Background(), wantAcct.ID)

			if tc.wantErr && err == nil {
				t.Fatal("expected error")
			}
			if !tc.wantErr && err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if !tc.wantErr && acct.ID != wantAcct.ID {
				t.Errorf("ID = %v, want %v", acct.ID, wantAcct.ID)
			}
		})
	}
}

// ---------------------------------------------------------------------------
// DecrementPlayBalance
// ---------------------------------------------------------------------------

func TestDecrementPlayBalance(t *testing.T) {
	t.Parallel()

	accountID := uuid.New()

	tests := []struct {
		name       string
		balance    decimal.Decimal
		amount     decimal.Decimal
		wantErr    bool
		wantInsuff bool
	}{
		{
			name:    "sufficient balance",
			balance: decimal.NewFromInt(100),
			amount:  decimal.NewFromInt(50),
			wantErr: false,
		},
		{
			name:       "insufficient balance",
			balance:    decimal.NewFromInt(5),
			amount:     decimal.NewFromInt(10),
			wantErr:    true,
			wantInsuff: true,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()

			storer := &mockStorer{
				queryByIDFn: func(ctx context.Context, id uuid.UUID) (Account, error) {
					return Account{ID: accountID, BalancePlay: tc.balance}, nil
				},
				updateBalanceFn: func(ctx context.Context, id uuid.UUID, currency string, delta decimal.Decimal) error {
					if currency != "PLAY" {
						t.Errorf("currency = %q, want PLAY", currency)
					}
					if !delta.IsNegative() {
						t.Error("delta should be negative for decrement")
					}
					return nil
				},
			}

			core := NewCore(storer)
			err := core.DecrementPlayBalance(context.Background(), accountID, tc.amount)

			if tc.wantErr && err == nil {
				t.Fatal("expected error")
			}
			if !tc.wantErr && err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if tc.wantInsuff && !errors.Is(err, v1.ErrInsufficientFund) {
				t.Errorf("should be ErrInsufficientFund, got: %v", err)
			}
		})
	}
}

// ---------------------------------------------------------------------------
// IncrementPlayBalance
// ---------------------------------------------------------------------------

func TestIncrementPlayBalance(t *testing.T) {
	t.Parallel()

	accountID := uuid.New()
	var gotCurrency string
	var gotDelta decimal.Decimal

	storer := &mockStorer{
		updateBalanceFn: func(ctx context.Context, id uuid.UUID, currency string, delta decimal.Decimal) error {
			gotCurrency = currency
			gotDelta = delta
			return nil
		},
	}

	core := NewCore(storer)
	err := core.IncrementPlayBalance(context.Background(), accountID, decimal.NewFromInt(25))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	if gotCurrency != "PLAY" {
		t.Errorf("currency = %q, want PLAY", gotCurrency)
	}
	if !gotDelta.Equal(decimal.NewFromInt(25)) {
		t.Errorf("delta = %s, want 25", gotDelta)
	}
}

// ---------------------------------------------------------------------------
// IncrementUSDCBalance
// ---------------------------------------------------------------------------

func TestIncrementUSDCBalance(t *testing.T) {
	t.Parallel()

	accountID := uuid.New()
	var gotCurrency string

	storer := &mockStorer{
		updateBalanceFn: func(ctx context.Context, id uuid.UUID, currency string, delta decimal.Decimal) error {
			gotCurrency = currency
			return nil
		},
	}

	core := NewCore(storer)
	err := core.IncrementUSDCBalance(context.Background(), accountID, decimal.NewFromInt(10))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	if gotCurrency != "USDC" {
		t.Errorf("currency = %q, want USDC", gotCurrency)
	}
}

// ---------------------------------------------------------------------------
// IncrementCashBalance
// ---------------------------------------------------------------------------

func TestIncrementCashBalance(t *testing.T) {
	t.Parallel()

	accountID := uuid.New()
	var gotCurrency string

	storer := &mockStorer{
		updateBalanceFn: func(ctx context.Context, id uuid.UUID, currency string, delta decimal.Decimal) error {
			gotCurrency = currency
			return nil
		},
	}

	core := NewCore(storer)
	err := core.IncrementCashBalance(context.Background(), accountID, decimal.NewFromInt(10))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	if gotCurrency != "CASH" {
		t.Errorf("currency = %q, want CASH", gotCurrency)
	}
}

// ---------------------------------------------------------------------------
// GenerateNonce
// ---------------------------------------------------------------------------

func TestGenerateNonce(t *testing.T) {
	t.Parallel()

	var storedNonce string
	storer := &mockStorer{
		createNonceFn: func(ctx context.Context, nonce, address string, expiresAt time.Time) error {
			storedNonce = nonce
			if address != "" {
				t.Errorf("address should be empty, got %q", address)
			}
			if time.Until(expiresAt) < 4*time.Minute {
				t.Error("expiry too short")
			}
			return nil
		},
	}

	core := NewCore(storer)
	rec, err := core.GenerateNonce(context.Background())
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	if rec.Nonce == "" {
		t.Error("nonce should not be empty")
	}
	if rec.Nonce != storedNonce {
		t.Errorf("returned nonce %q != stored nonce %q", rec.Nonce, storedNonce)
	}
	if len(rec.Nonce) != 64 { // 32 bytes = 64 hex chars
		t.Errorf("nonce length = %d, want 64", len(rec.Nonce))
	}
}

// ---------------------------------------------------------------------------
// VerifyWalletLogin
// ---------------------------------------------------------------------------

func TestVerifyWalletLogin(t *testing.T) {
	t.Parallel()

	// We can't easily sign messages in a unit test without importing
	// go-ethereum/crypto, so we test the error paths here. The happy path
	// is covered by the handler integration test using the ethereum package.

	tests := []struct {
		name    string
		storer  *mockStorer
		nonce   string
		sig     string
		address string
		wantErr bool
	}{
		{
			name: "expired nonce",
			storer: &mockStorer{
				consumeNonceFn: func(ctx context.Context, nonce string) (NonceRecord, error) {
					return NonceRecord{}, v1.NewRequestError(v1.ErrNotFound, 401)
				},
			},
			nonce:   "expired-nonce",
			sig:     "0x" + "aa" + repeatHex("bb", 64),
			address: "0x0000000000000000000000000000000000000001",
			wantErr: true,
		},
		{
			name: "invalid signature format",
			storer: &mockStorer{
				consumeNonceFn: func(ctx context.Context, nonce string) (NonceRecord, error) {
					return NonceRecord{Nonce: nonce}, nil
				},
			},
			nonce:   "test-nonce",
			sig:     "not-a-hex-sig",
			address: "0x0000000000000000000000000000000000000001",
			wantErr: true,
		},
		{
			name: "invalid address",
			storer: &mockStorer{
				consumeNonceFn: func(ctx context.Context, nonce string) (NonceRecord, error) {
					return NonceRecord{Nonce: nonce}, nil
				},
			},
			nonce:   "test-nonce",
			sig:     "0xdeadbeef",
			address: "not-an-address",
			wantErr: true,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()

			core := NewCore(tc.storer)
			_, err := core.VerifyWalletLogin(context.Background(), tc.nonce, tc.sig, tc.address)

			if tc.wantErr && err == nil {
				t.Fatal("expected error, got nil")
			}
			if !tc.wantErr && err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
		})
	}
}

// repeatHex returns n bytes as hex (2n hex chars).
func repeatHex(hexByte string, n int) string {
	s := ""
	for i := 0; i < n; i++ {
		s += hexByte
	}
	return s
}
