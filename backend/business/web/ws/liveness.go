package ws

import (
	"sync/atomic"
	"time"
)

// GameLivenessTTL is how long a game server may go silent before the backend
// treats it as gone. The game server publishes slot_status every ~30 ticks
// (≈1s, see game/server/src/game/GameLoop.ts), so this is five consecutive
// missed heartbeats — long enough to ride out a GC pause or a NATS reconnect,
// short enough that at most a handful of inserts land in the dead window.
//
// A Go const, not a config knob: the value is only defensible against the
// heartbeat cadence it was chosen for, and changing one without the other
// should require a deploy. See docs/decisions.md D-006.
const GameLivenessTTL = 5 * time.Second

// GameLiveness tracks when the backend last heard from the game server.
//
// The zero value reads as dead. That is the point: a backend that has never
// received a slot_status must refuse to debit balances or consume inventory,
// because there is nothing on the other end of NATS to act on the command.
// NATS core has no persistence here — a command published to a subject with no
// subscriber is dropped, and the player is charged for nothing.
//
// Safe for concurrent use.
type GameLiveness struct {
	// lastSeen is a Unix-nanosecond timestamp accessed atomically. 0 means
	// "never seen", which Live reports as dead.
	lastSeen int64
	ttl      time.Duration
	// now is injectable so tests can drive the clock instead of sleeping.
	now func() time.Time
}

// NewGameLiveness returns a liveness gate that considers the game server dead
// once ttl has elapsed since the last Touch. It starts dead.
func NewGameLiveness(ttl time.Duration) *GameLiveness {
	return &GameLiveness{ttl: ttl, now: time.Now}
}

// Touch records that a heartbeat just arrived.
func (l *GameLiveness) Touch() {
	atomic.StoreInt64(&l.lastSeen, l.now().UnixNano())
}

// Live reports whether a heartbeat arrived within the TTL. A nil receiver
// reports dead — an unwired gate must not silently degrade into the fail-open
// behaviour this type exists to remove.
func (l *GameLiveness) Live() bool {
	if l == nil {
		return false
	}
	last := atomic.LoadInt64(&l.lastSeen)
	if last == 0 {
		return false
	}
	return l.now().Sub(time.Unix(0, last)) < l.ttl
}

// LastSeen returns the time of the last heartbeat, or the zero Time if none
// has arrived. For diagnostics and health endpoints.
func (l *GameLiveness) LastSeen() time.Time {
	if l == nil {
		return time.Time{}
	}
	last := atomic.LoadInt64(&l.lastSeen)
	if last == 0 {
		return time.Time{}
	}
	return time.Unix(0, last)
}
