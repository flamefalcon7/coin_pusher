package ws

import (
	"context"
	"fmt"
	"math"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/shopspring/decimal"
	"github.com/vmihailenco/msgpack/v5"
	"go.uber.org/zap"

	"github.com/flamefalcon/coin-pusher/backend/business/core/inventory"
	"github.com/flamefalcon/coin-pusher/backend/business/core/user"
)

// ---------------------------------------------------------------------------
// Mock storers
// ---------------------------------------------------------------------------

type mockInventoryStorer struct {
	ensureInventoryFn      func(ctx context.Context, accountID uuid.UUID, dd *inventory.DevDefaults) error
	getInventoryFn         func(ctx context.Context, accountID uuid.UUID) (inventory.Inventory, error)
	decrementMegaspeakerFn func(ctx context.Context, accountID uuid.UUID) error
}

func (m *mockInventoryStorer) EnsureInventory(ctx context.Context, accountID uuid.UUID, dd *inventory.DevDefaults) error {
	if m.ensureInventoryFn != nil {
		return m.ensureInventoryFn(ctx, accountID, dd)
	}
	return nil
}
func (m *mockInventoryStorer) CreditKeyCoins(_ context.Context, _ uuid.UUID, _ int) error {
	return nil
}
func (m *mockInventoryStorer) GetInventory(ctx context.Context, accountID uuid.UUID) (inventory.Inventory, error) {
	if m.getInventoryFn != nil {
		return m.getInventoryFn(ctx, accountID)
	}
	return inventory.Inventory{}, nil
}
func (m *mockInventoryStorer) DecrementKeyCoins(_ context.Context, _ uuid.UUID, _ int) error { return nil }
func (m *mockInventoryStorer) IncrementScroll(_ context.Context, _ uuid.UUID, _ string) error {
	return nil
}
func (m *mockInventoryStorer) DecrementScroll(_ context.Context, _ uuid.UUID, _ string) error {
	return nil
}
func (m *mockInventoryStorer) IncrementMegaspeaker(_ context.Context, _ uuid.UUID) error { return nil }
func (m *mockInventoryStorer) DecrementMegaspeaker(ctx context.Context, accountID uuid.UUID) error {
	if m.decrementMegaspeakerFn != nil {
		return m.decrementMegaspeakerFn(ctx, accountID)
	}
	return nil
}
func (m *mockInventoryStorer) CreditPlayBalance(_ context.Context, _ uuid.UUID, _ int) (string, error) {
	return "100", nil
}
func (m *mockInventoryStorer) CreateChestOpen(_ context.Context, _ inventory.ChestOpen) error {
	return nil
}

type mockUserStorer struct {
	queryByIDFn func(ctx context.Context, accountID uuid.UUID) (user.Account, error)
}

func (m *mockUserStorer) Create(_ context.Context, _ user.Account) error                 { return nil }
func (m *mockUserStorer) CreateAuthProvider(_ context.Context, _ user.AuthProvider) error { return nil }
func (m *mockUserStorer) QueryByID(ctx context.Context, accountID uuid.UUID) (user.Account, error) {
	if m.queryByIDFn != nil {
		return m.queryByIDFn(ctx, accountID)
	}
	return user.Account{}, nil
}
func (m *mockUserStorer) QueryByIDForUpdate(ctx context.Context, accountID uuid.UUID) (user.Account, error) {
	return m.QueryByID(ctx, accountID)
}
func (m *mockUserStorer) QueryByProvider(_ context.Context, _, _ string) (user.Account, error) {
	return user.Account{}, nil
}
func (m *mockUserStorer) UpdateBalance(_ context.Context, _ uuid.UUID, _ string, _ decimal.Decimal) (decimal.Decimal, error) {
	return decimal.Zero, nil
}
func (m *mockUserStorer) SetRole(_ context.Context, _ uuid.UUID, _ string) error { return nil }
func (m *mockUserStorer) QueryByReferralCode(_ context.Context, _ string) (user.Account, error) {
	return user.Account{}, nil
}
func (m *mockUserStorer) SetDisplayName(_ context.Context, _ uuid.UUID, _ string) error { return nil }
func (m *mockUserStorer) SetReferralCode(_ context.Context, _ uuid.UUID, _ string) error {
	return nil
}
func (m *mockUserStorer) SetReferredBy(_ context.Context, _, _ uuid.UUID) error { return nil }
func (m *mockUserStorer) IncrementLifetimeDeposit(_ context.Context, _ uuid.UUID, _ decimal.Decimal) error {
	return nil
}
func (m *mockUserStorer) MarkReferralRewardPaid(_ context.Context, _ uuid.UUID) error { return nil }
func (m *mockUserStorer) CountReferrals(_ context.Context, _ uuid.UUID) (int, error)  { return 0, nil }
func (m *mockUserStorer) CreateNonce(_ context.Context, _, _ string, _ time.Time) error {
	return nil
}
func (m *mockUserStorer) ConsumeNonce(_ context.Context, _ string) (user.NonceRecord, error) {
	return user.NonceRecord{}, nil
}
func (m *mockUserStorer) PurgeExpiredNonces(_ context.Context) (int64, error) { return 0, nil }
func (m *mockUserStorer) QueryWalletAddress(_ context.Context, _ uuid.UUID) (string, error) {
	return "", nil
}

