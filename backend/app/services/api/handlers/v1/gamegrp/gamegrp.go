// Package gamegrp provides HTTP handlers for game event operations.
package gamegrp

import (
	"context"
	"fmt"
	"net/http"
	"time"

	"github.com/google/uuid"
	"github.com/shopspring/decimal"

	"github.com/flamefalcon/coin-pusher/backend/business/core/accounting"
	"github.com/flamefalcon/coin-pusher/backend/business/core/game"
	"github.com/flamefalcon/coin-pusher/backend/business/core/heat"
	"github.com/flamefalcon/coin-pusher/backend/business/web/mid"
	v1 "github.com/flamefalcon/coin-pusher/backend/business/web/v1"
	"github.com/flamefalcon/coin-pusher/backend/business/web/ws"
	"github.com/flamefalcon/coin-pusher/backend/foundation/metrics"
)

// refundTxTimeout bounds the refund transaction when run on context.Background()
// (decoupled from the request ctx so cancellation of the caller can't abort
// the refund, but still bounded so a stuck DB can't leak goroutines).
const refundTxTimeout = 10 * time.Second

// natsPublisher is the minimal NATS surface the Group needs. *nats.Conn
// satisfies it; tests inject a recorder to assert on published payloads.
type natsPublisher interface {
	Publish(subj string, data []byte) error
}

// Group holds the handler dependencies.
type Group struct {
	game *game.Core
	heat *heat.HeatEngine
	nc   natsPublisher
	room string
	// liveness is the game server's heartbeat gate, shared with the WS handler
	// that feeds it. Without it this endpoint would keep debiting balances into
	// a dead NATS subject after the game server stops. See D-006.
	liveness *ws.GameLiveness
	// outboxEnabled routes batch_insert through nats_outbox (flag on) or
	// keeps the legacy inline-publish-with-refund path (flag off). See
	// docs/plans/2026-04-13-001 Unit 6. Flag set at process start via
	// BACKEND_OUTBOX_ENABLED.
	outboxEnabled bool
}

