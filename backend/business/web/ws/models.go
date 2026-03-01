package ws

// PongMessage responds to a client ping.
type PongMessage struct {
	Op         string `msgpack:"op"`
	ServerTime int64  `msgpack:"serverTime"`
}

// EditorObject represents an editor-placed scene object.
type EditorObject struct {
	ID       string     `msgpack:"id"       json:"id"`
	Type     string     `msgpack:"type"     json:"type"`
	Position [3]float64 `msgpack:"position" json:"position"`
	Rotation [3]float64 `msgpack:"rotation" json:"rotation"`
	Scale    [3]float64 `msgpack:"scale"    json:"scale"`
}

// ClientMessage represents any message from the client (decoded from msgpack).
type ClientMessage struct {
	Op         string         `msgpack:"op"`
	X          float64        `msgpack:"x,omitempty"`
	Z          float64        `msgpack:"z,omitempty"`
	Type       string         `msgpack:"type,omitempty"`
	ClientTime int64          `msgpack:"clientTime,omitempty"`
	Objects    []EditorObject `msgpack:"objects,omitempty"`
	Count      int            `msgpack:"count,omitempty"`
	SlotID     int            `msgpack:"slot_id,omitempty"`
	Message    string         `msgpack:"message,omitempty"`
}
