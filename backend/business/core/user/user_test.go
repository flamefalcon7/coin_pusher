package user

import (
	"context"
	"errors"
	"testing"

	"github.com/google/uuid"
	"github.com/shopspring/decimal"

	v1 "github.com/flamefalcon/coin-pusher/backend/business/web/v1"
)

// ---------------------------------------------------------------------------
// Mock
// ---------------------------------------------------------------------------

type mockUserStorer struct {
	createFn         func(ctx context.Context, usr User) error
	queryByIDFn      func(ctx context.Context, userID uuid.UUID) (User, error)
	queryBySUIAddrFn func(ctx context.Context, suiAddress string) (User, error)
	updateBalanceFn  func(ctx context.Context, userID uuid.UUID, currency string, delta decimal.Decimal) error
}

func (m *mockUserStorer) Create(ctx context.Context, usr User) error {
	if m.createFn != nil {
		return m.createFn(ctx, usr)
	}
	return nil
}

func (m *mockUserStorer) QueryByID(ctx context.Context, userID uuid.UUID) (User, error) {
	if m.queryByIDFn != nil {
		return m.queryByIDFn(ctx, userID)
	}
	return User{}, nil
}

func (m *mockUserStorer) QueryBySUIAddress(ctx context.Context, suiAddress string) (User, error) {
	if m.queryBySUIAddrFn != nil {
		return m.queryBySUIAddrFn(ctx, suiAddress)
	}
	return User{}, nil
}

func (m *mockUserStorer) UpdateBalance(ctx context.Context, userID uuid.UUID, currency string, delta decimal.Decimal) error {
	if m.updateBalanceFn != nil {
		return m.updateBalanceFn(ctx, userID, currency, delta)
	}
	return nil
}

// ---------------------------------------------------------------------------
// FindOrCreate
// ---------------------------------------------------------------------------

func TestFindOrCreate(t *testing.T) {
	t.Parallel()

	existingUser := User{
		ID:          uuid.New(),
		SUIAddress:  "0xexisting",
		BalanceCoin: decimal.NewFromInt(100),
	}

	tests := []struct {
		name    string
		storer  *mockUserStorer
		input   NewUser
		wantErr bool
		check   func(t *testing.T, usr User)
	}{
		{
			name: "user exists - returns it",
			storer: &mockUserStorer{
				queryBySUIAddrFn: func(ctx context.Context, suiAddress string) (User, error) {
					return existingUser, nil
				},
			},
			input:   NewUser{SUIAddress: "0xexisting"},
			wantErr: false,
			check: func(t *testing.T, usr User) {
				t.Helper()
				if usr.ID != existingUser.ID {
					t.Errorf("ID = %v, want %v", usr.ID, existingUser.ID)
				}
			},
		},
		{
			name: "user not found - creates new",
			storer: &mockUserStorer{
				queryBySUIAddrFn: func(ctx context.Context, suiAddress string) (User, error) {
					return User{}, v1.NewNotFoundError()
				},
				createFn: func(ctx context.Context, usr User) error {
					return nil
				},
			},
			input:   NewUser{SUIAddress: "0xnew", Name: "alice"},
			wantErr: false,
			check: func(t *testing.T, usr User) {
				t.Helper()
				if usr.SUIAddress != "0xnew" {
					t.Errorf("SUIAddress = %q, want %q", usr.SUIAddress, "0xnew")
				}
				if usr.ID == uuid.Nil {
					t.Error("new user should have non-nil UUID")
				}
			},
		},
		{
			name: "storer error propagates",
			storer: &mockUserStorer{
				queryBySUIAddrFn: func(ctx context.Context, suiAddress string) (User, error) {
					return User{}, errors.New("db connection lost")
				},
			},
			input:   NewUser{SUIAddress: "0xerr"},
			wantErr: true,
		},
		{
			name: "create error propagates",
			storer: &mockUserStorer{
				queryBySUIAddrFn: func(ctx context.Context, suiAddress string) (User, error) {
					return User{}, v1.NewNotFoundError()
				},
				createFn: func(ctx context.Context, usr User) error {
					return errors.New("insert failed")
				},
			},
			input:   NewUser{SUIAddress: "0xfail"},
			wantErr: true,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()

			core := NewCore(tc.storer)
			usr, err := core.FindOrCreate(context.Background(), tc.input)

			if tc.wantErr && err == nil {
				t.Fatal("expected error, got nil")
			}
			if !tc.wantErr && err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if tc.check != nil {
				tc.check(t, usr)
			}
		})
	}
}

