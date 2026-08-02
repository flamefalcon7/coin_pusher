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

    // Create kinematic rigid body
    const bodyDesc =
      RAPIER.RigidBodyDesc.kinematicVelocityBased().setTranslation(
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

    // Position (synced to client)
    this.currentZ =
      this.amplitude * Math.sin(phase) + this.zOffset;

    // Velocity (v = dz/dt = A * omega * cos(phase))
    const velocityZ = this.amplitude * this.omega * Math.cos(phase);

    this.rigidBody.setLinvel({ x: 0, y: 0, z: velocityZ }, true);

    // Set position to correct drift
    this.rigidBody.setTranslation(
      {
        x: this.baseX,
        y: this.baseY,
        z: this.baseZ + this.currentZ,
      },
      true
    );
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

    let targetZ: number;
    let velocityZ: number;

    switch (this.spState) {
      case 'pullback': {
        if (elapsed >= PULLBACK_DURATION) {
          this.spStartTime = now;
          this.spState = 'thrust';
          targetZ = PULLBACK_Z;
          velocityZ = 0;
          break;
        }
        const t = elapsed / PULLBACK_DURATION;
        const eased = easeInCubic(t);
        targetZ = this.spStartZ + (PULLBACK_Z - this.spStartZ) * eased;
        // Analytical derivative: dz/dt = (PULLBACK_Z - spStartZ) * 3t^2 / PULLBACK_DURATION
        const range = PULLBACK_Z - this.spStartZ;
        velocityZ = range * 3 * t * t / (PULLBACK_DURATION / 1000);
        break;
      }

      case 'thrust': {
        if (elapsed >= THRUST_DURATION) {
          this.spStartTime = now;
          this.spState = 'hold';
          targetZ = THRUST_Z;
          velocityZ = 0;
          break;
        }
        const t = elapsed / THRUST_DURATION;
        const eased = easeOutExpo(t);
        targetZ = PULLBACK_Z + (THRUST_Z - PULLBACK_Z) * eased;
        // Analytical derivative of easeOutExpo: d/dt = (range * 10 * ln(2) * 2^(-10t)) / duration
        const range = THRUST_Z - PULLBACK_Z;
        const deriv = 10 * Math.LN2 * Math.pow(2, -10 * t);
        velocityZ = range * deriv / (THRUST_DURATION / 1000);
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
          targetZ = THRUST_Z;
          velocityZ = 0;
          break;
        }
        targetZ = THRUST_Z;
        velocityZ = 0;
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
        const eased = easeInOutQuad(t);
        targetZ = THRUST_Z + (this.recoveryTargetZ - THRUST_Z) * eased;
        // Analytical derivative of easeInOutQuad
        const range = this.recoveryTargetZ - THRUST_Z;
        let derivEase: number;
        if (t < 0.5) {
          derivEase = 4 * t;
        } else {
          derivEase = -4 * t + 4;
        }
        velocityZ = range * derivEase / (RECOVERY_DURATION / 1000);
        break;
      }

      default:
        return;
    }

    this.currentZ = targetZ;
    this.rigidBody.setLinvel({ x: 0, y: 0, z: velocityZ }, true);
    this.rigidBody.setTranslation(
      {
        x: this.baseX,
        y: this.baseY,
        z: this.baseZ + this.currentZ,
      },
      true
    );
  }

  getCurrentZ(): number {
    return this.baseZ + this.currentZ;
  }

  getRigidBody(): RAPIER.RigidBody {
    return this.rigidBody;
  }
}
