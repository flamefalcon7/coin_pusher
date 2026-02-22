import { SLOT_MACHINE_CONFIG, SCENE_CONFIG } from "@coin-pusher/shared";

/** Where a coin ended up when it despawned. */
export type CoinOutcome = "front_edge" | "left_wall" | "lost";

/**
 * Classify a despawned coin's outcome based on its final position.
 * Mirrors the logic in GameLoop.ts:140-144 for left-wall detection,
 * and the front-edge logic from the original rtp_sim.
 */
export function classifyCoin(pos: { x: number; y: number; z: number }): CoinOutcome {
  // Left wall opening: x < X_THRESHOLD && z < Z_MAX_THRESHOLD
  // (matches GameLoop.ts line 142)
  if (pos.x < SLOT_MACHINE_CONFIG.X_THRESHOLD && pos.z < SLOT_MACHINE_CONFIG.Z_MAX_THRESHOLD) {
    return "left_wall";
  }

  // Front edge: z past the platform front edge and within side bounds
  const platformFrontZ = SCENE_CONFIG.PLATFORM.POSITION.z + SCENE_CONFIG.PLATFORM.DEPTH / 2;
  const platformHalfWidth = SCENE_CONFIG.PLATFORM.WIDTH / 2;
  if (pos.z > platformFrontZ && Math.abs(pos.x) < platformHalfWidth + 0.1) {
    return "front_edge";
  }

  return "lost";
}