// New constructs a handler Group. liveness must be the same gate the WS
// handler's slot_status subscription feeds; a nil gate reads as dead and
// BatchInsert will refuse every request.
func New(game *game.Core, heat *heat.HeatEngine, nc natsPublisher, outboxEnabled bool, liveness *ws.GameLiveness) *Group {
	return &Group{
		game:          game,
		heat:          heat,
		nc:            nc,
		room:          "main",
		outboxEnabled: outboxEnabled,
		liveness:      liveness,
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
//
// PlayDebited and CashDebited expose the exact split applied on this insert,
// so clients and agents can verify what was consumed without having to retain
// pre-insert balance state.
type BatchInsertResponse struct {
	Queued      int     `json:"queued"`
	HeatShare   float64 `json:"heat_share"`
	BalancePlay string  `json:"balance_play"`
	BalanceCash string  `json:"balance_cash"`
	PlayDebited string  `json:"play_debited,omitempty"`
	CashDebited string  `json:"cash_debited,omitempty"`
}

// BatchInsert handles POST /v1/game/batch-insert.
func (g *Group) BatchInsert(ctx context.Context, w http.ResponseWriter, r *http.Request) error {
	var req BatchInsertRequest
	if err := v1.Decode(r, &req); err != nil {
		return err
	}

	if req.Count <= 0 || req.Count > ws.MaxBatchCount {
		return v1.NewRequestError(fmt.Errorf("count must be between 1 and %d", ws.MaxBatchCount), http.StatusBadRequest)
	}

	// Refuse before the debit if the game server's heartbeat is stale — the
	// published command would be dropped and the player charged for it.
	// 503 rather than 400: the request is valid, the dependency is not.
	if !g.liveness.Live() {
		metrics.GameUnavailableRejects.WithLabelValues("http_batch_insert").Inc()
		return v1.NewRequestError(fmt.Errorf("game server unavailable"), http.StatusServiceUnavailable)
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
	slotID := 0 // HTTP handler always uses default slot

	// Outbox path (flag on): write nats_outbox row inside same tx as debit;
	// drainer publishes at-least-once. No inline publish, no refund path.
	var outboxWriter accounting.OutboxWriter
	if g.outboxEnabled {
		payload, encodeErr := ws.EncodeBatchInsertPayload(accountID.String(), slotID, req.Count, refKey)
		if encodeErr != nil {
			return fmt.Errorf("encode batch_insert payload: %w", encodeErr)
		}
		subject := ws.TopicBatchInsert(g.room)
		outboxWriter = func(ctx context.Context, s accounting.Storer) error {
			return s.InsertOutboxRow(ctx, subject, payload, refKey)
		}
	}

	result, err := g.game.ProcessBatchInsert(ctx, accountID, req.Count, refKey, outboxWriter)
	if err != nil {
		return err
	}
	if !result.Success {
		return v1.NewRequestError(fmt.Errorf("%s", result.Error), http.StatusBadRequest)
	}

	// Add heat on commit.
	g.heat.AddHeat(accountID, req.Count)

	if !g.outboxEnabled {
		// Legacy path: inline publish + refund on publish failure. Unit 8 of
		// the outbox plan deletes this block after production bakes confirm
		// zero BatchInsertRefundFailures.
		// reference_id ships on this path too (not only outbox): the game
		// server dedupes commands on it — the only defense when NATS-level
		// duplication redelivers one publish N times. See docs/solutions/
		// infrastructure/nats-zombie-subscription-triple-command-2026-07-23.md.
		data, err := ws.EncodeBatchInsertPayload(accountID.String(), slotID, req.Count, refKey)
		if err != nil {
			return fmt.Errorf("encoding batch insert cmd: %w", err)
		}
		// P1-14: Check publish error; refund balance if NATS is unreachable.
		if err := g.nc.Publish(ws.TopicBatchInsert(g.room), data); err != nil {
			// Reverse the exact split the insert applied so the ledger refund
			// entries mirror the insert entries per-currency. Raw field values
			// are not echoed in the returned error — they could reflect
			// server-internal decimal formatting state.
			playDeb, parseErr := decimal.NewFromString(result.PlayDebited)
			if parseErr != nil {
				metrics.BatchInsertRefundFailures.Inc()
				return fmt.Errorf("nats publish failed; cannot refund — play_debited unparseable: publish=%w, parse=%v",
					err, parseErr)
			}
			cashDeb, parseErr := decimal.NewFromString(result.CashDebited)
			if parseErr != nil {
				metrics.BatchInsertRefundFailures.Inc()
				return fmt.Errorf("nats publish failed; cannot refund — cash_debited unparseable: publish=%w, parse=%v",
					err, parseErr)
			}
			// Decouple the refund tx from the request ctx (client cancellation
			// must not abort the refund), but cap the wall-clock window so a
			// stuck DB can't leak goroutines under a sustained outage.
			refundCtx, cancel := context.WithTimeout(context.Background(), refundTxTimeout)
			defer cancel()
			refundKey := refKey + accounting.RefundKeySuffix
			if _, refundErr := g.game.RefundBatchInsert(refundCtx, accountID, playDeb, cashDeb, refundKey); refundErr != nil {
				metrics.BatchInsertRefundFailures.Inc()
				return fmt.Errorf("nats publish failed and refund failed: publish=%w, refund=%v", err, refundErr)
			}
			return fmt.Errorf("nats publish failed (balance refunded): %w", err)
		}
	}

	share := g.heat.GetShareForUser(accountID)

	return v1.Respond(w, http.StatusOK, BatchInsertResponse{
		Queued:      req.Count,
		HeatShare:   share,
		BalancePlay: result.BalancePlay,
		BalanceCash: result.BalanceCash,
		PlayDebited: result.PlayDebited,
		CashDebited: result.CashDebited,
	})
}
