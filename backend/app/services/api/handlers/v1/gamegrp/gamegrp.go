// Package gamegrp provides HTTP handlers for game event operations.
package gamegrp

import (
	"context"
	"net/http"

	"github.com/flamefalcon/coin-pusher/backend/business/core/game"
	v1 "github.com/flamefalcon/coin-pusher/backend/business/web/v1"
)

// Group holds the handler dependencies.
type Group struct {
	game *game.Core
}

// New constructs a handler Group.
func New(game *game.Core) *Group {
	return &Group{game: game}
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
