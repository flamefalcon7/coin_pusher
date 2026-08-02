import { StateBuffer } from "./StateBuffer";
import { ClockSync } from "./ClockSync";
import { debugConfig } from "./debugConfig";

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
  private despawnedIds: Set<number> = new Set();

  // Grace period after world_snapshot: render static positions until buffer
  // has enough states for interpolation (~266ms = 4 state_deltas at 15Hz).
  private graceUntil: number = 0;
  private gracePusherZ: number = 0;

  // Reusable lookup map for before-state, cleared & reused each frame
  private lookupMap: Map<number, { id: number; pos: [number, number, number]; rot: [number, number, number, number] }> = new Map();

  // Reusable result object to avoid allocation per frame
  private resultState: InterpolatedState = { coins: [], pusherZ: 0 };

  constructor(stateBuffer: StateBuffer, clockSync: ClockSync) {
    this.stateBuffer = stateBuffer;
    this.clockSync = clockSync;
  }

  private getInterpolationDelay(): number {
    const rtt = this.clockSync.getRTT();

    const adaptiveDelay = Math.max(
      debugConfig.interpolationDelayBase,
      rtt * debugConfig.interpolationDelayMultiplier
    );

    return Math.max(
      debugConfig.interpolationDelayMin,
      Math.min(debugConfig.interpolationDelayMax, adaptiveDelay)
    );
  }

  /** Remove a coin (called on despawn). */
  removeCoin(id: number): void {
    this.knownCoins.delete(id);
    this.despawnedIds.add(id);
    // Cap to prevent unbounded growth in long sessions
    if (this.despawnedIds.size > 2000) {
      this.despawnedIds.clear();
    }
  }

  /** Clear all known coins and start grace period (called on reconnect / world_snapshot). */
  clear(): void {
    this.knownCoins.clear();
    this.despawnedIds.clear();
    // Start grace period: render snapshot positions statically until buffer
    // accumulates >= 2 states for interpolation. 266ms = ~4 state_deltas at 15Hz.
    this.graceUntil = Date.now() + 266;
  }

  /** Seed coins from a world snapshot so sleeping coins render immediately.
   *  Also stores pusherZ for grace period rendering. */
  seedCoins(coins: { id: number; pos: [number, number, number]; rot: [number, number, number, number] }[], pusherZ?: number): void {
    if (pusherZ !== undefined) this.gracePusherZ = pusherZ;
    for (let i = 0, len = coins.length; i < len; i++) {
      const c = coins[i];
      this.knownCoins.set(c.id, {
        id: c.id,
        pos: [c.pos[0], c.pos[1], c.pos[2]],
        rot: [c.rot[0], c.rot[1], c.rot[2], c.rot[3]],
      });
    }
  }

  /** Build the coins array from knownCoins into the reusable result. */
  private buildResult(pusherZ: number): InterpolatedState {
    // Reuse the array: truncate and refill from map values
    const coins = this.resultState.coins;
    let i = 0;
    for (const coin of this.knownCoins.values()) {
      coins[i++] = coin;
    }
    coins.length = i;
    this.resultState.pusherZ = pusherZ;
    return this.resultState;
  }

  getInterpolatedState(): InterpolatedState | null {
    // Grace period: after world_snapshot, render static positions until
    // the buffer has enough states for smooth interpolation.
    if (this.graceUntil > 0) {
      if (Date.now() < this.graceUntil || this.stateBuffer.getBufferSize() < 2) {
        // Still in grace period, or buffer not ready yet — render snapshot as-is
        if (this.knownCoins.size === 0) return null;
        return this.buildResult(this.gracePusherZ);
      }
      // Grace period over and buffer ready — resume normal interpolation
      this.graceUntil = 0;
    }

    const serverTime = this.clockSync.getServerTime();
    const interpolationDelay = this.getInterpolationDelay();
    const targetTime = serverTime - interpolationDelay;

    const states = this.stateBuffer.getStatesForInterpolation(targetTime);

    if (!states) {
      return this.getExtrapolatedState(targetTime);
    }

    const { before, after } = states;

    const timeDiff = after.serverTime - before.serverTime;
    const alpha =
      timeDiff > 0 ? (targetTime - before.serverTime) / timeDiff : 0;
    const clampedAlpha = Math.max(0, Math.min(1, alpha));

    // Reuse lookup map instead of allocating a new Map each frame
    const beforeMap = this.lookupMap;
    beforeMap.clear();
    for (let i = 0, len = before.updates.length; i < len; i++) {
      const u = before.updates[i];
      beforeMap.set(u.id, u);
    }

    // Update known coins with interpolated positions from this delta
    for (let i = 0, len = after.updates.length; i < len; i++) {
      const afterUpdate = after.updates[i];
      if (this.despawnedIds.has(afterUpdate.id)) continue;

      const beforeUpdate = beforeMap.get(afterUpdate.id);

      if (!beforeUpdate) {
        // New coin - reuse or create InterpolatedCoin object
        let coin = this.knownCoins.get(afterUpdate.id);
        if (coin) {
          coin.pos[0] = afterUpdate.pos[0];
          coin.pos[1] = afterUpdate.pos[1];
          coin.pos[2] = afterUpdate.pos[2];
          coin.rot[0] = afterUpdate.rot[0];
          coin.rot[1] = afterUpdate.rot[1];
          coin.rot[2] = afterUpdate.rot[2];
          coin.rot[3] = afterUpdate.rot[3];
        } else {
          coin = {
            id: afterUpdate.id,
            pos: [afterUpdate.pos[0], afterUpdate.pos[1], afterUpdate.pos[2]],
            rot: [afterUpdate.rot[0], afterUpdate.rot[1], afterUpdate.rot[2], afterUpdate.rot[3]],
          };
          this.knownCoins.set(afterUpdate.id, coin);
        }
        continue;
      }

      // Reuse existing coin object to avoid allocation
      let coin = this.knownCoins.get(afterUpdate.id);
      if (!coin) {
        coin = {
          id: afterUpdate.id,
          pos: [0, 0, 0],
          rot: [0, 0, 0, 0],
        };
        this.knownCoins.set(afterUpdate.id, coin);
      }

      // LERP position
      coin.pos[0] = beforeUpdate.pos[0] + (afterUpdate.pos[0] - beforeUpdate.pos[0]) * clampedAlpha;
      coin.pos[1] = beforeUpdate.pos[1] + (afterUpdate.pos[1] - beforeUpdate.pos[1]) * clampedAlpha;
      coin.pos[2] = beforeUpdate.pos[2] + (afterUpdate.pos[2] - beforeUpdate.pos[2]) * clampedAlpha;

      // Interpolate rotation (SLERP) - write directly into coin.rot
      this.slerpInto(coin.rot, beforeUpdate.rot, afterUpdate.rot, clampedAlpha);
    }

    const pusherZ = before.pusherZ + (after.pusherZ - before.pusherZ) * clampedAlpha;

    return this.buildResult(pusherZ);
  }

  private getExtrapolatedState(targetTime: number): InterpolatedState | null {
    const latestState = this.stateBuffer.getNewestState();
    if (!latestState) return null;

    const extrapolationTime = targetTime - latestState.serverTime;
    const clampedExtrapolationTime = Math.min(
      extrapolationTime,
      debugConfig.extrapolationMaxTime
    );

    if (extrapolationTime < 0 || clampedExtrapolationTime <= 0) {
      this.mergeUpdates(latestState.updates);
      return this.buildResult(latestState.pusherZ);
    }

    const previousState = this.stateBuffer.getPreviousState(latestState);
    if (!previousState) {
      this.mergeUpdates(latestState.updates);
      return this.buildResult(latestState.pusherZ);
    }

    const stateTimeDelta = latestState.serverTime - previousState.serverTime;
    if (stateTimeDelta <= 0) {
      this.mergeUpdates(latestState.updates);
      return this.buildResult(latestState.pusherZ);
    }

    // Reuse lookup map
    const previousMap = this.lookupMap;
    previousMap.clear();
    for (let i = 0, len = previousState.updates.length; i < len; i++) {
      const u = previousState.updates[i];
      previousMap.set(u.id, u);
    }

    const invDelta = 1 / stateTimeDelta;

    for (let i = 0, len = latestState.updates.length; i < len; i++) {
      const latestUpdate = latestState.updates[i];
      if (this.despawnedIds.has(latestUpdate.id)) continue;

      const previousUpdate = previousMap.get(latestUpdate.id);

      // Reuse or create coin object
      let coin = this.knownCoins.get(latestUpdate.id);
      if (!coin) {
        coin = {
          id: latestUpdate.id,
          pos: [0, 0, 0],
          rot: [0, 0, 0, 0],
        };
        this.knownCoins.set(latestUpdate.id, coin);
      }

      if (!previousUpdate) {
        coin.pos[0] = latestUpdate.pos[0];
        coin.pos[1] = latestUpdate.pos[1];
        coin.pos[2] = latestUpdate.pos[2];
        coin.rot[0] = latestUpdate.rot[0];
        coin.rot[1] = latestUpdate.rot[1];
        coin.rot[2] = latestUpdate.rot[2];
        coin.rot[3] = latestUpdate.rot[3];
        continue;
      }

      // Extrapolate position using position diff
      const velX = (latestUpdate.pos[0] - previousUpdate.pos[0]) * invDelta;
      const velY = (latestUpdate.pos[1] - previousUpdate.pos[1]) * invDelta;
      const velZ = (latestUpdate.pos[2] - previousUpdate.pos[2]) * invDelta;
      coin.pos[0] = latestUpdate.pos[0] + velX * clampedExtrapolationTime;
      coin.pos[1] = latestUpdate.pos[1] + velY * clampedExtrapolationTime;
      coin.pos[2] = latestUpdate.pos[2] + velZ * clampedExtrapolationTime;

      coin.rot[0] = latestUpdate.rot[0];
      coin.rot[1] = latestUpdate.rot[1];
      coin.rot[2] = latestUpdate.rot[2];
      coin.rot[3] = latestUpdate.rot[3];
    }

    const pusherVel =
      (latestState.pusherZ - previousState.pusherZ) * invDelta;
    const pusherZ = latestState.pusherZ + pusherVel * clampedExtrapolationTime;

    return this.buildResult(pusherZ);
  }

  /** Merge state updates into knownCoins, skipping despawned IDs. */
  private mergeUpdates(
    updates: { id: number; pos: [number, number, number]; rot: [number, number, number, number] }[]
  ): void {
    for (let i = 0, len = updates.length; i < len; i++) {
      const update = updates[i];
      if (this.despawnedIds.has(update.id)) continue;
      let coin = this.knownCoins.get(update.id);
      if (coin) {
        coin.pos[0] = update.pos[0];
        coin.pos[1] = update.pos[1];
        coin.pos[2] = update.pos[2];
        coin.rot[0] = update.rot[0];
        coin.rot[1] = update.rot[1];
        coin.rot[2] = update.rot[2];
        coin.rot[3] = update.rot[3];
      } else {
        this.knownCoins.set(update.id, {
          id: update.id,
          pos: [update.pos[0], update.pos[1], update.pos[2]],
          rot: [update.rot[0], update.rot[1], update.rot[2], update.rot[3]],
        });
      }
    }
  }

  /**
   * SLERP that writes directly into an output array — zero allocations.
   * Uses a pre-allocated q2Buf for the negation case.
   */
  private slerpInto(
    out: [number, number, number, number],
    q1: [number, number, number, number],
    q2: [number, number, number, number],
    t: number
  ): void {
    let dot = q1[0] * q2[0] + q1[1] * q2[1] + q1[2] * q2[2] + q1[3] * q2[3];

    // If dot is negative, negate q2 to take shorter path (use pre-allocated buffer)
    let q2x = q2[0], q2y = q2[1], q2z = q2[2], q2w = q2[3];
    if (dot < 0) {
      q2x = -q2x; q2y = -q2y; q2z = -q2z; q2w = -q2w;
      dot = -dot;
    }

    if (dot > 1) dot = 1;

    // If quaternions are very close, use linear interpolation
    if (dot > 0.9995) {
      out[0] = q1[0] + (q2x - q1[0]) * t;
      out[1] = q1[1] + (q2y - q1[1]) * t;
      out[2] = q1[2] + (q2z - q1[2]) * t;
      out[3] = q1[3] + (q2w - q1[3]) * t;
      this.normalizeInPlace(out);
      return;
    }

    const theta = Math.acos(dot);
    const sinTheta = Math.sin(theta);
    const w1 = Math.sin((1 - t) * theta) / sinTheta;
    const w2 = Math.sin(t * theta) / sinTheta;

    out[0] = w1 * q1[0] + w2 * q2x;
    out[1] = w1 * q1[1] + w2 * q2y;
    out[2] = w1 * q1[2] + w2 * q2z;
    out[3] = w1 * q1[3] + w2 * q2w;
    this.normalizeInPlace(out);
  }

  /**
   * Force a quaternion back onto the unit sphere, in place.
   *
   * Needed because the incoming rotations are not unit quaternions: the server
   * normalizes and then quantizes to 3 decimals, and quantization is the last
   * step, so what arrives is off the sphere by up to ~8e-5. SLERP does not
   * repair that — with non-unit inputs the dot product is not cos(theta), so
   * the weights are slightly wrong and the blend inherits the error. The lerp
   * shortcut above shortens it further by cutting a chord across the sphere
   * instead of following the arc.
   *
   * A non-unit quaternion handed to the renderer is not a pure rotation; it
   * scales the mesh. The error is small enough not to be obvious, but this is
   * a few flops per coin per frame and it makes the value well-formed rather
   * than nearly well-formed.
   *
   * This is fixed here rather than server-side on purpose: the server cannot
   * both quantize for bandwidth and promise unit length, and the client is
   * where the value is finally used as a rotation.
   */
  private normalizeInPlace(q: [number, number, number, number]): void {
    const lenSq = q[0] * q[0] + q[1] * q[1] + q[2] * q[2] + q[3] * q[3];
    if (lenSq === 0) {
      // Degenerate input — fall back to identity rather than emitting NaN.
      q[0] = 0;
      q[1] = 0;
      q[2] = 0;
      q[3] = 1;
      return;
    }
    const inv = 1 / Math.sqrt(lenSq);
    q[0] *= inv;
    q[1] *= inv;
    q[2] *= inv;
    q[3] *= inv;
  }
}
