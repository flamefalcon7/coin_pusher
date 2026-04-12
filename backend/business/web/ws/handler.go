package ws

import (
	"context"
	"encoding/json"
	"math"
	"net/http"
	"strings"
	"sync/atomic"
	"time"
	"unicode/utf8"

	"github.com/google/uuid"
	"github.com/gorilla/websocket"
	"github.com/nats-io/nats.go"
	"github.com/shopspring/decimal"
	"github.com/vmihailenco/msgpack/v5"
	"go.uber.org/zap"

	"github.com/flamefalcon/coin-pusher/backend/business/core/game"
	"github.com/flamefalcon/coin-pusher/backend/business/core/heat"
	"github.com/flamefalcon/coin-pusher/backend/business/core/inventory"
	"github.com/flamefalcon/coin-pusher/backend/business/core/sponsor"
	"github.com/flamefalcon/coin-pusher/backend/business/core/user"
	"github.com/flamefalcon/coin-pusher/backend/business/web/auth"
	"github.com/flamefalcon/coin-pusher/backend/foundation/metrics"
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
	maxActiveCoins = 800
)

// Handler upgrades HTTP connections to WebSocket and manages the read loop.
type Handler struct {
	log            *zap.SugaredLogger
	hub            *Hub
	nc             *nats.Conn
	auth           *auth.Auth
	room           string
	gameCore       *game.Core
	heat           *heat.HeatEngine
	inventoryCore  *inventory.Core
	userCore       *user.Core
	sponsorCore    *sponsor.Core
	slotCounts     [numSlots]int64 // atomic — optimistic per-slot pending count
	coinCount      int64          // atomic — authoritative active coin count from game server
	allowedOrigins []string
	upgrader       websocket.Upgrader
}

// NewHandler constructs a WS Handler.
func NewHandler(log *zap.SugaredLogger, hub *Hub, nc *nats.Conn, a *auth.Auth, gameCore *game.Core, heat *heat.HeatEngine, inventoryCore *inventory.Core, userCore *user.Core, sponsorCore *sponsor.Core, allowedOrigins []string) *Handler {
	h := &Handler{
		log:            log,
		hub:            hub,
		nc:             nc,
		auth:           a,
		room:           "main",
		gameCore:       gameCore,
		heat:           heat,
		inventoryCore:  inventoryCore,
		userCore:       userCore,
		sponsorCore:    sponsorCore,
		allowedOrigins: allowedOrigins,
	}
	h.upgrader = websocket.Upgrader{
		ReadBufferSize:  1024,
		WriteBufferSize: 1024,
		CheckOrigin: func(r *http.Request) bool {
			origin := r.Header.Get("Origin")
			for _, allowed := range h.allowedOrigins {
				if allowed == "*" || allowed == origin {
					return true
				}
			}
			return false
		},
	}
	return h
}

