// Package usergrp provides HTTP handlers for user operations.
package usergrp

import (
	"context"
	"net/http"

	"github.com/google/uuid"

	"github.com/flamefalcon/coin-pusher/backend/business/core/user"
	"github.com/flamefalcon/coin-pusher/backend/business/web/auth"
	"github.com/flamefalcon/coin-pusher/backend/business/web/mid"
	v1 "github.com/flamefalcon/coin-pusher/backend/business/web/v1"
)

// Group holds the handler dependencies.
type Group struct {
	user *user.Core
	auth *auth.Auth
}

// New constructs a handler Group.
func New(user *user.Core, auth *auth.Auth) *Group {
	return &Group{
		user: user,
		auth: auth,
	}
}

type loginRequest struct {
	ProviderType string `json:"provider_type"` // "wallet" or "email"
	ProviderUID  string `json:"provider_uid"`  // wallet address or email
	DisplayName  string `json:"display_name"`
}

type loginResponse struct {
	Token   string       `json:"token"`
	Account user.Account `json:"account"`
}

// Login handles POST /v1/auth/login.
func (g *Group) Login(ctx context.Context, w http.ResponseWriter, r *http.Request) error {
	var req loginRequest
	if err := v1.Decode(r, &req); err != nil {
		return err
	}

	if req.ProviderType == "" || req.ProviderUID == "" {
		return v1.NewRequestError(v1.ErrAuthFailed, http.StatusBadRequest)
	}

	// Find or create account.
	acct, err := g.user.FindOrCreate(ctx, user.NewAccount{
		DisplayName:  req.DisplayName,
		ProviderType: req.ProviderType,
		ProviderUID:  req.ProviderUID,
	})
	if err != nil {
		return err
	}

	// Generate JWT.
	token, err := g.auth.GenerateToken(acct.ID, acct.Role)
	if err != nil {
		return err
	}

	return v1.Respond(w, http.StatusOK, loginResponse{
		Token:   token,
		Account: acct,
	})
}

// -------------------------------------------------------------------------
// Wallet Login
// -------------------------------------------------------------------------

type nonceResponse struct {
	Nonce     string `json:"nonce"`
	Message   string `json:"message"`
	ExpiresIn int    `json:"expires_in"` // seconds
}

// Nonce handles GET /v1/auth/nonce.
func (g *Group) Nonce(ctx context.Context, w http.ResponseWriter, r *http.Request) error {
	rec, err := g.user.GenerateNonce(ctx)
	if err != nil {
		return err
	}

	msg := "Sign in to Coin Pusher\nNonce: " + rec.Nonce

	return v1.Respond(w, http.StatusOK, nonceResponse{
		Nonce:     rec.Nonce,
		Message:   msg,
		ExpiresIn: 300,
	})
}

type walletLoginRequest struct {
	Address   string `json:"address"`
	Nonce     string `json:"nonce"`
	Signature string `json:"signature"`
}

// WalletLogin handles POST /v1/auth/wallet/login.
func (g *Group) WalletLogin(ctx context.Context, w http.ResponseWriter, r *http.Request) error {
	var req walletLoginRequest
	if err := v1.Decode(r, &req); err != nil {
		return err
	}

	if req.Address == "" || req.Nonce == "" || req.Signature == "" {
		return v1.NewRequestError(v1.ErrAuthFailed, http.StatusBadRequest)
	}

	acct, err := g.user.VerifyWalletLogin(ctx, req.Nonce, req.Signature, req.Address)
	if err != nil {
		return err
	}

	token, err := g.auth.GenerateToken(acct.ID, acct.Role)
	if err != nil {
		return err
	}

	return v1.Respond(w, http.StatusOK, loginResponse{
		Token:   token,
		Account: acct,
	})
}

// Profile handles GET /v1/user/profile.
func (g *Group) Profile(ctx context.Context, w http.ResponseWriter, r *http.Request) error {
	claims, ok := mid.GetClaims(ctx)
	if !ok {
		return v1.NewAuthError()
	}

	accountID, err := uuid.Parse(claims.AccountID)
	if err != nil {
		return v1.NewAuthError()
	}

	acct, err := g.user.QueryByID(ctx, accountID)
	if err != nil {
		return err
	}

	return v1.Respond(w, http.StatusOK, acct)
}
