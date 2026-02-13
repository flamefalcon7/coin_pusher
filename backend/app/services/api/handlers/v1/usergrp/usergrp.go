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
	SUIAddress string `json:"sui_address"`
	Message    string `json:"message"`
	Signature  string `json:"signature"`
}

type loginResponse struct {
	Token string    `json:"token"`
	User  user.User `json:"user"`
}

// Login handles POST /v1/auth/login.
func (g *Group) Login(ctx context.Context, w http.ResponseWriter, r *http.Request) error {
	var req loginRequest
	if err := v1.Decode(r, &req); err != nil {
		return err
	}

	if req.SUIAddress == "" {
		return v1.NewRequestError(v1.ErrAuthFailed, http.StatusBadRequest)
	}

	// Verify SUI signature (skipped in dev mode).
	if !g.auth.VerifySUISignature(req.SUIAddress, req.Message, req.Signature) {
		return v1.NewAuthError()
	}

	// Find or create user.
	usr, err := g.user.FindOrCreate(ctx, user.NewUser{
		SUIAddress: req.SUIAddress,
		Name:       "",
	})
	if err != nil {
		return err
	}

	// Generate JWT.
	token, err := g.auth.GenerateToken(usr.ID, usr.SUIAddress)
	if err != nil {
		return err
	}

	return v1.Respond(w, http.StatusOK, loginResponse{
		Token: token,
		User:  usr,
	})
}

// Profile handles GET /v1/user/profile.
func (g *Group) Profile(ctx context.Context, w http.ResponseWriter, r *http.Request) error {
	claims, ok := mid.GetClaims(ctx)
	if !ok {
		return v1.NewAuthError()
	}

	userID, err := uuid.Parse(claims.UserID)
	if err != nil {
		return v1.NewAuthError()
	}

	usr, err := g.user.QueryByID(ctx, userID)
	if err != nil {
		return err
	}

	return v1.Respond(w, http.StatusOK, usr)
}
