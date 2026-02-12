import { NETWORK_CONFIG } from "@coin-pusher/shared";
import { StateBuffer } from "./StateBuffer";
import { ClockSync } from "./ClockSync";

export interface InterpolatedCoin {
  id: number;
  pos: [number, number, number];
  rot: [number, number, number, number];
}

export interface InterpolatedState {
  coins: InterpolatedCoin[];
  pusherZ: number;
}

export class Interpolator {
  private stateBuffer: StateBuffer;
  private clockSync: ClockSync;

  // Persistent map of last known coin positions.
  // Coins are only removed via removeCoin() (on despawn), so sleeping coins
  // that are omitted from state_delta keep rendering at their last position.
  private knownCoins: Map<number, InterpolatedCoin> = new Map();

  // Track despawned IDs so old buffered states don't re-add them.
  // The interpolation buffer is ~100ms behind, so a despawn message arrives
  // before the buffer catches up, and stale updates could re-insert the coin.
  private despawnedIds: Set<number> = new Set();

  constructor(stateBuffer: StateBuffer, clockSync: ClockSync) {
    this.stateBuffer = stateBuffer;
    this.clockSync = clockSync;
  }

  private getInterpolationDelay(): number {
    const rtt = this.clockSync.getRTT();

    // Calculate adaptive delay: max(base, rtt * multiplier), clamped
    const adaptiveDelay = Math.max(
      NETWORK_CONFIG.INTERPOLATION_DELAY_BASE,
      rtt * NETWORK_CONFIG.INTERPOLATION_DELAY_MULTIPLIER
    );

    return Math.max(
      NETWORK_CONFIG.INTERPOLATION_DELAY_MIN,
      Math.min(NETWORK_CONFIG.INTERPOLATION_DELAY_MAX, adaptiveDelay)
    );
  }

  /** Remove a coin (called on despawn). */
  removeCoin(id: number): void {
    this.knownCoins.delete(id);
    this.despawnedIds.add(id);
  }

  /** Clear all known coins (called on reconnect / world_snapshot). */
  clear(): void {
    this.knownCoins.clear();
    this.despawnedIds.clear();
  }

  getInterpolatedState(): InterpolatedState | null {
    // Calculate target time (server time - interpolation delay)
    const serverTime = this.clockSync.getServerTime();
    const interpolationDelay = this.getInterpolationDelay();
    const targetTime = serverTime - interpolationDelay;

    // Get states for interpolation
    const states = this.stateBuffer.getStatesForInterpolation(targetTime);

    if (!states) {
      // Not enough data for interpolation, try extrapolation
      return this.getExtrapolatedState(targetTime);
    }

    const { before, after } = states;

    // Calculate interpolation alpha
    const timeDiff = after.serverTime - before.serverTime;
    const alpha =
      timeDiff > 0 ? (targetTime - before.serverTime) / timeDiff : 0;

    // Clamp alpha to [0, 1]
    const clampedAlpha = Math.max(0, Math.min(1, alpha));

    // Build lookup map for O(1) access instead of O(n) .find()
    const beforeMap = new Map<number, (typeof before.updates)[0]>();
    for (const u of before.updates) {
      beforeMap.set(u.id, u);
    }

    // Update known coins with interpolated positions from this delta
    for (const afterUpdate of after.updates) {
      // Skip coins that have been despawned (old buffered state)
      if (this.despawnedIds.has(afterUpdate.id)) continue;

      const beforeUpdate = beforeMap.get(afterUpdate.id);

      if (!beforeUpdate) {
        // New coin, just use the after state
        this.knownCoins.set(afterUpdate.id, {
          id: afterUpdate.id,
          pos: afterUpdate.pos,
          rot: afterUpdate.rot,
        });
        continue;
      }

      // Interpolate position (linear)
      const pos: [number, number, number] = [
        this.lerp(beforeUpdate.pos[0], afterUpdate.pos[0], clampedAlpha),
        this.lerp(beforeUpdate.pos[1], afterUpdate.pos[1], clampedAlpha),
        this.lerp(beforeUpdate.pos[2], afterUpdate.pos[2], clampedAlpha),
      ];

      // Interpolate rotation (SLERP)
      const rot = this.slerp(beforeUpdate.rot, afterUpdate.rot, clampedAlpha);

      this.knownCoins.set(afterUpdate.id, {
        id: afterUpdate.id,
        pos,
        rot,
      });
    }

    // Interpolate pusher Z
    const pusherZ = this.lerp(before.pusherZ, after.pusherZ, clampedAlpha);

    // Return ALL known coins (including sleeping ones at their last position)
    return { coins: Array.from(this.knownCoins.values()), pusherZ };
  }