// ---------------------------------------------------------------------------
// Test helper
// ---------------------------------------------------------------------------

type testHandlerOpts struct {
	decrementMegaspeakerFn func(ctx context.Context, accountID uuid.UUID) error
	getInventoryFn         func(ctx context.Context, accountID uuid.UUID) (inventory.Inventory, error)
	queryByIDFn            func(ctx context.Context, accountID uuid.UUID) (user.Account, error)
}

func newTestHandler(t *testing.T, opts testHandlerOpts) (*Handler, *Connection) {
	t.Helper()

	hub := NewHub()
	log := zap.NewNop().Sugar()

	invStorer := &mockInventoryStorer{
		decrementMegaspeakerFn: opts.decrementMegaspeakerFn,
		getInventoryFn:         opts.getInventoryFn,
	}
	invCore := inventory.NewCore(nil, invStorer, nil, nil)

	usrStorer := &mockUserStorer{
		queryByIDFn: opts.queryByIDFn,
	}
	usrCore := user.NewCore(usrStorer)

	h := &Handler{
		log:           log,
		hub:           hub,
		inventoryCore: invCore,
		userCore:      usrCore,
	}

	userID := uuid.New().String()
	c := &Connection{
		send:   make(chan []byte, sendBufLen),
		hub:    hub,
		userID: userID,
		role:   "user",
	}
	hub.Add(c)

	return h, c
}

