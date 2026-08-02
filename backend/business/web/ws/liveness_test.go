package ws

import (
	"context"
	"fmt"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/flamefalcon/coin-pusher/backend/business/core/inventory"
)

// ---------------------------------------------------------------------------
// GameLiveness
// ---------------------------------------------------------------------------

// fakeClock drives GameLiveness without sleeping. Guarded by a mutex because
// the concurrency test reads it from several goroutines.
type fakeClock struct {
	mu sync.Mutex
	t  time.Time
}

func (f *fakeClock) now() time.Time {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.t
}

func (f *fakeClock) advance(d time.Duration) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.t = f.t.Add(d)
}

// newFakeLiveness returns a gate wired to a controllable clock.
func newFakeLiveness(ttl time.Duration) (*GameLiveness, *fakeClock) {
	clk := &fakeClock{t: time.Date(2026, 8, 2, 12, 0, 0, 0, time.UTC)}
	l := NewGameLiveness(ttl)
	l.now = clk.now
	return l, clk
}

func TestGameLiveness_ZeroValueIsDead(t *testing.T) {
	t.Parallel()

	// The fail-closed property: a backend that has never received a
	// slot_status must not accept inserts. If this ever flips to true, every
	// gate in this package silently reopens the window D-006 closed.
	l, _ := newFakeLiveness(GameLivenessTTL)

	if l.Live() {
		t.Fatal("a gate that has never been touched must read dead")
	}
	if !l.LastSeen().IsZero() {
		t.Errorf("LastSeen on an untouched gate = %v, want zero time", l.LastSeen())
	}
}

func TestGameLiveness_NilReceiverIsDead(t *testing.T) {
	t.Parallel()

	// An unwired gate must fail closed rather than degrade into the
	// pre-D-006 fail-open behaviour.
	var l *GameLiveness

	if l.Live() {
		t.Fatal("nil gate must read dead")
	}
	if !l.LastSeen().IsZero() {
		t.Error("nil gate LastSeen must be the zero time")
	}
}

func TestGameLiveness_TTLBoundary(t *testing.T) {
	t.Parallel()

	const ttl = 5 * time.Second

	tests := []struct {
		name     string
		elapsed  time.Duration
		wantLive bool
	}{
		{"immediately after touch", 0, true},
		{"just inside the TTL", ttl - time.Nanosecond, true},
		{"exactly at the TTL", ttl, false},
		{"past the TTL", ttl + time.Second, false},
		{"long past the TTL", time.Hour, false},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()

			l, clk := newFakeLiveness(ttl)
			l.Touch()
			clk.advance(tc.elapsed)

			if got := l.Live(); got != tc.wantLive {
				t.Errorf("Live() after %v = %v, want %v", tc.elapsed, got, tc.wantLive)
			}
		})
	}
}

func TestGameLivenessTTL_StaysWithinTheBoundD006Argued(t *testing.T) {
	t.Parallel()

	// The TTL is the size of the window in which players can still be charged
	// for coins that go nowhere. D-006 argues 5s from the ~1s slot_status
	// cadence: long enough to ride out a GC pause, short enough to bound the
	// loss. Widening it to quiet a noisy local environment would silently
	// reopen most of the window, so the bound is pinned here rather than left
	// to a code review catching a one-character edit.
	if GameLivenessTTL < 2*time.Second {
		t.Errorf("GameLivenessTTL = %v: below 2s a GC pause or NATS reconnect gates live play",
			GameLivenessTTL)
	}
	if GameLivenessTTL > 15*time.Second {
		t.Errorf("GameLivenessTTL = %v: above 15s the gate stops bounding the loss window; "+
			"if this is deliberate, update D-006 first", GameLivenessTTL)
	}
}

func TestGameLiveness_TouchRevivesAStaleGate(t *testing.T) {
	t.Parallel()

	// The recovery path: the game server comes back and heartbeats resume.
	l, clk := newFakeLiveness(GameLivenessTTL)
	l.Touch()
	clk.advance(GameLivenessTTL * 2)

	if l.Live() {
		t.Fatal("precondition: gate should be stale before the reviving touch")
	}

	l.Touch()

	if !l.Live() {
		t.Error("a touch after the TTL lapsed must bring the gate back to live")
	}
	if want := clk.now(); !l.LastSeen().Equal(want) {
		t.Errorf("LastSeen = %v, want %v", l.LastSeen(), want)
	}
}

func TestGameLiveness_ConcurrentTouchAndRead(t *testing.T) {
	t.Parallel()

	// slot_status arrives on the NATS callback goroutine while inserts read
	// the gate from connection goroutines. Meaningful under -race.
	l, _ := newFakeLiveness(GameLivenessTTL)

	var wg sync.WaitGroup
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for j := 0; j < 200; j++ {
				l.Touch()
				_ = l.Live()
				_ = l.LastSeen()
			}
		}()
	}
	wg.Wait()

	if !l.Live() {
		t.Error("gate should be live after concurrent touches")
	}
}

// ---------------------------------------------------------------------------
// slot_status is the heartbeat
// ---------------------------------------------------------------------------

func TestApplySlotStatus_RevivesTheGate(t *testing.T) {
	t.Parallel()

	// The link everything else depends on: if the subscriber stops feeding the
	// gate, it never opens and the backend refuses every insert forever.
	h, _ := newTestHandler(t, testHandlerOpts{gameServerDown: true})

	if h.liveness.Live() {
		t.Fatal("precondition: gate should start stale")
	}

	h.applySlotStatus([]byte(`{"counts":[1,2,3,4,5],"coin_count":42,"tick":900}`))

	if !h.liveness.Live() {
		t.Error("a decoded slot_status must count as a heartbeat")
	}
	if got := atomic.LoadInt64(&h.coinCount); got != 42 {
		t.Errorf("coinCount = %d, want 42", got)
	}
	for i, want := range []int64{1, 2, 3, 4, 5} {
		if got := atomic.LoadInt64(&h.slotCounts[i]); got != want {
			t.Errorf("slotCounts[%d] = %d, want %d", i, got, want)
		}
	}
}

