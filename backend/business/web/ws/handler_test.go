package ws

import (
	"context"
	"fmt"
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
	invCore := inventory.NewCore(nil, invStorer, nil)

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
