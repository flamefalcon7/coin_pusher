package bot

import (
	"context"
	"errors"
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

type mockBotStorer struct {
	queryConfigAllFn         func(ctx context.Context) (map[string]string, error)
	upsertConfigFn           func(ctx context.Context, key, value string) error
	queryBotAccountsFn       func(ctx context.Context) ([]Bot, error)
	queryBotAccountByIDFn    func(ctx context.Context, accountID uuid.UUID) (Bot, error)
	sumRefillsSinceFn        func(ctx context.Context, since time.Time) (decimal.Decimal, error)
	queryPausedAccountIDsFn  func(ctx context.Context) (map[uuid.UUID]struct{}, error)
}

func (m *mockBotStorer) QueryConfigAll(ctx context.Context) (map[string]string, error) {
	if m.queryConfigAllFn != nil {
		return m.queryConfigAllFn(ctx)
	}
	return map[string]string{}, nil
}

func (m *mockBotStorer) UpsertConfig(ctx context.Context, key, value string) error {
	if m.upsertConfigFn != nil {
		return m.upsertConfigFn(ctx, key, value)
	}
	return nil
}

func (m *mockBotStorer) QueryBotAccounts(ctx context.Context) ([]Bot, error) {
	if m.queryBotAccountsFn != nil {
		return m.queryBotAccountsFn(ctx)
	}
	return nil, nil
}

func (m *mockBotStorer) QueryBotAccountByID(ctx context.Context, accountID uuid.UUID) (Bot, error) {
	if m.queryBotAccountByIDFn != nil {
		return m.queryBotAccountByIDFn(ctx, accountID)
	}
	return Bot{}, v1.NewNotFoundError()
}

func (m *mockBotStorer) SumRefillsSince(ctx context.Context, since time.Time) (decimal.Decimal, error) {
	if m.sumRefillsSinceFn != nil {
		return m.sumRefillsSinceFn(ctx, since)
	}
	return decimal.Zero, nil
}

func (m *mockBotStorer) QueryPausedAccountIDs(ctx context.Context) (map[uuid.UUID]struct{}, error) {
	if m.queryPausedAccountIDsFn != nil {
		return m.queryPausedAccountIDsFn(ctx)
	}
	return map[uuid.UUID]struct{}{}, nil
}

// mockAcctStorer stubs just the accounting.Storer methods exercised by
// ProcessBotRefill. The package-level accounting_test.go has its own mock in
// a file owned by a parallel agent; we replicate the narrow surface we need
// here to avoid cross-file test fixture coupling.
type mockAcctStorer struct {
	createFn           func(ctx context.Context, log accounting.AccountingLog) error
	queryByReferenceFn func(ctx context.Context, actionType, referenceID string) (accounting.AccountingLog, error)
}

func (m *mockAcctStorer) Create(ctx context.Context, log accounting.AccountingLog) error {
	if m.createFn != nil {
		return m.createFn(ctx, log)
	}
	return nil
}

func (m *mockAcctStorer) QueryByAccountID(_ context.Context, _ uuid.UUID, _, _ int) ([]accounting.AccountingLog, error) {
	return nil, nil
}

func (m *mockAcctStorer) QueryByReference(ctx context.Context, actionType, referenceID string) (accounting.AccountingLog, error) {
	if m.queryByReferenceFn != nil {
		return m.queryByReferenceFn(ctx, actionType, referenceID)
	}
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

// mockUserStorer stubs just the user.Storer methods ProcessBotRefill exercises:
// QueryByID (post-credit balance read) and UpdateBalance (the credit itself).
type mockUserStorer struct {
	queryByIDFn     func(ctx context.Context, accountID uuid.UUID) (user.Account, error)
	updateBalanceFn func(ctx context.Context, accountID uuid.UUID, currency string, delta decimal.Decimal) (decimal.Decimal, error)
}

func (m *mockUserStorer) Create(_ context.Context, _ user.Account) error { return nil }
func (m *mockUserStorer) CreateAuthProvider(_ context.Context, _ user.AuthProvider) error {
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
func (m *mockUserStorer) QueryByProvider(_ context.Context, _, _ string) (user.Account, error) {
	return user.Account{}, nil
}
func (m *mockUserStorer) UpdateBalance(ctx context.Context, accountID uuid.UUID, currency string, delta decimal.Decimal) (decimal.Decimal, error) {
	if m.updateBalanceFn != nil {
		return m.updateBalanceFn(ctx, accountID, currency, delta)
	}
	return decimal.Zero, nil
}
func (m *mockUserStorer) CreateNonce(_ context.Context, _, _ string, _ time.Time) error { return nil }
func (m *mockUserStorer) ConsumeNonce(_ context.Context, _ string) (user.NonceRecord, error) {
	return user.NonceRecord{}, nil
}
func (m *mockUserStorer) PurgeExpiredNonces(_ context.Context) (int64, error)     { return 0, nil }
func (m *mockUserStorer) SetRole(_ context.Context, _ uuid.UUID, _ string) error  { return nil }
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
// GetConfig / SetConfig
// ---------------------------------------------------------------------------

func TestGetConfig(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name     string
		stored   map[string]string
		queryErr error
		key      string
		wantVal  string
		wantErr  error
	}{
		{
			name:    "existing key returns value",
			stored:  map[string]string{ConfigKeyKillSwitch: "on"},
			key:     ConfigKeyKillSwitch,
			wantVal: "on",
		},
		{
			name:    "missing key returns ErrConfigNotFound",
			stored:  map[string]string{ConfigKeyKillSwitch: "off"},
			key:     ConfigKeyRefillAmount,
			wantErr: ErrConfigNotFound,
		},
		{
			name:    "empty map returns ErrConfigNotFound",
			stored:  map[string]string{},
			key:     ConfigKeyKillSwitch,
			wantErr: ErrConfigNotFound,
		},
		{
			name:     "storer error propagates",
			queryErr: errors.New("db error"),
			key:      ConfigKeyKillSwitch,
			wantErr:  errors.New("any non-nil"),
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()

			botStr := &mockBotStorer{
				queryConfigAllFn: func(_ context.Context) (map[string]string, error) {
					if tc.queryErr != nil {
						return nil, tc.queryErr
					}
					return tc.stored, nil
				},
			}
			core := NewCore(nil, botStr, nil)

			got, err := core.GetConfig(context.Background(), tc.key)
			if tc.wantErr != nil {
				if err == nil {
					t.Fatal("expected error, got nil")
				}
				if errors.Is(tc.wantErr, ErrConfigNotFound) && !errors.Is(err, ErrConfigNotFound) {
					t.Errorf("want ErrConfigNotFound, got %v", err)
				}
				return
			}
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if got != tc.wantVal {
				t.Errorf("got %q, want %q", got, tc.wantVal)
			}
		})
	}
}

func TestSetConfig(t *testing.T) {
	t.Parallel()

	var gotKey, gotVal string
	var calls int
	botStr := &mockBotStorer{
		upsertConfigFn: func(_ context.Context, key, value string) error {
			calls++
			gotKey = key
			gotVal = value
			return nil
		},
	}
	core := NewCore(nil, botStr, nil)

	if err := core.SetConfig(context.Background(), ConfigKeyKillSwitch, "on"); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if calls != 1 {
		t.Errorf("upsert calls = %d, want 1", calls)
	}
	if gotKey != ConfigKeyKillSwitch || gotVal != "on" {
		t.Errorf("got (%q, %q), want (%q, %q)", gotKey, gotVal, ConfigKeyKillSwitch, "on")
	}
}

func TestSetConfig_ErrorPropagates(t *testing.T) {
	t.Parallel()

	botStr := &mockBotStorer{
		upsertConfigFn: func(_ context.Context, _, _ string) error {
			return errors.New("disk full")
		},
	}
	core := NewCore(nil, botStr, nil)

	if err := core.SetConfig(context.Background(), ConfigKeyRefillAmount, "500"); err == nil {
		t.Fatal("expected error, got nil")
	}
}

// ---------------------------------------------------------------------------
// ListAllBots / GetBot
// ---------------------------------------------------------------------------

func TestListAllBots(t *testing.T) {
	t.Parallel()

	id1, id2 := uuid.New(), uuid.New()
	name1 := "CoinDropMaster"

	botStr := &mockBotStorer{
		queryBotAccountsFn: func(_ context.Context) ([]Bot, error) {
			return []Bot{
				{AccountID: id1, DisplayName: &name1, ProviderUID: "bot-aaaa", BalancePlay: decimal.NewFromInt(1000)},
				{AccountID: id2, ProviderUID: "bot-bbbb", BalancePlay: decimal.NewFromInt(500)},
			}, nil
		},
	}
	core := NewCore(nil, botStr, nil)

	got, err := core.ListAllBots(context.Background())
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(got) != 2 {
		t.Fatalf("got %d bots, want 2", len(got))
	}
	if got[0].AccountID != id1 || got[1].AccountID != id2 {
		t.Errorf("bot order wrong")
	}
	if got[0].DisplayName == nil || *got[0].DisplayName != name1 {
		t.Errorf("expected display_name %q", name1)
	}
	if got[1].DisplayName != nil {
		t.Errorf("expected nil display_name for unnamed bot")
	}
}

func TestGetBot_Found(t *testing.T) {
	t.Parallel()

	id := uuid.New()
	botStr := &mockBotStorer{
		queryBotAccountByIDFn: func(_ context.Context, accountID uuid.UUID) (Bot, error) {
			if accountID != id {
				t.Errorf("queried with %s, want %s", accountID, id)
			}
			return Bot{AccountID: id, ProviderUID: "bot-xyz"}, nil
		},
	}
	core := NewCore(nil, botStr, nil)

	got, err := core.GetBot(context.Background(), id)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got.AccountID != id {
		t.Errorf("got %s, want %s", got.AccountID, id)
	}
}

func TestGetBot_NotFound(t *testing.T) {
	t.Parallel()

	botStr := &mockBotStorer{
		queryBotAccountByIDFn: func(_ context.Context, _ uuid.UUID) (Bot, error) {
			return Bot{}, v1.NewNotFoundError()
		},
	}
	core := NewCore(nil, botStr, nil)

	_, err := core.GetBot(context.Background(), uuid.New())
	if err == nil {
		t.Fatal("expected error, got nil")
	}
	if !errors.Is(err, v1.ErrNotFound) {
		t.Errorf("expected wrapped v1.ErrNotFound, got %v", err)
	}
}

// ---------------------------------------------------------------------------
// DailyRefillTotal
// ---------------------------------------------------------------------------

func TestDailyRefillTotal(t *testing.T) {
	t.Parallel()

	var gotSince time.Time
	botStr := &mockBotStorer{
		sumRefillsSinceFn: func(_ context.Context, since time.Time) (decimal.Decimal, error) {
			gotSince = since
			return decimal.NewFromInt(12345), nil
		},
	}
	core := NewCore(nil, botStr, nil)

	total, err := core.DailyRefillTotal(context.Background())
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !total.Equal(decimal.NewFromInt(12345)) {
		t.Errorf("got %s, want 12345", total)
	}

	// Verify the "since" argument is a UTC start-of-day.
	if gotSince.Location() != time.UTC {
		t.Errorf("since timezone = %v, want UTC", gotSince.Location())
	}
	if gotSince.Hour() != 0 || gotSince.Minute() != 0 || gotSince.Second() != 0 || gotSince.Nanosecond() != 0 {
		t.Errorf("since is not start-of-day: %v", gotSince)
	}
	now := time.Now().UTC()
	// Must be within the current UTC day.
	if gotSince.After(now) || now.Sub(gotSince) > 24*time.Hour {
		t.Errorf("since=%v is not within the current UTC day (now=%v)", gotSince, now)
	}
}

// ---------------------------------------------------------------------------
// RefillBalance — validation + success path
// ---------------------------------------------------------------------------

func TestRefillBalance_RejectsNonPositive(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name   string
		amount decimal.Decimal
	}{
		{"zero", decimal.Zero},
		{"negative", decimal.NewFromInt(-100)},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			core := NewCore(nil, &mockBotStorer{}, newAcctCore(t, nil, nil))
			_, err := core.RefillBalance(context.Background(), uuid.New(), tc.amount, "ref-1")
			if err == nil {
				t.Fatal("expected error, got nil")
			}
		})
	}
}

