package ws

// NATS topic builders for game room communication.

func TopicCoinInsert(room string) string  { return "game." + room + ".cmd.coin_insert" }
func TopicSpawnStack(room string) string  { return "game." + room + ".cmd.spawn_stack" }
func TopicStateDelta(room string) string  { return "game." + room + ".state_delta" }
func TopicDespawn(room string) string     { return "game." + room + ".despawn" }
func TopicReward(room string) string      { return "game." + room + ".reward" }
func TopicSnapshot(room string) string    { return "game." + room + ".snapshot" }
func TopicSnapshotReq(room string) string { return "game." + room + ".snapshot.request" }
func TopicShock(room string) string       { return "game." + room + ".cmd.shock" }