// ServeHTTP upgrades to WS, validates auth, starts read/write pumps.
func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	// Upgrade to WebSocket first, then validate auth.
	// This lets us send a proper WS close code (4401) instead of HTTP 401,
	// which the client can detect reliably (HTTP errors only produce code 1006).
	conn, err := h.upgrader.Upgrade(w, r, nil)
	if err != nil {
		h.log.Errorw("ws upgrade failed", "error", err)
		return
	}

	// Auth check: get token from ?token= query param.
	tokenStr := r.URL.Query().Get("token")

	var c *Connection

	if tokenStr == "" {
		// Spectator path — no auth required.
		const maxSpectators = 200
		if h.hub.SpectatorCount() >= maxSpectators {
			conn.WriteMessage(websocket.CloseMessage,
				websocket.FormatCloseMessage(4429, "spectator limit reached"))
			conn.Close()
			return
		}

		c = NewSpectatorConnection(conn, h.hub)
		h.hub.Add(c)

		h.log.Infow("spectator connected", "clients", h.hub.Count(), "spectators", h.hub.SpectatorCount())

		c.SendMessage(map[string]interface{}{
			"op":        "welcome",
			"user_id":   "",
			"spectator": true,
		})
	} else {
		// Authenticated path.
		claims, err := h.auth.ValidateToken(tokenStr)
		if err != nil {
			conn.WriteMessage(websocket.CloseMessage,
				websocket.FormatCloseMessage(4401, "invalid token"))
			conn.Close()
			return
		}
		userID := claims.AccountID
		role := claims.Role

		c = NewConnection(conn, h.hub, userID, role)

		// Enforce one connection per user — disconnect any existing connections.
		if n := h.hub.DisconnectUser(userID); n > 0 {
			h.log.Infow("replaced existing connection", "user_id", userID, "closed", n)
		}

		h.hub.Add(c)

		h.log.Infow("ws client connected", "user_id", userID, "clients", h.hub.Count())

		c.SendMessage(map[string]interface{}{
			"op":      "welcome",
			"user_id": userID,
		})
	}

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
			metrics.WSSnapshotTimeout.Inc()
		}
	}

	// Send megaspeaker history.
	for _, packed := range h.hub.GetMegaspeakerHistory() {
		c.SendRaw(packed)
	}

	// Send active sponsor config.
	if h.sponsorCore != nil {
		if camps, err := h.sponsorCore.ListActive(context.Background()); err == nil && len(camps) > 0 {
			type sponsorEntry struct {
				ID          string `msgpack:"id"`
				BrandName   string `msgpack:"brand_name"`
				BrandColor  string `msgpack:"brand_color"`
				TokenSymbol string `msgpack:"token_symbol"`
				LogoURL     string `msgpack:"logo_url"`
				AdImageURL  string `msgpack:"ad_image_url"`
			}
			type sponsorConfigMsg struct {
				Op       string         `msgpack:"op"`
				Sponsors []sponsorEntry `msgpack:"sponsors"`
			}
			msg := sponsorConfigMsg{Op: "sponsor_config"}
			for _, camp := range camps {
				msg.Sponsors = append(msg.Sponsors, sponsorEntry{
					ID:          camp.CampaignID.String(),
					BrandName:   camp.BrandName,
					BrandColor:  camp.BrandColor,
					TokenSymbol: camp.TokenSymbol,
					LogoURL:     camp.LogoURL,
					AdImageURL:  camp.AdImageURL,
				})
			}
			if packed, err := msgpack.Marshal(msg); err == nil {
				c.SendRaw(packed)
			}
		}
	}

	// Start write pump in a goroutine.
	go c.writePump()

	// Read pump blocks until connection closes.
	h.readPump(c)
}

// isFinite returns false if f is NaN or +/-Inf.
func isFinite(f float64) bool {
	return !math.IsNaN(f) && !math.IsInf(f, 0)
}

