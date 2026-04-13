package ws


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
	UserID   string `json:"user_id"`
	Username string `json:"username"`
}

// NATSTornadoCmd is published to game.{room}.cmd.tornado.
type NATSTornadoCmd struct {
	UserID   string  `json:"user_id"`
	Username string  `json:"username"`
	X        float64 `json:"x"`
	Z        float64 `json:"z"`
}

// NATSExplosionCmd is published to game.{room}.cmd.explosion.
type NATSExplosionCmd struct {
	UserID   string  `json:"user_id"`
	Username string  `json:"username"`
	X        float64 `json:"x"`
	Z        float64 `json:"z"`
}

// NATSLightningCmd is published to game.{room}.cmd.lightning.
type NATSLightningCmd struct {
	UserID   string `json:"user_id"`
	Username string `json:"username"`
}

// NATSSuperPushCmd is published to game.{room}.cmd.super_push.
type NATSSuperPushCmd struct {
	UserID   string `json:"user_id"`
	Username string `json:"username"`
}

// NATSClearAllCmd is published to game.{room}.cmd.clear_all.
type NATSClearAllCmd struct {
	UserID string `json:"user_id"`
}

// NATSFillPlatformCmd is published to game.{room}.cmd.fill_platform.
type NATSFillPlatformCmd struct {
	UserID string `json:"user_id"`
}

// NATSUpdateSceneObjectsCmd is published to game.{room}.cmd.update_scene_objects.
type NATSUpdateSceneObjectsCmd struct {
	UserID  string         `json:"user_id"`
	Objects []EditorObject `json:"objects"`
}

// NATSRewardEvent is received from game.{room}.reward.
type NATSRewardEvent struct {
	CoinCount int    `json:"coin_count"`
	UserID    string `json:"user_id,omitempty"`
}

// NATSBatchInsertCmd is published to game.{room}.cmd.batch_insert.
//
// ReferenceID (optional on the wire, omitted when empty) carries the
// accounting referenceID so the game server can dedup at-least-once
// retries from the outbox drainer. See EncodeBatchInsertPayload and
// game/server/src/nats/dedup.ts.
type NATSBatchInsertCmd struct {
	UserID      string `json:"user_id"`
	SlotID      int    `json:"slot_id"`
	Count       int    `json:"count"`
	ReferenceID string `json:"reference_id,omitempty"`
}

// NATSSponsorQuota is published to game.{room}.cmd.sponsor_quota.
type NATSSponsorQuota struct {
	QuotaID   string `json:"quota_id"`
	SponsorID string `json:"sponsor_id"`
	CoinCount int    `json:"coin_count"`
}

// NATSSponsorQuotaConsumed is received from game.{room}.evt.sponsor_quota_consumed.
type NATSSponsorQuotaConsumed struct {
	QuotaID      string `json:"quota_id"`
	CoinsSpawned int    `json:"coins_spawned"`
}

// NATSSponsorBonusDrop is published to game.{room}.cmd.sponsor_bonus.
type NATSSponsorBonusDrop struct {
	SponsorID   string `json:"sponsor_id"`
	SponsorName string `json:"sponsor_name"`
	TokenSymbol string `json:"token_symbol"`
	CoinCount   int    `json:"coin_count"`
}
