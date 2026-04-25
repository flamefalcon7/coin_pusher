package heat

import (
	"math"
	"sync"
	"time"

	"github.com/google/uuid"
)

// PlayerHeat tracks a single player's raw heat value and when it was last updated.
//
// IsBot flags the player as a server-controlled NPC account (role='bot'). The
// flag is dormant under the production default (guaranteed=0, floor disabled)
// — every player's share is purely proportional to effective heat regardless
// of role. The flag still gates the floor mechanism when it is opted into via
// WithGuaranteed(>0), in which case bot entries are excluded from the floor
// while remaining in the competitive denominator. The flag is maintained
// last-write-wins by AddHeat (sets false) and AddHeatForBot (sets true).
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
	now                    func() time.Time
}

// Option mutates a HeatEngine during construction. Used by simulations and
// tests to override defaults without a wider config surface.
type Option func(*HeatEngine)

// WithGuaranteed overrides the per-real-player guaranteed floor share. The
// production default is 0 (floor disabled). Pass a positive value (e.g.,
// 0.05) to study the floor's behavior in simulations or regression tests.
func WithGuaranteed(g float64) Option {
	return func(h *HeatEngine) { h.guaranteed = g }
}

// WithHalfLife overrides the heat half-life in seconds (default 180).
func WithHalfLife(seconds float64) Option {
	return func(h *HeatEngine) {
		h.halfLife = seconds
		h.lambda = math.Log(2) / seconds
	}
}

// WithAlpha overrides the diminishing-returns exponent (default 0.7).
func WithAlpha(a float64) Option {
	return func(h *HeatEngine) { h.alpha = a }
}

// WithFloorThreshold overrides the activity scaling threshold (default 10).
func WithFloorThreshold(t float64) Option {
	return func(h *HeatEngine) { h.floorActivityThreshold = t }
}

// New constructs a HeatEngine with default parameters and the system clock.
func New(opts ...Option) *HeatEngine {
	return NewWithClock(time.Now, opts...)
}

// NewWithClock constructs a HeatEngine with an injectable clock. Used by
// simulations and time-sensitive tests so virtual time can drive decay
// without sleeping. Production code should use New().
func NewWithClock(now func() time.Time, opts ...Option) *HeatEngine {
	halfLife := 180.0
	h := &HeatEngine{
		players:                make(map[uuid.UUID]*PlayerHeat),
		halfLife:               halfLife,
		lambda:                 math.Log(2) / halfLife,
		alpha:                  0.7,
		guaranteed:             0.0, // floor disabled — heatsim showed 1c/60s heartbeat hit 156% RTP with 0.05 floor
		floorActivityThreshold: 10.0,
		now:                    now,
	}
	for _, opt := range opts {
		opt(h)
	}
	return h
}

// AddHeat is called on real-player batch insert commit. It decays existing
// heat before adding the new coins to ensure monotonic decay between updates.
// IsBot is always reset to false on every call (last-write-wins with
// AddHeatForBot).
func (h *HeatEngine) AddHeat(userID uuid.UUID, coins int) {
	h.addHeatInternal(userID, coins, false)
}

// AddHeatForBot is called on bot batch insert commit. Behaves identically to
// AddHeat but flags the entry as IsBot=true. Under the production default
// (floor disabled) the flag is dormant; if WithGuaranteed(>0) is passed the
// flag excludes the player from the floor. If a real user ever receives
// AddHeatForBot by mistake, the next AddHeat call flips the flag back — no
// permanent corruption.
func (h *HeatEngine) AddHeatForBot(userID uuid.UUID, coins int) {
	h.addHeatInternal(userID, coins, true)
}

func (h *HeatEngine) addHeatInternal(userID uuid.UUID, coins int, isBot bool) {
	h.mu.Lock()
	defer h.mu.Unlock()

	now := h.now()
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

	now := h.now()

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

	// Guaranteed floor: under the production default h.guaranteed=0 every
	// branch below resolves to floorTotal=0 and the share is purely
	// proportional to effective heat. The floor branches remain wired up so
	// that simulations / tests can opt into the floor via WithGuaranteed(>0)
	// and study its behavior — but heatsim showed that any non-zero floor
	// opens a 1c/60s heartbeat exploit (RTP ~157%) when bots provide drop
	// activity, so it must stay 0 in prod. See app/tooling/heatsim/.
	//
	// When opted into: floor is applied to non-bot players only and is
	// activity-scaled by decayed heat (guaranteed * min(1, decayed/threshold))
	// so AFK players don't passively collect drops. The per-player guaranteed
	// cap uses realCount, not total, so bot population doesn't dilute the
	// real baseline.
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
// Production default has the floor disabled (h.guaranteed=0); see GetShares
// for full rationale on why and on the opt-in floor's bot/activity logic.
func (h *HeatEngine) GetShareForUser(userID uuid.UUID) float64 {
	h.mu.RLock()
	defer h.mu.RUnlock()

	now := h.now()

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

	now := h.now()
	for id, ph := range h.players {
		dt := now.Sub(ph.LastUpdated).Seconds()
		decayed := ph.RawHeat * math.Exp(-h.lambda*dt)
		if decayed < 0.01 {
			delete(h.players, id)
		}
	}
}
