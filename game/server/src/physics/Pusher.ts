import * as RAPIER from "@dimforge/rapier3d-compat";
import type { PhysicsWorld } from "./PhysicsWorld.js";
import { PUSHER_CONFIG, SCENE_CONFIG, SUPER_PUSH_CONFIG } from "@coin-pusher/shared";

type SuperPushState = 'idle' | 'pullback' | 'thrust' | 'hold' | 'recovery';

// Easing functions
function easeInCubic(t: number): number {
  return t * t * t;
}

function easeOutExpo(t: number): number {
  return t === 1 ? 1 : 1 - Math.pow(2, -10 * t);
}

function easeInOutQuad(t: number): number {
  return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
}

export class Pusher {
  private rigidBody: RAPIER.RigidBody;
  private currentZ: number = 0;

  /**
   * Simulated time in milliseconds, supplied by the caller every update().
   *
   * The pusher used to read Date.now() directly, which put a second clock in
   * the system: coins advance by a fixed dt per tick (simulated time) while the
   * pusher advanced by wall time. Any drift between the two — and a setInterval
   * loop always drifts — silently changed the phase relationship between the
   * pusher and the coins it is pushing, and made the run unreproducible. Time
   * now comes from the tick index, so there is exactly one clock.
   */
  private simTimeMs: number = 0;

  // Pre-computed constants to avoid recalculating every tick
  private readonly omega: number;
  private readonly baseAmplitude: number;
  private readonly maxAmplitude: number;
  private readonly ampCoinMin: number;
  private readonly ampCoinRange: number; // max - min (cached)
  private amplitude: number;
  private readonly initialPhase: number;
  private readonly zOffset: number;
  private readonly baseX: number;
  private readonly baseY: number;
  private readonly baseZ: number;

  // Super push state machine
  private spState: SuperPushState = 'idle';
  private spStartTime: number = 0;
  private spStartZ: number = 0;
  private recoveryTargetZ: number = 0;

  constructor(physicsWorld: PhysicsWorld) {
    const world = physicsWorld.getWorld();

    const { WIDTH, HEIGHT, DEPTH, POSITION, FRICTION, RESTITUTION } =
      SCENE_CONFIG.PUSHER;

    // Cache constants
    this.omega = 2 * Math.PI * PUSHER_CONFIG.FREQUENCY;
    this.baseAmplitude = PUSHER_CONFIG.AMPLITUDE;
    this.maxAmplitude = PUSHER_CONFIG.AMPLITUDE_MAX;
    this.ampCoinMin = PUSHER_CONFIG.AMPLITUDE_COIN_MIN;
    this.ampCoinRange = PUSHER_CONFIG.AMPLITUDE_COIN_MAX - PUSHER_CONFIG.AMPLITUDE_COIN_MIN;
    this.amplitude = this.baseAmplitude;
    this.initialPhase = PUSHER_CONFIG.INITIAL_PHASE;
    this.zOffset = PUSHER_CONFIG.Z_OFFSET;
    this.baseX = POSITION.x;
    this.baseY = POSITION.y;
    this.baseZ = POSITION.z;

    // Position-based kinematic body.
    //
    // The pusher's position is a closed-form function of time, so position is
    // the authoritative quantity and velocity is derived — which is exactly the
    // case Rapier's `kinematicPositionBased` + `setNextKinematicTranslation()`
    // is for. Rapier computes the artificial velocity between the current and
    // next position itself and uses it to resolve contacts with the coins.
    //
    // The previous body was `kinematicVelocityBased` and set BOTH a velocity
    // and an absolute translation each tick. Rapier integrated the velocity on
    // top of the position that had already been written, so the body ended each
    // step a full tick of travel ahead of the analytic value being broadcast to
    // clients. Setting position alone removes the double integration by
    // construction: there is nothing left to integrate.
    const bodyDesc =
      RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(
        POSITION.x,
        POSITION.y,
        POSITION.z
      );

    this.rigidBody = world.createRigidBody(bodyDesc);

    // Create collider
    const colliderDesc = RAPIER.ColliderDesc.cuboid(
      WIDTH / 2,
      HEIGHT / 2,
      DEPTH / 2
    )
      .setFriction(FRICTION)
      .setRestitution(RESTITUTION);

    world.createCollider(colliderDesc, this.rigidBody);

    console.log("🔨 Pusher created");
    console.log(
      `   Amplitude: ${PUSHER_CONFIG.AMPLITUDE}m, Frequency: ${PUSHER_CONFIG.FREQUENCY}Hz`
    );
  }

