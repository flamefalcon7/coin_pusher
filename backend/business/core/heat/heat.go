package heat

import (
	"math"
	"sync"
	"time"

	"github.com/google/uuid"
)

// PlayerHeat tracks a single player's raw heat value and when it was last updated.
type PlayerHeat struct {
	RawHeat     float64
	LastUpdated time.Time
}

// HeatEngine manages per-player heat and computes share distributions.
// It is concurrent-safe.
type HeatEngine struct {
	mu      sync.RWMutex
	players map[uuid.UUID]*PlayerHeat

	halfLife   float64 // 180s
	lambda     float64 // ln(2) / halfLife
	alpha      float64 // 0.7 diminishing returns
	guaranteed float64 // 0.05 per active player
}

// New constructs a HeatEngine with default parameters.
func New() *HeatEngine {
	halfLife := 180.0
	return &HeatEngine{
		players:    make(map[uuid.UUID]*PlayerHeat),
		halfLife:   halfLife,
		lambda:     math.Log(2) / halfLife,
		alpha:      0.7,
		guaranteed: 0.05,
	}
}

// AddHeat is called on batch insert commit. It decays existing heat before
// adding the new coins to ensure monotonic decay between updates.
func (h *HeatEngine) AddHeat(userID uuid.UUID, coins int) {
	h.mu.Lock()
	defer h.mu.Unlock()

	now := time.Now()
	ph, ok := h.players[userID]
	if !ok {
		ph = &PlayerHeat{}
		h.players[userID] = ph
	}

	// Decay existing heat before adding.
	dt := now.Sub(ph.LastUpdated).Seconds()
	if dt > 0 && ph.RawHeat > 0 {
		ph.RawHeat *= math.Exp(-h.lambda * dt)
	}

	ph.RawHeat += float64(coins)
	ph.LastUpdated = now
}

// PlayerShare represents a single player's heat share for external consumption.
type PlayerShare struct {
	UserID  uuid.UUID
	Share   float64
	RawHeat float64
}

// GetShares returns current shares for all active players (heat > threshold).
// Applies exponential decay lazily on read.
func (h *HeatEngine) GetShares() []PlayerShare {
	h.mu.RLock()
	defer h.mu.RUnlock()

	now := time.Now()

	type entry struct {
		id  uuid.UUID
		eff float64
		raw float64
	}
	var active []entry
	var totalEff float64

	for id, ph := range h.players {
		dt := now.Sub(ph.LastUpdated).Seconds()
		decayed := ph.RawHeat * math.Exp(-h.lambda*dt)
		if decayed < 0.01 {
			continue // prune negligible heat
		}

		eff := math.Pow(decayed, h.alpha) // diminishing returns
		active = append(active, entry{id, eff, decayed})
		totalEff += eff
	}

	if len(active) == 0 {
		return nil
	}

	n := float64(len(active))
	// Smooth guaranteed: shrinks with player count, competitive pool ≥ 50%.
	// n≤10 → 0.05 each (total 0.05n), n>10 → 1/(2n) each (total 0.50).
	guaranteed := math.Min(h.guaranteed, 1.0/(2.0*n))
	competitivePool := 1.0 - n*guaranteed

	shares := make([]PlayerShare, 0, len(active))
	for _, e := range active {
		shares = append(shares, PlayerShare{
			UserID:  e.id,
			Share:   guaranteed + competitivePool*(e.eff/totalEff),
			RawHeat: e.raw,
		})
	}

	return shares
}

// DistributeFrontEdgeDrop distributes coinCount to players based on current shares.
// Returns map of userID -> fractional coin amount.
func (h *HeatEngine) DistributeFrontEdgeDrop(coinCount int) map[uuid.UUID]float64 {
	shares := h.GetShares()
	if len(shares) == 0 {
		return nil
	}

	result := make(map[uuid.UUID]float64, len(shares))
	for _, s := range shares {
		result[s.UserID] = float64(coinCount) * s.Share
	}
	return result
}

// GetShareForUser returns the current share for a specific user.
func (h *HeatEngine) GetShareForUser(userID uuid.UUID) float64 {
	shares := h.GetShares()
	for _, s := range shares {
		if s.UserID == userID {
			return s.Share
		}
	}
	return 0
}

// Prune removes players with negligible heat to prevent unbounded growth.
func (h *HeatEngine) Prune() {
	h.mu.Lock()
	defer h.mu.Unlock()

	now := time.Now()
	for id, ph := range h.players {
		dt := now.Sub(ph.LastUpdated).Seconds()
		decayed := ph.RawHeat * math.Exp(-h.lambda*dt)
		if decayed < 0.01 {
			delete(h.players, id)
		}
	}
}