func TestRefillBalance_RejectsEmptyReference(t *testing.T) {
	t.Parallel()

	core := NewCore(nil, &mockBotStorer{}, newAcctCore(t, nil, nil))
	_, err := core.RefillBalance(context.Background(), uuid.New(), decimal.NewFromInt(100), "")
	if err == nil {
		t.Fatal("expected error, got nil")
	}
}

func TestRefillBalance_RejectsNonBot(t *testing.T) {
	t.Parallel()

	botStr := &mockBotStorer{
		queryBotAccountByIDFn: func(_ context.Context, _ uuid.UUID) (Bot, error) {
			return Bot{}, v1.NewNotFoundError()
		},
	}
	core := NewCore(nil, botStr, newAcctCore(t, nil, nil))

	_, err := core.RefillBalance(context.Background(), uuid.New(), decimal.NewFromInt(100), "ref-1")
	if err == nil {
		t.Fatal("expected error, got nil")
	}
	if !errors.Is(err, ErrNotABot) {
		t.Errorf("expected ErrNotABot, got %v", err)
	}
}

func TestRefillBalance_HappyPath(t *testing.T) {
	t.Parallel()

	accountID := uuid.New()
	referenceID := "bot-refill:" + accountID.String() + ":20260416"

	botStr := &mockBotStorer{
		queryBotAccountByIDFn: func(_ context.Context, id uuid.UUID) (Bot, error) {
			if id != accountID {
				t.Errorf("got %s, want %s", id, accountID)
			}
			return Bot{AccountID: accountID, BalancePlay: decimal.NewFromInt(50)}, nil
		},
	}

	// Accounting + user mocks: simulate tx with balance starting at 50,
	// credit by 1000, new balance 1050.
	balance := decimal.NewFromInt(50)

	var createCalls int
	var gotAction, gotCurrency, gotRef string
	var gotAmount decimal.Decimal
	acctStr := &mockAcctStorer{
		queryByReferenceFn: func(_ context.Context, _, _ string) (accounting.AccountingLog, error) {
			// Fresh refill: not already processed.
			return accounting.AccountingLog{}, v1.NewNotFoundError()
		},
		createFn: func(_ context.Context, log accounting.AccountingLog) error {
			createCalls++
			gotAction = log.ActionType
			gotCurrency = log.Currency
			gotRef = log.ReferenceID
			gotAmount = log.Amount
			return nil
		},
	}

	userStr := &mockUserStorer{
		queryByIDFn: func(_ context.Context, _ uuid.UUID) (user.Account, error) {
			return user.Account{ID: accountID, BalancePlay: balance}, nil
		},
		updateBalanceFn: func(_ context.Context, _ uuid.UUID, currency string, delta decimal.Decimal) (decimal.Decimal, error) {
			if currency != user.CurrencyPlay {
				t.Errorf("update currency = %q, want PLAY", currency)
			}
			balance = balance.Add(delta)
			return balance, nil
		},
	}

	core := NewCore(nil, botStr, newAcctCore(t, acctStr, userStr))

	newPlay, err := core.RefillBalance(context.Background(), accountID, decimal.NewFromInt(1000), referenceID)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !newPlay.Equal(decimal.NewFromInt(1050)) {
		t.Errorf("newPlay = %s, want 1050", newPlay)
	}
	if createCalls != 1 {
		t.Errorf("create calls = %d, want 1", createCalls)
	}
	if gotAction != accounting.ActionBotRefill {
		t.Errorf("action = %q, want %q", gotAction, accounting.ActionBotRefill)
	}
	if gotCurrency != accounting.CurrencyPlay {
		t.Errorf("currency = %q, want PLAY", gotCurrency)
	}
	if gotRef != referenceID {
		t.Errorf("reference_id = %q, want %q", gotRef, referenceID)
	}
	if !gotAmount.Equal(decimal.NewFromInt(1000)) {
		t.Errorf("amount = %s, want 1000", gotAmount)
	}
}

