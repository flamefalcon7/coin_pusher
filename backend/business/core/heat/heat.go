package heat

import (
	"math"
	"sync"
	"time"

	"github.com/google/uuid"
)

// PlayerHeat tracks a single player's raw heat value and when it was last updated.
//
// IsBot flags the player as a server-controlled NPC account (role='bot'). Bot
// entries are included in the heat denominator (so the competitive pool
// correctly accounts for their raw heat) but are excluded from the guaranteed
// floor distribution — otherwise 5 active bots would absorb 25% of rewards
// with near-zero investment. The flag is maintained last-write-wins by
// AddHeat (sets false) and AddHeatForBot (sets true); role authority lives at
// the caller, not sticky in the heat map.
type PlayerHeat struct {
	RawHeat     float64
	LastUpdated time.Time
	IsBot       bool
}

// HeatEngine manages per-player heat and computes share distributions.
// It is concurrent-safe.
type HeatEngine struct {
	mu      sync.RWMutex
	players map[uuid.UUID]*PlayerHeat

	halfLife               float64 // 180s
	lambda                 float64 // ln(2) / halfLife
	alpha                  float64 // 0.7 diminishing returns
	guaranteed             float64 // 0.05 per active player
	floorActivityThreshold float64 // 10 coins — decayed heat at/above this gets full floor; below, scaled linearly to 0
}

// New constructs a HeatEngine with default parameters.
func New() *HeatEngine {
	halfLife := 180.0
	return &HeatEngine{
		players:                make(map[uuid.UUID]*PlayerHeat),
		halfLife:               halfLife,
		lambda:                 math.Log(2) / halfLife,
		alpha:                  0.7,
		guaranteed:             0.05,
		floorActivityThreshold: 10.0,
	}
}

// AddHeat is called on real-player batch insert commit. It decays existing
// heat before adding the new coins to ensure monotonic decay between updates.
// IsBot is always reset to false on every call (last-write-wins with
// AddHeatForBot).
func (h *HeatEngine) AddHeat(userID uuid.UUID, coins int) {
	h.addHeatInternal(userID, coins, false)
}

// AddHeatForBot is called on bot batch insert commit. Behaves identically to
// AddHeat but flags the entry as IsBot=true so the share formula excludes
// this player from the 5% guaranteed floor. If a real user ever receives
// AddHeatForBot by mistake, the next AddHeat call flips the flag back — no
// permanent corruption.
func (h *HeatEngine) AddHeatForBot(userID uuid.UUID, coins int) {
	h.addHeatInternal(userID, coins, true)
}

func (h *HeatEngine) addHeatInternal(userID uuid.UUID, coins int, isBot bool) {
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
	ph.IsBot = isBot
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
		id    uuid.UUID
		eff   float64
		raw   float64
		isBot bool
	}
	var active []entry
	var totalEff float64
	var realCount float64
	var sumRealActivity float64 // sum of min(1, decayed/threshold) across real players

	for id, ph := range h.players {
		dt := now.Sub(ph.LastUpdated).Seconds()
		decayed := ph.RawHeat * math.Exp(-h.lambda*dt)
		if decayed < 0.01 {
			continue // prune negligible heat
		}

		eff := math.Pow(decayed, h.alpha) // diminishing returns
		active = append(active, entry{id, eff, decayed, ph.IsBot})
		totalEff += eff
		if !ph.IsBot {
			realCount++
			sumRealActivity += math.Min(1.0, decayed/h.floorActivityThreshold)
		}
	}

	if len(active) == 0 {
		return nil
	}

	// Guaranteed floor is applied to non-bot (real) players only. Bots are
	// excluded so they don't absorb reward share with near-zero investment,
	// but they remain in totalEff so the competitive pool is apportioned
	// correctly across all active participants.
	//
	// Floor is activity-scaled by decayed heat: a real player's floor is
	// guaranteed * min(1, decayed/threshold). This prevents an AFK player
	// (heat decays past threshold but not yet pruned) from passively
	// collecting 5% of bot-generated drops for up to 40 minutes.
	//
	// The per-player guaranteed cap uses realCount (not total) to keep the
	// real baseline independent of bot population: with 2 real + many bots,
	// active real players still get the full 0.05 floor each.
	var guaranteed float64
	if realCount > 0 {
		guaranteed = math.Min(h.guaranteed, 1.0/(2.0*realCount))
	}
	floorTotal := guaranteed * sumRealActivity
	competitivePool := 1.0 - floorTotal

	shares := make([]PlayerShare, 0, len(active))
	for _, e := range active {
		share := competitivePool * (e.eff / totalEff)
		if !e.isBot {
			activity := math.Min(1.0, e.raw/h.floorActivityThreshold)
			share += guaranteed * activity
		}
		shares = append(shares, PlayerShare{
			UserID:  e.id,
			Share:   share,
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
// Inlines the share computation for a single user without building the
// intermediate []PlayerShare slice. Single RLock, no allocation, single pass.
//
// Bots are excluded from the guaranteed floor (5% or 1/(2*realCount), whichever
// smaller) but still participate in the competitive pool via totalEff. Floor
// is activity-scaled per real player by min(1, decayed/floorActivityThreshold);
// see GetShares for rationale.
func (h *HeatEngine) GetShareForUser(userID uuid.UUID) float64 {
	h.mu.RLock()
	defer h.mu.RUnlock()

	now := time.Now()

	// First check if the target user has meaningful heat.
	ph, ok := h.players[userID]
	if !ok {
		return 0
	}
	dt := now.Sub(ph.LastUpdated).Seconds()
	targetDecayed := ph.RawHeat * math.Exp(-h.lambda*dt)
	if targetDecayed < 0.01 {
		return 0
	}

	targetEff := math.Pow(targetDecayed, h.alpha)
	targetIsBot := ph.IsBot

	// Compute total effective heat, real count, and summed real-player activity.
	var totalEff float64
	var realCount float64
	var sumRealActivity float64
	for _, p := range h.players {
		dt := now.Sub(p.LastUpdated).Seconds()
		decayed := p.RawHeat * math.Exp(-h.lambda*dt)
		if decayed < 0.01 {
			continue
		}
		totalEff += math.Pow(decayed, h.alpha)
		if !p.IsBot {
			realCount++
			sumRealActivity += math.Min(1.0, decayed/h.floorActivityThreshold)
		}
	}

	if totalEff == 0 {
		return 0
	}

	var guaranteed float64
	if realCount > 0 {
		guaranteed = math.Min(h.guaranteed, 1.0/(2.0*realCount))
	}
	floorTotal := guaranteed * sumRealActivity
	competitivePool := 1.0 - floorTotal

	share := competitivePool * (targetEff / totalEff)
	if !targetIsBot {
		activity := math.Min(1.0, targetDecayed/h.floorActivityThreshold)
		share += guaranteed * activity
	}
	return share
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
