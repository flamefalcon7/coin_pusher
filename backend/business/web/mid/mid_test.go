package mid

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"regexp"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/prometheus/client_golang/prometheus/promhttp"
	"go.uber.org/zap"

	"github.com/flamefalcon/coin-pusher/backend/business/web/auth"
	v1 "github.com/flamefalcon/coin-pusher/backend/business/web/v1"
)

// ---------------------------------------------------------------------------
// Context helpers
// ---------------------------------------------------------------------------

func TestCorrelationIDContext(t *testing.T) {
	t.Parallel()

	ctx := context.Background()
	if got := GetCorrelationID(ctx); got != "" {
		t.Errorf("empty ctx should return empty string, got %q", got)
	}

	ctx = SetCorrelationID(ctx, "abc-123")
	if got := GetCorrelationID(ctx); got != "abc-123" {
		t.Errorf("GetCorrelationID = %q, want %q", got, "abc-123")
	}
}

func TestClaimsContext(t *testing.T) {
	t.Parallel()

	ctx := context.Background()
	_, ok := GetClaims(ctx)
	if ok {
		t.Error("empty ctx should not have claims")
	}

	want := Claims{AccountID: "a1"}
	ctx = SetClaims(ctx, want)

	got, ok := GetClaims(ctx)
	if !ok {
		t.Fatal("GetClaims should return ok=true after SetClaims")
	}
	if got != want {
		t.Errorf("claims = %+v, want %+v", got, want)
	}
}

// ---------------------------------------------------------------------------
// CorrelationID middleware
// ---------------------------------------------------------------------------

func TestCorrelationIDMiddleware(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name       string
		headerVal  string
		wantCustom bool
	}{
		{
			name:       "generates UUID when header missing",
			headerVal:  "",
			wantCustom: false,
		},
		{
			name:       "passes through existing header",
			headerVal:  "my-custom-id",
			wantCustom: true,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()

			var ctxID string
			inner := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				ctxID = GetCorrelationID(r.Context())
			})

			handler := CorrelationID()(inner)

			r := httptest.NewRequest(http.MethodGet, "/", nil)
			if tc.headerVal != "" {
				r.Header.Set("X-Correlation-ID", tc.headerVal)
			}
			w := httptest.NewRecorder()

			handler.ServeHTTP(w, r)

			respID := w.Header().Get("X-Correlation-ID")
			if respID == "" {
				t.Fatal("response should have X-Correlation-ID header")
			}

			if ctxID != respID {
				t.Errorf("context ID %q != response header ID %q", ctxID, respID)
			}

			if tc.wantCustom && respID != tc.headerVal {
				t.Errorf("should pass through custom ID, got %q want %q", respID, tc.headerVal)
			}

			if !tc.wantCustom {
				if _, err := uuid.Parse(respID); err != nil {
					t.Errorf("generated ID should be valid UUID, got %q", respID)
				}
			}
		})
	}
}

// ---------------------------------------------------------------------------
// GameSecret middleware
// ---------------------------------------------------------------------------

func TestGameSecret(t *testing.T) {
	t.Parallel()

	const secret = "test-secret-key"

	tests := []struct {
		name       string
		headerVal  string
		wantStatus int
	}{
		{
			name:       "missing secret",
			headerVal:  "",
			wantStatus: http.StatusUnauthorized,
		},
		{
			name:       "wrong secret",
			headerVal:  "wrong-key",
			wantStatus: http.StatusUnauthorized,
		},
		{
			name:       "correct secret",
			headerVal:  secret,
			wantStatus: http.StatusOK,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()

			inner := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.WriteHeader(http.StatusOK)
			})

			handler := GameSecret(secret)(inner)

			r := httptest.NewRequest(http.MethodPost, "/", nil)
			if tc.headerVal != "" {
				r.Header.Set("X-Game-Secret", tc.headerVal)
			}
			w := httptest.NewRecorder()

			handler.ServeHTTP(w, r)

			if w.Code != tc.wantStatus {
				t.Errorf("status = %d, want %d", w.Code, tc.wantStatus)
			}
		})
	}
}

// ---------------------------------------------------------------------------
// Authenticate middleware
// ---------------------------------------------------------------------------

