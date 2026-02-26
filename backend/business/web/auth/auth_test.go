package auth

import (
	"crypto/rand"
	"crypto/rsa"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"github.com/google/uuid"
)

func TestGenerateAndValidateToken(t *testing.T) {
	t.Parallel()

	a := NewDevAuth("test-issuer")
	accountID := uuid.New()

	token, err := a.GenerateToken(accountID)
	if err != nil {
		t.Fatalf("GenerateToken() error = %v", err)
	}

	if token == "" {
		t.Fatal("GenerateToken() returned empty token")
	}

	claims, err := a.ValidateToken(token)
	if err != nil {
		t.Fatalf("ValidateToken() error = %v", err)
	}

	if claims.AccountID != accountID.String() {
		t.Errorf("AccountID = %q, want %q", claims.AccountID, accountID.String())
	}

	if claims.Issuer != "test-issuer" {
		t.Errorf("Issuer = %q, want %q", claims.Issuer, "test-issuer")
	}

	if claims.Subject != accountID.String() {
		t.Errorf("Subject = %q, want %q", claims.Subject, accountID.String())
	}
}

func TestValidateToken_Expired(t *testing.T) {
	t.Parallel()

	a := NewDevAuth("test-issuer")

	// Create a token that's already expired by signing manually.
	claims := Claims{
		RegisteredClaims: jwt.RegisteredClaims{
			Issuer:    "test-issuer",
			Subject:   uuid.NewString(),
			ExpiresAt: jwt.NewNumericDate(time.Now().Add(-1 * time.Hour)),
			IssuedAt:  jwt.NewNumericDate(time.Now().Add(-2 * time.Hour)),
		},
		AccountID: uuid.NewString(),
	}

	token := jwt.NewWithClaims(jwt.SigningMethodRS256, claims)
	signed, err := token.SignedString(a.devKey)
	if err != nil {
		t.Fatalf("signing expired token: %v", err)
	}

	_, err = a.ValidateToken(signed)
	if err == nil {
		t.Fatal("ValidateToken() should reject expired token")
	}
}

func TestValidateToken_WrongKey(t *testing.T) {
	t.Parallel()

	a := NewDevAuth("test-issuer")
	accountID := uuid.New()

	token, err := a.GenerateToken(accountID)
	if err != nil {
		t.Fatalf("GenerateToken() error = %v", err)
	}

	// Create a different auth with a different key.
	other := NewDevAuth("test-issuer")

	_, err = other.ValidateToken(token)
	if err == nil {
		t.Fatal("ValidateToken() should reject token signed with different key")
	}
}

func TestDevMode(t *testing.T) {
	t.Parallel()

	a := NewDevAuth("test-issuer")

	if !a.IsDevMode() {
		t.Fatal("NewDevAuth should be in dev mode")
	}

	key, _ := rsa.GenerateKey(rand.Reader, 2048)
	prod := &Auth{
		devMode: false,
		devKey:  key,
	}

	if prod.IsDevMode() {
		t.Fatal("should not be in dev mode")
	}
}