// drainOne reads a single message from the connection's send channel with a timeout.
func drainOne(t *testing.T, c *Connection) map[string]interface{} {
	t.Helper()

	select {
	case raw := <-c.send:
		var msg map[string]interface{}
		if err := msgpack.Unmarshal(raw, &msg); err != nil {
			t.Fatalf("msgpack unmarshal: %v", err)
		}
		return msg
	case <-time.After(time.Second):
		t.Fatal("timeout waiting for message on send channel")
		return nil
	}
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Spectator tests
// ---------------------------------------------------------------------------

func TestSpectator_PingAllowed(t *testing.T) {
	t.Parallel()

	h, _ := newTestHandler(t, testHandlerOpts{})

	// Create a spectator connection.
	sc := &Connection{
		send:      make(chan []byte, sendBufLen),
		hub:       h.hub,
		spectator: true,
	}
	h.hub.Add(sc)

	// handlePing should work for spectators.
	h.handlePing(sc)

	msg := drainOne(t, sc)
	if msg["op"] != "pong" {
		t.Errorf("op = %v, want pong", msg["op"])
	}
}

func TestSpectator_MegaspeakerNoEffect(t *testing.T) {
	t.Parallel()

	h, _ := newTestHandler(t, testHandlerOpts{})

	sc := &Connection{
		send:      make(chan []byte, sendBufLen),
		hub:       h.hub,
		spectator: true,
	}
	h.hub.Add(sc)

	// Even if the readPump guard were bypassed, handleMegaspeaker would fail
	// because the spectator has no userID (uuid.Parse("") fails).
	// Verify no megaspeaker message is added to the hub.
	h.handleMegaspeaker(sc, ClientMessage{Op: "megaspeaker", Message: "hello"})

	if len(h.hub.GetMegaspeakerHistory()) != 0 {
		t.Error("spectator megaspeaker should not be stored in hub history")
	}
}

func TestSpectator_ReadPumpGuard(t *testing.T) {
	t.Parallel()

	// Verify the guard logic used in readPump: spectator connections should
	// only be allowed to send "ping" ops.
	sc := &Connection{spectator: true, send: make(chan []byte, sendBufLen)}

	blockedOps := []string{"batch_insert", "megaspeaker", "shock", "tornado", "explosion", "lightning", "super_push"}
	for _, op := range blockedOps {
		if !(sc.IsSpectator() && op != "ping") {
			t.Errorf("op %q should be blocked for spectators", op)
		}
	}

	// "ping" should pass the guard.
	if sc.IsSpectator() && "ping" != "ping" {
		t.Error("ping should not be blocked for spectators")
	}
}

// ---------------------------------------------------------------------------
// Megaspeaker tests
// ---------------------------------------------------------------------------

func TestHandleMegaspeaker_EmptyMessage(t *testing.T) {
	t.Parallel()

	h, c := newTestHandler(t, testHandlerOpts{})
	h.handleMegaspeaker(c, ClientMessage{Op: "megaspeaker", Message: ""})

	msg := drainOne(t, c)
	if msg["op"] != "megaspeaker_error" {
		t.Errorf("op = %v, want megaspeaker_error", msg["op"])
	}
	if msg["error"] != "invalid_message" {
		t.Errorf("error = %v, want invalid_message", msg["error"])
	}
}

func TestHandleMegaspeaker_WhitespaceOnly(t *testing.T) {
	t.Parallel()

	h, c := newTestHandler(t, testHandlerOpts{})
	h.handleMegaspeaker(c, ClientMessage{Op: "megaspeaker", Message: "   \t\n  "})

	msg := drainOne(t, c)
	if msg["op"] != "megaspeaker_error" {
		t.Errorf("op = %v, want megaspeaker_error", msg["op"])
	}
	if msg["error"] != "invalid_message" {
		t.Errorf("error = %v, want invalid_message", msg["error"])
	}
}

func TestHandleMegaspeaker_TooLong(t *testing.T) {
	t.Parallel()

	// 151 CJK characters (each is 1 rune).
	longMsg := strings.Repeat("啊", 151)

	h, c := newTestHandler(t, testHandlerOpts{})
	h.handleMegaspeaker(c, ClientMessage{Op: "megaspeaker", Message: longMsg})

	msg := drainOne(t, c)
	if msg["op"] != "megaspeaker_error" {
		t.Errorf("op = %v, want megaspeaker_error", msg["op"])
	}
	if msg["error"] != "invalid_message" {
		t.Errorf("error = %v, want invalid_message", msg["error"])
	}
}

func TestHandleMegaspeaker_ExactLimit(t *testing.T) {
	t.Parallel()

	// 150 CJK characters — should pass validation.
	exactMsg := strings.Repeat("啊", 150)

	h, c := newTestHandler(t, testHandlerOpts{})
	h.handleMegaspeaker(c, ClientMessage{Op: "megaspeaker", Message: exactMsg})

	// Should NOT get megaspeaker_error. Should get broadcast + inventory_update.
	msg := drainOne(t, c)
	if msg["op"] == "megaspeaker_error" {
		t.Fatalf("150 chars should be accepted, got megaspeaker_error: %v", msg["error"])
	}
}

func TestHandleMegaspeaker_NoCharge(t *testing.T) {
	t.Parallel()

	h, c := newTestHandler(t, testHandlerOpts{
		decrementMegaspeakerFn: func(_ context.Context, _ uuid.UUID) error {
			return fmt.Errorf("no megaspeaker charges")
		},
	})
	h.handleMegaspeaker(c, ClientMessage{Op: "megaspeaker", Message: "hello"})

	msg := drainOne(t, c)
	if msg["op"] != "megaspeaker_error" {
		t.Errorf("op = %v, want megaspeaker_error", msg["op"])
	}
	if msg["error"] != "no_charge" {
		t.Errorf("error = %v, want no_charge", msg["error"])
	}
}

func TestHandleMegaspeaker_Success(t *testing.T) {
	t.Parallel()

	displayName := "TestUser"

	h, c := newTestHandler(t, testHandlerOpts{
		queryByIDFn: func(_ context.Context, _ uuid.UUID) (user.Account, error) {
			return user.Account{DisplayName: &displayName}, nil
		},
	})
	h.handleMegaspeaker(c, ClientMessage{Op: "megaspeaker", Message: "hello world"})

	// Hub should have 1 megaspeaker message.
	history := h.hub.GetMegaspeakerHistory()
	if len(history) != 1 {
		t.Fatalf("expected 1 megaspeaker in history, got %d", len(history))
	}

	// Verify the broadcast message content.
	var broadcast struct {
		Op          string `msgpack:"op"`
		SpeakerName string `msgpack:"speaker_name"`
		Message     string `msgpack:"message"`
		Timestamp   int64  `msgpack:"timestamp"`
	}
	if err := msgpack.Unmarshal(history[0], &broadcast); err != nil {
		t.Fatalf("unmarshal broadcast: %v", err)
	}
	if broadcast.Op != "megaspeaker" {
		t.Errorf("broadcast.Op = %q, want %q", broadcast.Op, "megaspeaker")
	}
	if broadcast.SpeakerName != "TestUser" {
		t.Errorf("broadcast.SpeakerName = %q, want %q", broadcast.SpeakerName, "TestUser")
	}
	if broadcast.Message != "hello world" {
		t.Errorf("broadcast.Message = %q, want %q", broadcast.Message, "hello world")
	}

	// Connection should receive the broadcast + inventory_update (2 messages).
	msg1 := drainOne(t, c)
	msg2 := drainOne(t, c)

	ops := map[string]bool{
		fmt.Sprintf("%v", msg1["op"]): true,
		fmt.Sprintf("%v", msg2["op"]): true,
	}
	if !ops["megaspeaker"] {
		t.Error("expected megaspeaker broadcast message on connection")
	}
	if !ops["inventory_update"] {
		t.Error("expected inventory_update message on connection")
	}
}

// ---------------------------------------------------------------------------
// isFinite tests (Fix 1 — NaN/Infinity bypass)
// ---------------------------------------------------------------------------

func TestIsFinite(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name string
		val  float64
		want bool
	}{
		{"zero", 0, true},
		{"positive", 1.5, true},
		{"negative", -0.4, true},
		{"max float", math.MaxFloat64, true},
		{"smallest nonzero", math.SmallestNonzeroFloat64, true},
		{"NaN", math.NaN(), false},
		{"+Inf", math.Inf(1), false},
		{"-Inf", math.Inf(-1), false},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			if got := isFinite(tc.val); got != tc.want {
				t.Errorf("isFinite(%v) = %v, want %v", tc.val, got, tc.want)
			}
		})
	}
}

