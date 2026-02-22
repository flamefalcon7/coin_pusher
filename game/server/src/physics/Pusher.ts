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
  private startTime: number;
  private currentZ: number = 0;

  // Pre-computed constants to avoid recalculating every tick
  private readonly omega: number;
  private readonly amplitude: number;
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

  // Injectable clock (defaults to Date.now for production)
  private getTime: () => number;

  constructor(physicsWorld: PhysicsWorld, getTime?: () => number) {
    const world = physicsWorld.getWorld();
    this.getTime = getTime ?? (() => Date.now());
    this.startTime = this.getTime();

    const { WIDTH, HEIGHT, DEPTH, POSITION, FRICTION, RESTITUTION } =
      SCENE_CONFIG.PUSHER;

    // Cache constants
    this.omega = 2 * Math.PI * PUSHER_CONFIG.FREQUENCY;
    this.amplitude = PUSHER_CONFIG.AMPLITUDE;
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

  update(): void {
    if (this.spState !== 'idle') {
      this.updateSuperPush();
      return;
    }

    const elapsedTime = (this.getTime() - this.startTime) / 1000;

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
    this.spStartTime = this.getTime();
    this.spState = 'pullback';

    console.log("💥 Super push activated!");
  }

  private updateSuperPush(): void {
    const now = this.getTime();
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
          // Pre-compute where the sin wave will be when recovery ends
          const recoveryEndTime = (now + RECOVERY_DURATION - this.startTime) / 1000;
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
          // Resume normal oscillation — the sin wave's startTime was never modified
          this.update();
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
