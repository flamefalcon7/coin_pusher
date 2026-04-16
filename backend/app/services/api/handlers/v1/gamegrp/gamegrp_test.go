package gamegrp

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/shopspring/decimal"
	"go.uber.org/zap"

	"github.com/flamefalcon/coin-pusher/backend/business/core/accounting"
	"github.com/flamefalcon/coin-pusher/backend/business/core/game"
	"github.com/flamefalcon/coin-pusher/backend/business/core/heat"
	"github.com/flamefalcon/coin-pusher/backend/business/core/user"
	"github.com/flamefalcon/coin-pusher/backend/business/web/mid"
	v1 "github.com/flamefalcon/coin-pusher/backend/business/web/v1"
	"github.com/flamefalcon/coin-pusher/backend/business/web/ws"
	fmetrics "github.com/flamefalcon/coin-pusher/backend/foundation/metrics"
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
	insertOutboxRowFn  func(ctx context.Context, subject string, payload []byte, referenceID string) error
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

func (m *mockAcctStorer) QueryAllByReference(_ context.Context, _, _ string) ([]accounting.AccountingLog, error) {
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

func (m *mockAcctStorer) SumByActionSinceExcludingRole(_ context.Context, _, _ string, _ time.Time) (decimal.Decimal, error) {
	return decimal.Zero, nil
}

func (m *mockAcctStorer) SumByPlayerSinceExcludingRole(_ context.Context, _, _ string, _ time.Time) ([]accounting.PlayerSum, error) {
	return nil, nil
}

func (m *mockAcctStorer) InsertOutboxRow(ctx context.Context, subject string, payload []byte, referenceID string) error {
	if m.insertOutboxRowFn != nil {
		return m.insertOutboxRowFn(ctx, subject, payload, referenceID)
	}
	return nil
}

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

func errHandler(log *zap.SugaredLogger, handler v1.Handler) http.HandlerFunc {
	return mid.Errors(log, handler)
}

// newGameCore builds a game.Core with `balance` seeded as balance_play and
// zero balance_cash. Behaves equivalently to the pre-split test helper for
// existing play-only scenarios.
func newGameCore(accountID uuid.UUID, balance decimal.Decimal) *game.Core {
	return newGameCoreWithBalances(accountID, balance, decimal.Zero)
}

func newGameCoreWithBalances(accountID uuid.UUID, play, cash decimal.Decimal) *game.Core {
	curPlay := play
	curCash := cash
	userStr := &mockUserStorer{
		queryByIDFn: func(_ context.Context, _ uuid.UUID) (user.Account, error) {
			return user.Account{ID: accountID, BalancePlay: curPlay, BalanceCash: curCash}, nil
		},
		updateBalanceFn: func(_ context.Context, _ uuid.UUID, currency string, delta decimal.Decimal) (decimal.Decimal, error) {
			switch currency {
			case user.CurrencyPlay:
				newBal := curPlay.Add(delta)
				if newBal.IsNegative() {
					return decimal.Zero, v1.NewInsufficientFundError(currency, delta.Abs(), curPlay)
				}
				curPlay = newBal
				return curPlay, nil
			case user.CurrencyCash:
				newBal := curCash.Add(delta)
				if newBal.IsNegative() {
					return decimal.Zero, v1.NewInsufficientFundError(currency, delta.Abs(), curCash)
				}
				curCash = newBal
				return curCash, nil
			}
			return decimal.Zero, v1.NewInsufficientFundError(currency, delta.Abs(), decimal.Zero)
		},
	}
	acctStr := &mockAcctStorer{}

	userCore := user.NewCore(userStr)
	acctCore := accounting.NewCore(nil, acctStr, userCore, nil, nil)
	return game.NewCore(userCore, acctCore)
}

// ---------------------------------------------------------------------------
// Event
// ---------------------------------------------------------------------------

func TestEvent(t *testing.T) {
	t.Parallel()

	log := zap.NewNop().Sugar()
	accountID := uuid.New()

	tests := []struct {
		name       string
		body       string
		balance    decimal.Decimal
		wantStatus int
		wantField  string // "success" or "error" in response
	}{
		{
			name:       "success - insert coin",
			body:       `{"user_id":"` + accountID.String() + `","type":"INSERT_COIN","coin_count":1,"idempotency_key":"k1"}`,
			balance:    decimal.NewFromInt(100),
			wantStatus: http.StatusOK,
			wantField:  "success",
		},
		{
			name:       "invalid JSON",
			body:       `{bad json`,
			balance:    decimal.NewFromInt(100),
			wantStatus: http.StatusBadRequest,
		},
		{
			name:       "game error - unknown event type",
			body:       `{"user_id":"` + accountID.String() + `","type":"INVALID_TYPE"}`,
			balance:    decimal.NewFromInt(100),
			wantStatus: http.StatusInternalServerError,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()

			gameCore := newGameCore(accountID, tc.balance)
			grp := New(gameCore, heat.New(), nil, false)

			r := httptest.NewRequest(http.MethodPost, "/v1/game/event", strings.NewReader(tc.body))
			r.Header.Set("Content-Type", "application/json")
			w := httptest.NewRecorder()

			handler := errHandler(log, grp.Event)
			handler.ServeHTTP(w, r)

			if w.Code != tc.wantStatus {
				t.Errorf("status = %d, want %d; body = %s", w.Code, tc.wantStatus, w.Body.String())
			}

			if tc.wantField == "success" {
				var result game.GameEventResult
				if err := json.NewDecoder(w.Body).Decode(&result); err != nil {
					t.Fatalf("decoding response: %v", err)
				}
				if !result.Success {
					t.Errorf("result.Success = false, Error = %q", result.Error)
				}
			}
		})
	}
}