// readPump reads messages from the WS and dispatches them.
func (h *Handler) readPump(c *Connection) {
	defer func() {
		h.hub.Remove(c)
		c.Close()
		c.conn.Close()
		h.log.Infow("ws client disconnected", "user_id", c.userID, "clients", h.hub.Count())
	}()

	c.conn.SetReadLimit(4096) // 4KB max message size
	c.conn.SetReadDeadline(time.Now().Add(pongWait))
	c.conn.SetPongHandler(func(string) error {
		c.conn.SetReadDeadline(time.Now().Add(pongWait))
		return nil
	})

	// Global per-connection rate limit: max 30 messages per second.
	const maxMsgPerSec = 30
	msgCount := 0
	windowStart := time.Now()

	for {
		_, data, err := c.conn.ReadMessage()
		if err != nil {
			if websocket.IsUnexpectedCloseError(err, websocket.CloseGoingAway, websocket.CloseNormalClosure) {
				h.log.Warnw("ws read error", "error", err, "user_id", c.userID)
			}
			return
		}

		// Global rate limit: reset window each second, disconnect if exceeded.
		now := time.Now()
		if now.Sub(windowStart) >= time.Second {
			msgCount = 0
			windowStart = now
		}
		msgCount++
		if msgCount > maxMsgPerSec {
			h.log.Warnw("ws global rate limit exceeded, disconnecting", "user_id", c.userID)
			metrics.WSRateLimit.WithLabelValues("global").Inc()
			return
		}

		var msg ClientMessage
		if err := msgpack.Unmarshal(data, &msg); err != nil {
			h.log.Warnw("msgpack decode error", "error", err)
			continue
		}

		// Spectators can only send pings and pause/resume — silently drop everything else.
		if c.IsSpectator() && msg.Op != "ping" && msg.Op != "pause_updates" && msg.Op != "resume_updates" {
			continue
		}

		switch msg.Op {
		case "spawn_stack":
			metrics.WSMessagesReceived.WithLabelValues(msg.Op).Inc()
			h.handleSpawnStack(c, msg)
		case "shock":
			metrics.WSMessagesReceived.WithLabelValues(msg.Op).Inc()
			h.handleShock(c)
		case "tornado":
			metrics.WSMessagesReceived.WithLabelValues(msg.Op).Inc()
			h.handleTornado(c, msg)
		case "explosion":
			metrics.WSMessagesReceived.WithLabelValues(msg.Op).Inc()
			h.handleExplosion(c, msg)
		case "lightning":
			metrics.WSMessagesReceived.WithLabelValues(msg.Op).Inc()
			h.handleLightning(c)
		case "super_push":
			metrics.WSMessagesReceived.WithLabelValues(msg.Op).Inc()
			h.handleSuperPush(c)
		case "clear_all":
			metrics.WSMessagesReceived.WithLabelValues(msg.Op).Inc()
			h.handleClearAll(c)
		case "fill_platform":
			metrics.WSMessagesReceived.WithLabelValues(msg.Op).Inc()
			h.handleFillPlatform(c)
		case "batch_insert":
			metrics.WSMessagesReceived.WithLabelValues(msg.Op).Inc()
			h.handleBatchInsert(c, msg)
		case "ping":
			metrics.WSMessagesReceived.WithLabelValues(msg.Op).Inc()
			h.handlePing(c)
		case "update_scene_objects":
			metrics.WSMessagesReceived.WithLabelValues(msg.Op).Inc()
			h.handleUpdateSceneObjects(c, msg)
		case "megaspeaker":
			metrics.WSMessagesReceived.WithLabelValues(msg.Op).Inc()
			h.handleMegaspeaker(c, msg)
		case "pause_updates":
			metrics.WSMessagesReceived.WithLabelValues(msg.Op).Inc()
			c.SetPaused(true)
			h.log.Debugw("client paused updates", "user_id", c.userID)
		case "resume_updates":
			metrics.WSMessagesReceived.WithLabelValues(msg.Op).Inc()
			h.log.Debugw("client resumed updates", "user_id", c.userID)
			// Send snapshot BEFORE unpausing so no stale deltas can slip in.
			if snap := h.hub.GetSnapshot(); snap != nil {
				c.SendRaw(snap)
			} else if resp, err := h.nc.Request(TopicSnapshotReq(h.room), nil, snapshotReqTTL); err == nil {
				c.SendRaw(resp.Data)
			}
			c.SetPaused(false)
		default:
			metrics.WSMessagesReceived.WithLabelValues("unknown").Inc()
		}
	}
}


