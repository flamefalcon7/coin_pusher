package sponsorgrp

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/shopspring/decimal"
	"go.uber.org/zap"

	"github.com/flamefalcon/coin-pusher/backend/business/core/sponsor"
	"github.com/flamefalcon/coin-pusher/backend/business/web/mid"
	v1 "github.com/flamefalcon/coin-pusher/backend/business/web/v1"
)

// ---------------------------------------------------------------------------
// Mock
// ---------------------------------------------------------------------------

type mockStorer struct {
	createFn                func(ctx context.Context, camp sponsor.Campaign) error
	queryByIDFn             func(ctx context.Context, campaignID uuid.UUID) (sponsor.Campaign, error)
	queryActiveFn           func(ctx context.Context) ([]sponsor.Campaign, error)
	decrementPoolFn         func(ctx context.Context, campaignID uuid.UUID, amount decimal.Decimal) (decimal.Decimal, error)
	creditBalanceFn         func(ctx context.Context, campaignID, accountID uuid.UUID, amount decimal.Decimal) error
	createRewardLogFn       func(ctx context.Context, log sponsor.RewardLog) error
	queryBalancesByAccountFn func(ctx context.Context, accountID uuid.UUID) ([]sponsor.SponsorBalance, error)
	updateStatusFn          func(ctx context.Context, campaignID uuid.UUID, status string) error
	queryByAccountFn        func(ctx context.Context, accountID uuid.UUID) ([]sponsor.Campaign, error)
	createQuotaFn           func(ctx context.Context, entry sponsor.QuotaEntry) error
	consumeQuotaFn          func(ctx context.Context, quotaID uuid.UUID, coinsSpawned int) error
	queryStaleQuotasFn      func(ctx context.Context, olderThan time.Time) ([]sponsor.QuotaEntry, error)
	refundQuotaFn           func(ctx context.Context, quotaID uuid.UUID) error
}

func (m *mockStorer) Create(ctx context.Context, camp sponsor.Campaign) error {
	if m.createFn != nil {
		return m.createFn(ctx, camp)
	}
	return nil
}

func (m *mockStorer) QueryByID(ctx context.Context, campaignID uuid.UUID) (sponsor.Campaign, error) {
	if m.queryByIDFn != nil {
		return m.queryByIDFn(ctx, campaignID)
	}
	return sponsor.Campaign{}, nil
}

func (m *mockStorer) QueryActive(ctx context.Context) ([]sponsor.Campaign, error) {
	if m.queryActiveFn != nil {
		return m.queryActiveFn(ctx)
	}
	return nil, nil
}

func (m *mockStorer) DecrementPool(ctx context.Context, campaignID uuid.UUID, amount decimal.Decimal) (decimal.Decimal, error) {
	if m.decrementPoolFn != nil {
		return m.decrementPoolFn(ctx, campaignID, amount)
	}
	return decimal.Zero, nil
}

func (m *mockStorer) CreditBalance(ctx context.Context, campaignID, accountID uuid.UUID, amount decimal.Decimal) error {
	if m.creditBalanceFn != nil {
		return m.creditBalanceFn(ctx, campaignID, accountID, amount)
	}
	return nil
}

func (m *mockStorer) CreateRewardLog(ctx context.Context, log sponsor.RewardLog) error {
	if m.createRewardLogFn != nil {
		return m.createRewardLogFn(ctx, log)
	}
	return nil
}

func (m *mockStorer) QueryBalancesByAccount(ctx context.Context, accountID uuid.UUID) ([]sponsor.SponsorBalance, error) {
	if m.queryBalancesByAccountFn != nil {
		return m.queryBalancesByAccountFn(ctx, accountID)
	}
	return nil, nil
}

func (m *mockStorer) UpdateStatus(ctx context.Context, campaignID uuid.UUID, status string) error {
	if m.updateStatusFn != nil {
		return m.updateStatusFn(ctx, campaignID, status)
	}
	return nil
}