// ---------------------------------------------------------------------------
// BatchInsert
// ---------------------------------------------------------------------------

func TestBatchInsert_CountExceedsMax(t *testing.T) {
	t.Parallel()

	log := zap.NewNop().Sugar()
	accountID := uuid.New()
	gameCore := newGameCore(accountID, decimal.NewFromInt(100000))
	grp := New(gameCore, heat.New(), nil, false)

	tests := []struct {
		name       string
		count      int
		wantStatus int
	}{
		{
			name:       "count exceeds max (101)",
			count:      101,
			wantStatus: http.StatusBadRequest,
		},
		{
			name:       "count zero",
			count:      0,
			wantStatus: http.StatusBadRequest,
		},
		{
			name:       "count negative",
			count:      -1,
			wantStatus: http.StatusBadRequest,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()

			body, _ := json.Marshal(BatchInsertRequest{SlotID: 0, Count: tc.count})
			r := httptest.NewRequest(http.MethodPost, "/v1/game/batch-insert", strings.NewReader(string(body)))
			r.Header.Set("Content-Type", "application/json")

			// Inject auth claims into context.
			ctx := mid.SetClaims(r.Context(), mid.Claims{AccountID: accountID.String(), Role: "user"})
			r = r.WithContext(ctx)

			w := httptest.NewRecorder()
			handler := errHandler(log, grp.BatchInsert)
			handler.ServeHTTP(w, r)

			if w.Code != tc.wantStatus {
				t.Errorf("status = %d, want %d; body = %s", w.Code, tc.wantStatus, w.Body.String())
			}
		})
	}
}

// TestBatchInsert_ResponseShape verifies the API exposes both balance_play
// and balance_cash after a split insert so the client can render a unified
// wallet total plus the withdrawable sub-indicator.
func TestBatchInsert_ResponseShape(t *testing.T) {
	t.Parallel()

	log := zap.NewNop().Sugar()
	accountID := uuid.New()
	// Seed play=2, cash=10; inserting 5 draws 2 from play + 3 from cash.
	gameCore := newGameCoreWithBalances(accountID, decimal.NewFromInt(2), decimal.NewFromInt(10))

	// Use a fake NATS conn via a nil check path: we pass nil nc but the
	// handler would NPE on Publish, so stage with a real conn would be ideal.
	// Instead, we exercise the success → response branch by skipping the NATS
	// publish path via a stub. Since New() stores nc directly, use a mock
	// HTTP test that focuses on validating the shape via the game core
	// directly rather than the handler end-to-end.
	_ = log

	result, err := gameCore.ProcessBatchInsert(context.Background(), accountID, 5, "ref-shape", nil)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !result.Success {
		t.Fatalf("insert failed: %s", result.Error)
	}
	if result.BalancePlay != "0" {
		t.Errorf("BalancePlay = %q, want 0", result.BalancePlay)
	}
	if result.BalanceCash != "7" {
		t.Errorf("BalanceCash = %q, want 7", result.BalanceCash)
	}

	// Verify the response payload shape (JSON field names) by marshalling a
	// representative response through the struct definition.
	resp := BatchInsertResponse{
		Queued:      5,
		HeatShare:   0.5,
		BalancePlay: result.BalancePlay,
		BalanceCash: result.BalanceCash,
		PlayDebited: result.PlayDebited,
		CashDebited: result.CashDebited,
	}
	blob, err := json.Marshal(resp)
	if err != nil {
		t.Fatalf("marshal response: %v", err)
	}
	payload := string(blob)
	if !strings.Contains(payload, `"balance_play":"0"`) {
		t.Errorf("response missing balance_play; got %s", payload)
	}
	if !strings.Contains(payload, `"balance_cash":"7"`) {
		t.Errorf("response missing balance_cash; got %s", payload)
	}
	if !strings.Contains(payload, `"play_debited":"2"`) {
		t.Errorf("response missing play_debited=2; got %s", payload)
	}
	if !strings.Contains(payload, `"cash_debited":"3"`) {
		t.Errorf("response missing cash_debited=3; got %s", payload)
	}
	if strings.Contains(payload, `"balance":`) {
		t.Errorf("response should not include legacy single-balance field; got %s", payload)
	}
}

