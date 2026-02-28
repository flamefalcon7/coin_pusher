// Package inventory provides the inventory domain logic.
package inventory

import (
	"time"

	"github.com/google/uuid"
)

// Scroll type constants.
const (
	ScrollShock     = "shock"
	ScrollTornado   = "tornado"
	ScrollExplosion = "explosion"
	ScrollLightning = "lightning"
	ScrollSuperPush = "super_push"
)

// ScrollWeights defines the weighted random loot table for chest opens.
var ScrollWeights = []struct {
	Type   string
	Weight int
}{
	{ScrollShock, 30},
	{ScrollTornado, 20},
	{ScrollExplosion, 20},
	{ScrollLightning, 20},
	{ScrollSuperPush, 10},
}

// TotalWeight is the sum of all scroll weights.
var TotalWeight int

func init() {
	for _, sw := range ScrollWeights {
		TotalWeight += sw.Weight
	}
}

// Inventory represents a player's inventory row.
type Inventory struct {
	AccountID       uuid.UUID `db:"account_id" json:"account_id"`
	KeyCoins        int       `db:"key_coins" json:"key_coins"`
	ScrollShock     int       `db:"scroll_shock" json:"scroll_shock"`
	ScrollTornado   int       `db:"scroll_tornado" json:"scroll_tornado"`
	ScrollExplosion int       `db:"scroll_explosion" json:"scroll_explosion"`
	ScrollLightning int       `db:"scroll_lightning" json:"scroll_lightning"`
	ScrollSuperPush int       `db:"scroll_super_push" json:"scroll_super_push"`
	UpdatedAt       time.Time `db:"updated_at" json:"updated_at"`
}

// ChestOpen represents a log entry for a chest open event.
type ChestOpen struct {
	OpenID      uuid.UUID `db:"open_id" json:"open_id"`
	AccountID   uuid.UUID `db:"account_id" json:"account_id"`
	ScrollType  string    `db:"scroll_type" json:"scroll_type"`
	ScrollCount int       `db:"scroll_count" json:"scroll_count"`
	CreatedAt   time.Time `db:"created_at" json:"created_at"`
}
