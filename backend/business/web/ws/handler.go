package ws

import (
	"context"
	"encoding/json"
	"net/http"
	"sync/atomic"
	"time"

	"github.com/google/uuid"
	"github.com/gorilla/websocket"
	"github.com/nats-io/nats.go"
	"github.com/vmihailenco/msgpack/v5"
	"go.uber.org/zap"

	"github.com/flamefalcon/coin-pusher/backend/business/core/game"
	"github.com/flamefalcon/coin-pusher/backend/business/core/heat"
	"github.com/flamefalcon/coin-pusher/backend/business/web/auth"
)

const (
	maxXPosition   = 0.5
	spawnHeight    = 1.5
	backWallZ      = -0.4
	stackSpawnY    = 0.3  // Just above the platform
	stackSpawnZ    = 0.35 // Near front lip
	snapshotReqTTL = 2 * time.Second
	numSlots       = 5
	slotCap        = 500
)

var upgrader = websocket.Upgrader{
	ReadBufferSize:  1024,
	WriteBufferSize: 1024,
	CheckOrigin:     func(r *http.Request) bool { return true },
}

// Handler upgrades HTTP connections to WebSocket and manages the read loop.
type Handler struct {
	log        *zap.SugaredLogger
	hub        *Hub
	nc         *nats.Conn
	auth       *auth.Auth
	room       string
	gameCore   *game.Core
	heat       *heat.HeatEngine
	slotCounts [numSlots]int64 // atomic — optimistic per-slot pending count
}

// NewHandler constructs a WS Handler.
func NewHandler(log *zap.SugaredLogger, hub *Hub, nc *nats.Conn, a *auth.Auth, gameCore *game.Core, heat *heat.HeatEngine) *Handler {
	return &Handler{
		log:      log,
		hub:      hub,
		nc:       nc,
		auth:     a,
		room:     "main",
		gameCore: gameCore,
		heat:     heat,
	}
}

// ServeHTTP upgrades to WS, validates auth, starts read/write pumps.
func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	// Auth check: get token from ?token= query param.
	var userID string
	if h.auth.IsDevMode() {
		userID = uuid.NewString()
	} else {
		tokenStr := r.URL.Query().Get("token")
		if tokenStr == "" {
			http.Error(w, `{"error":"missing token"}`, http.StatusUnauthorized)
			return
		}
		claims, err := h.auth.ValidateToken(tokenStr)
		if err != nil {
			http.Error(w, `{"error":"invalid token"}`, http.StatusUnauthorized)
			return
		}
		userID = claims.UserID
	}

	// Upgrade to WebSocket.
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		h.log.Errorw("ws upgrade failed", "error", err)
		return
	}

	c := NewConnection(conn, h.hub, userID)
	h.hub.Add(c)

	h.log.Infow("ws client connected", "user_id", userID, "clients", h.hub.Count())

	// Send welcome message with assigned user ID.
	c.SendMessage(map[string]interface{}{
		"op":      "welcome",
		"user_id": userID,
	})

	// Send cached snapshot if available.
	if snap := h.hub.GetSnapshot(); snap != nil {
		c.SendRaw(snap)
	} else {
		// Request a fresh snapshot via NATS request/reply.
		msg, err := h.nc.Request(TopicSnapshotReq(h.room), nil, snapshotReqTTL)
		if err == nil {
			c.SendRaw(msg.Data)
		} else {
			h.log.Warnw("snapshot request failed", "error", err)
		}
	}

	// Start write pump in a goroutine.
	go c.writePump()

	// Read pump blocks until connection closes.
	h.readPump(c)
}

// readPump reads messages from the WS and dispatches them.
func (h *Handler) readPump(c *Connection) {
	defer func() {
		h.hub.Remove(c)
		c.Close()
		c.conn.Close()
		h.log.Infow("ws client disconnected", "user_id", c.userID, "clients", h.hub.Count())
	}()

	c.conn.SetReadDeadline(time.Now().Add(pongWait))
	c.conn.SetPongHandler(func(string) error {
		c.conn.SetReadDeadline(time.Now().Add(pongWait))
		return nil
	})

	for {
		_, data, err := c.conn.ReadMessage()
		if err != nil {
			if websocket.IsUnexpectedCloseError(err, websocket.CloseGoingAway, websocket.CloseNormalClosure) {
				h.log.Warnw("ws read error", "error", err, "user_id", c.userID)
			}
			return
		}

		var msg ClientMessage
		if err := msgpack.Unmarshal(data, &msg); err != nil {
			h.log.Warnw("msgpack decode error", "error", err)
			continue
		}

		switch msg.Op {
		case "coin_insert":
			h.handleCoinInsert(c, msg)
		case "spawn_stack":
			h.handleSpawnStack(c, msg)
		case "shock":
			h.handleShock(c)
		case "tornado":
			h.handleTornado(c, msg)
		case "explosion":
			h.handleExplosion(c, msg)
		case "lightning":
			h.handleLightning(c)
		case "super_push":
			h.handleSuperPush(c)
		case "clear_all":
			h.handleClearAll(c)
		case "fill_platform":
			h.handleFillPlatform(c)
		case "batch_insert":
			h.handleBatchInsert(c, msg)
		case "ping":
			h.handlePing(c)
		case "update_scene_objects":
			h.handleUpdateSceneObjects(c, msg)
		}
	}
}

