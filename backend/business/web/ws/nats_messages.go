package ws

// NATSCoinInsertCmd is published to game.{room}.cmd.coin_insert.
type NATSCoinInsertCmd struct {
	UserID string  `json:"user_id"`
	X      float64 `json:"x"`
	Y      float64 `json:"y"`
	Z      float64 `json:"z"`
}

// NATSSpawnStackCmd is published to game.{room}.cmd.spawn_stack.
type NATSSpawnStackCmd struct {
	UserID string  `json:"user_id"`
	Type   string  `json:"type"`
	X      float64 `json:"x"`
	Y      float64 `json:"y"`
	Z      float64 `json:"z"`
}

// NATSShockCmd is published to game.{room}.cmd.shock.
type NATSShockCmd struct {
	UserID string `json:"user_id"`
}

// NATSRewardEvent is received from game.{room}.reward.
type NATSRewardEvent struct {
	CoinCount int    `json:"coin_count"`
	UserID    string `json:"user_id,omitempty"`
}
