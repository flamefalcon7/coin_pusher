package gamegrp

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/shopspring/decimal"
	"go.uber.org/zap"

	"github.com/flamefalcon/coin-pusher/backend/business/core/accounting"
	"github.com/flamefalcon/coin-pusher/backend/business/core/game"
	"github.com/flamefalcon/coin-pusher/backend/business/core/user"
	"github.com/flamefalcon/coin-pusher/backend/business/web/mid"
	v1 "github.com/flamefalcon/coin-pusher/backend/business/web/v1"
)

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

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

type mockAcctStorer struct {
	createFn           func(ctx context.Context, log accounting.AccountingLog) error
	queryByUserIDFn    func(ctx context.Context, userID uuid.UUID, page, pageSize int) ([]accounting.AccountingLog, error)
	queryByReferenceFn func(ctx context.Context, actionType, referenceID string) (accounting.AccountingLog, error)
}

func (m *mockAcctStorer) Create(ctx context.Context, log accounting.AccountingLog) error {
	if m.createFn != nil {
		return m.createFn(ctx, log)
	}
	return nil
}

func (m *mockAcctStorer) QueryByUserID(ctx context.Context, userID uuid.UUID, page, pageSize int) ([]accounting.AccountingLog, error) {
	if m.queryByUserIDFn != nil {
		return m.queryByUserIDFn(ctx, userID, page, pageSize)
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

func newGameCore(userID uuid.UUID, balance decimal.Decimal) *game.Core {
	userStr := &mockUserStorer{
		queryByIDFn: func(ctx context.Context, id uuid.UUID) (user.User, error) {
			return user.User{ID: userID, BalanceCoin: balance}, nil
		},
	}
	acctStr := &mockAcctStorer{}

	userCore := user.NewCore(userStr)
	acctCore := accounting.NewCore(acctStr, userCore)
	return game.NewCore(userCore, acctCore)
}

// ---------------------------------------------------------------------------
// Event
// ---------------------------------------------------------------------------

func TestEvent(t *testing.T) {
	t.Parallel()

	log := zap.NewNop().Sugar()
	userID := uuid.New()

	tests := []struct {
		name       string
		body       string
		balance    decimal.Decimal
		wantStatus int
		wantField  string // "success" or "error" in response
	}{
		{
			name:       "success - insert coin",
			body:       `{"user_id":"` + userID.String() + `","type":"INSERT_COIN","coin_count":1,"idempotency_key":"k1"}`,
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
			body:       `{"user_id":"` + userID.String() + `","type":"INVALID_TYPE"}`,
			balance:    decimal.NewFromInt(100),
			wantStatus: http.StatusInternalServerError,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()

			gameCore := newGameCore(userID, tc.balance)
			grp := New(gameCore)

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
