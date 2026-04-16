package usergrp

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

	"github.com/flamefalcon/coin-pusher/backend/business/core/user"
	"github.com/flamefalcon/coin-pusher/backend/business/web/auth"
	"github.com/flamefalcon/coin-pusher/backend/business/web/mid"
	v1 "github.com/flamefalcon/coin-pusher/backend/business/web/v1"
)

// ---------------------------------------------------------------------------
// Mock
// ---------------------------------------------------------------------------

type mockStorer struct {
	createFn              func(ctx context.Context, acct user.Account) error
	createAuthProviderFn  func(ctx context.Context, ap user.AuthProvider) error
	queryByIDFn           func(ctx context.Context, accountID uuid.UUID) (user.Account, error)
	queryByProviderFn     func(ctx context.Context, providerType, providerUID string) (user.Account, error)
	updateBalanceFn       func(ctx context.Context, accountID uuid.UUID, currency string, delta decimal.Decimal) (decimal.Decimal, error)
	createNonceFn         func(ctx context.Context, nonce, address string, expiresAt time.Time) error
	consumeNonceFn        func(ctx context.Context, nonce string) (user.NonceRecord, error)
	purgeExpiredNoncesFn  func(ctx context.Context) (int64, error)
}

func (m *mockStorer) Create(ctx context.Context, acct user.Account) error {
	if m.createFn != nil {
		return m.createFn(ctx, acct)
	}
	return nil
}

func (m *mockStorer) CreateAuthProvider(ctx context.Context, ap user.AuthProvider) error {
	if m.createAuthProviderFn != nil {
		return m.createAuthProviderFn(ctx, ap)
	}
	return nil
}

func (m *mockStorer) QueryByID(ctx context.Context, accountID uuid.UUID) (user.Account, error) {
	if m.queryByIDFn != nil {
		return m.queryByIDFn(ctx, accountID)
	}
	return user.Account{}, nil
}

func (m *mockStorer) QueryByIDForUpdate(ctx context.Context, accountID uuid.UUID) (user.Account, error) {
	if m.queryByIDFn != nil {
		return m.queryByIDFn(ctx, accountID)
	}
	return user.Account{}, nil
}

func (m *mockStorer) QueryByProvider(ctx context.Context, providerType, providerUID string) (user.Account, error) {
	if m.queryByProviderFn != nil {
		return m.queryByProviderFn(ctx, providerType, providerUID)
	}
	return user.Account{}, nil
}

func (m *mockStorer) UpdateBalance(ctx context.Context, accountID uuid.UUID, currency string, delta decimal.Decimal) (decimal.Decimal, error) {
	if m.updateBalanceFn != nil {
		return m.updateBalanceFn(ctx, accountID, currency, delta)
	}
	return decimal.Zero, nil
}

func (m *mockStorer) CreateNonce(ctx context.Context, nonce, address string, expiresAt time.Time) error {
	if m.createNonceFn != nil {
		return m.createNonceFn(ctx, nonce, address, expiresAt)
	}
	return nil
}

func (m *mockStorer) ConsumeNonce(ctx context.Context, nonce string) (user.NonceRecord, error) {
	if m.consumeNonceFn != nil {
		return m.consumeNonceFn(ctx, nonce)
	}
	return user.NonceRecord{}, nil
}

func (m *mockStorer) PurgeExpiredNonces(ctx context.Context) (int64, error) {
	if m.purgeExpiredNoncesFn != nil {
		return m.purgeExpiredNoncesFn(ctx)
	}
	return 0, nil
}