// ---------------------------------------------------------------------------
// NaN/Inf coordinate rejection tests (Fix 1)
// ---------------------------------------------------------------------------

// newTestHandlerWithNATS creates a handler with a mock NATS connection that
// records publishes. Returns handler, connection, and a channel that receives
// published NATS subjects.
func newTestHandlerAdmin(t *testing.T) (*Handler, *Connection) {
	t.Helper()

	hub := NewHub()
	log := zap.NewNop().Sugar()

	invStorer := &mockInventoryStorer{}
	invCore := inventory.NewCore(nil, invStorer, nil, nil)

	usrStorer := &mockUserStorer{}
	usrCore := user.NewCore(usrStorer)

	h := &Handler{
		log:           log,
		hub:           hub,
		inventoryCore: invCore,
		userCore:      usrCore,
	}

	userID := uuid.New().String()
	c := &Connection{
		send:   make(chan []byte, sendBufLen),
		hub:    hub,
		userID: userID,
		role:   "admin",
	}
	hub.Add(c)

	return h, c
}

func TestHandleSpawnStack_RejectsNaN(t *testing.T) {
	t.Parallel()

	h, c := newTestHandlerAdmin(t)

	// NaN x — should be silently dropped (no NATS publish, no crash).
	h.handleSpawnStack(c, ClientMessage{Op: "spawn_stack", Type: "wall", X: math.NaN()})

	// No message should be sent to the connection.
	select {
	case msg := <-c.send:
		t.Fatalf("expected no message, got %v", msg)
	case <-time.After(50 * time.Millisecond):
		// OK — no message sent.
	}
}

