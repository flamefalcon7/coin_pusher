// Package inventory provides the inventory domain logic.
package inventory

import (
	"crypto/rand"
	"math/big"
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
	ItemMegaspeaker = "megaspeaker"
	ItemPlayCoins   = "play_coins"
)

// KeyCoinsPerChest is the number of key coins required to open one chest.
const KeyCoinsPerChest = 3

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
	{ItemMegaspeaker, 30},
	{ItemPlayCoins, 20},
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
	Megaspeaker     int       `db:"megaspeaker" json:"megaspeaker"`
	UpdatedAt       time.Time `db:"updated_at" json:"updated_at"`
}

// playCoinsRanges defines the tiered distribution for play coin rewards.
// 80% → 10-20, 15% → 21-50, 4.9% → 51-80, 0.1% → 100
var playCoinsRanges = []struct {
	Weight int // out of 1000
	Min    int
	Max    int
}{
	{800, 10, 20},
	{150, 21, 50},
	{49, 51, 80},
	{1, 100, 100},
}

// rollPlayCoinsAmount picks a random play coin amount using the tiered distribution.
func rollPlayCoinsAmount() (int, error) {
	n, err := rand.Int(rand.Reader, big.NewInt(1000))
	if err != nil {
		return 0, err
	}
	roll := int(n.Int64())

	cumulative := 0
	for _, r := range playCoinsRanges {
		cumulative += r.Weight
		if roll < cumulative {
			if r.Min == r.Max {
				return r.Min, nil
			}
			span := big.NewInt(int64(r.Max - r.Min + 1))
			v, err := rand.Int(rand.Reader, span)
			if err != nil {
				return 0, err
			}
			return r.Min + int(v.Int64()), nil
		}
	}
	return 10, nil
}

// ChestOpen represents a log entry for a chest open event.
type ChestOpen struct {
	OpenID      uuid.UUID `db:"open_id" json:"open_id"`
	AccountID   uuid.UUID `db:"account_id" json:"account_id"`
	ScrollType  string    `db:"scroll_type" json:"scroll_type"`
	ScrollCount int       `db:"scroll_count" json:"scroll_count"`
	CreatedAt   time.Time `db:"created_at" json:"created_at"`
}
