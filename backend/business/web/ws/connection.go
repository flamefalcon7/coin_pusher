package ws

import (
	"sync"
	"time"

	"github.com/gorilla/websocket"
	"github.com/vmihailenco/msgpack/v5"
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
	lastCoinInsert time.Time
	mu             sync.Mutex
	closed         bool
}

// NewConnection creates a Connection and registers it with the hub.
func NewConnection(conn *websocket.Conn, hub *Hub, userID string) *Connection {
	return &Connection{
		conn:   conn,
		send:   make(chan []byte, sendBufLen),
		hub:    hub,
		userID: userID,
	}
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

// CanInsertCoin checks rate limit (100ms cooldown).
func (c *Connection) CanInsertCoin() bool {
	now := time.Now()
	c.mu.Lock()
	defer c.mu.Unlock()

	if now.Sub(c.lastCoinInsert) < 100*time.Millisecond {
		return false
	}
	c.lastCoinInsert = now
	return true
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