// ---------------------------------------------------------------------------
// QueryByID
// ---------------------------------------------------------------------------

func TestQueryByID(t *testing.T) {
	t.Parallel()

	wantUser := User{ID: uuid.New(), SUIAddress: "0xquery"}

	tests := []struct {
		name    string
		storer  *mockUserStorer
		wantErr bool
	}{
		{
			name: "found",
			storer: &mockUserStorer{
				queryByIDFn: func(ctx context.Context, userID uuid.UUID) (User, error) {
					return wantUser, nil
				},
			},
			wantErr: false,
		},
		{
			name: "not found",
			storer: &mockUserStorer{
				queryByIDFn: func(ctx context.Context, userID uuid.UUID) (User, error) {
					return User{}, v1.NewNotFoundError()
				},
			},
			wantErr: true,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()

			core := NewCore(tc.storer)
			usr, err := core.QueryByID(context.Background(), wantUser.ID)

			if tc.wantErr && err == nil {
				t.Fatal("expected error")
			}
			if !tc.wantErr && err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if !tc.wantErr && usr.ID != wantUser.ID {
				t.Errorf("ID = %v, want %v", usr.ID, wantUser.ID)
			}
		})
	}
}

// ---------------------------------------------------------------------------
// DecrementCoinBalance
// ---------------------------------------------------------------------------

func TestDecrementCoinBalance(t *testing.T) {
	t.Parallel()

	userID := uuid.New()

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

			storer := &mockUserStorer{
				queryByIDFn: func(ctx context.Context, id uuid.UUID) (User, error) {
					return User{ID: userID, BalanceCoin: tc.balance}, nil
				},
				updateBalanceFn: func(ctx context.Context, id uuid.UUID, currency string, delta decimal.Decimal) error {
					if currency != "COIN" {
						t.Errorf("currency = %q, want COIN", currency)
					}
					if !delta.IsNegative() {
						t.Error("delta should be negative for decrement")
					}
					return nil
				},
			}

			core := NewCore(storer)
			err := core.DecrementCoinBalance(context.Background(), userID, tc.amount)

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
// IncrementCoinBalance
// ---------------------------------------------------------------------------

func TestIncrementCoinBalance(t *testing.T) {
	t.Parallel()

	userID := uuid.New()
	var gotCurrency string
	var gotDelta decimal.Decimal

	storer := &mockUserStorer{
		updateBalanceFn: func(ctx context.Context, id uuid.UUID, currency string, delta decimal.Decimal) error {
			gotCurrency = currency
			gotDelta = delta
			return nil
		},
	}

	core := NewCore(storer)
	err := core.IncrementCoinBalance(context.Background(), userID, decimal.NewFromInt(25))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	if gotCurrency != "COIN" {
		t.Errorf("currency = %q, want COIN", gotCurrency)
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

	userID := uuid.New()
	var gotCurrency string

	storer := &mockUserStorer{
		updateBalanceFn: func(ctx context.Context, id uuid.UUID, currency string, delta decimal.Decimal) error {
			gotCurrency = currency
			return nil
		},
	}

	core := NewCore(storer)
	err := core.IncrementUSDCBalance(context.Background(), userID, decimal.NewFromInt(10))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	if gotCurrency != "USDC" {
		t.Errorf("currency = %q, want USDC", gotCurrency)
	}
}