  private getExtrapolatedState(targetTime: number): InterpolatedState | null {
    // Get the latest state we have
    const latestState = this.stateBuffer.getNewestState();
    if (!latestState) return null;

    // Calculate how far we're extrapolating into the future
    const extrapolationTime = targetTime - latestState.serverTime;

    // If we're extrapolating too far into the future, clamp it
    const clampedExtrapolationTime = Math.min(
      extrapolationTime,
      NETWORK_CONFIG.EXTRAPOLATION_MAX_TIME
    );

    // If the latest state is too old, just return it as-is (no extrapolation)
    if (extrapolationTime < 0 || clampedExtrapolationTime <= 0) {
      this.mergeUpdates(latestState.updates);
      return {
        coins: Array.from(this.knownCoins.values()),
        pusherZ: latestState.pusherZ,
      };
    }

    // Get previous state to calculate velocities
    const previousState = this.stateBuffer.getPreviousState(latestState);
    if (!previousState) {
      this.mergeUpdates(latestState.updates);
      return {
        coins: Array.from(this.knownCoins.values()),
        pusherZ: latestState.pusherZ,
      };
    }

    // Calculate time delta between states
    const stateTimeDelta = latestState.serverTime - previousState.serverTime;
    if (stateTimeDelta <= 0) {
      this.mergeUpdates(latestState.updates);
      return {
        coins: Array.from(this.knownCoins.values()),
        pusherZ: latestState.pusherZ,
      };
    }

    // Build lookup map for O(1) access
    const previousMap = new Map<number, (typeof previousState.updates)[0]>();
    for (const u of previousState.updates) {
      previousMap.set(u.id, u);
    }

    for (const latestUpdate of latestState.updates) {
      // Skip coins that have been despawned (old buffered state)
      if (this.despawnedIds.has(latestUpdate.id)) continue;

      const previousUpdate = previousMap.get(latestUpdate.id);

      if (!previousUpdate) {
        // New coin, just use latest position
        this.knownCoins.set(latestUpdate.id, {
          id: latestUpdate.id,
          pos: latestUpdate.pos,
          rot: latestUpdate.rot,
        });
        continue;
      }

      // Calculate velocity (change per ms)
      const vel: [number, number, number] = [
        (latestUpdate.pos[0] - previousUpdate.pos[0]) / stateTimeDelta,
        (latestUpdate.pos[1] - previousUpdate.pos[1]) / stateTimeDelta,
        (latestUpdate.pos[2] - previousUpdate.pos[2]) / stateTimeDelta,
      ];

      // Extrapolate position
      const pos: [number, number, number] = [
        latestUpdate.pos[0] + vel[0] * clampedExtrapolationTime,
        latestUpdate.pos[1] + vel[1] * clampedExtrapolationTime,
        latestUpdate.pos[2] + vel[2] * clampedExtrapolationTime,
      ];

      this.knownCoins.set(latestUpdate.id, {
        id: latestUpdate.id,
        pos,
        rot: latestUpdate.rot,
      });
    }

    // Extrapolate pusher Z
    const pusherVel =
      (latestState.pusherZ - previousState.pusherZ) / stateTimeDelta;
    const pusherZ = latestState.pusherZ + pusherVel * clampedExtrapolationTime;

    return { coins: Array.from(this.knownCoins.values()), pusherZ };
  }

  /** Merge state updates into knownCoins, skipping despawned IDs. */
  private mergeUpdates(
    updates: { id: number; pos: [number, number, number]; rot: [number, number, number, number] }[]
  ): void {
    for (const update of updates) {
      if (this.despawnedIds.has(update.id)) continue;
      this.knownCoins.set(update.id, {
        id: update.id,
        pos: update.pos,
        rot: update.rot,
      });
    }
  }

  private lerp(a: number, b: number, t: number): number {
    return a + (b - a) * t;
  }

  private slerp(
    q1: [number, number, number, number],
    q2: [number, number, number, number],
    t: number
  ): [number, number, number, number] {
    // Calculate dot product
    let dot = q1[0] * q2[0] + q1[1] * q2[1] + q1[2] * q2[2] + q1[3] * q2[3];

    // If dot product is negative, negate one quaternion to take shorter path
    let q2Copy: [number, number, number, number] = [...q2];
    if (dot < 0) {
      q2Copy = [-q2[0], -q2[1], -q2[2], -q2[3]];
      dot = -dot;
    }

    // Clamp dot to avoid numerical issues
    dot = Math.max(-1, Math.min(1, dot));

    // If quaternions are very close, use linear interpolation
    if (dot > 0.9995) {
      return [
        this.lerp(q1[0], q2Copy[0], t),
        this.lerp(q1[1], q2Copy[1], t),
        this.lerp(q1[2], q2Copy[2], t),
        this.lerp(q1[3], q2Copy[3], t),
      ];
    }

    // Calculate SLERP
    const theta = Math.acos(dot);
    const sinTheta = Math.sin(theta);
    const w1 = Math.sin((1 - t) * theta) / sinTheta;
    const w2 = Math.sin(t * theta) / sinTheta;

    return [
      w1 * q1[0] + w2 * q2Copy[0],
      w1 * q1[1] + w2 * q2Copy[1],
      w1 * q1[2] + w2 * q2Copy[2],
      w1 * q1[3] + w2 * q2Copy[3],
    ];
  }
}
