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
	// Default: no prior entry. Refund idempotency guard treats nil-error as
	// "already processed" — returning ErrNotFound matches the real storer's
	// miss semantics so tests that don't override see a clean slate.
	return AccountingLog{}, v1.NewNotFoundError()
}

func (m *mockAcctStorer) QueryAllByReference(_ context.Context, _, _ string) ([]AccountingLog, error) {
	return nil, nil
}

func (m *mockAcctStorer) SumByActionSince(_ context.Context, _ string, _ time.Time) (decimal.Decimal, error) {
	return decimal.Zero, nil
}

func (m *mockAcctStorer) SumByPlayerSince(_ context.Context, _ string, _ time.Time) ([]PlayerSum, error) {
	return nil, nil
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
func (m *mockUserStorer) QueryWalletAddress(_ context.Context, _ uuid.UUID) (string, error) {
	return "", nil
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
		name        string
		startPlay   int64
		startCash   int64
		count       int
		wantErr     bool
		wantInsuff  bool
		wantPlayDeb int64
		wantCashDeb int64
		// Expected ledger entries (currency -> amount).
		wantLedger map[string]int64
	}{
		{
			name: "pure play draw", startPlay: 95, startCash: 0, count: 5,
			wantPlayDeb: 5, wantCashDeb: 0,
			wantLedger: map[string]int64{CurrencyPlay: 5},
		},
		{
			name: "pure cash draw (play empty)", startPlay: 0, startCash: 10, count: 3,
			wantPlayDeb: 0, wantCashDeb: 3,
			wantLedger: map[string]int64{CurrencyCash: 3},
		},
		{
			name: "mixed split draw", startPlay: 2, startCash: 10, count: 5,
			wantPlayDeb: 2, wantCashDeb: 3,
			wantLedger: map[string]int64{CurrencyPlay: 2, CurrencyCash: 3},
		},
		{
			name: "insufficient combined balance", startPlay: 1, startCash: 1, count: 5,
			wantErr: true, wantInsuff: true,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()

			play := decimal.NewFromInt(tc.startPlay)
			cash := decimal.NewFromInt(tc.startCash)

			userStr := &mockUserStorer{
				queryByIDFn: func(_ context.Context, _ uuid.UUID) (user.Account, error) {
					return user.Account{ID: accountID, BalancePlay: play, BalanceCash: cash}, nil
				},
				updateBalanceFn: func(_ context.Context, _ uuid.UUID, currency string, delta decimal.Decimal) (decimal.Decimal, error) {
					switch currency {
					case CurrencyPlay:
						play = play.Add(delta)
						return play, nil
					case CurrencyCash:
						cash = cash.Add(delta)
						return cash, nil
					}
					return decimal.Zero, errors.New("unexpected currency")
				},
			}

			gotLedger := map[string]int64{}
			acctStr := &mockAcctStorer{
				createFn: func(_ context.Context, log AccountingLog) error {
					if log.ActionType != ActionGameInsert {
						t.Errorf("action_type = %q, want %q", log.ActionType, ActionGameInsert)
					}
					if log.ReferenceID != "ref-123" {
						t.Errorf("reference_id = %q, want ref-123", log.ReferenceID)
					}
					gotLedger[log.Currency] = log.Amount.IntPart()
					return nil
				},
			}

			userCore := user.NewCore(userStr)
			core := NewCore(nil, acctStr, userCore, nil, nil)

			pd, cd, np, nc, err := core.ProcessGameInsert(
				context.Background(), accountID, tc.count, "ref-123",
			)

			if tc.wantErr {
				if err == nil {
					t.Fatal("expected error, got nil")
				}
				if tc.wantInsuff && !errors.Is(err, v1.ErrInsufficientFund) {
					t.Errorf("should wrap ErrInsufficientFund, got: %v", err)
				}
				if len(gotLedger) != 0 {
					t.Errorf("expected no ledger writes on error, got %v", gotLedger)
				}
				return
			}

			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if !pd.Equal(decimal.NewFromInt(tc.wantPlayDeb)) {
				t.Errorf("playDebited = %s, want %d", pd, tc.wantPlayDeb)
			}
			if !cd.Equal(decimal.NewFromInt(tc.wantCashDeb)) {
				t.Errorf("cashDebited = %s, want %d", cd, tc.wantCashDeb)
			}
			// Balance conservation.
			wantNewTotal := tc.startPlay + tc.startCash - int64(tc.count)
			gotNewTotal := np.Add(nc)
			if !gotNewTotal.Equal(decimal.NewFromInt(wantNewTotal)) {
				t.Errorf("new total = %s, want %d", gotNewTotal, wantNewTotal)
			}
			// Ledger entries match expected split.
			if len(gotLedger) != len(tc.wantLedger) {
				t.Errorf("ledger entries = %v, want %v", gotLedger, tc.wantLedger)
			}
			for cur, wantAmt := range tc.wantLedger {
				if gotLedger[cur] != wantAmt {
					t.Errorf("ledger[%s] = %d, want %d", cur, gotLedger[cur], wantAmt)
				}
			}
		})
	}
}

