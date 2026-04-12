// Package gamegrp provides HTTP handlers for game event operations.
package gamegrp

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"

	"github.com/google/uuid"
	"github.com/nats-io/nats.go"
	"github.com/shopspring/decimal"

	"github.com/flamefalcon/coin-pusher/backend/business/core/game"
	"github.com/flamefalcon/coin-pusher/backend/business/core/heat"
	"github.com/flamefalcon/coin-pusher/backend/business/web/mid"
	v1 "github.com/flamefalcon/coin-pusher/backend/business/web/v1"
	"github.com/flamefalcon/coin-pusher/backend/business/web/ws"
	"github.com/flamefalcon/coin-pusher/backend/foundation/metrics"
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
//
// BalancePlay and BalanceCash are the post-insert balances. A single insert
// may draw from one or both currencies (play-first, cash-fallback); both
// values are returned so the client can render a unified wallet total plus a
// separate "withdrawable" sub-indicator.
type BatchInsertResponse struct {
	Queued      int     `json:"queued"`
	HeatShare   float64 `json:"heat_share"`
	BalancePlay string  `json:"balance_play"`
	BalanceCash string  `json:"balance_cash"`
}

// BatchInsert handles POST /v1/game/batch-insert.
func (g *Group) BatchInsert(ctx context.Context, w http.ResponseWriter, r *http.Request) error {
	var req BatchInsertRequest
	if err := v1.Decode(r, &req); err != nil {
		return err
	}

	const maxBatchCount = 100
	if req.Count <= 0 || req.Count > maxBatchCount {
		return v1.NewRequestError(fmt.Errorf("count must be between 1 and %d", maxBatchCount), http.StatusBadRequest)
	}

	// Extract user ID from auth context.
	claims, ok := mid.GetClaims(ctx)
	if !ok {
		return v1.NewAuthError()
	}
	accountID, err := uuid.Parse(claims.AccountID)
	if err != nil {
		return v1.NewRequestError(fmt.Errorf("invalid account id"), http.StatusBadRequest)
	}

	refKey := uuid.NewString()
	result, err := g.game.ProcessBatchInsert(ctx, accountID, req.Count, refKey)
	if err != nil {
		return err
	}
	if !result.Success {
		return v1.NewRequestError(fmt.Errorf("%s", result.Error), http.StatusBadRequest)
	}

	// Add heat on commit.
	g.heat.AddHeat(accountID, req.Count)

	// Publish batch_insert command to NATS for game server.
	cmd := ws.NATSBatchInsertCmd{
		UserID: accountID.String(),
		SlotID: 0, // default slot
		Count:  req.Count,
	}
	data, err := json.Marshal(cmd)
	if err != nil {
		return fmt.Errorf("marshaling batch insert cmd: %w", err)
	}
	// P1-14: Check publish error; refund balance if NATS is unreachable.
	if err := g.nc.Publish(ws.TopicBatchInsert(g.room), data); err != nil {
		refundKey := uuid.NewString()
		// Reverse the exact split the insert applied so the ledger refund
		// entries mirror the insert entries per-currency.
		playDeb, _ := decimal.NewFromString(result.PlayDebited)
		cashDeb, _ := decimal.NewFromString(result.CashDebited)
		if _, refundErr := g.game.RefundBatchInsert(ctx, accountID, playDeb, cashDeb, refundKey); refundErr != nil {
			metrics.BatchInsertRefundFailures.Inc()
			return fmt.Errorf("nats publish failed and refund failed: publish=%w, refund=%v", err, refundErr)
		}
		return fmt.Errorf("nats publish failed (balance refunded): %w", err)
	}

	share := g.heat.GetShareForUser(accountID)

	return v1.Respond(w, http.StatusOK, BatchInsertResponse{
		Queued:      req.Count,
		HeatShare:   share,
		BalancePlay: result.BalancePlay,
		BalanceCash: result.BalanceCash,
	})
}