// ---------------------------------------------------------------------------
// Unit 6: flag-gated outbox path
// ---------------------------------------------------------------------------

// newGameCoreWithOutboxCapture wires a game.Core whose acctStorer captures
// every InsertOutboxRow call. Returns the core + a pointer to the captured
// call record so Unit 6 tests can assert the handler fed the correct
// subject/payload/refID into the outbox writer.
func newGameCoreWithOutboxCapture(accountID uuid.UUID, play, cash decimal.Decimal) (*game.Core, *struct {
	called      bool
	subject     string
	payload     []byte
	referenceID string
}) {
	captured := &struct {
		called      bool
		subject     string
		payload     []byte
		referenceID string
	}{}

	curPlay := play
	curCash := cash
	userStr := &mockUserStorer{
		queryByIDFn: func(_ context.Context, _ uuid.UUID) (user.Account, error) {
			return user.Account{ID: accountID, BalancePlay: curPlay, BalanceCash: curCash}, nil
		},
		updateBalanceFn: func(_ context.Context, _ uuid.UUID, currency string, delta decimal.Decimal) (decimal.Decimal, error) {
			switch currency {
			case user.CurrencyPlay:
				curPlay = curPlay.Add(delta)
				return curPlay, nil
			case user.CurrencyCash:
				curCash = curCash.Add(delta)
				return curCash, nil
			}
			return decimal.Zero, v1.NewInsufficientFundError(currency, delta.Abs(), decimal.Zero)
		},
	}
	acctStr := &mockAcctStorer{
		insertOutboxRowFn: func(_ context.Context, subject string, payload []byte, referenceID string) error {
			captured.called = true
			captured.subject = subject
			captured.payload = payload
			captured.referenceID = referenceID
			return nil
		},
	}

	userCore := user.NewCore(userStr)
	acctCore := accounting.NewCore(nil, acctStr, userCore, nil, nil)
	return game.NewCore(userCore, acctCore), captured
}

// TestBatchInsert_OutboxPathWritesRowAndSkipsInlinePublish covers Unit 6's
// flag-on path: handler MUST call accounting.Storer.InsertOutboxRow with
// the correct subject + encoded payload + reference_id, AND MUST NOT
// attempt an inline nats publish. Tripwire: BatchInsertRefundFailures
// counter must stay at 0 — the refund path code must not run when the
// outbox is handling delivery.
func TestBatchInsert_OutboxPathWritesRowAndSkipsInlinePublish(t *testing.T) {
	t.Parallel()

	// Tripwire asserted at teardown: counter must not advance during this
	// test. If it does, the refund code path ran, meaning Unit 6's flip is
	// broken. This is the R1 hard guarantee.
	fmetrics.AssertNoRefundFailures(t)

	log := zap.NewNop().Sugar()
	accountID := uuid.New()
	// Seed play=100, cash=0 so insert stays in the single-currency path.
	gameCore, captured := newGameCoreWithOutboxCapture(accountID, decimal.NewFromInt(100), decimal.Zero)

	// flag = true. nc can stay nil: if the handler ever tries to publish
	// inline, the nil dereference will panic and fail the test — that's
	// the strongest "no inline publish" guard.
	grp := New(gameCore, heat.New(), nil, true)

	body := `{"count":5}`
	r := httptest.NewRequest(http.MethodPost, "/v1/game/batch-insert", strings.NewReader(body))
	r.Header.Set("Content-Type", "application/json")

	// Inject authed user via claims context.
	ctx := mid.SetClaims(r.Context(), mid.Claims{AccountID: accountID.String()})
	r = r.WithContext(ctx)

	w := httptest.NewRecorder()
	handler := errHandler(log, grp.BatchInsert)
	handler.ServeHTTP(w, r)

	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body = %s", w.Code, w.Body.String())
	}
	if !captured.called {
		t.Fatal("outbox writer was never called — handler did not route through outbox path")
	}
	// Subject must match the NATS topic the drainer later publishes to.
	wantSubject := "game.main.cmd.batch_insert"
	if captured.subject != wantSubject {
		t.Errorf("subject = %q, want %q", captured.subject, wantSubject)
	}
	// Payload must round-trip to a NATSBatchInsertCmd with the right fields.
	var cmd ws.NATSBatchInsertCmd
	if err := json.Unmarshal(captured.payload, &cmd); err != nil {
		t.Fatalf("decode captured payload: %v", err)
	}
	if cmd.UserID != accountID.String() {
		t.Errorf("payload user_id = %q, want %q", cmd.UserID, accountID.String())
	}
	if cmd.Count != 5 {
		t.Errorf("payload count = %d, want 5", cmd.Count)
	}
	if cmd.ReferenceID == "" || cmd.ReferenceID != captured.referenceID {
		t.Errorf("payload reference_id = %q, outbox row reference_id = %q — must be non-empty and equal", cmd.ReferenceID, captured.referenceID)
	}
}
