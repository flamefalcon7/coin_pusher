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
func TopicTornado(room string) string     { return "game." + room + ".cmd.tornado" }
func TopicExplosion(room string) string   { return "game." + room + ".cmd.explosion" }
func TopicLightning(room string) string   { return "game." + room + ".cmd.lightning" }
func TopicSuperPush(room string) string   { return "game." + room + ".cmd.super_push" }
func TopicClearAll(room string) string    { return "game." + room + ".cmd.clear_all" }
func TopicFillPlatform(room string) string       { return "game." + room + ".cmd.fill_platform" }
func TopicUpdateSceneObjects(room string) string { return "game." + room + ".cmd.update_scene_objects" }
func TopicSlotSpin(room string) string            { return "game." + room + ".slot_spin" }
func TopicSlotCounter(room string) string          { return "game." + room + ".slot_counter" }
func TopicAbility(room string) string              { return "game." + room + ".ability" }
