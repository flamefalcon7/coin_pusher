// Package usergrp provides HTTP handlers for user operations.
package usergrp

import (
	"context"
	"crypto/subtle"
	"net/http"
	"sync"
	"time"

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

	adminPasscode string
	failMu        sync.Mutex
	failTimes     []time.Time // recent failed passcode attempts (process-wide)
}

// Brute-force throttle for AdminLogin: once this many failures land inside
// the window, every attempt (right or wrong) is rejected until it slides out.
const (
	adminLoginMaxFails   = 3
	adminLoginFailWindow = 10 * time.Minute
)

// New constructs a handler Group.
func New(user *user.Core, auth *auth.Auth) *Group {
	return &Group{
		user: user,
		auth: auth,
	}
}

// WithAdminPasscode enables AdminLogin with the given shared secret. An empty
// passcode keeps the handler disabled (every call returns 404).
func (g *Group) WithAdminPasscode(passcode string) *Group {
	g.adminPasscode = passcode
	return g
}

type loginRequest struct {
	ProviderType string `json:"provider_type"` // "wallet" or "email"
	ProviderUID  string `json:"provider_uid"`  // wallet address or email
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

	// Early reject bot provider_type at HTTP boundary. Core-layer
	// FindOrCreate also rejects; this is defense in depth so the generic
	// login endpoint never even reaches core code for bot provisioning
	// attempts. The passcode-admin identity is a published constant pair,
	// so it must never be reachable without the passcode either.
	if req.ProviderType == user.ProviderTypeBot || req.ProviderType == user.ProviderTypePasscode {
		return v1.NewRequestError(v1.ErrAuthFailed, http.StatusBadRequest)
	}

	// Find or create account.
	acct, err := g.user.FindOrCreate(ctx, user.NewAccount{
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
	Address      string `json:"address"`
	Nonce        string `json:"nonce"`
	Signature    string `json:"signature"`
	ReferralCode string `json:"referral_code"` // optional, used on first login only
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

	acct, err := g.user.VerifyWalletLogin(ctx, req.Nonce, req.Signature, req.Address, req.ReferralCode)
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

// -------------------------------------------------------------------------
// Admin passcode login
// -------------------------------------------------------------------------

type adminLoginRequest struct {
	Passcode string `json:"passcode"`
}

// AdminLogin handles POST /v1/auth/admin/login. It exchanges the configured
// shared passcode for a JWT on the single passcode-admin account, so an
// operator can reach admin-only controls from a device with no wallet.
//
// Not a general login: the account is fixed (provider passcode/admin), its
// role is forced to admin on every call, and failures are throttled
// process-wide because a shared secret has no per-user lockout to lean on.
func (g *Group) AdminLogin(ctx context.Context, w http.ResponseWriter, r *http.Request) error {
	if g.adminPasscode == "" {
		return v1.NewRequestError(v1.ErrNotFound, http.StatusNotFound)
	}

	var req adminLoginRequest
	if err := v1.Decode(r, &req); err != nil {
		return err
	}

	switch g.checkPasscode(req.Passcode) {
	case passcodeLocked:
		return v1.NewRequestError(v1.ErrAuthFailed, http.StatusTooManyRequests)
	case passcodeWrong:
		return v1.NewAuthError()
	}

	acct, err := g.user.FindOrCreate(ctx, user.NewAccount{
		ProviderType: user.ProviderTypePasscode,
		ProviderUID:  user.PasscodeAdminUID,
	})
	if err != nil {
		return err
	}

	if acct.Role != user.RoleAdmin {
		if err := g.user.SetRole(ctx, acct.ID, user.RoleAdmin); err != nil {
			return err
		}
		acct.Role = user.RoleAdmin
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

type passcodeResult int

const (
	passcodeOK passcodeResult = iota
	passcodeWrong
	passcodeLocked
)

// checkPasscode prunes, checks the lockout, compares, and records — all under
// one lock, so concurrent requests cannot each observe "under budget" before
// any of them has recorded a failure. A correct passcode clears the counter so
// an operator's own earlier typos don't lock them out later.
func (g *Group) checkPasscode(candidate string) passcodeResult {
	g.failMu.Lock()
	defer g.failMu.Unlock()

	now := time.Now()
	cutoff := now.Add(-adminLoginFailWindow)
	kept := g.failTimes[:0]
	for _, t := range g.failTimes {
		if t.After(cutoff) {
			kept = append(kept, t)
		}
	}
	g.failTimes = kept

	if len(g.failTimes) >= adminLoginMaxFails {
		return passcodeLocked
	}
	if subtle.ConstantTimeCompare([]byte(candidate), []byte(g.adminPasscode)) != 1 {
		g.failTimes = append(g.failTimes, now)
		return passcodeWrong
	}
	g.failTimes = g.failTimes[:0]
	return passcodeOK
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

// -------------------------------------------------------------------------
// Display Name + Referral
// -------------------------------------------------------------------------

type setDisplayNameRequest struct {
	DisplayName string `json:"display_name"`
}

// SetDisplayName handles PUT /v1/user/display-name.
func (g *Group) SetDisplayName(ctx context.Context, w http.ResponseWriter, r *http.Request) error {
	claims, ok := mid.GetClaims(ctx)
	if !ok {
		return v1.NewAuthError()
	}

	accountID, err := uuid.Parse(claims.AccountID)
	if err != nil {
		return v1.NewAuthError()
	}

	var req setDisplayNameRequest
	if err := v1.Decode(r, &req); err != nil {
		return err
	}

	if err := g.user.SetDisplayName(ctx, accountID, req.DisplayName); err != nil {
		return err
	}

	return v1.Respond(w, http.StatusOK, map[string]string{"display_name": req.DisplayName})
}

type setReferralCodeRequest struct {
	ReferralCode string `json:"referral_code"`
}

// SetReferralCode handles PUT /v1/user/referral-code.
func (g *Group) SetReferralCode(ctx context.Context, w http.ResponseWriter, r *http.Request) error {
	claims, ok := mid.GetClaims(ctx)
	if !ok {
		return v1.NewAuthError()
	}

	accountID, err := uuid.Parse(claims.AccountID)
	if err != nil {
		return v1.NewAuthError()
	}

	var req setReferralCodeRequest
	if err := v1.Decode(r, &req); err != nil {
		return err
	}

	if err := g.user.SetCustomReferralCode(ctx, accountID, req.ReferralCode); err != nil {
		return err
	}

	return v1.Respond(w, http.StatusOK, map[string]string{"referral_code": req.ReferralCode})
}

type referralInfoResponse struct {
	ReferralCode       string `json:"referral_code"`
	ReferralCustomized bool   `json:"referral_customized"`
	ReferralCount      int    `json:"referral_count"`
}

// ReferralInfo handles GET /v1/user/referral.
func (g *Group) ReferralInfo(ctx context.Context, w http.ResponseWriter, r *http.Request) error {
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

	count, err := g.user.CountReferrals(ctx, accountID)
	if err != nil {
		return err
	}

	return v1.Respond(w, http.StatusOK, referralInfoResponse{
		ReferralCode:       acct.ReferralCode,
		ReferralCustomized: acct.ReferralCodeCustomized,
		ReferralCount:      count,
	})
}
