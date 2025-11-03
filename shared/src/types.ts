// Protocol version - increment when making breaking changes
export const PROTOCOL_VERSION = 1;

// Body types in the physics world
export type BodyType = "coin" | "pusher";

// Body state representation for network transmission
export type BodyState = {
  id: number;
  type: BodyType;
  // Coin properties (only for type="coin")
  pos?: [number, number, number]; // [x, y, z] position
  rot?: [number, number, number, number]; // [x, y, z, w] quaternion
  // Pusher properties (only for type="pusher")
  z?: number; // z-axis position for kinematic pusher
};

// Complete world state (sent on connect)
export type WorldState = {
  protocolVersion: number;
  tick: number;
  serverTime: number; // milliseconds since epoch
  bodies: BodyState[];
};

// Delta update for active bodies
export type StateUpdate = {
  id: number;
  pos: [number, number, number];
  rot: [number, number, number, number];
};

// --- Message Types ---

// Client → Server: Insert coin at position x
export type CoinInsertMessage = {
  op: "coin_insert";
  x: number; // Range: [-0.5, 0.5]
};

// Client → Server: Ping for clock sync
export type PingMessage = {
  op: "ping";
  clientTime: number;
};

// Server → Client: World snapshot (initial state)
export type WorldSnapshotMessage = {
  op: "world_snapshot";
  protocolVersion: number;
  serverTime: number;
  tick: number;
  bodies: BodyState[];
};

// Server → Client: State delta (incremental update)
export type StateDeltaMessage = {
  op: "state_delta";
  serverTime: number;
  tick: number;
  updates: StateUpdate[];
  pusherZ: number; // Current pusher z position
};

// Server → Client: Despawn entities
export type DespawnMessage = {
  op: "despawn";
  tick: number;
  ids: number[];
};

// Server → Client: Pong response
export type PongMessage = {
  op: "pong";
  serverTime: number;
};

// Union of all client-to-server messages
export type ClientMessage = CoinInsertMessage | PingMessage;

// Union of all server-to-client messages
export type ServerMessage =
  | WorldSnapshotMessage
  | StateDeltaMessage
  | DespawnMessage
  | PongMessage;

// Coin spawn parameters (server-side)
export type CoinSpawnParams = {
  x: number;
  y?: number; // Default: 1.5m
  z?: number; // Default: 0m
};

// Physics configuration constants
export const PHYSICS_CONFIG = {
  TICK_RATE: 30, // Hz
  TICK_INTERVAL: 1000 / 30, // ~33.333ms
  SUBSTEPS: 2,
  SOLVER_VELOCITY_ITERATIONS: 8,
  SOLVER_POSITION_ITERATIONS: 3,
  GRAVITY: { x: 0, y: -9.81, z: 0 },
  QUANTIZE_DECIMALS: 3, // Quantize network values to 3 decimal places
} as const;

// Pusher configuration
export const PUSHER_CONFIG = {
  AMPLITUDE: 0.3, // meters
  FREQUENCY: 0.5, // Hz
  INITIAL_PHASE: 0,
} as const;

// Coin configuration
export const COIN_CONFIG = {
  RADIUS: 0.02, // meters
  THICKNESS: 0.009, // meters
  MASS: 0.01, // kg
  FRICTION: 0.3,
  RESTITUTION: 0.2,
  SPAWN_HEIGHT: 1.5, // meters
  DESPAWN_Y: -0.1, // meters (below this = remove)
  CCD_DISABLE_VELOCITY: 0.5, // m/s
  CCD_DISABLE_HEIGHT: 0.5, // meters
} as const;

// Network/Interpolation configuration
export const NETWORK_CONFIG = {
  INTERPOLATION_DELAY_BASE: 110, // ms (base delay, will be scaled by RTT)
  INTERPOLATION_DELAY_MULTIPLIER: 1.5, // Multiply RTT by this for delay (min 1.0, handles high latency)
  INTERPOLATION_DELAY_MIN: 100, // ms (minimum delay)
  INTERPOLATION_DELAY_MAX: 500, // ms (maximum delay)
  EXTRAPOLATION_MAX_TIME: 150, // ms (max time to extrapolate into the future)
  PING_INTERVAL: 5000, // ms
  RTT_SAMPLES: 5, // Number of RTT samples for median calculation
  CONNECTION_IDLE_TIMEOUT: 300000, // 5 minutes (300000 ms) - disconnect idle connections
  CONNECTION_CHECK_INTERVAL: 30000, // 30 seconds - check for idle connections
} as const;

// Rate limiting
export const RATE_LIMIT_CONFIG = {
  COIN_INSERT_COOLDOWN: 100, // ms between coin inserts per connection
  MAX_X_POSITION: 0.5, // Valid x range: [-0.5, 0.5]
} as const;
