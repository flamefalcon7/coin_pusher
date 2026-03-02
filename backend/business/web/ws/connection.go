package ws

import (
	"sync"
	"time"

	"github.com/gorilla/websocket"
	"github.com/vmihailenco/msgpack/v5"

	"github.com/flamefalcon/coin-pusher/backend/foundation/metrics"
)

const (
	writeWait  = 10 * time.Second
	pongWait   = 60 * time.Second
	pingPeriod = (pongWait * 9) / 10
	sendBufLen = 256
)

// Connection wraps a WebSocket connection with buffered sending.
type Connection struct {
	conn           *websocket.Conn
	send           chan []byte
	hub            *Hub
	userID         string
	role           string
	lastBatchInsert time.Time
	lastShock       time.Time
	lastTornado    time.Time
	lastExplosion  time.Time
	lastLightning  time.Time
	lastSuperPush  time.Time
	lastActivity   time.Time
	idleWarned     bool
	mu             sync.Mutex
	closed         bool
}

// NewConnection creates a Connection and registers it with the hub.
func NewConnection(conn *websocket.Conn, hub *Hub, userID, role string) *Connection {
	return &Connection{
		conn:         conn,
		send:         make(chan []byte, sendBufLen),
		hub:          hub,
		userID:       userID,
		role:         role,
		lastActivity: time.Now(),
	}
}

// IsAdmin returns true if the connection belongs to an admin user.
func (c *Connection) IsAdmin() bool {
	return c.role == "admin"
}

// writePump drains the send channel to the WebSocket.
func (c *Connection) writePump() {
	ticker := time.NewTicker(pingPeriod)
	defer func() {
		ticker.Stop()
		c.conn.Close()
	}()

	for {
		select {
		case msg, ok := <-c.send:
			c.conn.SetWriteDeadline(time.Now().Add(writeWait))
			if !ok {
				c.conn.WriteMessage(websocket.CloseMessage, nil)
				return
			}
			if err := c.conn.WriteMessage(websocket.BinaryMessage, msg); err != nil {
				return
			}
		case <-ticker.C:
			c.conn.SetWriteDeadline(time.Now().Add(writeWait))
			if err := c.conn.WriteMessage(websocket.PingMessage, nil); err != nil {
				return
			}
		}
	}
}

// SendRaw sends pre-encoded bytes (for broadcast -- no re-encoding).
func (c *Connection) SendRaw(data []byte) {
	c.mu.Lock()
	defer c.mu.Unlock()

	if c.closed {
		return
	}

	select {
	case c.send <- data:
	default:
		// Drop message if send buffer is full.
		metrics.WSSendBufferOverflow.Inc()
	}
}

// SendMessage encodes and sends a message via msgpack.
func (c *Connection) SendMessage(msg interface{}) error {
	data, err := msgpack.Marshal(msg)
	if err != nil {
		return err
	}
	c.SendRaw(data)
	return nil
}

// CanBatchInsert checks rate limit (200ms cooldown).
func (c *Connection) CanBatchInsert() bool {
	now := time.Now()
	c.mu.Lock()
	defer c.mu.Unlock()

	if now.Sub(c.lastBatchInsert) < 200*time.Millisecond {
		return false
	}
	c.lastBatchInsert = now
	return true
}


// CanShock checks rate limit (2s cooldown).
func (c *Connection) CanShock() bool {
	now := time.Now()
	c.mu.Lock()
	defer c.mu.Unlock()

	if now.Sub(c.lastShock) < 2*time.Second {
		return false
	}
	c.lastShock = now
	return true
}

// CanTornado checks rate limit (10s cooldown).
func (c *Connection) CanTornado() bool {
	now := time.Now()
	c.mu.Lock()
	defer c.mu.Unlock()

	if now.Sub(c.lastTornado) < 10*time.Second {
		return false
	}
	c.lastTornado = now
	return true
}

// CanExplosion checks rate limit (8s cooldown).
func (c *Connection) CanExplosion() bool {
	now := time.Now()
	c.mu.Lock()
	defer c.mu.Unlock()

	if now.Sub(c.lastExplosion) < 8*time.Second {
		return false
	}
	c.lastExplosion = now
	return true
}

// CanLightning checks rate limit (6s cooldown).
func (c *Connection) CanLightning() bool {
	now := time.Now()
	c.mu.Lock()
	defer c.mu.Unlock()

	if now.Sub(c.lastLightning) < 6*time.Second {
		return false
	}
	c.lastLightning = now
	return true
}

// CanSuperPush checks rate limit (12s cooldown).
func (c *Connection) CanSuperPush() bool {
	now := time.Now()
	c.mu.Lock()
	defer c.mu.Unlock()

	if now.Sub(c.lastSuperPush) < 12*time.Second {
		return false
	}
	c.lastSuperPush = now
	return true
}

// TouchActivity resets the idle timer (called on game actions, not pings).
func (c *Connection) TouchActivity() {
	c.mu.Lock()
	c.lastActivity = time.Now()
	c.idleWarned = false
	c.mu.Unlock()
}

// IdleDuration returns how long the connection has been idle.
func (c *Connection) IdleDuration() time.Duration {
	c.mu.Lock()
	d := time.Since(c.lastActivity)
	c.mu.Unlock()
	return d
}

// Close closes the connection.
func (c *Connection) Close() {
	c.mu.Lock()
	defer c.mu.Unlock()

	if c.closed {
		return
	}
	c.closed = true
	close(c.send)
}