func (h *Handler) handleCoinInsert(c *Connection, msg ClientMessage) {
	if !c.CanInsertCoin() {
		return
	}

	// Clamp x to valid range.
	x := msg.X
	if x < -maxXPosition {
		x = -maxXPosition
	}
	if x > maxXPosition {
		x = maxXPosition
	}

	cmd := NATSCoinInsertCmd{
		UserID: c.userID,
		X:      x,
		Y:      spawnHeight,
		Z:      backWallZ,
	}

	data, err := json.Marshal(cmd)
	if err != nil {
		h.log.Errorw("json marshal coin_insert", "error", err)
		return
	}

	h.nc.Publish(TopicCoinInsert(h.room), data)
}

func (h *Handler) handleSpawnStack(c *Connection, msg ClientMessage) {
	// Validate stack type.
	validTypes := map[string]bool{
		"wall": true, "tower": true, "pyramid": true,
		"pyramid3bleLayer": true, "cylinder": true,
	}
	if !validTypes[msg.Type] {
		return
	}

	// Clamp x to valid range.
	x := msg.X
	if x < -maxXPosition {
		x = -maxXPosition
	}
	if x > maxXPosition {
		x = maxXPosition
	}

	cmd := NATSSpawnStackCmd{
		UserID: c.userID,
		Type:   msg.Type,
		X:      x,
		Y:      stackSpawnY,
		Z:      stackSpawnZ,
	}

	data, err := json.Marshal(cmd)
	if err != nil {
		h.log.Errorw("json marshal spawn_stack", "error", err)
		return
	}

	h.nc.Publish(TopicSpawnStack(h.room), data)
}

func (h *Handler) handleShock(c *Connection) {
	if !c.CanShock() {
		return
	}

	cmd := NATSShockCmd{
		UserID: c.userID,
	}

	data, err := json.Marshal(cmd)
	if err != nil {
		h.log.Errorw("json marshal shock", "error", err)
		return
	}

	h.nc.Publish(TopicShock(h.room), data)
}

func (h *Handler) handleTornado(c *Connection, msg ClientMessage) {
	if !c.CanTornado() {
		return
	}

	// Clamp x to valid range.
	x := msg.X
	if x < -maxXPosition {
		x = -maxXPosition
	}
	if x > maxXPosition {
		x = maxXPosition
	}

	// Clamp z to platform range.
	z := msg.Z
	platformFrontZ := 0.7
	platformBackZ := -0.5
	if z < platformBackZ {
		z = platformBackZ
	}
	if z > platformFrontZ {
		z = platformFrontZ
	}

	cmd := NATSTornadoCmd{
		UserID: c.userID,
		X:      x,
		Z:      z,
	}

	data, err := json.Marshal(cmd)
	if err != nil {
		h.log.Errorw("json marshal tornado", "error", err)
		return
	}

	h.nc.Publish(TopicTornado(h.room), data)
}

func (h *Handler) handleExplosion(c *Connection, msg ClientMessage) {
	if !c.CanExplosion() {
		return
	}

	// Clamp x to valid range.
	x := msg.X
	if x < -maxXPosition {
		x = -maxXPosition
	}
	if x > maxXPosition {
		x = maxXPosition
	}

	// Clamp z to platform range.
	z := msg.Z
	platformFrontZ := 0.7
	platformBackZ := -0.5
	if z < platformBackZ {
		z = platformBackZ
	}
	if z > platformFrontZ {
		z = platformFrontZ
	}

	cmd := NATSExplosionCmd{
		UserID: c.userID,
		X:      x,
		Z:      z,
	}

	data, err := json.Marshal(cmd)
	if err != nil {
		h.log.Errorw("json marshal explosion", "error", err)
		return
	}

	h.nc.Publish(TopicExplosion(h.room), data)
}

func (h *Handler) handleLightning(c *Connection) {
	if !c.CanLightning() {
		return
	}

	cmd := NATSLightningCmd{
		UserID: c.userID,
	}

	data, err := json.Marshal(cmd)
	if err != nil {
		h.log.Errorw("json marshal lightning", "error", err)
		return
	}

	h.nc.Publish(TopicLightning(h.room), data)
}