func TestAuthenticate(t *testing.T) {
	t.Parallel()

	devAuth := auth.NewDevAuth("test-issuer")
	accountID := uuid.New()

	validToken, err := devAuth.GenerateToken(accountID, "user")
	if err != nil {
		t.Fatalf("generating test token: %v", err)
	}

	tests := []struct {
		name       string
		authHeader string
		wantStatus int
		wantClaims bool
	}{
		{
			name:       "missing authorization header",
			authHeader: "",
			wantStatus: http.StatusUnauthorized,
		},
		{
			name:       "invalid format - no bearer prefix",
			authHeader: "Token " + validToken,
			wantStatus: http.StatusUnauthorized,
		},
		{
			name:       "invalid token",
			authHeader: "Bearer invalid.token.here",
			wantStatus: http.StatusUnauthorized,
		},
		{
			name:       "valid token",
			authHeader: "Bearer " + validToken,
			wantStatus: http.StatusOK,
			wantClaims: true,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()

			var gotClaims Claims
			var gotOK bool

			inner := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				gotClaims, gotOK = GetClaims(r.Context())
				w.WriteHeader(http.StatusOK)
			})

			handler := Authenticate(devAuth)(inner)

			r := httptest.NewRequest(http.MethodGet, "/", nil)
			if tc.authHeader != "" {
				r.Header.Set("Authorization", tc.authHeader)
			}
			w := httptest.NewRecorder()

			handler.ServeHTTP(w, r)

			if w.Code != tc.wantStatus {
				t.Errorf("status = %d, want %d", w.Code, tc.wantStatus)
			}

			if tc.wantClaims {
				if !gotOK {
					t.Fatal("claims should be set in context")
				}
				if gotClaims.AccountID != accountID.String() {
					t.Errorf("claims.AccountID = %q, want %q", gotClaims.AccountID, accountID.String())
				}
				if gotClaims.Role != "user" {
					t.Errorf("claims.Role = %q, want %q", gotClaims.Role, "user")
				}
			}
		})
	}
}

// TestAuthenticate_RejectsBotRole pins that the Authenticate middleware
// rejects any JWT whose claims.Role == "bot". Bots are never supposed to hold
// tokens — this is the last-resort backstop if upstream login gates fail.
func TestAuthenticate_RejectsBotRole(t *testing.T) {
	t.Parallel()

	devAuth := auth.NewDevAuth("test-issuer")
	accountID := uuid.New()

	botToken, err := devAuth.GenerateToken(accountID, "bot")
	if err != nil {
		t.Fatalf("generating bot token: %v", err)
	}

	innerCalled := false
	inner := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		innerCalled = true
		w.WriteHeader(http.StatusOK)
	})

	handler := Authenticate(devAuth)(inner)

	r := httptest.NewRequest(http.MethodGet, "/", nil)
	r.Header.Set("Authorization", "Bearer "+botToken)
	w := httptest.NewRecorder()

	handler.ServeHTTP(w, r)

	if w.Code != http.StatusUnauthorized {
		t.Errorf("status = %d, want %d", w.Code, http.StatusUnauthorized)
	}
	if innerCalled {
		t.Error("inner handler should not be called for bot-role tokens")
	}
}

func TestAuthenticate_AdminRole(t *testing.T) {
	t.Parallel()

	devAuth := auth.NewDevAuth("test-issuer")
	accountID := uuid.New()

	adminToken, err := devAuth.GenerateToken(accountID, "admin")
	if err != nil {
		t.Fatalf("generating admin token: %v", err)
	}

	var gotClaims Claims
	var gotOK bool

	inner := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotClaims, gotOK = GetClaims(r.Context())
		w.WriteHeader(http.StatusOK)
	})

	handler := Authenticate(devAuth)(inner)

	r := httptest.NewRequest(http.MethodGet, "/", nil)
	r.Header.Set("Authorization", "Bearer "+adminToken)
	w := httptest.NewRecorder()

	handler.ServeHTTP(w, r)

	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d", w.Code, http.StatusOK)
	}
	if !gotOK {
		t.Fatal("claims should be set in context")
	}
	if gotClaims.Role != "admin" {
		t.Errorf("claims.Role = %q, want %q", gotClaims.Role, "admin")
	}
}

// ---------------------------------------------------------------------------
// Errors middleware
// ---------------------------------------------------------------------------

