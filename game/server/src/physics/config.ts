import { PHYSICS_CONFIG } from "@coin-pusher/shared";

export const PHYSICS_PARAMS = {
  // Tick configuration
  TICK_RATE: PHYSICS_CONFIG.TICK_RATE,
  TICK_INTERVAL: PHYSICS_CONFIG.TICK_INTERVAL,
  DELTA_TIME: 1 / PHYSICS_CONFIG.TICK_RATE,

  // Solver configuration
  SUBSTEPS: PHYSICS_CONFIG.SUBSTEPS,
  VELOCITY_ITERATIONS: PHYSICS_CONFIG.SOLVER_VELOCITY_ITERATIONS,
  POSITION_ITERATIONS: PHYSICS_CONFIG.SOLVER_POSITION_ITERATIONS,

  // Gravity
  GRAVITY: PHYSICS_CONFIG.GRAVITY,

  // Sleep configuration
  SLEEP_LINEAR_THRESHOLD: 0.1, // m/s
  SLEEP_ANGULAR_THRESHOLD: 0.1, // rad/s
  SLEEP_TIME_UNTIL_SLEEP: 0.5, // seconds

  // Freeze configuration (converts slow coins to Fixed bodies — zero solver cost)
  FREEZE_LINEAR_THRESHOLD: 0.15, // m/s (slightly higher than sleep)
  FREEZE_ANGULAR_THRESHOLD: 0.15, // rad/s
  FREEZE_TIME: 1.5, // seconds of low velocity before freezing

  // Debug flags
  DEBUG_SLEEP: false,
} as const;
