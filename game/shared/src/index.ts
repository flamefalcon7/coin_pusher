// Re-export all types and constants
export * from "./types.js";

// Re-export generated protobuf types and schemas
export {
  type GameMessage,
  GameMessageSchema,
  type StateDelta,
  StateDeltaSchema,
  type Despawn,
  DespawnSchema,
  type WorldSnapshot,
  WorldSnapshotSchema,
  type SlotSpin,
  SlotSpinSchema,
  type SlotCounter,
  SlotCounterSchema,
  type AbilityEvent,
  AbilityEventSchema,
  type CoinSpawn,
  CoinSpawnSchema,
  type CoinSpawnEntry,
  CoinSpawnEntrySchema,
  type CoinUpdate,
  CoinUpdateSchema,
  type BodyState as PbBodyState,
  BodyStateSchema,
  type QueueUpdate,
  QueueUpdateSchema,
} from "./gen/game_pb.js";
