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
  SUBSTEPS: 4,
  SOLVER_VELOCITY_ITERATIONS: 4,
  SOLVER_POSITION_ITERATIONS: 4,
  GRAVITY: { x: 0, y: -9.81, z: 0 },
  QUANTIZE_DECIMALS: 3, // Quantize network values to 3 decimal places
} as const;

// Pusher configuration
export const PUSHER_CONFIG = {
  AMPLITUDE: 0.15, // meters
  FREQUENCY: 0.25, // Hz
  INITIAL_PHASE: 0,
} as const;

// Coin configuration
export const COIN_CONFIG = {
  RADIUS: 0.04, // meters
  THICKNESS: 0.015, // meters
  MASS: 0.01, // kg
  FRICTION: 0.3,
  RESTITUTION: 0.3,
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

// Coin spawn slot configuration
export const SLOT_CONFIG = {
  POSITIONS: [
    -0.4, // Slot 1 (leftmost)
    -0.2, // Slot 2
    0.0, // Slot 3 (center)
    0.2, // Slot 4
    0.4, // Slot 5 (rightmost)
  ],
  SPAWN_HEIGHT: 1.5, // meters (same as COIN_CONFIG.SPAWN_HEIGHT)
  SPAWN_Z: 0, // meters (centered)
} as const;

// Scene geometry configuration (shared between server physics and client rendering)
export const SCENE_CONFIG = {
  PLATFORM: {
    WIDTH: 1.2, // meters
    DEPTH: 1, // meters
    THICKNESS: 0.05, // meters
    POSITION: { x: 0, y: 0.25, z: 0 },
    TILT_ANGLE: 0, // degrees (no tilt)
    FRICTION: 0.35,
    RESTITUTION: 0.15,
  },
  BACK_WALL: {
    WIDTH: 1.2, // meters
    HEIGHT: 2, // meters
    THICKNESS: 0.05, // meters
    POSITION: { x: 0, y: 0.5, z: -0.4 },
    TILT_ANGLE: -5, // degrees (backward tilt)
    FRICTION: 0.3,
    RESTITUTION: 0.1,
  },
  PINS: {
    RADIUS: 0.015, // meters
    HEIGHT: 0.12, // meters
    ROWS: 5,
    ODD_ROW_COUNT: 5, // pins per odd row
    EVEN_ROW_COUNT: 6, // pins per even row
    HORIZONTAL_SPACING: 0.2, // meters
    VERTICAL_SPACING: 0.15, // meters
    START_Y: 0.3, // meters from bottom of back wall
    Y_OFFSET: 0.8, // meters (adjust vertical position of all pins)
    FRICTION: 0.0,
    RESTITUTION: 0.3,
  },
  SIDE_WALLS: {
    DEPTH: 1, // meters
    HEIGHT: 2, // meters
    THICKNESS: 0.05, // meters
    LEFT_POSITION: { x: -0.6, y: 0.5, z: 0 },
    RIGHT_POSITION: { x: 0.6, y: 0.5, z: 0 },
    INNER_TILT_ANGLE: 1.5, // degrees (inward tilt)
    FRICTION: 0.3,
    RESTITUTION: 0.1,
  },
  PUSHER: {
    WIDTH: 1.2, // meters
    HEIGHT: 0.2, // meters (thickness)
    DEPTH: 1, // meters
    POSITION: { x: 0, y: 0.3, z: -0.5 },
    FRICTION: 0.5,
    RESTITUTION: 0.1,
  },
  // Client-only visual elements
  DROP_ZONE: {
    WIDTH: 1.0, // meters
    HEIGHT: 0.05, // meters
    DEPTH: 0.3, // meters
    POSITION: { x: 0, y: 0.15, z: 0.45 },
  },
} as const;