// ---------------------------------------------------------------------------
// ProcessGameInsertRefund
// ---------------------------------------------------------------------------

func TestProcessGameInsertRefund(t *testing.T) {
	t.Parallel()

	accountID := uuid.New()

	tests := []struct {
		name        string
		playDeb     int64
		cashDeb     int64
		startPlay   int64
		startCash   int64
		updateErr   error
		queryErr    error
		createErr   error
		wantErr     bool
		wantLedger  map[string]int64 // currency -> amount for refund entries
		wantNewPlay int64
		wantNewCash int64
	}{
		{
			name: "mixed refund restores both legs",
			playDeb: 2, cashDeb: 3,
			startPlay: 0, startCash: 7, // before refund: insert left play=0, cash=7
			wantLedger:  map[string]int64{CurrencyPlay: 2, CurrencyCash: 3},
			wantNewPlay: 2, wantNewCash: 10,
		},
		{
			name: "pure play refund writes only play entry",
			playDeb: 5, cashDeb: 0,
			startPlay: 0, startCash: 10,
			wantLedger:  map[string]int64{CurrencyPlay: 5},
			wantNewPlay: 5, wantNewCash: 10,
		},
		{
			name: "pure cash refund writes only cash entry",
			playDeb: 0, cashDeb: 5,
			startPlay: 0, startCash: 5,
			wantLedger:  map[string]int64{CurrencyCash: 5},
			wantNewPlay: 0, wantNewCash: 10,
		},
		{
			name: "increment balance fails",
			playDeb: 5, cashDeb: 0,
			updateErr: errors.New("db error"),
			wantErr:   true,
		},
		{
			name: "query after refund fails",
			playDeb: 5, cashDeb: 0,
			startPlay: 0, startCash: 0,
			queryErr:  errors.New("db error"),
			wantErr:   true,
		},
		{
			name: "create log fails",
			playDeb: 5, cashDeb: 0,
			startPlay: 0, startCash: 0,
			createErr: errors.New("insert failed"),
			wantErr:   true,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()

			play := decimal.NewFromInt(tc.startPlay)
			cash := decimal.NewFromInt(tc.startCash)

			userStr := &mockUserStorer{
				updateBalanceFn: func(_ context.Context, _ uuid.UUID, currency string, delta decimal.Decimal) (decimal.Decimal, error) {
					if tc.updateErr != nil {
						return decimal.Zero, tc.updateErr
					}
					switch currency {
					case CurrencyPlay:
						play = play.Add(delta)
						return play, nil
					case CurrencyCash:
						cash = cash.Add(delta)
						return cash, nil
					}
					return decimal.Zero, errors.New("unexpected currency")
				},
				queryByIDFn: func(_ context.Context, _ uuid.UUID) (user.Account, error) {
					if tc.queryErr != nil {
						return user.Account{}, tc.queryErr
					}
					return user.Account{BalancePlay: play, BalanceCash: cash}, nil
				},
			}

			gotLedger := map[string]int64{}
			acctStr := &mockAcctStorer{
				createFn: func(_ context.Context, log AccountingLog) error {
					if tc.createErr != nil {
						return tc.createErr
					}
					if log.ActionType != ActionGameInsertRefund {
						t.Errorf("action_type = %q, want %q", log.ActionType, ActionGameInsertRefund)
					}
					if log.ReferenceID != "refund-ref-123" {
						t.Errorf("reference_id = %q, want refund-ref-123", log.ReferenceID)
					}
					gotLedger[log.Currency] = log.Amount.IntPart()
					return nil
				},
			}

			userCore := user.NewCore(userStr)
			core := NewCore(nil, acctStr, userCore, nil, nil)

			newPlay, newCash, err := core.ProcessGameInsertRefund(
				context.Background(), accountID,
				decimal.NewFromInt(tc.playDeb), decimal.NewFromInt(tc.cashDeb),
				"refund-ref-123",
			)

			if tc.wantErr {
				if err == nil {
					t.Fatal("expected error, got nil")
				}
				return
			}
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if !newPlay.Equal(decimal.NewFromInt(tc.wantNewPlay)) {
				t.Errorf("newPlay = %s, want %d", newPlay, tc.wantNewPlay)
			}
			if !newCash.Equal(decimal.NewFromInt(tc.wantNewCash)) {
				t.Errorf("newCash = %s, want %d", newCash, tc.wantNewCash)
			}
			if len(gotLedger) != len(tc.wantLedger) {
				t.Errorf("ledger entries = %v, want %v", gotLedger, tc.wantLedger)
			}
			for cur, wantAmt := range tc.wantLedger {
				if gotLedger[cur] != wantAmt {
					t.Errorf("ledger[%s] = %d, want %d", cur, gotLedger[cur], wantAmt)
				}
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

// TestProcessGameInsertRefund_Idempotent verifies that a replay of
// ProcessGameInsertRefund with the same referenceID is a no-op: no double
// credit, no additional ledger entries. Mirrors ProcessDeposit's TOCTOU-safe
// idempotency pattern (docs/security-audit.md P0-8).
func TestProcessGameInsertRefund_Idempotent(t *testing.T) {
	t.Parallel()

	accountID := uuid.New()
	referenceID := "insert-ref-42:refund"

	// Simulate: an earlier refund already wrote a ledger entry for this ref.
	// QueryByReference returns a non-nil log (no error). Post-refund balance
	// is play=5, cash=10. No new writes should occur on replay.
	existingLog := AccountingLog{
		LogID:       uuid.New(),
		AccountID:   accountID,
		ActionType:  ActionGameInsertRefund,
		Amount:      decimal.NewFromInt(2),
		Currency:    CurrencyPlay,
		ReferenceID: referenceID,
	}

	var createCalls int
	var incrementCalls int

	userStr := &mockUserStorer{
		updateBalanceFn: func(_ context.Context, _ uuid.UUID, _ string, _ decimal.Decimal) (decimal.Decimal, error) {
			incrementCalls++
			return decimal.Zero, nil
		},
		queryByIDFn: func(_ context.Context, _ uuid.UUID) (user.Account, error) {
			return user.Account{
				BalancePlay: decimal.NewFromInt(5),
				BalanceCash: decimal.NewFromInt(10),
			}, nil
		},
	}
	acctStr := &mockAcctStorer{
		queryByReferenceFn: func(_ context.Context, action, ref string) (AccountingLog, error) {
			if action == ActionGameInsertRefund && ref == referenceID {
				return existingLog, nil
			}
			return AccountingLog{}, v1.NewNotFoundError()
		},
		createFn: func(_ context.Context, _ AccountingLog) error {
			createCalls++
			return nil
		},
	}

	userCore := user.NewCore(userStr)
	core := NewCore(nil, acctStr, userCore, nil, nil)

	newPlay, newCash, err := core.ProcessGameInsertRefund(
		context.Background(), accountID,
		decimal.NewFromInt(2), decimal.NewFromInt(3),
		referenceID,
	)
	if err != nil {
		t.Fatalf("idempotent replay should succeed, got error: %v", err)
	}
	if incrementCalls != 0 {
		t.Errorf("expected zero balance increments on replay, got %d", incrementCalls)
	}
	if createCalls != 0 {
		t.Errorf("expected zero ledger writes on replay, got %d", createCalls)
	}
	if !newPlay.Equal(decimal.NewFromInt(5)) {
		t.Errorf("replay newPlay = %s, want 5", newPlay)
	}
	if !newCash.Equal(decimal.NewFromInt(10)) {
		t.Errorf("replay newCash = %s, want 10", newCash)
	}
}
