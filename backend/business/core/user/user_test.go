package user

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/lib/pq"
	"github.com/shopspring/decimal"

	v1 "github.com/flamefalcon/coin-pusher/backend/business/web/v1"
)

// newPQUniqueViolation creates a pq.Error that mimics a PostgreSQL unique violation (23505).
func newPQUniqueViolation() error {
	return &pq.Error{Code: "23505", Message: "duplicate key value"}
}

// ---------------------------------------------------------------------------
// Mock
// ---------------------------------------------------------------------------

type mockStorer struct {
	createFn              func(ctx context.Context, acct Account) error
	createAuthProviderFn  func(ctx context.Context, ap AuthProvider) error
	queryByIDFn           func(ctx context.Context, accountID uuid.UUID) (Account, error)
	queryByProviderFn     func(ctx context.Context, providerType, providerUID string) (Account, error)
	updateBalanceFn       func(ctx context.Context, accountID uuid.UUID, currency string, delta decimal.Decimal) (decimal.Decimal, error)
	setRoleFn             func(ctx context.Context, accountID uuid.UUID, role string) error
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

func (m *mockStorer) QueryByIDForUpdate(ctx context.Context, accountID uuid.UUID) (Account, error) {
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

func (m *mockStorer) UpdateBalance(ctx context.Context, accountID uuid.UUID, currency string, delta decimal.Decimal) (decimal.Decimal, error) {
	if m.updateBalanceFn != nil {
		return m.updateBalanceFn(ctx, accountID, currency, delta)
	}
	return decimal.Zero, nil
}

func (m *mockStorer) SetRole(ctx context.Context, accountID uuid.UUID, role string) error {
	if m.setRoleFn != nil {
		return m.setRoleFn(ctx, accountID, role)
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

func (m *mockStorer) QueryByReferralCode(_ context.Context, _ string) (Account, error) {
	return Account{}, v1.NewRequestError(v1.ErrNotFound, 404)
}
func (m *mockStorer) SetDisplayName(_ context.Context, _ uuid.UUID, _ string) error { return nil }
func (m *mockStorer) SetReferralCode(_ context.Context, _ uuid.UUID, _ string) error { return nil }
func (m *mockStorer) SetReferredBy(_ context.Context, _, _ uuid.UUID) error          { return nil }
func (m *mockStorer) IncrementLifetimeDeposit(_ context.Context, _ uuid.UUID, _ decimal.Decimal) error {
	return nil
}
func (m *mockStorer) MarkReferralRewardPaid(_ context.Context, _ uuid.UUID) error { return nil }
func (m *mockStorer) CountReferrals(_ context.Context, _ uuid.UUID) (int, error)  { return 0, nil }
func (m *mockStorer) QueryWalletAddress(_ context.Context, _ uuid.UUID) (string, error) {
	return "", nil
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
			input:   NewAccount{ProviderType: "wallet", ProviderUID: "0xnew"},
			wantErr: false,
			check: func(t *testing.T, acct Account) {
				t.Helper()
				if acct.DisplayName != nil {
					t.Errorf("DisplayName = %v, want nil", acct.DisplayName)
				}
				if acct.ID == uuid.Nil {
					t.Error("new account should have non-nil UUID")
				}
				if acct.ReferralCode == "" {
					t.Error("new account should have auto-generated referral code")
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

func TestFindOrCreate_ConcurrentRace(t *testing.T) {
	t.Parallel()

	existingAcct := Account{
		ID:          uuid.New(),
		BalancePlay: decimal.NewFromInt(100),
	}

	// Simulate: QueryByProvider returns not-found, Create succeeds (orphaned row),
	// but CreateAuthProvider hits unique violation. Should fall back to QueryByProvider.
	calls := 0
	storer := &mockStorer{
		queryByProviderFn: func(ctx context.Context, pt, uid string) (Account, error) {
			calls++
			if calls == 1 {
				return Account{}, v1.NewNotFoundError()
			}
			// Second call (fallback after unique violation) returns the existing account.
			return existingAcct, nil
		},
		createAuthProviderFn: func(ctx context.Context, ap AuthProvider) error {
			return newPQUniqueViolation()
		},
	}

	core := NewCore(storer)
	acct, err := core.FindOrCreate(context.Background(), NewAccount{
		ProviderType: "wallet",
		ProviderUID:  "0xrace",
	})

	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if acct.ID != existingAcct.ID {
		t.Errorf("should return existing account, got ID %v want %v", acct.ID, existingAcct.ID)
	}
}

// ---------------------------------------------------------------------------
// QueryByID
// ---------------------------------------------------------------------------

func TestQueryByID(t *testing.T) {
	t.Parallel()

	dn := "query-test"
	wantAcct := Account{ID: uuid.New(), DisplayName: &dn}

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
		amount     decimal.Decimal
		mockReturn decimal.Decimal
		mockErr    error
		wantErr    bool
		wantInsuff bool
		wantBal    decimal.Decimal
	}{
		{
			name:       "sufficient balance",
			amount:     decimal.NewFromInt(50),
			mockReturn: decimal.NewFromInt(50),
			wantErr:    false,
			wantBal:    decimal.NewFromInt(50),
		},
		{
			name:       "insufficient balance",
			amount:     decimal.NewFromInt(10),
			mockErr:    v1.NewInsufficientFundError("PLAY", decimal.NewFromInt(10), decimal.NewFromInt(5)),
			wantErr:    true,
			wantInsuff: true,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()

			storer := &mockStorer{
				updateBalanceFn: func(ctx context.Context, id uuid.UUID, currency string, delta decimal.Decimal) (decimal.Decimal, error) {
					if currency != "PLAY" {
						t.Errorf("currency = %q, want PLAY", currency)
					}
					if !delta.IsNegative() {
						t.Error("delta should be negative for decrement")
					}
					return tc.mockReturn, tc.mockErr
				},
			}

			core := NewCore(storer)
			bal, err := core.DecrementPlayBalance(context.Background(), accountID, tc.amount)

			if tc.wantErr && err == nil {
				t.Fatal("expected error")
			}
			if !tc.wantErr && err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if tc.wantInsuff && !errors.Is(err, v1.ErrInsufficientFund) {
				t.Errorf("should be ErrInsufficientFund, got: %v", err)
			}
			if !tc.wantErr && !bal.Equal(tc.wantBal) {
				t.Errorf("balance = %s, want %s", bal, tc.wantBal)
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
		updateBalanceFn: func(ctx context.Context, id uuid.UUID, currency string, delta decimal.Decimal) (decimal.Decimal, error) {
			gotCurrency = currency
			gotDelta = delta
			return decimal.Zero, nil
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
		updateBalanceFn: func(ctx context.Context, id uuid.UUID, currency string, delta decimal.Decimal) (decimal.Decimal, error) {
			gotCurrency = currency
			return decimal.Zero, nil
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
		updateBalanceFn: func(ctx context.Context, id uuid.UUID, currency string, delta decimal.Decimal) (decimal.Decimal, error) {
			gotCurrency = currency
			return decimal.Zero, nil
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
// DecrementForInsert
// ---------------------------------------------------------------------------

func TestDecrementForInsert(t *testing.T) {
	t.Parallel()

	accountID := uuid.New()

	tests := []struct {
		name        string
		play        int64
		cash        int64
		amount      int64
		wantErr     bool
		wantInsuff  bool
		wantPlayDeb int64
		wantCashDeb int64
		wantNewPlay int64
		wantNewCash int64
	}{
		{
			name: "pure play source", play: 10, cash: 5, amount: 3,
			wantPlayDeb: 3, wantCashDeb: 0, wantNewPlay: 7, wantNewCash: 5,
		},
		{
			name: "pure cash source (play empty)", play: 0, cash: 5, amount: 3,
			wantPlayDeb: 0, wantCashDeb: 3, wantNewPlay: 0, wantNewCash: 2,
		},
		{
			name: "mixed cross-currency draw", play: 2, cash: 10, amount: 5,
			wantPlayDeb: 2, wantCashDeb: 3, wantNewPlay: 0, wantNewCash: 7,
		},
		{
			name: "exact play boundary", play: 5, cash: 5, amount: 5,
			wantPlayDeb: 5, wantCashDeb: 0, wantNewPlay: 0, wantNewCash: 5,
		},
		{
			name: "insufficient combined balance", play: 2, cash: 2, amount: 5,
			wantErr: true, wantInsuff: true,
		},
		{
			name: "zero amount is a no-op", play: 3, cash: 3, amount: 0,
			wantPlayDeb: 0, wantCashDeb: 0, wantNewPlay: 3, wantNewCash: 3,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()

			play := decimal.NewFromInt(tc.play)
			cash := decimal.NewFromInt(tc.cash)

			var updates []struct {
				currency string
				delta    decimal.Decimal
			}

			storer := &mockStorer{
				queryByIDFn: func(_ context.Context, _ uuid.UUID) (Account, error) {
					return Account{
						ID:          accountID,
						BalancePlay: play,
						BalanceCash: cash,
					}, nil
				},
				updateBalanceFn: func(_ context.Context, _ uuid.UUID, currency string, delta decimal.Decimal) (decimal.Decimal, error) {
					updates = append(updates, struct {
						currency string
						delta    decimal.Decimal
					}{currency, delta})
					switch currency {
					case "PLAY":
						play = play.Add(delta)
						return play, nil
					case "CASH":
						cash = cash.Add(delta)
						return cash, nil
					}
					return decimal.Zero, errors.New("unexpected currency")
				},
			}

			core := NewCore(storer)
			pd, cd, np, nc, err := core.DecrementForInsert(
				context.Background(), accountID, decimal.NewFromInt(tc.amount),
			)

			if tc.wantErr {
				if err == nil {
					t.Fatal("expected error, got nil")
				}
				if tc.wantInsuff && !errors.Is(err, v1.ErrInsufficientFund) {
					t.Errorf("should wrap ErrInsufficientFund, got: %v", err)
				}
				// No writes should have occurred on error.
				if len(updates) != 0 {
					t.Errorf("expected no balance updates on error, got %d", len(updates))
				}
				return
			}

			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if !pd.Equal(decimal.NewFromInt(tc.wantPlayDeb)) {
				t.Errorf("playDeb = %s, want %d", pd, tc.wantPlayDeb)
			}
			if !cd.Equal(decimal.NewFromInt(tc.wantCashDeb)) {
				t.Errorf("cashDeb = %s, want %d", cd, tc.wantCashDeb)
			}
			if !np.Equal(decimal.NewFromInt(tc.wantNewPlay)) {
				t.Errorf("newPlay = %s, want %d", np, tc.wantNewPlay)
			}
			if !nc.Equal(decimal.NewFromInt(tc.wantNewCash)) {
				t.Errorf("newCash = %s, want %d", nc, tc.wantNewCash)
			}

			// Verify we skipped writes for zero legs.
			wantWrites := 0
			if tc.wantPlayDeb > 0 {
				wantWrites++
			}
			if tc.wantCashDeb > 0 {
				wantWrites++
			}
			if len(updates) != wantWrites {
				t.Errorf("balance updates = %d, want %d (updates=%+v)", len(updates), wantWrites, updates)
			}
			// All writes must be negative deltas (decrements).
			for _, u := range updates {
				if !u.delta.IsNegative() {
					t.Errorf("expected negative delta, got %s for %s", u.delta, u.currency)
				}
			}
			// Conservation: new totals must equal old totals minus amount.
			gotTotal := np.Add(nc)
			wantTotal := decimal.NewFromInt(tc.play + tc.cash - tc.amount)
			if !gotTotal.Equal(wantTotal) {
				t.Errorf("conservation violated: new total %s, want %s", gotTotal, wantTotal)
			}
		})
	}
}

// TestDecrementForInsert_PartialFailureLeavesPlayDebited documents (and pins)
// the contract that DecrementForInsert relies on its caller's enclosing
// transaction for atomicity. When the second UpdateBalance (CASH) fails after
// the first (PLAY) has already written, this primitive returns the error but
// does NOT itself rollback the play debit. It is the caller's execTx that must
// observe the error and roll the whole transaction back.
//
// If the contract ever changes — e.g., a future maintainer unconditionally
// unexports this primitive, or an alternate caller is added that doesn't wrap
// it in a transaction — this test will either need deletion or a strengthening
// assertion about internal rollback. It exists so such a change is a loud
// edit, not a silent one.
func TestDecrementForInsert_PartialFailureLeavesPlayDebited(t *testing.T) {
	t.Parallel()

	accountID := uuid.New()
	// Start: play=10, cash=5. Insert 12 → playDeb=10, cashDeb=2.
	play := decimal.NewFromInt(10)
	cash := decimal.NewFromInt(5)

	storer := &mockStorer{
		queryByIDFn: func(_ context.Context, _ uuid.UUID) (Account, error) {
			return Account{ID: accountID, BalancePlay: play, BalanceCash: cash}, nil
		},
		updateBalanceFn: func(_ context.Context, _ uuid.UUID, currency string, delta decimal.Decimal) (decimal.Decimal, error) {
			switch currency {
			case CurrencyPlay:
				play = play.Add(delta)
				return play, nil
			case CurrencyCash:
				// Simulate lock-wait-timeout / transient DB failure on the second leg.
				return decimal.Zero, errors.New("simulated cash update failure")
			}
			return decimal.Zero, errors.New("unexpected currency")
		},
	}

	core := NewCore(storer)
	_, _, _, _, err := core.DecrementForInsert(
		context.Background(), accountID, decimal.NewFromInt(12),
	)
	if err == nil {
		t.Fatal("expected error from cash-leg failure, got nil")
	}

	// Contract: PLAY leg has been written (no internal rollback). In production
	// the enclosing execTx observes err != nil and rolls the whole tx back —
	// the DB is the safety net, not this primitive. Assert on the in-memory
	// mock state to make this visible.
	if !play.Equal(decimal.NewFromInt(0)) {
		t.Errorf("play leg should have been written before cash leg failure; "+
			"got play=%s, want 0 (10 - 10)", play)
	}
	if !cash.Equal(decimal.NewFromInt(5)) {
		t.Errorf("cash leg must not have been written on failure; got cash=%s, want 5", cash)
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
			_, err := core.VerifyWalletLogin(context.Background(), tc.nonce, tc.sig, tc.address, "")

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

// ---------------------------------------------------------------------------
// ValidateName
// ---------------------------------------------------------------------------

func TestValidateName(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name    string
		input   string
		min     int
		max     int
		wantErr bool
		errMsg  string
	}{
		{"valid simple", "alice", 3, 20, false, ""},
		{"valid with numbers", "player123", 3, 20, false, ""},
		{"valid with underscore", "cool_name", 3, 20, false, ""},
		{"valid with hyphen", "cool-name", 3, 20, false, ""},
		{"valid min length", "abc", 3, 20, false, ""},
		{"valid max length", "abcdefghijklmnopqrst", 3, 20, false, ""},

		{"too short", "ab", 3, 20, true, "must be 3-20 characters"},
		{"too long", "abcdefghijklmnopqrstu", 3, 20, true, "must be 3-20 characters"},
		{"empty", "", 3, 20, true, "must be 3-20 characters"},

		{"has space", "no spaces", 3, 20, true, "only letters, numbers"},
		{"has dot", "no.dots", 3, 20, true, "only letters, numbers"},
		{"has unicode", "名前test", 3, 20, true, "only letters, numbers"},
		{"has emoji", "test🔥", 3, 20, true, "only letters, numbers"},

		{"reserved admin", "admin", 3, 20, true, "reserved"},
		{"reserved ADMIN case", "ADMIN", 3, 20, true, "reserved"},
		{"reserved system", "system", 3, 20, true, "reserved"},
		{"reserved coinpusher", "CoinPusher", 3, 20, true, "reserved"},
		{"reserved null", "null", 3, 20, true, "reserved"},
		{"reserved undefined", "undefined", 3, 20, true, "reserved"},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()

			err := ValidateName(tc.input, tc.min, tc.max)
			if tc.wantErr {
				if err == nil {
					t.Fatal("expected error, got nil")
				}
				if tc.errMsg != "" && !strings.Contains(err.Error(), tc.errMsg) {
					t.Errorf("error = %q, want to contain %q", err.Error(), tc.errMsg)
				}
			} else {
				if err != nil {
					t.Fatalf("unexpected error: %v", err)
				}
			}
		})
	}
}

// ---------------------------------------------------------------------------
// generateReferralCode
// ---------------------------------------------------------------------------

func TestGenerateReferralCode(t *testing.T) {
	t.Parallel()

	code, err := generateReferralCode()
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	// Format: xxxx-xxxx (9 chars with hyphen).
	if len(code) != 9 {
		t.Errorf("code length = %d, want 9", len(code))
	}
	if code[4] != '-' {
		t.Errorf("code[4] = %q, want '-'", code[4])
	}

	// All chars must be from the lowercase charset (no 0/o/1/i/l).
	const validChars = "abcdefghjklmnpqrstuvwxyz23456789"
	for i, c := range code {
		if i == 4 {
			continue // skip hyphen
		}
		if !strings.ContainsRune(validChars, c) {
			t.Errorf("code[%d] = %q, not in valid charset", i, c)
		}
	}

	// Codes should be unique (generate 100 and check).
	seen := map[string]bool{code: true}
	for i := 0; i < 100; i++ {
		c, err := generateReferralCode()
		if err != nil {
			t.Fatalf("unexpected error on iteration %d: %v", i, err)
		}
		if seen[c] {
			t.Errorf("duplicate code generated: %s", c)
		}
		seen[c] = true
	}
}

// ---------------------------------------------------------------------------
// SetDisplayName
// ---------------------------------------------------------------------------

func TestSetDisplayName(t *testing.T) {
	t.Parallel()

	accountID := uuid.New()

	tests := []struct {
		name       string
		displayName string
		acct       Account
		wantErr    bool
		wantStatus int
	}{
		{
			name:        "success",
			displayName: "coolplayer",
			acct: Account{
				ID:                  accountID,
				DisplayName:         nil,
				LifetimeDepositUSDC: decimal.NewFromInt(150),
			},
			wantErr: false,
		},
		{
			name:        "exactly at threshold",
			displayName: "player100",
			acct: Account{
				ID:                  accountID,
				DisplayName:         nil,
				LifetimeDepositUSDC: decimal.NewFromInt(100),
			},
			wantErr: false,
		},
		{
			name:        "validation fails - too short",
			displayName: "ab",
			acct:        Account{},
			wantErr:     true,
			wantStatus:  400,
		},
		{
			name:        "validation fails - reserved",
			displayName: "admin",
			acct:        Account{},
			wantErr:     true,
			wantStatus:  400,
		},
		{
			name:        "already set",
			displayName: "newname",
			acct: func() Account {
				dn := "oldname"
				return Account{
					ID:                  accountID,
					DisplayName:         &dn,
					LifetimeDepositUSDC: decimal.NewFromInt(200),
				}
			}(),
			wantErr:    true,
			wantStatus: 409,
		},
		{
			name:        "below threshold",
			displayName: "wannabe",
			acct: Account{
				ID:                  accountID,
				DisplayName:         nil,
				LifetimeDepositUSDC: decimal.NewFromInt(50),
			},
			wantErr:    true,
			wantStatus: 403,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()

			storer := &mockStorer{
				queryByIDFn: func(ctx context.Context, id uuid.UUID) (Account, error) {
					return tc.acct, nil
				},
			}

			core := NewCore(storer)
			err := core.SetDisplayName(context.Background(), accountID, tc.displayName)

			if tc.wantErr {
				if err == nil {
					t.Fatal("expected error, got nil")
				}
				var reqErr *v1.RequestError
				if errors.As(err, &reqErr) && tc.wantStatus != 0 {
					if reqErr.Status != tc.wantStatus {
						t.Errorf("status = %d, want %d", reqErr.Status, tc.wantStatus)
					}
				}
			} else {
				if err != nil {
					t.Fatalf("unexpected error: %v", err)
				}
			}
		})
	}
}

// ---------------------------------------------------------------------------
// SetCustomReferralCode
// ---------------------------------------------------------------------------

func TestSetCustomReferralCode(t *testing.T) {
	t.Parallel()

	accountID := uuid.New()

	tests := []struct {
		name       string
		code       string
		acct       Account
		wantErr    bool
		wantStatus int
		checkCode  string // expected lowercase code passed to storer
	}{
		{
			name: "success - lowercases input",
			code: "MyCode",
			acct: Account{
				ID:                    accountID,
				ReferralCodeCustomized: false,
				LifetimeDepositUSDC:   decimal.NewFromInt(20),
			},
			wantErr:   false,
			checkCode: "mycode",
		},
		{
			name: "success - already lowercase",
			code: "coolref",
			acct: Account{
				ID:                    accountID,
				ReferralCodeCustomized: false,
				LifetimeDepositUSDC:   decimal.NewFromInt(10),
			},
			wantErr:   false,
			checkCode: "coolref",
		},
		{
			name:       "validation fails - too short",
			code:       "ab",
			acct:       Account{},
			wantErr:    true,
			wantStatus: 400,
		},
		{
			name: "already customized",
			code: "newcode",
			acct: Account{
				ID:                    accountID,
				ReferralCodeCustomized: true,
				LifetimeDepositUSDC:   decimal.NewFromInt(100),
			},
			wantErr:    true,
			wantStatus: 409,
		},
		{
			name: "below threshold",
			code: "wannabe",
			acct: Account{
				ID:                    accountID,
				ReferralCodeCustomized: false,
				LifetimeDepositUSDC:   decimal.NewFromInt(5),
			},
			wantErr:    true,
			wantStatus: 403,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()

			var gotCode string
			storerWithCapture := &mockStorerWithReferralCapture{
				mockStorer: &mockStorer{
					queryByIDFn: func(ctx context.Context, id uuid.UUID) (Account, error) {
						return tc.acct, nil
					},
				},
				setReferralCodeFn: func(ctx context.Context, id uuid.UUID, code string) error {
					gotCode = code
					return nil
				},
			}

			core := NewCore(storerWithCapture)
			err := core.SetCustomReferralCode(context.Background(), accountID, tc.code)

			if tc.wantErr {
				if err == nil {
					t.Fatal("expected error, got nil")
				}
				var reqErr *v1.RequestError
				if errors.As(err, &reqErr) && tc.wantStatus != 0 {
					if reqErr.Status != tc.wantStatus {
						t.Errorf("status = %d, want %d", reqErr.Status, tc.wantStatus)
					}
				}
			} else {
				if err != nil {
					t.Fatalf("unexpected error: %v", err)
				}
				if gotCode != tc.checkCode {
					t.Errorf("code passed to storer = %q, want %q", gotCode, tc.checkCode)
				}
			}
		})
	}
}

// mockStorerWithReferralCapture wraps mockStorer but overrides SetReferralCode.
type mockStorerWithReferralCapture struct {
	*mockStorer
	setReferralCodeFn func(ctx context.Context, accountID uuid.UUID, code string) error
}

func (m *mockStorerWithReferralCapture) SetReferralCode(ctx context.Context, accountID uuid.UUID, code string) error {
	if m.setReferralCodeFn != nil {
		return m.setReferralCodeFn(ctx, accountID, code)
	}
	return nil
}

// ---------------------------------------------------------------------------
// FindOrCreate — referral code resolution
// ---------------------------------------------------------------------------

func TestFindOrCreate_WithReferralCode(t *testing.T) {
	t.Parallel()

	referrerID := uuid.New()

	tests := []struct {
		name          string
		referralCode  string
		referrerFound bool
		wantReferred  bool
	}{
		{
			name:          "valid referral code sets referred_by",
			referralCode:  "ABCD-1234",
			referrerFound: true,
			wantReferred:  true,
		},
		{
			name:          "invalid referral code ignored",
			referralCode:  "BAD-CODE",
			referrerFound: false,
			wantReferred:  false,
		},
		{
			name:         "empty referral code",
			referralCode: "",
			wantReferred: false,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()

			storer := &mockStorer{
				queryByProviderFn: func(ctx context.Context, pt, uid string) (Account, error) {
					return Account{}, v1.NewNotFoundError()
				},
			}

			// Override QueryByReferralCode for this test.
			storerWithRef := &mockStorerWithReferral{
				mockStorer: storer,
				queryByReferralCodeFn: func(ctx context.Context, code string) (Account, error) {
					if tc.referrerFound {
						return Account{ID: referrerID}, nil
					}
					return Account{}, v1.NewNotFoundError()
				},
			}

			core := NewCore(storerWithRef)
			acct, err := core.FindOrCreate(context.Background(), NewAccount{
				ProviderType: "wallet",
				ProviderUID:  "0xtest",
				ReferralCode: tc.referralCode,
			})

			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}

			if tc.wantReferred {
				if acct.ReferredBy == nil {
					t.Fatal("expected referred_by to be set")
				}
				if *acct.ReferredBy != referrerID {
					t.Errorf("referred_by = %v, want %v", *acct.ReferredBy, referrerID)
				}
			} else {
				if acct.ReferredBy != nil {
					t.Errorf("expected referred_by to be nil, got %v", *acct.ReferredBy)
				}
			}
		})
	}
}

// mockStorerWithReferral wraps mockStorer but overrides QueryByReferralCode.
type mockStorerWithReferral struct {
	*mockStorer
	queryByReferralCodeFn func(ctx context.Context, code string) (Account, error)
}

func (m *mockStorerWithReferral) QueryByReferralCode(ctx context.Context, code string) (Account, error) {
	if m.queryByReferralCodeFn != nil {
		return m.queryByReferralCodeFn(ctx, code)
	}
	return Account{}, v1.NewRequestError(v1.ErrNotFound, 404)
}

// ---------------------------------------------------------------------------
// FindOrCreate — referral code collision retry
// ---------------------------------------------------------------------------

func TestFindOrCreate_ReferralCodeCollisionRetry(t *testing.T) {
	t.Parallel()

	createCalls := 0

	storer := &mockStorer{
		queryByProviderFn: func(ctx context.Context, pt, uid string) (Account, error) {
			return Account{}, v1.NewNotFoundError()
		},
		createFn: func(ctx context.Context, acct Account) error {
			createCalls++
			if createCalls <= 2 {
				// Simulate unique violation using pq.Error.
				return newPQUniqueViolation()
			}
			return nil // 3rd attempt succeeds
		},
	}

	core := NewCore(storer)
	acct, err := core.FindOrCreate(context.Background(), NewAccount{
		ProviderType: "wallet",
		ProviderUID:  "0xretry",
	})

	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if acct.ReferralCode == "" {
		t.Error("account should have a referral code")
	}
	if createCalls != 3 {
		t.Errorf("expected 3 create calls, got %d", createCalls)
	}
}

func TestFindOrCreate_ReferralCodeCollisionExhausted(t *testing.T) {
	t.Parallel()

	storer := &mockStorer{
		queryByProviderFn: func(ctx context.Context, pt, uid string) (Account, error) {
			return Account{}, v1.NewNotFoundError()
		},
		createFn: func(ctx context.Context, acct Account) error {
			return newPQUniqueViolation() // always collide
		},
	}

	core := NewCore(storer)
	_, err := core.FindOrCreate(context.Background(), NewAccount{
		ProviderType: "wallet",
		ProviderUID:  "0xexhausted",
	})

	if err == nil {
		t.Fatal("expected error after exhausting retries")
	}
	if !strings.Contains(err.Error(), "collision after 3 attempts") {
		t.Errorf("error = %q, want collision message", err.Error())
	}
}

// ---------------------------------------------------------------------------
// FindOrCreate — initialBalance
// ---------------------------------------------------------------------------

func TestFindOrCreate_InitialBalance(t *testing.T) {
	t.Parallel()

	storer := &mockStorer{
		queryByProviderFn: func(ctx context.Context, pt, uid string) (Account, error) {
			return Account{}, v1.NewNotFoundError()
		},
	}

	core := NewCore(storer)
	core.SetInitialBalance(decimal.NewFromInt(500))

	acct, err := core.FindOrCreate(context.Background(), NewAccount{
		ProviderType: "wallet",
		ProviderUID:  "0xbalance",
	})

	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !acct.BalancePlay.Equal(decimal.NewFromInt(500)) {
		t.Errorf("balance_play = %s, want 500", acct.BalancePlay)
	}
}
