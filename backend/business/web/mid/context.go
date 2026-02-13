// Package mid provides HTTP middleware for the web framework.
package mid

import "context"

type ctxKey int

const (
	correlationIDKey ctxKey = iota + 1
	claimsKey
)

// SetCorrelationID stores the correlation ID in the context.
func SetCorrelationID(ctx context.Context, id string) context.Context {
	return context.WithValue(ctx, correlationIDKey, id)
}

// GetCorrelationID retrieves the correlation ID from the context.
func GetCorrelationID(ctx context.Context) string {
	v, ok := ctx.Value(correlationIDKey).(string)
	if !ok {
		return ""
	}
	return v
}

// Claims represents the authorization claims extracted from a JWT.
type Claims struct {
	UserID     string `json:"user_id"`
	SUIAddress string `json:"sui_address"`
}

// SetClaims stores the claims in the context.
func SetClaims(ctx context.Context, claims Claims) context.Context {
	return context.WithValue(ctx, claimsKey, claims)
}

// GetClaims retrieves the claims from the context.
func GetClaims(ctx context.Context) (Claims, bool) {
	v, ok := ctx.Value(claimsKey).(Claims)
	return v, ok
}
