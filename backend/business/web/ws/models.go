package ws

// BodyState mirrors the TS BodyState type.
type BodyState struct {
	ID   int        `msgpack:"id"`
	Type string     `msgpack:"type"`
	Pos  [3]float64 `msgpack:"pos,omitempty"`
	Rot  [4]float64 `msgpack:"rot,omitempty"`
	Z    float64    `msgpack:"z,omitempty"`
}

// WorldSnapshotMessage is sent to clients on connect.
type WorldSnapshotMessage struct {
	Op              string      `msgpack:"op"`
	ProtocolVersion int         `msgpack:"protocolVersion"`
	ServerTime      int64       `msgpack:"serverTime"`
	Tick            int         `msgpack:"tick"`
	Bodies          []BodyState `msgpack:"bodies"`
}

// StateDeltaMessage is an incremental state update.
type StateDeltaMessage struct {
	Op         string        `msgpack:"op"`
	ServerTime int64         `msgpack:"serverTime"`
	Tick       int           `msgpack:"tick"`
	Updates    []StateUpdate `msgpack:"updates"`
	PusherZ    float64       `msgpack:"pusherZ"`
}

// StateUpdate is a single body's position/rotation update.
type StateUpdate struct {
	ID  int        `msgpack:"id"`
	Pos [3]float64 `msgpack:"pos"`
	Rot [4]float64 `msgpack:"rot"`
}

// DespawnMessage notifies clients to remove entities.
type DespawnMessage struct {
	Op   string `msgpack:"op"`
	Tick int    `msgpack:"tick"`
	IDs  []int  `msgpack:"ids"`
}

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
	Type       string         `msgpack:"type,omitempty"`
	ClientTime int64          `msgpack:"clientTime,omitempty"`
	Objects    []EditorObject `msgpack:"objects,omitempty"`
}
