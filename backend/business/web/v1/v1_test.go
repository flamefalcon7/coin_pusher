package v1

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestRespond(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name       string
		statusCode int
		data       any
		wantStatus int
		wantCT     string
		wantBody   string
	}{
		{
			name:       "ok with data",
			statusCode: http.StatusOK,
			data:       map[string]string{"msg": "hello"},
			wantStatus: http.StatusOK,
			wantCT:     "application/json",
			wantBody:   `{"msg":"hello"}`,
		},
		{
			name:       "created with data",
			statusCode: http.StatusCreated,
			data:       map[string]int{"id": 42},
			wantStatus: http.StatusCreated,
			wantCT:     "application/json",
			wantBody:   `{"id":42}`,
		},
		{
			name:       "no content skips body",
			statusCode: http.StatusNoContent,
			data:       nil,
			wantStatus: http.StatusNoContent,
			wantCT:     "",
			wantBody:   "",
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()

			w := httptest.NewRecorder()
			err := Respond(w, tc.statusCode, tc.data)
			if err != nil {
				t.Fatalf("Respond() error = %v", err)
			}

			if w.Code != tc.wantStatus {
				t.Errorf("status = %d, want %d", w.Code, tc.wantStatus)
			}

			ct := w.Header().Get("Content-Type")
			if ct != tc.wantCT {
				t.Errorf("Content-Type = %q, want %q", ct, tc.wantCT)
			}

			body := strings.TrimSpace(w.Body.String())
			if body != tc.wantBody {
				t.Errorf("body = %q, want %q", body, tc.wantBody)
			}
		})
	}
}

func TestDecode(t *testing.T) {
	t.Parallel()

	type payload struct {
		Name string `json:"name"`
		Age  int    `json:"age"`
	}

	tests := []struct {
		name    string
		body    string
		wantErr bool
	}{
		{
			name:    "valid json",
			body:    `{"name":"alice","age":30}`,
			wantErr: false,
		},
		{
			name:    "invalid json",
			body:    `{bad json`,
			wantErr: true,
		},
		{
			name:    "unknown fields rejected",
			body:    `{"name":"alice","age":30,"extra":"field"}`,
			wantErr: true,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()

			r := httptest.NewRequest(http.MethodPost, "/", strings.NewReader(tc.body))
			var p payload
			err := Decode(r, &p)

			if tc.wantErr && err == nil {
				t.Fatal("Decode() expected error, got nil")
			}
			if !tc.wantErr && err != nil {
				t.Fatalf("Decode() unexpected error: %v", err)
			}

			if tc.wantErr {
				var reqErr *RequestError
				if !errors.As(err, &reqErr) {
					t.Errorf("error should be *RequestError, got %T", err)
				} else if reqErr.Status != http.StatusBadRequest {
					t.Errorf("status = %d, want %d", reqErr.Status, http.StatusBadRequest)
				}
			}

			if !tc.wantErr {
				if p.Name != "alice" || p.Age != 30 {
					t.Errorf("decoded = %+v, want {alice 30}", p)
				}
			}
		})
	}
}

func TestRequestError(t *testing.T) {
	t.Parallel()

	inner := errors.New("something broke")
	err := NewRequestError(inner, http.StatusBadGateway)

	var reqErr *RequestError
	if !errors.As(err, &reqErr) {
		t.Fatal("NewRequestError should return *RequestError")
	}

	if reqErr.Status != http.StatusBadGateway {
		t.Errorf("status = %d, want %d", reqErr.Status, http.StatusBadGateway)
	}

	if reqErr.Error() != "something broke" {
		t.Errorf("Error() = %q, want %q", reqErr.Error(), "something broke")
	}

	if !errors.Is(err, inner) {
		t.Error("Unwrap should allow errors.Is to find the inner error")
	}
}

func TestSentinelErrors(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name       string
		factory    func() error
		sentinel   error
		wantStatus int
	}{
		{
			name:       "not found",
			factory:    NewNotFoundError,
			sentinel:   ErrNotFound,
			wantStatus: 404,
		},
		{
			name:       "auth failed",
			factory:    NewAuthError,
			sentinel:   ErrAuthFailed,
			wantStatus: 401,
		},
		{
			name:       "forbidden",
			factory:    NewForbiddenError,
			sentinel:   ErrForbidden,
			wantStatus: 403,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()

			err := tc.factory()
			if !errors.Is(err, tc.sentinel) {
				t.Errorf("errors.Is should match sentinel %v", tc.sentinel)
			}

			var reqErr *RequestError
			if !errors.As(err, &reqErr) {
				t.Fatal("should be *RequestError")
			}
			if reqErr.Status != tc.wantStatus {
				t.Errorf("status = %d, want %d", reqErr.Status, tc.wantStatus)
			}
		})
	}
}

func TestNewInsufficientFundError(t *testing.T) {
	t.Parallel()

	err := NewInsufficientFundError("COIN", json.Number("10"), json.Number("5"))
	if !errors.Is(err, ErrInsufficientFund) {
		t.Error("should wrap ErrInsufficientFund")
	}

	var reqErr *RequestError
	if !errors.As(err, &reqErr) {
		t.Fatal("should be *RequestError")
	}
	if reqErr.Status != 402 {
		t.Errorf("status = %d, want 402", reqErr.Status)
	}

	if !strings.Contains(err.Error(), "COIN") {
		t.Errorf("error should mention currency, got: %s", err.Error())
	}
}
