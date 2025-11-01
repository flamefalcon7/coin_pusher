import { NETWORK_CONFIG } from '@coin-pusher/shared';
import { StateBuffer } from './StateBuffer';
import { ClockSync } from './ClockSync';

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
  private interpolationDelay: number;

  constructor(stateBuffer: StateBuffer, clockSync: ClockSync) {
    this.stateBuffer = stateBuffer;
    this.clockSync = clockSync;
    this.interpolationDelay = NETWORK_CONFIG.INTERPOLATION_DELAY;
  }

  getInterpolatedState(): InterpolatedState | null {
    // Calculate target time (server time - interpolation delay)
    const serverTime = this.clockSync.getServerTime();
    const targetTime = serverTime - this.interpolationDelay;

    // Get states for interpolation
    const states = this.stateBuffer.getStatesForInterpolation(targetTime);

    if (!states) {
      // Not enough data for interpolation, use latest available state
      const latestState = this.stateBuffer.getStateAtTime(targetTime);
      if (!latestState) return null;

      return {
        coins: latestState.updates.map(update => ({
          id: update.id,
          pos: update.pos,
          rot: update.rot,
        })),
        pusherZ: latestState.pusherZ,
      };
    }

    const { before, after } = states;

    // Calculate interpolation alpha
    const timeDiff = after.serverTime - before.serverTime;
    const alpha = timeDiff > 0 
      ? (targetTime - before.serverTime) / timeDiff 
      : 0;

    // Clamp alpha to [0, 1]
    const clampedAlpha = Math.max(0, Math.min(1, alpha));

    // Interpolate coins
    const coins: InterpolatedCoin[] = [];
    
    for (const afterUpdate of after.updates) {
      const beforeUpdate = before.updates.find(u => u.id === afterUpdate.id);
      
      if (!beforeUpdate) {
        // New coin, just use the after state
        coins.push({
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

      coins.push({ id: afterUpdate.id, pos, rot });
    }

    // Interpolate pusher Z
    const pusherZ = this.lerp(before.pusherZ, after.pusherZ, clampedAlpha);

    return { coins, pusherZ };
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