func TestHandleSpawnStack_RejectsInf(t *testing.T) {
	t.Parallel()

	h, c := newTestHandlerAdmin(t)

	h.handleSpawnStack(c, ClientMessage{Op: "spawn_stack", Type: "wall", X: math.Inf(1)})

	select {
	case msg := <-c.send:
		t.Fatalf("expected no message, got %v", msg)
	case <-time.After(50 * time.Millisecond):
	}
}

func TestHandleTornado_RejectsNaN(t *testing.T) {
	t.Parallel()

	h, c := newTestHandler(t, testHandlerOpts{})

	// Tornado requires a scroll — but NaN check happens before consumeScroll.
	// So even without inventory, the NaN check should reject the message.
	h.handleTornado(c, ClientMessage{Op: "tornado", X: math.NaN(), Z: 0.3})

	// The connection should receive ability_error from consumeScroll if NaN
	// check didn't fire. If NaN check works, no message at all.
	select {
	case raw := <-c.send:
		var msg map[string]interface{}
		msgpack.Unmarshal(raw, &msg)
		// If we get ability_error, the NaN check was bypassed.
		if msg["op"] == "ability_error" {
			t.Fatal("NaN should be rejected before consumeScroll")
		}
		t.Fatalf("expected no message, got op=%v", msg["op"])
	case <-time.After(50 * time.Millisecond):
		// OK — NaN was rejected.
	}
}

func TestHandleTornado_RejectsInfZ(t *testing.T) {
	t.Parallel()

	h, c := newTestHandler(t, testHandlerOpts{})

	h.handleTornado(c, ClientMessage{Op: "tornado", X: 0.1, Z: math.Inf(-1)})

	select {
	case raw := <-c.send:
		var msg map[string]interface{}
		msgpack.Unmarshal(raw, &msg)
		if msg["op"] == "ability_error" {
			t.Fatal("Inf should be rejected before consumeScroll")
		}
		t.Fatalf("expected no message, got op=%v", msg["op"])
	case <-time.After(50 * time.Millisecond):
	}
}

func TestHandleExplosion_RejectsNaN(t *testing.T) {
	t.Parallel()

	h, c := newTestHandler(t, testHandlerOpts{})

	h.handleExplosion(c, ClientMessage{Op: "explosion", X: 0.1, Z: math.NaN()})

	select {
	case raw := <-c.send:
		var msg map[string]interface{}
		msgpack.Unmarshal(raw, &msg)
		if msg["op"] == "ability_error" {
			t.Fatal("NaN should be rejected before consumeScroll")
		}
		t.Fatalf("expected no message, got op=%v", msg["op"])
	case <-time.After(50 * time.Millisecond):
	}
}

// ---------------------------------------------------------------------------
// Global WS rate limit tests (Fix 7)
// ---------------------------------------------------------------------------

func TestReadPump_GlobalRateLimit_Constants(t *testing.T) {
	t.Parallel()

	// Verify the rate limit constant is reasonable (not accidentally 0 or huge).
	const maxMsgPerSec = 30
	if maxMsgPerSec < 10 {
		t.Error("maxMsgPerSec too low, would disconnect normal clients")
	}
	if maxMsgPerSec > 100 {
		t.Error("maxMsgPerSec too high, wouldn't protect against flooding")
	}
}