func TestErrors(t *testing.T) {
	t.Parallel()

	log := zap.NewNop().Sugar()

	tests := []struct {
		name       string
		handler    v1.Handler
		wantStatus int
		wantError  string
	}{
		{
			name: "no error passes through",
			handler: func(ctx context.Context, w http.ResponseWriter, r *http.Request) error {
				return v1.Respond(w, http.StatusOK, map[string]string{"ok": "true"})
			},
			wantStatus: http.StatusOK,
		},
		{
			name: "RequestError maps to its status",
			handler: func(ctx context.Context, w http.ResponseWriter, r *http.Request) error {
				return v1.NewRequestError(errors.New("bad input"), http.StatusBadRequest)
			},
			wantStatus: http.StatusBadRequest,
			wantError:  "bad input",
		},
		{
			name: "sentinel not found error",
			handler: func(ctx context.Context, w http.ResponseWriter, r *http.Request) error {
				return v1.NewNotFoundError()
			},
			wantStatus: http.StatusNotFound,
			wantError:  "not found",
		},
		{
			name: "non-RequestError becomes 500",
			handler: func(ctx context.Context, w http.ResponseWriter, r *http.Request) error {
				return errors.New("unexpected failure")
			},
			wantStatus: http.StatusInternalServerError,
			wantError:  "Internal Server Error",
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()

			h := Errors(log, tc.handler)

			r := httptest.NewRequest(http.MethodGet, "/", nil)
			w := httptest.NewRecorder()

			h.ServeHTTP(w, r)

			if w.Code != tc.wantStatus {
				t.Errorf("status = %d, want %d", w.Code, tc.wantStatus)
			}

			if tc.wantError != "" {
				var resp v1.ErrorResponse
				if err := json.NewDecoder(w.Body).Decode(&resp); err != nil {
					t.Fatalf("decoding response: %v", err)
				}
				if resp.Error != tc.wantError {
					t.Errorf("error = %q, want %q", resp.Error, tc.wantError)
				}
			}
		})
	}
}

// ---------------------------------------------------------------------------
// Panics middleware
// ---------------------------------------------------------------------------

func TestPanics(t *testing.T) {
	t.Parallel()

	log := zap.NewNop().Sugar()

	inner := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		panic("test panic")
	})

	handler := Panics(log)(inner)

	r := httptest.NewRequest(http.MethodGet, "/", nil)
	w := httptest.NewRecorder()

	handler.ServeHTTP(w, r)

	if w.Code != http.StatusInternalServerError {
		t.Errorf("status = %d, want %d", w.Code, http.StatusInternalServerError)
	}
}

// ---------------------------------------------------------------------------
// Logger middleware
// ---------------------------------------------------------------------------

func TestLogger(t *testing.T) {
	t.Parallel()

	log := zap.NewNop().Sugar()

	inner := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusCreated)
	})

	handler := Logger(log)(inner)

	r := httptest.NewRequest(http.MethodGet, "/test", nil)
	w := httptest.NewRecorder()

	handler.ServeHTTP(w, r)

	if w.Code != http.StatusCreated {
		t.Errorf("status = %d, want %d", w.Code, http.StatusCreated)
	}
}

// TestMetricPath guards Prometheus label cardinality. Unmatched routes (404s from
// internet vulnerability scanners) must collapse to a single label value instead of
// leaking the raw URL, which would create one time series per scanned URL.
// See docs/solutions/infrastructure/prometheus-cardinality-oom-2026-07-09.md.
func TestMetricPath(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name     string
		patterns []string
		url      string
		want     string
	}{
		{
			name:     "matched route uses chi pattern, not the concrete URL",
			patterns: []string{"/v1/users/{id}"},
			url:      "/v1/users/8f0c1a2b",
			want:     "/v1/users/{id}",
		},
		{
			name:     "unmatched route collapses to a constant",
			patterns: nil,
			url:      "/owa/auth/errorFE.aspx",
			want:     unmatchedPath,
		},
		{
			name:     "distinct unmatched routes share one label value",
			patterns: nil,
			url:      "/_layouts/15/error.aspx",
			want:     unmatchedPath,
		},
		{
			name:     "no chi route context at all collapses to a constant",
			patterns: nil,
			url:      "/anything",
			want:     unmatchedPath,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()

			r := httptest.NewRequest(http.MethodGet, tt.url, nil)

			// The last case deliberately carries no chi RouteContext.
			if tt.name != "no chi route context at all collapses to a constant" {
				rctx := chi.NewRouteContext()
				rctx.RoutePatterns = tt.patterns
				r = r.WithContext(context.WithValue(r.Context(), chi.RouteCtxKey, rctx))
			}

			if got := metricPath(r); got != tt.want {
				t.Errorf("metricPath() = %q, want %q", got, tt.want)
			}
		})
	}
}

