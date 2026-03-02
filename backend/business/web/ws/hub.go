package ws

import (
	"sync"
	"time"

	"github.com/gorilla/websocket"
	"github.com/vmihailenco/msgpack/v5"
	"go.uber.org/zap"
)

// Hub manages the set of active WebSocket connections and caches the latest snapshot.
type Hub struct {
	connections map[*Connection]bool
	mu          sync.RWMutex
	snapshot    []byte
	snapshotMu  sync.RWMutex
	megaMsgs    [][]byte
	megaMu      sync.RWMutex
}

// NewHub constructs a Hub.
func NewHub() *Hub {
	return &Hub{
		connections: make(map[*Connection]bool),
	}
}

// Add registers a connection.
func (h *Hub) Add(c *Connection) {
	h.mu.Lock()
	h.connections[c] = true
	h.mu.Unlock()
}

// Remove unregisters a connection.
func (h *Hub) Remove(c *Connection) {
	h.mu.Lock()
	delete(h.connections, c)
	h.mu.Unlock()
}

// Broadcast sends raw bytes to all connections.
func (h *Hub) Broadcast(data []byte) {
	h.mu.RLock()
	defer h.mu.RUnlock()

	for c := range h.connections {
		c.SendRaw(data)
	}
}

// Count returns the number of active connections.
func (h *Hub) Count() int {
	h.mu.RLock()
	defer h.mu.RUnlock()
	return len(h.connections)
}

// SetSnapshot caches the latest world snapshot bytes.
func (h *Hub) SetSnapshot(data []byte) {
	h.snapshotMu.Lock()
	h.snapshot = data
	h.snapshotMu.Unlock()
}

// GetSnapshot returns the cached world snapshot bytes.
func (h *Hub) GetSnapshot() []byte {
	h.snapshotMu.RLock()
	defer h.snapshotMu.RUnlock()
	return h.snapshot
}

// AddMegaspeakerMsg appends a packed megaspeaker message to the ring buffer (max 50).
func (h *Hub) AddMegaspeakerMsg(packed []byte) {
	h.megaMu.Lock()
	h.megaMsgs = append(h.megaMsgs, packed)
	if len(h.megaMsgs) > 50 {
		h.megaMsgs = h.megaMsgs[len(h.megaMsgs)-50:]
	}
	h.megaMu.Unlock()
}

// GetMegaspeakerHistory returns a copy of the megaspeaker ring buffer.
func (h *Hub) GetMegaspeakerHistory() [][]byte {
	h.megaMu.RLock()
	defer h.megaMu.RUnlock()
	out := make([][]byte, len(h.megaMsgs))
	copy(out, h.megaMsgs)
	return out
}

// SendToUser sends raw bytes to the connection belonging to userID.
// If the user is not connected, the message is silently dropped.
func (h *Hub) SendToUser(userID string, data []byte) {
	h.mu.RLock()
	defer h.mu.RUnlock()

	for c := range h.connections {
		if c.userID == userID {
			c.SendRaw(data)
			return
		}
	}
}

const (
	idleCloseCode = 4408
	idleCloseText = "idle timeout"
)

// StartIdleChecker starts a goroutine that periodically checks for idle
// connections. It sends an idle_warning message at warningDur, and closes the
// connection with code 4408 at timeoutDur.
func (h *Hub) StartIdleChecker(log *zap.SugaredLogger, checkInterval, warningDur, timeoutDur time.Duration) {
	go func() {
		ticker := time.NewTicker(checkInterval)
		defer ticker.Stop()

		for range ticker.C {
			h.mu.RLock()
			// Snapshot the connection set to avoid holding the lock during I/O.
			conns := make([]*Connection, 0, len(h.connections))
			for c := range h.connections {
				conns = append(conns, c)
			}
			h.mu.RUnlock()

			for _, c := range conns {
				idle := c.IdleDuration()

				if idle >= timeoutDur {
					log.Infow("idle timeout, closing connection", "user_id", c.userID, "idle", idle)
					// Send WS close frame with custom code, then close.
					msg := websocket.FormatCloseMessage(idleCloseCode, idleCloseText)
					c.conn.WriteControl(websocket.CloseMessage, msg, time.Now().Add(writeWait))
					c.conn.Close()
					continue
				}

				if idle >= warningDur {
					c.mu.Lock()
					alreadyWarned := c.idleWarned
					c.idleWarned = true
					c.mu.Unlock()

					if !alreadyWarned {
						log.Infow("idle warning sent", "user_id", c.userID, "idle", idle)
						data, err := msgpack.Marshal(map[string]interface{}{
							"op": "idle_warning",
						})
						if err == nil {
							c.SendRaw(data)
						}
					}
				}
			}
		}
	}()
}
