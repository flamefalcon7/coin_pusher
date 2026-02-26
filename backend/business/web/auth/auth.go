// Package auth provides JWT generation and validation for the API.
package auth

import (
	"crypto/rand"
	"crypto/rsa"
	"errors"
	"fmt"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"github.com/google/uuid"

	"github.com/flamefalcon/coin-pusher/backend/foundation/keystore"
)

// Claims represents the authorization claims embedded in a JWT.
type Claims struct {
	jwt.RegisteredClaims
	AccountID string `json:"account_id"`
}

// Auth manages authentication and authorization.
type Auth struct {
	ks        *keystore.KeyStore
	activeKID string
	issuer    string
	devMode   bool
	devKey    *rsa.PrivateKey
}

// New constructs a production Auth using the provided keystore.
func New(ks *keystore.KeyStore, activeKID, issuer string) *Auth {
	return &Auth{
		ks:        ks,
		activeKID: activeKID,
		issuer:    issuer,
	}
}

// NewDevAuth constructs a dev-mode Auth that generates tokens with a
// throwaway RSA key and skips signature verification.
func NewDevAuth(issuer string) *Auth {
	// Generate an ephemeral RSA key for development tokens.
	key, _ := rsa.GenerateKey(rand.Reader, 2048)
	return &Auth{
		issuer:  issuer,
		devMode: true,
		devKey:  key,
	}
}

// GenerateToken creates a signed JWT for the given account.
func (a *Auth) GenerateToken(accountID uuid.UUID) (string, error) {
	claims := Claims{
		RegisteredClaims: jwt.RegisteredClaims{
			Issuer:    a.issuer,
			Subject:   accountID.String(),
			ExpiresAt: jwt.NewNumericDate(time.Now().Add(24 * time.Hour)),
			IssuedAt:  jwt.NewNumericDate(time.Now()),
		},
		AccountID: accountID.String(),
	}

	token := jwt.NewWithClaims(jwt.SigningMethodRS256, claims)

	privateKey, err := a.signingKey()
	if err != nil {
		return "", fmt.Errorf("signing key: %w", err)
	}

	str, err := token.SignedString(privateKey)
	if err != nil {
		return "", fmt.Errorf("signing token: %w", err)
	}

	return str, nil
}

// ValidateToken parses and validates a JWT, returning the claims.
func (a *Auth) ValidateToken(tokenStr string) (Claims, error) {
	var claims Claims

	token, err := jwt.ParseWithClaims(tokenStr, &claims, func(t *jwt.Token) (any, error) {
		if _, ok := t.Method.(*jwt.SigningMethodRSA); !ok {
			return nil, fmt.Errorf("unexpected signing method: %v", t.Header["alg"])
		}
		return a.verifyKey()
	})
	if err != nil {
		return Claims{}, fmt.Errorf("parsing token: %w", err)
	}

	if !token.Valid {
		return Claims{}, errors.New("invalid token")
	}

	return claims, nil
}

// IsDevMode returns whether auth is running in development mode.
func (a *Auth) IsDevMode() bool {
	return a.devMode
}

func (a *Auth) signingKey() (*rsa.PrivateKey, error) {
	if a.devMode {
		return a.devKey, nil
	}
	return a.ks.PrivateKey(a.activeKID)
}

func (a *Auth) verifyKey() (*rsa.PublicKey, error) {
	if a.devMode {
		return &a.devKey.PublicKey, nil
	}
	return a.ks.PublicKey(a.activeKID)
}
