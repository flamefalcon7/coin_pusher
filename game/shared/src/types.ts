// Protocol version - increment when making breaking changes
export const PROTOCOL_VERSION = 1;

// Body types in the physics world
export type BodyType = "coin" | "pusher";

// Editor primitive types
export type EditorPrimitiveType = "box" | "sphere" | "cylinder" | "prism";

// Editor object for network transmission
export type EditorObjectNet = {
  id: string;
  type: EditorPrimitiveType;
  position: [number, number, number];
  rotation: [number, number, number]; // euler radians
  scale: [number, number, number];
};

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

// Despawn zone classification
export const DespawnZone = {
  FRONT_EDGE: "front",
  LEFT_WALL: "left_wall",
  RIGHT_WALL: "right_wall",
  OTHER: "other",
} as const;
export type DespawnZone = (typeof DespawnZone)[keyof typeof DespawnZone];

// --- Message Types ---

// Client → Server: Insert coin at position x
export type CoinInsertMessage = {
  op: "coin_insert";
  x: number; // Range: [-0.5, 0.5]
};

// Stack types
export type StackType =
  | "wall"
  | "tower"
  | "pyramid"
  | "pyramid3bleLayer"
  | "cylinder";

// Client → Server: Spawn a stack of coins
export type StackSpawnMessage = {
  op: "spawn_stack";
  type: StackType;
  x: number;
};

// Client → Server: Shock pins to dislodge stuck coins
export type ShockMessage = {
  op: "shock";
};

// Client → Server: Tornado at position
export type TornadoMessage = {
  op: "tornado";
  x: number;
  z: number;
};

// Client → Server: Explosion at position
export type ExplosionMessage = {
  op: "explosion";
  x: number;
  z: number;
};

// Client → Server: Lightning strike (random positions, no targeting)
export type LightningMessage = {
  op: "lightning";
};

// Client → Server: Super push (pusher slams forward)
export type SuperPushMessage = {
  op: "super_push";
};

// Client → Server: Ping for clock sync
export type PingMessage = {
  op: "ping";
  clientTime: number;
};

// Client → Server: Clear all coins (dev/test)
export type ClearAllMessage = {
  op: "clear_all";
};

// Client → Server: Fill platform with random coins (dev/test)
export type FillPlatformMessage = {
  op: "fill_platform";
};

// Client → Server: Batch insert request
export type BatchInsertMessage = {
  op: "batch_insert";
  slot_id: number;
  count: number;
};

// Client → Server: Update editor scene objects for physics
export type UpdateSceneObjectsMessage = {
  op: "update_scene_objects";
  objects: EditorObjectNet[];
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
export type ClientMessage =
  | CoinInsertMessage
  | StackSpawnMessage
  | ShockMessage
  | TornadoMessage
  | ExplosionMessage
  | LightningMessage
  | SuperPushMessage
  | PingMessage
  | ClearAllMessage
  | FillPlatformMessage
  | UpdateSceneObjectsMessage
  | BatchInsertMessage;

// Server → Client: Slot machine spin result
export type SlotSymbol = "bitcoin" | "ethereum" | "solana";

export type SlotMachineSpinMessage = {
  op: "slot_spin";
  reels: [SlotSymbol, SlotSymbol, SlotSymbol];
  jackpot: boolean;
};

// Server → Client: Slot machine counter update
export type SlotMachineCounterMessage = {
  op: "slot_counter";
  counter: number;
};

// Server → Client: Coin spawn notification (one-time per coin drop)
export type CoinSpawnMessage = {
  op: "coin_spawn";
  coins: { id: number; owner_id: string }[];
};

// Server → Client: Heat state update (1Hz from backend via relay)
export type HeatUpdateMessage = {
  op: "heat_update";
  players: { user_id: string; share: number; raw_heat: number }[];
};

// Server → Client: Queue progress update
export type QueueUpdateMessage = {
  op: "queue_update";
  user_id: string;
  pending: number;
};

// Server → Client: Reward notification
export type RewardMessage = {
  op: "reward";
  user_id: string;
  amount: number;
  balance: string;
};

// Server → Client: Ability VFX event (broadcast to all clients)
export type AbilityType =
  | "shock"
  | "tornado"
  | "explosion"
  | "lightning"
  | "superPush";

export type AbilityEventMessage = {
  op: "ability";
  ability: AbilityType;
  x?: number; // position for tornado/explosion
  z?: number;
};

// Server → Client: Welcome message with assigned user ID
export type WelcomeMessage = {
  op: "welcome";
  user_id: string;
};

// Server (internal): Slot status for backend sync (not relayed to clients)
export type SlotStatusMessage = {
  op: "slot_status";
  counts: number[];
  tick: number;
};

// Server → Client: Batch insert acknowledgement
export type BatchInsertAckMessage = {
  op: "batch_insert_ack";
  queued: number;
  heat_share?: number;
  balance?: string;
  error?: string;
};

// Union of all server-to-client messages
export type ServerMessage =
  | WorldSnapshotMessage
  | StateDeltaMessage
  | DespawnMessage
  | PongMessage
  | SlotMachineSpinMessage
  | SlotMachineCounterMessage
  | AbilityEventMessage
  | CoinSpawnMessage
  | HeatUpdateMessage
  | QueueUpdateMessage
  | RewardMessage
  | WelcomeMessage
  | SlotStatusMessage
  | BatchInsertAckMessage;

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
  SUBSTEPS: 2, // 2 substeps (reduced from 4 to halve physics cost)
  SOLVER_VELOCITY_ITERATIONS: 4,
  SOLVER_POSITION_ITERATIONS: 3,
  GRAVITY: { x: 0, y: -9.81, z: 0 },
  QUANTIZE_DECIMALS: 3, // Quantize network values to 3 decimal places
  NETWORK_SEND_INTERVAL: 2, // Send state_delta every N physics ticks (2 = 15Hz)
} as const;