func (m *mockStorer) SetRole(ctx context.Context, accountID uuid.UUID, role string) error {
	return nil
}
func (m *mockStorer) QueryByReferralCode(_ context.Context, _ string) (user.Account, error) {
	return user.Account{}, v1.NewRequestError(v1.ErrNotFound, 404)
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

	loginDN := "login-test"
	existingAcct := user.Account{
		ID:          uuid.New(),
		DisplayName: &loginDN,
		BalancePlay: decimal.NewFromInt(100),
	}

	tests := []struct {
		name       string
		body       string
		storer     *mockStorer
		wantStatus int
	}{
		{
			name: "success - existing account",
			body: `{"provider_type":"wallet","provider_uid":"0xlogin-test"}`,
			storer: &mockStorer{
				queryByProviderFn: func(ctx context.Context, pt, uid string) (user.Account, error) {
					return existingAcct, nil
				},
			},
			wantStatus: http.StatusOK,
		},
		{
			name:       "missing provider_type",
			body:       `{"provider_type":"","provider_uid":"0xtest"}`,
			storer:     &mockStorer{},
			wantStatus: http.StatusBadRequest,
		},
		{
			// Bot provider_type must be rejected at the HTTP layer, before any
			// core-level call. Core also rejects (defense in depth), but the
			// handler early-rejects so bot-login attempts never even consult
			// the storer.
			name: "rejects provider_type=bot",
			body: `{"provider_type":"bot","provider_uid":"any"}`,
			storer: &mockStorer{
				queryByProviderFn: func(ctx context.Context, pt, uid string) (user.Account, error) {
					t.Errorf("storer must not be called for bot provider; got (%s, %s)", pt, uid)
					return user.Account{}, nil
				},
			},
			wantStatus: http.StatusBadRequest,
		},
		{
			name:       "missing provider_uid",
			body:       `{"provider_type":"wallet","provider_uid":""}`,
			storer:     &mockStorer{},
			wantStatus: http.StatusBadRequest,
		},
		{
			name:       "invalid json",
			body:       `{bad`,
			storer:     &mockStorer{},
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
				if resp.Account.DisplayName == nil || *resp.Account.DisplayName != "login-test" {
					t.Errorf("account.DisplayName = %v, want %q", resp.Account.DisplayName, "login-test")
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

	accountID := uuid.New()
	profileDN := "profile-test"
	testAcct := user.Account{
		ID:          accountID,
		DisplayName: &profileDN,
		BalancePlay: decimal.NewFromInt(42),
	}

	tests := []struct {
		name       string
		claims     *mid.Claims
		storer     *mockStorer
		wantStatus int
	}{
		{
			name:   "success",
			claims: &mid.Claims{AccountID: accountID.String()},
			storer: &mockStorer{
				queryByIDFn: func(ctx context.Context, id uuid.UUID) (user.Account, error) {
					return testAcct, nil
				},
			},
			wantStatus: http.StatusOK,
		},
		{
			name:       "no claims in context",
			claims:     nil,
			storer:     &mockStorer{},
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
				var acct user.Account
				if err := json.NewDecoder(w.Body).Decode(&acct); err != nil {
					t.Fatalf("decoding response: %v", err)
				}
				if acct.ID != accountID {
					t.Errorf("account.ID = %v, want %v", acct.ID, accountID)
				}
			}
		})
	}
}

// ---------------------------------------------------------------------------
// Nonce
// ---------------------------------------------------------------------------

func TestNonce(t *testing.T) {
	t.Parallel()

	log := zap.NewNop().Sugar()
	devAuth := auth.NewDevAuth("test-issuer")

	storer := &mockStorer{}
	userCore := user.NewCore(storer)
	grp := New(userCore, devAuth)

	r := httptest.NewRequest(http.MethodGet, "/v1/auth/nonce", nil)
	w := httptest.NewRecorder()

	handler := errHandler(log, grp.Nonce)
	handler.ServeHTTP(w, r)

	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d; body = %s", w.Code, http.StatusOK, w.Body.String())
	}

	var resp nonceResponse
	if err := json.NewDecoder(w.Body).Decode(&resp); err != nil {
		t.Fatalf("decoding response: %v", err)
	}

	if resp.Nonce == "" {
		t.Error("nonce should not be empty")
	}
	if resp.Message == "" {
		t.Error("message should not be empty")
	}
	if resp.ExpiresIn != 300 {
		t.Errorf("expires_in = %d, want 300", resp.ExpiresIn)
	}
}

// ---------------------------------------------------------------------------
// WalletLogin
// ---------------------------------------------------------------------------

func TestWalletLogin(t *testing.T) {
	t.Parallel()

	log := zap.NewNop().Sugar()
	devAuth := auth.NewDevAuth("test-issuer")

	tests := []struct {
		name       string
		body       string
		storer     *mockStorer
		wantStatus int
	}{
		{
			name:       "missing address",
			body:       `{"nonce":"abc","signature":"0xdef"}`,
			storer:     &mockStorer{},
			wantStatus: http.StatusBadRequest,
		},
		{
			name:       "missing nonce",
			body:       `{"address":"0x1234","signature":"0xdef"}`,
			storer:     &mockStorer{},
			wantStatus: http.StatusBadRequest,
		},
		{
			name:       "missing signature",
			body:       `{"address":"0x1234","nonce":"abc"}`,
			storer:     &mockStorer{},
			wantStatus: http.StatusBadRequest,
		},
		{
			name:       "invalid json",
			body:       `{bad`,
			storer:     &mockStorer{},
			wantStatus: http.StatusBadRequest,
		},
		{
			name: "expired nonce returns 401",
			body: `{"address":"0x0000000000000000000000000000000000000001","nonce":"expired","signature":"0xdeadbeef"}`,
			storer: &mockStorer{
				consumeNonceFn: func(ctx context.Context, nonce string) (user.NonceRecord, error) {
					return user.NonceRecord{}, v1.NewRequestError(v1.ErrNotFound, 401)
				},
			},
			wantStatus: http.StatusUnauthorized,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()

			userCore := user.NewCore(tc.storer)
			grp := New(userCore, devAuth)

			r := httptest.NewRequest(http.MethodPost, "/v1/auth/wallet/login", strings.NewReader(tc.body))
			r.Header.Set("Content-Type", "application/json")
			w := httptest.NewRecorder()

			handler := errHandler(log, grp.WalletLogin)
			handler.ServeHTTP(w, r)

			if w.Code != tc.wantStatus {
				t.Errorf("status = %d, want %d; body = %s", w.Code, tc.wantStatus, w.Body.String())
			}
		})
	}
}
