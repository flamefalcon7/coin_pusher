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

type mockAcctStorer struct {
	createFn           func(ctx context.Context, log accounting.AccountingLog) error
	queryByAccountIDFn func(ctx context.Context, accountID uuid.UUID, page, pageSize int) ([]accounting.AccountingLog, error)
	queryByReferenceFn func(ctx context.Context, actionType, referenceID string) (accounting.AccountingLog, error)
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

func (m *mockAcctStorer) QueryByReference(ctx context.Context, actionType, referenceID string) (accounting.AccountingLog, error) {
	if m.queryByReferenceFn != nil {
		return m.queryByReferenceFn(ctx, actionType, referenceID)
	}
	return accounting.AccountingLog{}, nil
}

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

func errHandler(log *zap.SugaredLogger, handler v1.Handler) http.HandlerFunc {
	return mid.Errors(log, handler)
}

func newGameCore(accountID uuid.UUID, balance decimal.Decimal) *game.Core {
	currentBalance := balance
	userStr := &mockUserStorer{
		updateBalanceFn: func(ctx context.Context, id uuid.UUID, currency string, delta decimal.Decimal) (decimal.Decimal, error) {
			newBal := currentBalance.Add(delta)
			if newBal.IsNegative() {
				return decimal.Zero, v1.NewInsufficientFundError(currency, delta.Abs(), currentBalance)
			}
			currentBalance = newBal
			return currentBalance, nil
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
			grp := New(gameCore, heat.New(), nil)

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