func TestApplySlotStatus_MalformedPayloadIsNotAHeartbeat(t *testing.T) {
	t.Parallel()

	// A publisher emitting garbage is not a game server we can route commands
	// to, so it must not hold the gate open.
	h, _ := newTestHandler(t, testHandlerOpts{gameServerDown: true})

	h.applySlotStatus([]byte(`{"counts":`))

	if h.liveness.Live() {
		t.Error("undecodable slot_status must not count as a heartbeat")
	}
}

// ---------------------------------------------------------------------------
// WS gates
// ---------------------------------------------------------------------------

func TestHandleBatchInsert_RefusedWhenGameServerStale(t *testing.T) {
	t.Parallel()

	// h.gameCore is nil in this harness, so if the gate fails to stop the
	// request the handler panics on the debit instead of quietly passing —
	// the assertion below cannot succeed by accident.
	h, c := newTestHandler(t, testHandlerOpts{gameServerDown: true})

	h.handleBatchInsert(c, ClientMessage{Op: "batch_insert", Count: 5})

	msg := drainOne(t, c)
	if got := msg["op"]; got != "batch_insert_ack" {
		t.Fatalf("op = %v, want batch_insert_ack", got)
	}
	if got := msg["error"]; got != "game_unavailable" {
		t.Errorf("error = %v, want game_unavailable", got)
	}
	// msgpack picks the narrowest int type on decode, so compare on value
	// rather than on a guessed concrete type.
	if got := fmt.Sprint(msg["queued"]); got != "0" {
		t.Errorf("queued = %s, want 0", got)
	}
}

func TestHandleBatchInsert_ProceedsPastGateWhenLive(t *testing.T) {
	t.Parallel()

	// The inverse of the test above, and the reason the gate can't just
	// always return false: with a live gate the handler must get far enough
	// to attempt the debit, which panics on this harness's nil gameCore.
	// Catching that panic proves the gate let the request through rather
	// than the request being dropped for some unrelated reason.
	h, c := newTestHandler(t, testHandlerOpts{})

	defer func() {
		if r := recover(); r == nil {
			t.Error("expected the handler to reach the nil gameCore debit; " +
				"a live gate must not short-circuit batch_insert")
		}
	}()

	h.handleBatchInsert(c, ClientMessage{Op: "batch_insert", Count: 5})
}

func TestConsumeScroll_RefusedWhenGameServerStale(t *testing.T) {
	t.Parallel()

	// Every ability funnels through consumeScroll, so this covers shock,
	// tornado, explosion, lightning and super_push at once. The inventory
	// mock records whether the scroll was actually spent.
	var decremented bool
	h, c := newTestHandler(t, testHandlerOpts{gameServerDown: true})
	h.inventoryCore = inventory.NewCore(nil, &recordingInventoryStorer{
		onDecrementScroll: func() { decremented = true },
	}, nil, nil)

	err := h.consumeScroll(c, inventory.ScrollTornado)

	if err == nil {
		t.Fatal("consumeScroll must fail while the game server is stale")
	}
	if decremented {
		t.Error("scroll was consumed for a command the game server can never receive")
	}

	msg := drainOne(t, c)
	if got := msg["op"]; got != "ability_error" {
		t.Fatalf("op = %v, want ability_error", got)
	}
	if got := msg["error"]; got != "game_unavailable" {
		t.Errorf("error = %v, want game_unavailable", got)
	}
	if got := msg["type"]; got != inventory.ScrollTornado {
		t.Errorf("type = %v, want %v", got, inventory.ScrollTornado)
	}
}

func TestConsumeScroll_SpendsScrollWhenGameServerLive(t *testing.T) {
	t.Parallel()

	// Pins that the gate is the only thing standing between an ability and
	// its scroll: with a live gate the same call spends normally.
	var decremented bool
	h, c := newTestHandler(t, testHandlerOpts{})
	h.inventoryCore = inventory.NewCore(nil, &recordingInventoryStorer{
		onDecrementScroll: func() { decremented = true },
	}, nil, nil)

	if err := h.consumeScroll(c, inventory.ScrollTornado); err != nil {
		t.Fatalf("consumeScroll with a live gate: %v", err)
	}
	if !decremented {
		t.Error("expected the scroll to be spent while the game server is live")
	}
}

func TestHandleTornado_DoesNotPublishWhenGameServerStale(t *testing.T) {
	t.Parallel()

	// h.nc is nil here: reaching the publish would panic. This is the
	// end-to-end shape of the ability gate — a stale game server must stop
	// the handler before both the scroll spend and the NATS publish.
	h, c := newTestHandler(t, testHandlerOpts{gameServerDown: true})

	h.handleTornado(c, ClientMessage{Op: "tornado", X: 0.1, Z: 0.2})

	msg := drainOne(t, c)
	if got := msg["error"]; got != "game_unavailable" {
		t.Errorf("error = %v, want game_unavailable", got)
	}
}

// recordingInventoryStorer reports scroll spends. Only the methods the
// liveness tests touch are meaningful; the rest satisfy the interface.
type recordingInventoryStorer struct {
	mockInventoryStorer
	onDecrementScroll func()
}

func (m *recordingInventoryStorer) DecrementScroll(_ context.Context, _ uuid.UUID, _ string) error {
	if m.onDecrementScroll != nil {
		m.onDecrementScroll()
	}
	return nil
}