// Pusher configuration
export const PUSHER_CONFIG = {
  AMPLITUDE: 0.08, // meters (base amplitude)
  AMPLITUDE_MAX: 0.16, // meters (max amplitude at coin cap)
  AMPLITUDE_COIN_MIN: 250, // coin count where amplitude starts increasing
  AMPLITUDE_COIN_MAX: 400, // coin count where amplitude reaches max
  FREQUENCY: 0.5, // Hz
  INITIAL_PHASE: 0,
  Z_OFFSET: 0.1, // meters
} as const;

// Coin configuration
export const COIN_CONFIG = {
  RADIUS: 0.06, // meters (was 0.05 — larger circumference)
  THICKNESS: 0.012, // meters (was 0.015 — thinner)
  MASS: 0.01, // kg
  FRICTION: 0.7, // (was 0.5 — higher friction helps coins grip edges)
  RESTITUTION: 0.0,
  SPAWN_HEIGHT: 1.5, // meters
  DESPAWN_Y: -0.1, // meters (below this = remove)
  CCD_DISABLE_VELOCITY: 0.5, // m/s
  CCD_DISABLE_HEIGHT: 0.5, // meters
  BORDER_RADIUS: 0.0001, // meters (chamfer radius)
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
  COIN_INSERT_COOLDOWN: 50, // ms between coin inserts per connection
  SHOCK_COOLDOWN: 2000, // ms between shock activations per connection
  TORNADO_COOLDOWN: 10000, // ms between tornado activations per connection
  TORNADO_DURATION: 4000, // ms tornado is active
  EXPLOSION_COOLDOWN: 8000, // ms between explosion activations per connection
  LIGHTNING_COOLDOWN: 6000, // ms between lightning activations per connection
  SUPER_PUSH_COOLDOWN: 12000, // ms between super push activations per connection
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
    WIDTH: 1.2, // meters (back edge width, constant up to FLARE_Z)
    DEPTH: 1.3, // meters
    FLARE_Z: 0, // z where outward flare begins (0 = midpoint of platform)
    FLARE_ANGLE: 30, // degrees outward from each side wall
    THICKNESS: 0.05, // meters
    POSITION: { x: 0, y: 0.25, z: 0.05 },
    TILT_ANGLE: 2, // degrees (forward tilt to help coins flow toward front)
    FRICTION: 0.35,
    RESTITUTION: 0.15,
  },
  BACK_WALL: {
    WIDTH: 1.2, // meters
    HEIGHT: 2, // meters
    THICKNESS: 0.05, // meters
    POSITION: { x: 0, y: 0.5, z: -0.4 },
    TILT_ANGLE: -5, // degrees (backward tilt)
    FRICTION: 0.1, // low friction so coins slide down
    RESTITUTION: 0.3, // bouncier so coins don't settle against wall
  },
  PINS: {
    RADIUS: 0.006, // meters (thinner pins)
    HEIGHT: 0.12, // meters
    ROWS: 5,
    ODD_ROW_COUNT: 5, // pins at x: -0.4, -0.2, 0.0, 0.2, 0.4 (aligned with slots)
    EVEN_ROW_COUNT: 6, // pins at x: -0.5, -0.3, -0.1, 0.1, 0.3, 0.5 (staggered)
    HORIZONTAL_SPACING: 0.2, // meters
    VERTICAL_SPACING: 0.18, // meters (> coin diameter 0.12m to prevent wedging)
    START_Y: 0.3, // meters from bottom of back wall
    Y_OFFSET: 0.8, // meters (adjust vertical position of all pins)
    FRICTION: 0.0,
    RESTITUTION: 0.8, // high bounce to push coins away from pins
  },
  SIDE_WALLS: {
    DEPTH: 1.3, // meters
    HEIGHT: 2, // meters
    THICKNESS: 0.1, // meters
    LEFT_POSITION: { x: -0.6, y: 0.5, z: 0.05 },
    RIGHT_POSITION: { x: 0.6, y: 0.5, z: 0.05 },
    INNER_TILT_ANGLE: 1.5, // degrees (inward tilt)
    FRONT_OPENING_SIZE: 0.32, // meters - square hole side length
    FRONT_OPENING_CENTER: 0.5, // normalized position along flared wall (0=FLARE_Z end, 1=front end)
    FRONT_OPENING_Y: 0.35, // world Y position of hole center
    FRICTION: 0.3,
    RESTITUTION: 0.1,
  },
  // Left platform: raised shelf extending outward from the left wall
  LEFT_PLATFORM: {
    WIDTH: 0.35, // meters — extends outward from left wall (-x direction)
    HEIGHT: 0.08, // meters — shelf thickness
    BACK_Z: -0.6, // z start (aligns with platform back)
    FRONT_Z: 0.0, // z end (up to flare point — back segment only)
    TOP_Y: 1.5, // y position of shelf surface (at wall top)
    FRICTION: 0.3,
    RESTITUTION: 0.1,
  },
  // Slot machine: decorative slot machine on the left platform (visual only)
  SLOT_MACHINE: {
    WIDTH: 0.28, // meters — cabinet width
    HEIGHT: 0.45, // meters — cabinet height
    DEPTH: 0.22, // meters — cabinet depth
    POSITION_OFFSET_Z: -0.25, // z offset from platform center (centered on back segment)
  },
  // Side ramps: depressed surfaces near wall openings to guide coins through
  SIDE_RAMP: {
    DROP: 0.04, // meters — how far the outer edge dips below platform surface
    FRICTION: 0.05, // low friction to help coins slide into openings
  },
  // Front lip: wedge at front edge to prevent coins from sliding off too easily
  FRONT_LIP: {
    HEIGHT: 0.035, // meters — rise at front edge (~2.9× coin thickness)
    DEPTH: 0.1, // meters — extent in Z
    BASE: 0.005, // meters — embedded base thickness
  },
  PUSHER: {
    WIDTH: 1.2, // meters
    HEIGHT: 0.2, // meters (thickness)
    DEPTH: 1, // meters
    POSITION: { x: 0, y: 0.3, z: -0.6 },
    FRICTION: 0.5,
    RESTITUTION: 0.1,
  },
  // Client-only visual elements
  DROP_ZONE: {
    WIDTH: 2.1, // meters (matches flared front edge)
    HEIGHT: 0.05, // meters
    DEPTH: 0.3, // meters
    POSITION: { x: 0, y: 0.15, z: 0.75 },
  },
} as const;