// TestRefillBalance_Idempotent mirrors the accounting ProcessDeposit
// idempotency test: a replay with the same reference_id must be a no-op
// (no double credit, no extra ledger entry) and must return the current
// balance_play.
func TestRefillBalance_Idempotent(t *testing.T) {
	t.Parallel()

	accountID := uuid.New()
	referenceID := "bot-refill:" + accountID.String() + ":20260416"
	currentBalance := decimal.NewFromInt(2500)

	botStr := &mockBotStorer{
		queryBotAccountByIDFn: func(_ context.Context, _ uuid.UUID) (Bot, error) {
			return Bot{AccountID: accountID, BalancePlay: currentBalance}, nil
		},
	}

	var createCalls, updateCalls int
	acctStr := &mockAcctStorer{
		queryByReferenceFn: func(_ context.Context, action, ref string) (accounting.AccountingLog, error) {
			if action == accounting.ActionBotRefill && ref == referenceID {
				return accounting.AccountingLog{
					LogID:       uuid.New(),
					AccountID:   accountID,
					ActionType:  accounting.ActionBotRefill,
					Amount:      decimal.NewFromInt(1000),
					Currency:    accounting.CurrencyPlay,
					ReferenceID: referenceID,
				}, nil
			}
			return accounting.AccountingLog{}, v1.NewNotFoundError()
		},
		createFn: func(_ context.Context, _ accounting.AccountingLog) error {
			createCalls++
			return nil
		},
	}
	userStr := &mockUserStorer{
		queryByIDFn: func(_ context.Context, _ uuid.UUID) (user.Account, error) {
			return user.Account{ID: accountID, BalancePlay: currentBalance}, nil
		},
		updateBalanceFn: func(_ context.Context, _ uuid.UUID, _ string, _ decimal.Decimal) (decimal.Decimal, error) {
			updateCalls++
			return decimal.Zero, nil
		},
	}

	core := NewCore(nil, botStr, newAcctCore(t, acctStr, userStr))

	newPlay, err := core.RefillBalance(context.Background(), accountID, decimal.NewFromInt(1000), referenceID)
	if err != nil {
		t.Fatalf("idempotent replay should succeed, got: %v", err)
	}
	if createCalls != 0 {
		t.Errorf("expected zero ledger writes on replay, got %d", createCalls)
	}
	if updateCalls != 0 {
		t.Errorf("expected zero balance updates on replay, got %d", updateCalls)
	}
	if !newPlay.Equal(currentBalance) {
		t.Errorf("replay newPlay = %s, want %s", newPlay, currentBalance)
	}
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// newAcctCore constructs an accounting.Core in unit-test mode (db=nil) wired
// to the provided storer + user storer. When both are nil, the core is
// unusable for ProcessBotRefill; validation-only tests that never reach it
// pass nil to keep fixtures minimal.
func newAcctCore(_ *testing.T, acctStr accounting.Storer, userStr user.Storer) *accounting.Core {
	if acctStr == nil {
		acctStr = &mockAcctStorer{}
	}
	var userCore *user.Core
	if userStr != nil {
		userCore = user.NewCore(userStr)
	}
	return accounting.NewCore(nil, acctStr, userCore, nil, nil)
}