func (h *Handler) handleSuperPush(c *Connection) {
	if !c.CanSuperPush() {
		return
	}

	cmd := NATSSuperPushCmd{
		UserID: c.userID,
	}

	data, err := json.Marshal(cmd)
	if err != nil {
		h.log.Errorw("json marshal super_push", "error", err)
		return
	}

	h.nc.Publish(TopicSuperPush(h.room), data)
}

func (h *Handler) handleClearAll(c *Connection) {
	cmd := NATSClearAllCmd{UserID: c.userID}
	data, err := json.Marshal(cmd)
	if err != nil {
		h.log.Errorw("json marshal clear_all", "error", err)
		return
	}
	h.nc.Publish(TopicClearAll(h.room), data)
}

func (h *Handler) handleFillPlatform(c *Connection) {
	cmd := NATSFillPlatformCmd{UserID: c.userID}
	data, err := json.Marshal(cmd)
	if err != nil {
		h.log.Errorw("json marshal fill_platform", "error", err)
		return
	}
	h.nc.Publish(TopicFillPlatform(h.room), data)
}

func (h *Handler) handleUpdateSceneObjects(c *Connection, msg ClientMessage) {
	cmd := NATSUpdateSceneObjectsCmd{
		UserID:  c.userID,
		Objects: msg.Objects,
	}

	data, err := json.Marshal(cmd)
	if err != nil {
		h.log.Errorw("json marshal update_scene_objects", "error", err)
		return
	}

	h.nc.Publish(TopicUpdateSceneObjects(h.room), data)
}

func (h *Handler) handleBatchInsert(c *Connection, msg ClientMessage) {
	count := msg.Count
	if count <= 0 {
		return
	}

	slotID := msg.SlotID
	if slotID < 0 || slotID >= numSlots {
		slotID = 0
	}

	// Check per-slot cap (optimistic).
	current := atomic.LoadInt64(&h.slotCounts[slotID])
	space := int64(slotCap) - current
	if space <= 0 {
		c.SendMessage(map[string]interface{}{
			"op":     "batch_insert_ack",
			"queued": 0,
			"error":  "slot_full",
		})
		return
	}
	accepted := int64(count)
	if accepted > space {
		accepted = space
	}

	var userID uuid.UUID
	var balanceStr string

	userID, err := uuid.Parse(c.userID)
	if err != nil {
		h.log.Errorw("batch_insert invalid user_id", "user_id", c.userID, "error", err)
		return
	}

	if h.auth.IsDevMode() {
		// Dev mode: skip balance checks.
		balanceStr = "dev"
	} else {
		refKey := uuid.NewString()
		result, err := h.gameCore.ProcessBatchInsert(context.Background(), userID, int(accepted), refKey)
		if err != nil {
			h.log.Errorw("batch_insert process error", "error", err, "user_id", c.userID)
			return
		}
		if !result.Success {
			h.log.Warnw("batch_insert failed", "error", result.Error, "user_id", c.userID)
			return
		}
		balanceStr = result.BalanceCoin
	}

	// Optimistic increment slot count.
	atomic.AddInt64(&h.slotCounts[slotID], accepted)

	// Add heat on commit.
	h.heat.AddHeat(userID, int(accepted))

	// Publish batch_insert command to NATS for game server.
	cmd := NATSBatchInsertCmd{
		UserID: userID.String(),
		SlotID: slotID,
		Count:  int(accepted),
	}
	data, err := json.Marshal(cmd)
	if err != nil {
		h.log.Errorw("json marshal batch_insert", "error", err)
		return
	}
	h.nc.Publish(TopicBatchInsert(h.room), data)

	// Send response to the requesting client.
	share := h.heat.GetShareForUser(userID)
	c.SendMessage(map[string]interface{}{
		"op":         "batch_insert_ack",
		"queued":     accepted,
		"heat_share": share,
		"balance":    balanceStr,
	})
}

func (h *Handler) handlePing(c *Connection) {
	c.SendMessage(PongMessage{
		Op:         "pong",
		ServerTime: time.Now().UnixMilli(),
	})
}

// SubscribeSlotStatus subscribes to slot_status messages from the game server
// and overwrites the local slotCounts with authoritative values.
func (h *Handler) SubscribeSlotStatus() error {
	_, err := h.nc.Subscribe(TopicSlotStatus(h.room), func(msg *nats.Msg) {
		var status struct {
			Counts []int `json:"counts"`
		}
		if err := json.Unmarshal(msg.Data, &status); err != nil {
			h.log.Errorw("slot_status unmarshal error", "error", err)
			return
		}
		for i := 0; i < numSlots && i < len(status.Counts); i++ {
			atomic.StoreInt64(&h.slotCounts[i], int64(status.Counts[i]))
		}
	})
	return err
}