func (m *mockStorer) QueryByAccount(ctx context.Context, accountID uuid.UUID) ([]sponsor.Campaign, error) {
	if m.queryByAccountFn != nil {
		return m.queryByAccountFn(ctx, accountID)
	}
	return nil, nil
}

func (m *mockStorer) CreateQuota(ctx context.Context, entry sponsor.QuotaEntry) error {
	if m.createQuotaFn != nil {
		return m.createQuotaFn(ctx, entry)
	}
	return nil
}

func (m *mockStorer) ConsumeQuota(ctx context.Context, quotaID uuid.UUID, coinsSpawned int) error {
	if m.consumeQuotaFn != nil {
		return m.consumeQuotaFn(ctx, quotaID, coinsSpawned)
	}
	return nil
}

func (m *mockStorer) QueryStaleQuotas(ctx context.Context, olderThan time.Time) ([]sponsor.QuotaEntry, error) {
	if m.queryStaleQuotasFn != nil {
		return m.queryStaleQuotasFn(ctx, olderThan)
	}
	return nil, nil
}

func (m *mockStorer) RefundQuota(ctx context.Context, quotaID uuid.UUID) error {
	if m.refundQuotaFn != nil {
		return m.refundQuotaFn(ctx, quotaID)
	}
	return nil
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

func errHandler(log *zap.SugaredLogger, handler v1.Handler) http.HandlerFunc {
	return mid.Errors(log, handler)
}

func withClaims(r *http.Request, accountID string) *http.Request {
	ctx := mid.SetClaims(r.Context(), mid.Claims{AccountID: accountID})
	return r.WithContext(ctx)
}

func withChiParam(r *http.Request, key, value string) *http.Request {
	rctx := chi.NewRouteContext()
	rctx.URLParams.Add(key, value)
	ctx := context.WithValue(r.Context(), chi.RouteCtxKey, rctx)
	return r.WithContext(ctx)
}

func newGroup(s *mockStorer) *Group {
	core := sponsor.NewCore(nil, s, nil)
	return New(core, zap.NewNop().Sugar())
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

func TestCreate(t *testing.T) {
	t.Parallel()

	log := zap.NewNop().Sugar()
	acctID := uuid.New()

	tests := []struct {
		name       string
		body       string
		storer     *mockStorer
		claims     string // account ID for claims; empty = no claims
		wantStatus int
	}{
		{
			name:       "success",
			body:       `{"chain":"sui","token_address":"0xtok","token_symbol":"FLAME","token_decimals":9,"brand_color":"#FF0000","brand_name":"TestBrand","pool_total":"10000","reward_per_coin":"100"}`,
			storer:     &mockStorer{},
			claims:     acctID.String(),
			wantStatus: http.StatusCreated,
		},
		{
			name:       "no auth",
			body:       `{"chain":"sui","token_address":"0xtok","token_symbol":"FLAME","brand_name":"Test","pool_total":"10000","reward_per_coin":"100"}`,
			storer:     &mockStorer{},
			claims:     "",
			wantStatus: http.StatusUnauthorized,
		},
		{
			name:       "missing chain",
			body:       `{"chain":"","token_address":"0xtok","token_symbol":"FLAME","brand_name":"Test","pool_total":"10000","reward_per_coin":"100"}`,
			storer:     &mockStorer{},
			claims:     acctID.String(),
			wantStatus: http.StatusBadRequest,
		},
		{
			name:       "missing token_address",
			body:       `{"chain":"sui","token_address":"","token_symbol":"FLAME","brand_name":"Test","pool_total":"10000","reward_per_coin":"100"}`,
			storer:     &mockStorer{},
			claims:     acctID.String(),
			wantStatus: http.StatusBadRequest,
		},
		{
			name:       "missing token_symbol",
			body:       `{"chain":"sui","token_address":"0xtok","token_symbol":"","brand_name":"Test","pool_total":"10000","reward_per_coin":"100"}`,
			storer:     &mockStorer{},
			claims:     acctID.String(),
			wantStatus: http.StatusBadRequest,
		},
		{
			name:       "missing brand_name",
			body:       `{"chain":"sui","token_address":"0xtok","token_symbol":"FLAME","brand_name":"","pool_total":"10000","reward_per_coin":"100"}`,
			storer:     &mockStorer{},
			claims:     acctID.String(),
			wantStatus: http.StatusBadRequest,
		},
		{
			name:       "invalid pool_total",
			body:       `{"chain":"sui","token_address":"0xtok","token_symbol":"FLAME","brand_name":"Test","pool_total":"notanumber","reward_per_coin":"100"}`,
			storer:     &mockStorer{},
			claims:     acctID.String(),
			wantStatus: http.StatusBadRequest,
		},
		{
			name:       "zero pool_total",
			body:       `{"chain":"sui","token_address":"0xtok","token_symbol":"FLAME","brand_name":"Test","pool_total":"0","reward_per_coin":"100"}`,
			storer:     &mockStorer{},
			claims:     acctID.String(),
			wantStatus: http.StatusBadRequest,
		},
		{
			name:       "negative reward_per_coin",
			body:       `{"chain":"sui","token_address":"0xtok","token_symbol":"FLAME","brand_name":"Test","pool_total":"10000","reward_per_coin":"-5"}`,
			storer:     &mockStorer{},
			claims:     acctID.String(),
			wantStatus: http.StatusBadRequest,
		},
		{
			name:       "invalid json",
			body:       `{bad`,
			storer:     &mockStorer{},
			claims:     acctID.String(),
			wantStatus: http.StatusBadRequest,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()

			grp := newGroup(tc.storer)

			r := httptest.NewRequest(http.MethodPost, "/v1/sponsor/campaign", strings.NewReader(tc.body))
			r.Header.Set("Content-Type", "application/json")
			if tc.claims != "" {
				r = withClaims(r, tc.claims)
			}
			w := httptest.NewRecorder()

			handler := errHandler(log, grp.Create)
			handler.ServeHTTP(w, r)

			if w.Code != tc.wantStatus {
				t.Errorf("status = %d, want %d; body = %s", w.Code, tc.wantStatus, w.Body.String())
			}

			if tc.wantStatus == http.StatusCreated {
				var camp sponsor.Campaign
				if err := json.Unmarshal(w.Body.Bytes(), &camp); err != nil {
					t.Fatalf("failed to decode response: %v", err)
				}
				if camp.CampaignID == uuid.Nil {
					t.Error("response should have campaign_id")
				}
				if camp.Status != sponsor.StatusActive {
					t.Errorf("status = %q, want %q", camp.Status, sponsor.StatusActive)
				}
			}
		})
	}
}

// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------

func TestList(t *testing.T) {
	t.Parallel()

	log := zap.NewNop().Sugar()

	grp := newGroup(&mockStorer{
		queryActiveFn: func(ctx context.Context) ([]sponsor.Campaign, error) {
			return []sponsor.Campaign{
				{CampaignID: uuid.New(), Status: sponsor.StatusActive},
			}, nil
		},
	})

	r := httptest.NewRequest(http.MethodGet, "/v1/sponsor/campaigns", nil)
	w := httptest.NewRecorder()

	handler := errHandler(log, grp.List)
	handler.ServeHTTP(w, r)

	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d", w.Code, http.StatusOK)
	}

	var camps []sponsor.Campaign
	if err := json.Unmarshal(w.Body.Bytes(), &camps); err != nil {
		t.Fatalf("failed to decode: %v", err)
	}
	if len(camps) != 1 {
		t.Errorf("len = %d, want 1", len(camps))
	}
}

