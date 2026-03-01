package mid

import (
	"crypto/subtle"
	"net/http"
	"strings"

	"github.com/flamefalcon/coin-pusher/backend/business/web/auth"
)

// Authenticate returns middleware that validates a JWT Bearer token.
func Authenticate(a *auth.Auth) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			authHeader := r.Header.Get("Authorization")
			if authHeader == "" {
				http.Error(w, `{"error":"missing authorization header"}`, http.StatusUnauthorized)
				return
			}

			parts := strings.SplitN(authHeader, " ", 2)
			if len(parts) != 2 || !strings.EqualFold(parts[0], "bearer") {
				http.Error(w, `{"error":"invalid authorization format"}`, http.StatusUnauthorized)
				return
			}

			claims, err := a.ValidateToken(parts[1])
			if err != nil {
				http.Error(w, `{"error":"invalid token"}`, http.StatusUnauthorized)
				return
			}

			ctx := SetClaims(r.Context(), Claims{
				AccountID: claims.AccountID,
				Role:      claims.Role,
			})

			next.ServeHTTP(w, r.WithContext(ctx))
		})
	}
}

// GameSecret returns middleware that validates the X-Game-Secret header.
func GameSecret(apiKey string) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			secret := r.Header.Get("X-Game-Secret")
			if secret == "" || subtle.ConstantTimeCompare([]byte(secret), []byte(apiKey)) != 1 {
				http.Error(w, `{"error":"invalid game secret"}`, http.StatusUnauthorized)
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}
