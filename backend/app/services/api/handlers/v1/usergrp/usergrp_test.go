package usergrp

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

	"github.com/flamefalcon/coin-pusher/backend/business/core/user"
	"github.com/flamefalcon/coin-pusher/backend/business/web/auth"
	"github.com/flamefalcon/coin-pusher/backend/business/web/mid"
	v1 "github.com/flamefalcon/coin-pusher/backend/business/web/v1"
)

// ---------------------------------------------------------------------------
// Mock
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

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

func errHandler(log *zap.SugaredLogger, handler v1.Handler) http.HandlerFunc {
	return mid.Errors(log, handler)
}

// ---------------------------------------------------------------------------
// Login
// ---------------------------------------------------------------------------

func TestLogin(t *testing.T) {
	t.Parallel()

	devAuth := auth.NewDevAuth("test-issuer")
	log := zap.NewNop().Sugar()

	existingUser := user.User{
		ID:          uuid.New(),
		SUIAddress:  "0xlogin-test",
		BalanceCoin: decimal.NewFromInt(100),
	}

	tests := []struct {
		name       string
		body       string
		storer     *mockUserStorer
		wantStatus int
	}{
		{
			name: "success - existing user",
			body: `{"sui_address":"0xlogin-test","message":"hello","signature":"sig"}`,
			storer: &mockUserStorer{
				queryBySUIAddrFn: func(ctx context.Context, suiAddress string) (user.User, error) {
					return existingUser, nil
				},
			},
			wantStatus: http.StatusOK,
		},
		{
			name:       "missing sui_address",
			body:       `{"sui_address":"","message":"hello","signature":"sig"}`,
			storer:     &mockUserStorer{},
			wantStatus: http.StatusBadRequest,
		},
		{
			name:       "invalid json",
			body:       `{bad`,
			storer:     &mockUserStorer{},
			wantStatus: http.StatusBadRequest,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()

			userCore := user.NewCore(tc.storer)
			grp := New(userCore, devAuth)

			r := httptest.NewRequest(http.MethodPost, "/v1/auth/login", strings.NewReader(tc.body))
			r.Header.Set("Content-Type", "application/json")
			w := httptest.NewRecorder()

			handler := errHandler(log, grp.Login)
			handler.ServeHTTP(w, r)

			if w.Code != tc.wantStatus {
				t.Errorf("status = %d, want %d; body = %s", w.Code, tc.wantStatus, w.Body.String())
			}

			if tc.wantStatus == http.StatusOK {
				var resp loginResponse
				if err := json.NewDecoder(w.Body).Decode(&resp); err != nil {
					t.Fatalf("decoding response: %v", err)
				}
				if resp.Token == "" {
					t.Error("token should not be empty")
				}
				if resp.User.SUIAddress != "0xlogin-test" {
					t.Errorf("user.SUIAddress = %q, want %q", resp.User.SUIAddress, "0xlogin-test")
				}
			}
		})
	}
}

// ---------------------------------------------------------------------------
// Profile
// ---------------------------------------------------------------------------

func TestProfile(t *testing.T) {
	t.Parallel()

	log := zap.NewNop().Sugar()

	userID := uuid.New()
	testUser := user.User{
		ID:          userID,
		SUIAddress:  "0xprofile-test",
		BalanceCoin: decimal.NewFromInt(42),
	}

	tests := []struct {
		name       string
		claims     *mid.Claims
		storer     *mockUserStorer
		wantStatus int
	}{
		{
			name:   "success",
			claims: &mid.Claims{UserID: userID.String(), SUIAddress: "0xprofile-test"},
			storer: &mockUserStorer{
				queryByIDFn: func(ctx context.Context, id uuid.UUID) (user.User, error) {
					return testUser, nil
				},
			},
			wantStatus: http.StatusOK,
		},
		{
			name:       "no claims in context",
			claims:     nil,
			storer:     &mockUserStorer{},
			wantStatus: http.StatusUnauthorized,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()

			userCore := user.NewCore(tc.storer)
			devAuth := auth.NewDevAuth("test-issuer")
			grp := New(userCore, devAuth)

			r := httptest.NewRequest(http.MethodGet, "/v1/user/profile", nil)

			if tc.claims != nil {
				ctx := mid.SetClaims(r.Context(), *tc.claims)
				r = r.WithContext(ctx)
			}

			w := httptest.NewRecorder()

			handler := errHandler(log, grp.Profile)
			handler.ServeHTTP(w, r)

			if w.Code != tc.wantStatus {
				t.Errorf("status = %d, want %d; body = %s", w.Code, tc.wantStatus, w.Body.String())
			}

			if tc.wantStatus == http.StatusOK {
				var usr user.User
				if err := json.NewDecoder(w.Body).Decode(&usr); err != nil {
					t.Fatalf("decoding response: %v", err)
				}
				if usr.ID != userID {
					t.Errorf("user.ID = %v, want %v", usr.ID, userID)
				}
			}
		})
	}
}