func TestListEmpty(t *testing.T) {
	t.Parallel()

	log := zap.NewNop().Sugar()

	grp := newGroup(&mockStorer{
		queryActiveFn: func(ctx context.Context) ([]sponsor.Campaign, error) {
			return nil, nil
		},
	})

	r := httptest.NewRequest(http.MethodGet, "/v1/sponsor/campaigns", nil)
	w := httptest.NewRecorder()

	handler := errHandler(log, grp.List)
	handler.ServeHTTP(w, r)

	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d", w.Code, http.StatusOK)
	}

	// Should return [] not null.
	if body := strings.TrimSpace(w.Body.String()); body != "[]" {
		t.Errorf("body = %s, want []", body)
	}
}

// ---------------------------------------------------------------------------
// GetByID
// ---------------------------------------------------------------------------

func TestGetByID(t *testing.T) {
	t.Parallel()

	log := zap.NewNop().Sugar()
	campID := uuid.New()

	tests := []struct {
		name       string
		idParam    string
		storer     *mockStorer
		wantStatus int
	}{
		{
			name:    "success",
			idParam: campID.String(),
			storer: &mockStorer{
				queryByIDFn: func(ctx context.Context, id uuid.UUID) (sponsor.Campaign, error) {
					return sponsor.Campaign{CampaignID: campID, BrandName: "Found"}, nil
				},
			},
			wantStatus: http.StatusOK,
		},
		{
			name:       "invalid uuid",
			idParam:    "not-a-uuid",
			storer:     &mockStorer{},
			wantStatus: http.StatusBadRequest,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()

			grp := newGroup(tc.storer)

			r := httptest.NewRequest(http.MethodGet, "/v1/sponsor/campaign/"+tc.idParam, nil)
			r = withChiParam(r, "id", tc.idParam)
			w := httptest.NewRecorder()

			handler := errHandler(log, grp.GetByID)
			handler.ServeHTTP(w, r)

			if w.Code != tc.wantStatus {
				t.Errorf("status = %d, want %d; body = %s", w.Code, tc.wantStatus, w.Body.String())
			}
		})
	}
}

