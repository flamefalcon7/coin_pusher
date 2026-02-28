// Package inventorygrp provides HTTP handlers for inventory operations.
package inventorygrp

import (
	"context"
	"net/http"

	"github.com/google/uuid"

	"github.com/flamefalcon/coin-pusher/backend/business/core/inventory"
	"github.com/flamefalcon/coin-pusher/backend/business/web/mid"
	v1 "github.com/flamefalcon/coin-pusher/backend/business/web/v1"
)

// Group holds the handler dependencies.
type Group struct {
	inventory *inventory.Core
}

// New constructs a handler Group.
func New(inventory *inventory.Core) *Group {
	return &Group{
		inventory: inventory,
	}
}

// GetInventory handles GET /v1/inventory.
func (g *Group) GetInventory(ctx context.Context, w http.ResponseWriter, r *http.Request) error {
	claims, ok := mid.GetClaims(ctx)
	if !ok {
		return v1.NewAuthError()
	}

	accountID, err := uuid.Parse(claims.AccountID)
	if err != nil {
		return v1.NewAuthError()
	}

	inv, err := g.inventory.GetInventory(ctx, accountID)
	if err != nil {
		return err
	}

	return v1.Respond(w, http.StatusOK, inv)
}

// OpenChest handles POST /v1/chest/open.
func (g *Group) OpenChest(ctx context.Context, w http.ResponseWriter, r *http.Request) error {
	claims, ok := mid.GetClaims(ctx)
	if !ok {
		return v1.NewAuthError()
	}

	accountID, err := uuid.Parse(claims.AccountID)
	if err != nil {
		return v1.NewAuthError()
	}

	result, err := g.inventory.OpenChest(ctx, accountID)
	if err != nil {
		return err
	}

	return v1.Respond(w, http.StatusOK, result)
}
