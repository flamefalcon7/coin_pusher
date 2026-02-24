// Package gamegrp provides HTTP handlers for game event operations.
package gamegrp

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"

	"github.com/google/uuid"
	"github.com/nats-io/nats.go"

	"github.com/flamefalcon/coin-pusher/backend/business/core/game"
	"github.com/flamefalcon/coin-pusher/backend/business/core/heat"
	"github.com/flamefalcon/coin-pusher/backend/business/web/mid"
	v1 "github.com/flamefalcon/coin-pusher/backend/business/web/v1"
	"github.com/flamefalcon/coin-pusher/backend/business/web/ws"
)

// Group holds the handler dependencies.
type Group struct {
	game *game.Core
	heat *heat.HeatEngine
	nc   *nats.Conn
	room string
}

// New constructs a handler Group.
func New(game *game.Core, heat *heat.HeatEngine, nc *nats.Conn) *Group {
	return &Group{
		game: game,
		heat: heat,
		nc:   nc,
		room: "main",
	}
}

// Event handles POST /v1/game/event.
func (g *Group) Event(ctx context.Context, w http.ResponseWriter, r *http.Request) error {
	var evt game.GameEvent
	if err := v1.Decode(r, &evt); err != nil {
		return err
	}

	result, err := g.game.ProcessEvent(ctx, evt)
	if err != nil {
		return err
	}

	return v1.Respond(w, http.StatusOK, result)
}

// BatchInsertRequest is the request body for batch insert.
type BatchInsertRequest struct {
	SlotID int `json:"slot_id"`
	Count  int `json:"count"`
}

// BatchInsertResponse is the response for batch insert.
type BatchInsertResponse struct {
	Queued    int     `json:"queued"`
	HeatShare float64 `json:"heat_share"`
	Balance   string  `json:"balance"`
}

// BatchInsert handles POST /v1/game/batch-insert.
func (g *Group) BatchInsert(ctx context.Context, w http.ResponseWriter, r *http.Request) error {
	var req BatchInsertRequest
	if err := v1.Decode(r, &req); err != nil {
		return err
	}

	if req.Count <= 0 {
		return v1.NewRequestError(fmt.Errorf("count must be positive"), http.StatusBadRequest)
	}

	// Extract user ID from auth context.
	claims, ok := mid.GetClaims(ctx)
	if !ok {
		return v1.NewAuthError()
	}
	userID, err := uuid.Parse(claims.UserID)
	if err != nil {
		return v1.NewRequestError(fmt.Errorf("invalid user id"), http.StatusBadRequest)
	}

	refKey := uuid.NewString()
	result, err := g.game.ProcessBatchInsert(ctx, userID, req.Count, refKey)
	if err != nil {
		return err
	}
	if !result.Success {
		return v1.NewRequestError(fmt.Errorf("%s", result.Error), http.StatusBadRequest)
	}

	// Add heat on commit.
	g.heat.AddHeat(userID, req.Count)

	// Publish batch_insert command to NATS for game server.
	cmd := ws.NATSBatchInsertCmd{
		UserID: userID.String(),
		SlotID: 0, // default slot
		Count:  req.Count,
	}
	data, err := json.Marshal(cmd)
	if err != nil {
		return fmt.Errorf("marshaling batch insert cmd: %w", err)
	}
	g.nc.Publish(ws.TopicBatchInsert(g.room), data)

	share := g.heat.GetShareForUser(userID)

	return v1.Respond(w, http.StatusOK, BatchInsertResponse{
		Queued:    req.Count,
		HeatShare: share,
		Balance:   result.BalanceCoin,
	})
}