// ---------------------------------------------------------------------------
// ListMine
// ---------------------------------------------------------------------------

func TestListMine(t *testing.T) {
	t.Parallel()

	log := zap.NewNop().Sugar()
	acctID := uuid.New()

	tests := []struct {
		name       string
		claims     string
		storer     *mockStorer
		wantStatus int
		wantLen    int
	}{
		{
			name:   "success",
			claims: acctID.String(),
			storer: &mockStorer{
				queryByAccountFn: func(ctx context.Context, id uuid.UUID) ([]sponsor.Campaign, error) {
					return []sponsor.Campaign{{CampaignID: uuid.New()}}, nil
				},
			},
			wantStatus: http.StatusOK,
			wantLen:    1,
		},
		{
			name:       "no auth",
			claims:     "",
			storer:     &mockStorer{},
			wantStatus: http.StatusUnauthorized,
		},
		{
			name:   "empty list returns []",
			claims: acctID.String(),
			storer: &mockStorer{
				queryByAccountFn: func(ctx context.Context, id uuid.UUID) ([]sponsor.Campaign, error) {
					return nil, nil
				},
			},
			wantStatus: http.StatusOK,
			wantLen:    0,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()

			grp := newGroup(tc.storer)

			r := httptest.NewRequest(http.MethodGet, "/v1/sponsor/campaigns/mine", nil)
			if tc.claims != "" {
				r = withClaims(r, tc.claims)
			}
			w := httptest.NewRecorder()

			handler := errHandler(log, grp.ListMine)
			handler.ServeHTTP(w, r)

			if w.Code != tc.wantStatus {
				t.Errorf("status = %d, want %d; body = %s", w.Code, tc.wantStatus, w.Body.String())
			}

			if tc.wantStatus == http.StatusOK {
				var camps []sponsor.Campaign
				if err := json.Unmarshal(w.Body.Bytes(), &camps); err != nil {
					t.Fatalf("decode: %v", err)
				}
				if len(camps) != tc.wantLen {
					t.Errorf("len = %d, want %d", len(camps), tc.wantLen)
				}
			}
		})
	}
}

// ---------------------------------------------------------------------------
// Pause / Resume / Remove
// ---------------------------------------------------------------------------