func (h *Handler) handleSpawnStack(c *Connection, msg ClientMessage) {
	if !c.IsAdmin() {
		return
	}

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
	if !isFinite(x) {
		return
	}
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

// resolveDisplayName looks up the user's display name, falling back to a
// truncated user ID on error.
func (h *Handler) resolveDisplayName(userID string) string {
	name := userID[:8] + "..."
	uid, err := uuid.Parse(userID)
	if err != nil {
		return name
	}
	acct, err := h.userCore.QueryByID(context.Background(), uid)
	if err == nil && acct.DisplayName != nil {
		name = *acct.DisplayName
	}
	return name
}

func (h *Handler) handleShock(c *Connection) {
	c.TouchActivity()

	if !c.CanShock() {
		metrics.WSRateLimit.WithLabelValues("shock").Inc()
		return
	}

	if err := h.consumeScroll(c, inventory.ScrollShock); err != nil {
		return
	}
	metrics.AbilityUsageTotal.WithLabelValues("shock").Inc()

	cmd := NATSShockCmd{
		UserID:   c.userID,
		Username: h.resolveDisplayName(c.userID),
	}

	data, err := json.Marshal(cmd)
	if err != nil {
		h.log.Errorw("json marshal shock", "error", err)
		return
	}

	h.nc.Publish(TopicShock(h.room), data)
}

func (h *Handler) handleTornado(c *Connection, msg ClientMessage) {
	c.TouchActivity()

	// Reject non-finite floats before consuming scroll (NaN/Inf bypass comparison operators).
	x := msg.X
	z := msg.Z
	if !isFinite(x) || !isFinite(z) {
		return
	}

	if !c.CanTornado() {
		metrics.WSRateLimit.WithLabelValues("tornado").Inc()
		return
	}

	if err := h.consumeScroll(c, inventory.ScrollTornado); err != nil {
		return
	}
	metrics.AbilityUsageTotal.WithLabelValues("tornado").Inc()

	// Clamp x to valid range.
	if x < -maxXPosition {
		x = -maxXPosition
	}
	if x > maxXPosition {
		x = maxXPosition
	}

	// Clamp z to platform range.
	platformFrontZ := 0.7
	platformBackZ := -0.5
	if z < platformBackZ {
		z = platformBackZ
	}
	if z > platformFrontZ {
		z = platformFrontZ
	}

	cmd := NATSTornadoCmd{
		UserID:   c.userID,
		Username: h.resolveDisplayName(c.userID),
		X:        x,
		Z:        z,
	}

	data, err := json.Marshal(cmd)
	if err != nil {
		h.log.Errorw("json marshal tornado", "error", err)
		return
	}

	h.nc.Publish(TopicTornado(h.room), data)
}

func (h *Handler) handleExplosion(c *Connection, msg ClientMessage) {
	c.TouchActivity()

	// Reject non-finite floats before consuming scroll (NaN/Inf bypass comparison operators).
	x := msg.X
	z := msg.Z
	if !isFinite(x) || !isFinite(z) {
		return
	}

	if !c.CanExplosion() {
		metrics.WSRateLimit.WithLabelValues("explosion").Inc()
		return
	}

	if err := h.consumeScroll(c, inventory.ScrollExplosion); err != nil {
		return
	}
	metrics.AbilityUsageTotal.WithLabelValues("explosion").Inc()

	// Clamp x to valid range.
	if x < -maxXPosition {
		x = -maxXPosition
	}
	if x > maxXPosition {
		x = maxXPosition
	}

	// Clamp z to platform range.
	platformFrontZ := 0.7
	platformBackZ := -0.5
	if z < platformBackZ {
		z = platformBackZ
	}
	if z > platformFrontZ {
		z = platformFrontZ
	}

	cmd := NATSExplosionCmd{
		UserID:   c.userID,
		Username: h.resolveDisplayName(c.userID),
		X:        x,
		Z:        z,
	}

	data, err := json.Marshal(cmd)
	if err != nil {
		h.log.Errorw("json marshal explosion", "error", err)
		return
	}

	h.nc.Publish(TopicExplosion(h.room), data)
}

func (h *Handler) handleLightning(c *Connection) {
	c.TouchActivity()

	if !c.CanLightning() {
		metrics.WSRateLimit.WithLabelValues("lightning").Inc()
		return
	}

	if err := h.consumeScroll(c, inventory.ScrollLightning); err != nil {
		return
	}
	metrics.AbilityUsageTotal.WithLabelValues("lightning").Inc()

	cmd := NATSLightningCmd{
		UserID:   c.userID,
		Username: h.resolveDisplayName(c.userID),
	}

	data, err := json.Marshal(cmd)
	if err != nil {
		h.log.Errorw("json marshal lightning", "error", err)
		return
	}

	h.nc.Publish(TopicLightning(h.room), data)
}

func (h *Handler) handleSuperPush(c *Connection) {
	c.TouchActivity()

	if !c.CanSuperPush() {
		metrics.WSRateLimit.WithLabelValues("super_push").Inc()
		return
	}

	if err := h.consumeScroll(c, inventory.ScrollSuperPush); err != nil {
		return
	}
	metrics.AbilityUsageTotal.WithLabelValues("super_push").Inc()

	cmd := NATSSuperPushCmd{
		UserID:   c.userID,
		Username: h.resolveDisplayName(c.userID),
	}

	data, err := json.Marshal(cmd)
	if err != nil {
		h.log.Errorw("json marshal super_push", "error", err)
		return
	}

	h.nc.Publish(TopicSuperPush(h.room), data)
}

func (h *Handler) handleClearAll(c *Connection) {
	if !c.IsAdmin() {
		return
	}

	cmd := NATSClearAllCmd{UserID: c.userID}
	data, err := json.Marshal(cmd)
	if err != nil {
		h.log.Errorw("json marshal clear_all", "error", err)
		return
	}
	h.nc.Publish(TopicClearAll(h.room), data)
}

func (h *Handler) handleFillPlatform(c *Connection) {
	if !c.IsAdmin() {
		return
	}

	cmd := NATSFillPlatformCmd{UserID: c.userID}
	data, err := json.Marshal(cmd)
	if err != nil {
		h.log.Errorw("json marshal fill_platform", "error", err)
		return
	}
	h.nc.Publish(TopicFillPlatform(h.room), data)
}

func (h *Handler) handleUpdateSceneObjects(c *Connection, msg ClientMessage) {
	if !c.IsAdmin() {
		return
	}

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

const maxBatchCount = 100

func (h *Handler) handleBatchInsert(c *Connection, msg ClientMessage) {
	c.TouchActivity()

	count := msg.Count
	if count <= 0 || count > maxBatchCount {
		return
	}

	if !c.CanBatchInsert() {
		metrics.WSRateLimit.WithLabelValues("batch_insert").Inc()
		return
	}

	slotID := msg.SlotID
	if slotID < 0 || slotID >= numSlots {
		slotID = 0
	}

	// Check global coin cap.
	if atomic.LoadInt64(&h.coinCount) >= maxActiveCoins {
		c.SendMessage(map[string]interface{}{
			"op":     "batch_insert_ack",
			"queued": 0,
			"error":  "table_full",
		})
		return
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

	userID, err := uuid.Parse(c.userID)
	if err != nil {
		h.log.Errorw("batch_insert invalid user_id", "user_id", c.userID, "error", err)
		return
	}

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
	// Optimistic increment slot count.
	atomic.AddInt64(&h.slotCounts[slotID], accepted)
	metrics.BatchInsertCoins.Add(float64(accepted))

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
	// P1-14: Check publish error; refund balance if NATS is unreachable.
	if err := h.nc.Publish(TopicBatchInsert(h.room), data); err != nil {
		h.log.Errorw("nats publish batch_insert failed, refunding", "error", err, "user_id", c.userID, "count", accepted)
		// Reverse the exact play/cash split the insert applied. Parse failures
		// are fatal — a silent zero-refund would permanently lose funds.
		playDeb, parseErr := decimal.NewFromString(result.PlayDebited)
		if parseErr != nil {
			h.log.Errorw("refund aborted — play_debited unparseable",
				"raw", result.PlayDebited, "error", parseErr, "user_id", c.userID)
			metrics.BatchInsertRefundFailures.Inc()
			return
		}
		cashDeb, parseErr := decimal.NewFromString(result.CashDebited)
		if parseErr != nil {
			h.log.Errorw("refund aborted — cash_debited unparseable",
				"raw", result.CashDebited, "error", parseErr, "user_id", c.userID)
			metrics.BatchInsertRefundFailures.Inc()
			return
		}
		// Deterministic refund reference ID: <insert-ref>:refund. Enables
		// idempotency guard in ProcessGameInsertRefund (see Unit 2).
		refundKey := refKey + ":refund"
		if _, refundErr := h.gameCore.RefundBatchInsert(context.Background(), userID, playDeb, cashDeb, refundKey); refundErr != nil {
			h.log.Errorw("refund after nats failure also failed", "error", refundErr, "user_id", c.userID)
			metrics.BatchInsertRefundFailures.Inc()
		}
		return
	}

	// Send response to the requesting client. Carry both balances so the
	// client can render a unified wallet total plus the withdrawable
	// sub-indicator without doing arithmetic from two separate messages.
	share := h.heat.GetShareForUser(userID)
	c.SendMessage(map[string]interface{}{
		"op":           "batch_insert_ack",
		"queued":       accepted,
		"heat_share":   share,
		"balance_play": result.BalancePlay,
		"balance_cash": result.BalanceCash,
	})
}

func (h *Handler) handlePing(c *Connection) {
	c.SendMessage(PongMessage{
		Op:         "pong",
		ServerTime: time.Now().UnixMilli(),
	})
}

func (h *Handler) handleMegaspeaker(c *Connection, msg ClientMessage) {
	c.TouchActivity()

	trimmed := strings.TrimSpace(msg.Message)
	if len(trimmed) == 0 || utf8.RuneCountInString(trimmed) > 150 {
		c.SendMessage(map[string]interface{}{
			"op":    "megaspeaker_error",
			"error": "invalid_message",
		})
		return
	}

	userID, err := uuid.Parse(c.userID)
	if err != nil {
		h.log.Errorw("megaspeaker invalid user_id", "user_id", c.userID, "error", err)
		return
	}

	if err := h.inventoryCore.ConsumeMegaspeaker(context.Background(), userID); err != nil {
		c.SendMessage(map[string]interface{}{
			"op":    "megaspeaker_error",
			"error": "no_charge",
		})
		return
	}

	// Resolve display name.
	speakerName := c.userID[:8] + "..."
	acct, err := h.userCore.QueryByID(context.Background(), userID)
	if err == nil && acct.DisplayName != nil {
		speakerName = *acct.DisplayName
	}

	// Broadcast directly via hub (no NATS — single-instance, no game server involvement).
	packed, err := msgpack.Marshal(struct {
		Op          string `msgpack:"op"`
		SpeakerName string `msgpack:"speaker_name"`
		Message     string `msgpack:"message"`
		Timestamp   int64  `msgpack:"timestamp"`
	}{
		Op:          "megaspeaker",
		SpeakerName: speakerName,
		Message:     trimmed,
		Timestamp:   time.Now().UnixMilli(),
	})
	if err != nil {
		h.log.Errorw("msgpack marshal megaspeaker", "error", err)
		return
	}
	h.hub.AddMegaspeakerMsg(packed)
	h.hub.Broadcast(packed)
	metrics.MegaspeakerTotal.Inc()

	// Send inventory update to the user.
	h.sendInventoryUpdate(c, userID)
}

// consumeScroll attempts to consume a scroll of the given type for the user.
// On success it sends an inventory_update to the client and returns nil.
// On failure it sends an error message and returns the error.
func (h *Handler) consumeScroll(c *Connection, scrollType string) error {
	userID, err := uuid.Parse(c.userID)
	if err != nil {
		h.log.Errorw("consumeScroll invalid user_id", "user_id", c.userID, "error", err)
		return err
	}

	if err := h.inventoryCore.ConsumeScroll(context.Background(), userID, scrollType); err != nil {
		c.SendMessage(map[string]interface{}{
			"op":    "ability_error",
			"type":  scrollType,
			"error": "no_scroll",
		})
		return err
	}

	// Send updated inventory to the user.
	h.sendInventoryUpdate(c, userID)
	return nil
}

// sendInventoryUpdate fetches the user's inventory and sends it to the connection.
func (h *Handler) sendInventoryUpdate(c *Connection, userID uuid.UUID) {
	inv, err := h.inventoryCore.GetInventory(context.Background(), userID)
	if err != nil {
		h.log.Errorw("sendInventoryUpdate get inventory error", "user_id", userID, "error", err)
		return
	}
	c.SendMessage(map[string]interface{}{
		"op":                "inventory_update",
		"key_coins":         inv.KeyCoins,
		"scroll_shock":      inv.ScrollShock,
		"scroll_tornado":    inv.ScrollTornado,
		"scroll_explosion":  inv.ScrollExplosion,
		"scroll_lightning":  inv.ScrollLightning,
		"scroll_super_push": inv.ScrollSuperPush,
		"megaspeaker":       inv.Megaspeaker,
	})
}

// SubscribeSlotStatus subscribes to slot_status messages from the game server
// and overwrites the local slotCounts with authoritative values.
func (h *Handler) SubscribeSlotStatus() error {
	_, err := h.nc.Subscribe(TopicSlotStatus(h.room), func(msg *nats.Msg) {
		var status struct {
			Counts    []int `json:"counts"`
			CoinCount int   `json:"coin_count"`
		}
		if err := json.Unmarshal(msg.Data, &status); err != nil {
			h.log.Errorw("slot_status unmarshal error", "error", err)
			return
		}
		for i := 0; i < numSlots && i < len(status.Counts); i++ {
			atomic.StoreInt64(&h.slotCounts[i], int64(status.Counts[i]))
		}
		atomic.StoreInt64(&h.coinCount, int64(status.CoinCount))
	})
	return err
}