  /** Update dynamic amplitude based on current coin count. Call before update(). */
  updateAmplitude(coinCount: number): void {
    if (coinCount <= this.ampCoinMin) {
      this.amplitude = this.baseAmplitude;
    } else {
      const t = Math.min((coinCount - this.ampCoinMin) / this.ampCoinRange, 1);
      // smoothstep for gradual transition
      const s = t * t * (3 - 2 * t);
      this.amplitude = this.baseAmplitude + (this.maxAmplitude - this.baseAmplitude) * s;
    }
  }

  /** @param simTimeMs simulated time since start, in milliseconds. */
  update(simTimeMs: number): void {
    this.simTimeMs = simTimeMs;

    if (this.spState !== 'idle') {
      this.updateSuperPush();
      return;
    }

    const elapsedTime = simTimeMs / 1000;
    const phase = this.omega * elapsedTime + this.initialPhase;

    this.setTargetZ(this.amplitude * Math.sin(phase) + this.zOffset);
  }

  /**
   * Commit the pusher's position for the upcoming substep.
   *
   * `currentZ` is what gets broadcast, and it is set from the same value handed
   * to Rapier — so the number clients receive and the number the solver uses
   * cannot diverge.
   */
  private setTargetZ(z: number): void {
    this.currentZ = z;
    this.rigidBody.setNextKinematicTranslation({
      x: this.baseX,
      y: this.baseY,
      z: this.baseZ + z,
    });
  }

  startSuperPush(): void {
    if (this.spState !== 'idle') return;

    this.spStartZ = this.currentZ;
    // Anchored to the last simulated time seen, not the wall clock — this is
    // called from a NATS callback between ticks, and the state machine below
    // measures elapsed time in the same units.
    this.spStartTime = this.simTimeMs;
    this.spState = 'pullback';

    console.log("💥 Super push activated!");
  }

  private updateSuperPush(): void {
    const now = this.simTimeMs;
    const elapsed = now - this.spStartTime;
    const { PULLBACK_Z, THRUST_Z, PULLBACK_DURATION, THRUST_DURATION, HOLD_DURATION, RECOVERY_DURATION } = SUPER_PUSH_CONFIG;

    // Each phase yields a target position only. The hand-derived velocities
    // that used to accompany them are gone: Rapier derives the contact velocity
    // from the position delta between substeps, which is both exact and
    // impossible to get out of step with the position clients are shown.
    let targetZ: number;

    switch (this.spState) {
      case 'pullback': {
        if (elapsed >= PULLBACK_DURATION) {
          this.spStartTime = now;
          this.spState = 'thrust';
          targetZ = PULLBACK_Z;
          break;
        }
        const t = elapsed / PULLBACK_DURATION;
        targetZ = this.spStartZ + (PULLBACK_Z - this.spStartZ) * easeInCubic(t);
        break;
      }

      case 'thrust': {
        if (elapsed >= THRUST_DURATION) {
          this.spStartTime = now;
          this.spState = 'hold';
          targetZ = THRUST_Z;
          break;
        }
        const t = elapsed / THRUST_DURATION;
        targetZ = PULLBACK_Z + (THRUST_Z - PULLBACK_Z) * easeOutExpo(t);
        break;
      }

      case 'hold': {
        if (elapsed >= HOLD_DURATION) {
          this.spStartTime = now;
          this.spState = 'recovery';
          // Pre-compute where the sin wave will be when recovery ends.
          // Simulated time starts at 0, so it is already "elapsed".
          const recoveryEndTime = (now + RECOVERY_DURATION) / 1000;
          const recoveryEndPhase = this.omega * recoveryEndTime + this.initialPhase;
          this.recoveryTargetZ = this.amplitude * Math.sin(recoveryEndPhase) + this.zOffset;
        }
        targetZ = THRUST_Z;
        break;
      }

      case 'recovery': {
        if (elapsed >= RECOVERY_DURATION) {
          this.spState = 'idle';
          // Resume normal oscillation — the sin wave is a pure function of
          // simulated time, so it was never interrupted.
          this.update(now);
          return;
        }
        const t = elapsed / RECOVERY_DURATION;
        targetZ = THRUST_Z + (this.recoveryTargetZ - THRUST_Z) * easeInOutQuad(t);
        break;
      }

      default:
        return;
    }

    this.setTargetZ(targetZ);
  }

  getCurrentZ(): number {
    return this.baseZ + this.currentZ;
  }

  getRigidBody(): RAPIER.RigidBody {
    return this.rigidBody;
  }
}