func TestAdminActions(t *testing.T) {
	t.Parallel()

	log := zap.NewNop().Sugar()
	campID := uuid.New()

	tests := []struct {
		name       string
		handler    func(g *Group) v1.Handler
		idParam    string
		wantStatus int
		wantBody   string
	}{
		{
			name:       "pause success",
			handler:    func(g *Group) v1.Handler { return g.Pause },
			idParam:    campID.String(),
			wantStatus: http.StatusOK,
			wantBody:   "paused",
		},
		{
			name:       "resume success",
			handler:    func(g *Group) v1.Handler { return g.Resume },
			idParam:    campID.String(),
			wantStatus: http.StatusOK,
			wantBody:   "active",
		},
		{
			name:       "remove success",
			handler:    func(g *Group) v1.Handler { return g.Remove },
			idParam:    campID.String(),
			wantStatus: http.StatusOK,
			wantBody:   "expired",
		},
		{
			name:       "pause invalid uuid",
			handler:    func(g *Group) v1.Handler { return g.Pause },
			idParam:    "bad-uuid",
			wantStatus: http.StatusBadRequest,
		},
		{
			name:       "resume invalid uuid",
			handler:    func(g *Group) v1.Handler { return g.Resume },
			idParam:    "bad-uuid",
			wantStatus: http.StatusBadRequest,
		},
		{
			name:       "remove invalid uuid",
			handler:    func(g *Group) v1.Handler { return g.Remove },
			idParam:    "bad-uuid",
			wantStatus: http.StatusBadRequest,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()

			grp := newGroup(&mockStorer{})

			r := httptest.NewRequest(http.MethodPut, "/v1/admin/sponsor/campaign/"+tc.idParam+"/action", nil)
			r = withChiParam(r, "id", tc.idParam)
			w := httptest.NewRecorder()

			handler := errHandler(log, tc.handler(grp))
			handler.ServeHTTP(w, r)

			if w.Code != tc.wantStatus {
				t.Errorf("status = %d, want %d; body = %s", w.Code, tc.wantStatus, w.Body.String())
			}

			if tc.wantBody != "" && w.Code == http.StatusOK {
				var resp map[string]string
				if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
					t.Fatalf("decode: %v", err)
				}
				if resp["status"] != tc.wantBody {
					t.Errorf("status = %q, want %q", resp["status"], tc.wantBody)
				}
			}
		})
	}
}

// ---------------------------------------------------------------------------
// GetBalances
// ---------------------------------------------------------------------------

func TestGetBalances(t *testing.T) {
	t.Parallel()

	log := zap.NewNop().Sugar()
	acctID := uuid.New()

	tests := []struct {
		name       string
		claims     string
		storer     *mockStorer
		wantStatus int
	}{
		{
			name:   "success",
			claims: acctID.String(),
			storer: &mockStorer{
				queryBalancesByAccountFn: func(ctx context.Context, id uuid.UUID) ([]sponsor.SponsorBalance, error) {
					return []sponsor.SponsorBalance{
						{AccountID: acctID, Balance: decimal.NewFromInt(500)},
					}, nil
				},
			},
			wantStatus: http.StatusOK,
		},
		{
			name:       "no auth",
			claims:     "",
			storer:     &mockStorer{},
			wantStatus: http.StatusUnauthorized,
		},
		{
			name:   "empty returns []",
			claims: acctID.String(),
			storer: &mockStorer{
				queryBalancesByAccountFn: func(ctx context.Context, id uuid.UUID) ([]sponsor.SponsorBalance, error) {
					return nil, nil
				},
			},
			wantStatus: http.StatusOK,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()

			grp := newGroup(tc.storer)

			r := httptest.NewRequest(http.MethodGet, "/v1/sponsor/balances", nil)
			if tc.claims != "" {
				r = withClaims(r, tc.claims)
			}
			w := httptest.NewRecorder()

			handler := errHandler(log, grp.GetBalances)
			handler.ServeHTTP(w, r)

			if w.Code != tc.wantStatus {
				t.Errorf("status = %d, want %d; body = %s", w.Code, tc.wantStatus, w.Body.String())
			}
		})
	}
}