// TestMetricPath_ScannerTrafficDoesNotGrowCardinality proves the property that
// actually caused the OOM: N distinct unmatched URLs must yield exactly 1 label value.
func TestMetricPath_ScannerTrafficDoesNotGrowCardinality(t *testing.T) {
	t.Parallel()

	scannerURLs := []string{
		"/owa/auth/errorFE.aspx",
		"/_layouts/15/error.aspx",
		"/wp-admin/setup-config.php",
		"/.env",
		"/actuator/health",
	}

	seen := make(map[string]struct{})
	for _, u := range scannerURLs {
		r := httptest.NewRequest(http.MethodGet, u, nil)
		rctx := chi.NewRouteContext() // no RoutePatterns => unmatched
		r = r.WithContext(context.WithValue(r.Context(), chi.RouteCtxKey, rctx))
		seen[metricPath(r)] = struct{}{}
	}

	if len(seen) != 1 {
		t.Errorf("%d distinct scanner URLs produced %d label values, want 1: %v",
			len(scannerURLs), len(seen), seen)
	}
}

// TestLogger_ScrapeOutputHasBoundedPathLabels drives the real Logger middleware through a
// real chi router, then reads the actual Prometheus scrape body. The unit tests above pin
// metricPath's contract; this pins chi's real 404 behaviour AND proves the scraped series
// — the thing that actually exhausted Prometheus's memory — stay bounded.
func TestLogger_ScrapeOutputHasBoundedPathLabels(t *testing.T) {
	// Not parallel: reads the process-global Prometheus registry.

	router := chi.NewRouter()
	router.Use(Logger(zap.NewNop().Sugar()))
	router.Get("/v1/users/{id}", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	})

	// Two concrete URLs on one route pattern, plus scanner URLs matching no route.
	matched := []string{"/v1/users/aaa", "/v1/users/bbb"}
	scanners := []string{"/owa/auth/errorFE.aspx", "/_layouts/15/error.aspx", "/.env"}
	for _, u := range append(append([]string{}, matched...), scanners...) {
		router.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodGet, u, nil))
	}

	// Scrape exactly what Prometheus would scrape.
	scrapeRec := httptest.NewRecorder()
	promhttp.Handler().ServeHTTP(scrapeRec, httptest.NewRequest(http.MethodGet, "/metrics", nil))
	body := scrapeRec.Body.String()

	if !strings.Contains(body, `path="/v1/users/{id}"`) {
		t.Error("scrape is missing the matched route pattern label")
	}
	if !strings.Contains(body, `path="`+unmatchedPath+`"`) {
		t.Error("scrape is missing the collapsed <unmatched> label")
	}

	// No concrete URL may ever appear as a label value.
	for _, u := range append(append([]string{}, matched...), scanners...) {
		if strings.Contains(body, `path="`+u+`"`) {
			t.Errorf("raw URL %q leaked into the scrape as a path label — unbounded cardinality", u)
		}
	}

	// Count distinct path label values on the counter. Bounded regardless of scanner volume.
	paths := make(map[string]struct{})
	re := regexp.MustCompile(`coinpusher_http_requests_total\{[^}]*path="([^"]*)"`)
	for _, m := range re.FindAllStringSubmatch(body, -1) {
		paths[m[1]] = struct{}{}
	}
	if len(paths) > 2 {
		t.Errorf("counter exposed %d distinct path labels, want <=2 (pattern + unmatched): %v", len(paths), paths)
	}
}

// ---------------------------------------------------------------------------
// RequireAdmin middleware
// ---------------------------------------------------------------------------

func TestRequireAdmin(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name       string
		claims     *Claims
		wantStatus int
	}{
		{
			name:       "no claims in context",
			claims:     nil,
			wantStatus: http.StatusUnauthorized,
		},
		{
			name:       "user role blocked",
			claims:     &Claims{AccountID: "a1", Role: "user"},
			wantStatus: http.StatusForbidden,
		},
		{
			name:       "empty role blocked",
			claims:     &Claims{AccountID: "a1", Role: ""},
			wantStatus: http.StatusForbidden,
		},
		{
			name:       "admin role allowed",
			claims:     &Claims{AccountID: "a1", Role: "admin"},
			wantStatus: http.StatusOK,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()

			inner := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.WriteHeader(http.StatusOK)
			})

			handler := RequireAdmin()(inner)

			r := httptest.NewRequest(http.MethodGet, "/", nil)
			if tc.claims != nil {
				ctx := SetClaims(r.Context(), *tc.claims)
				r = r.WithContext(ctx)
			}
			w := httptest.NewRecorder()

			handler.ServeHTTP(w, r)

			if w.Code != tc.wantStatus {
				t.Errorf("status = %d, want %d", w.Code, tc.wantStatus)
			}
		})
	}
}