// Super push configuration
export const SUPER_PUSH_CONFIG = {
  PULLBACK_Z: -0.05, // currentZ during wind-up (behind normal min 0.02)
  THRUST_Z: 0.6, // currentZ at full extension (stop 10cm before front lip)
  PULLBACK_DURATION: 400, // ms - slow retract, builds tension
  THRUST_DURATION: 350, // ms - powerful forward slam
  HOLD_DURATION: 250, // ms - heavy pause at full extension (weight feel)
  RECOVERY_DURATION: 700, // ms - slow return to oscillation (inertia)
} as const;

// Slot machine configuration
export const SLOT_MACHINE_CONFIG = {
  TRIGGER_COUNT: 10, // coins through left wall to trigger spin
  BONUS_AMOUNT: 100, // coins awarded on jackpot
  X_THRESHOLD: -0.5, // coins with x < this count as left-wall drops
  Z_MAX_THRESHOLD: 0.55, // coins through left opening have Z < 0.5; front-edge coins have Z > 0.7
  SYMBOLS: ["bitcoin", "ethereum", "solana"] as const,
  SPIN_DURATION: 3500, // ms total reel animation time
  BONUS_SPAWN_DELAY: 4000, // ms after spin starts before bonus coins drop
  BONUS_SPAWN_INTERVAL: 30, // ms between each bonus coin spawn
} as const;

// Heat system configuration
export const HEAT_CONFIG = {
  HALF_LIFE: 180, // seconds
  ALPHA: 0.7, // diminishing returns
  GUARANTEED_MIN: 0.05, // per active player
  BROADCAST_INTERVAL: 1000, // ms
  REWARD_FLUSH_INTERVAL: 10000, // ms
} as const;

// Drop scheduler configuration (per-slot independent queues)
export const DROP_SCHEDULER_CONFIG = {
  DROP_INTERVAL_TICKS: 4, // 1 drop every 4 ticks per slot = ~7.5 drops/sec/slot
  SLOT_CAP: 500, // max coins queued per slot (shared across all players)
  RANDOM_X_OFFSET: 0.03, // ±0.03 random X offset on each drop
} as const;
