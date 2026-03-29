import * as RAPIER from "@dimforge/rapier3d-compat";
import type { PhysicsWorld } from "./PhysicsWorld.js";
import { COIN_CONFIG } from "@coin-pusher/shared";
import { PHYSICS_PARAMS } from "./config.js";

export class Coin {
  private rigidBody: RAPIER.RigidBody;
  private id: number;
  private ccdEnabled: boolean = false;
  private sleepTimer: number = 0;

  // Pre-computed constants (avoid recomputing every update())
  private static readonly LIN_THRESHOLD_SQ =
    PHYSICS_PARAMS.SLEEP_LINEAR_THRESHOLD ** 2;
  private static readonly ANG_THRESHOLD_SQ =
    PHYSICS_PARAMS.SLEEP_ANGULAR_THRESHOLD ** 2;
  private static readonly CCD_DISABLE_VEL_SQ =
    COIN_CONFIG.CCD_DISABLE_VELOCITY ** 2;

  constructor(
    physicsWorld: PhysicsWorld,
    id: number,
    x: number,
    y: number,
    z: number,
    rotation?: { x: number; y: number; z: number; w: number },
  ) {
    const world = physicsWorld.getWorld();
    this.id = id;

    // Create dynamic rigid body at spawn position
    // Default rotation: 90 degrees around X-axis (coin standing up)
    const finalRotation = rotation || {
      x: Math.SQRT1_2,
      y: 0,
      z: 0,
      w: Math.SQRT1_2,
    };
    const bodyDesc = RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(x, y, z)
      .setRotation(finalRotation)
      .setLinearDamping(4.0)
      .setAngularDamping(5.0);

    this.rigidBody = world.createRigidBody(bodyDesc);
    this.rigidBody.enableCcd(true); // Enable CCD on spawn for free-fall

    // Create chamfered cylinder collider (round cylinder)
    // Use BORDER_RADIUS to create rounded edges for better physics stability
    // Subtract BORDER_RADIUS from dimensions because roundCylinder expands the shape
    const coreHalfHeight =
      COIN_CONFIG.THICKNESS / 2 - COIN_CONFIG.BORDER_RADIUS;
    const coreRadius = COIN_CONFIG.RADIUS - COIN_CONFIG.BORDER_RADIUS;

    const colliderDesc = RAPIER.ColliderDesc.roundCylinder(
      coreHalfHeight,
      coreRadius,
      COIN_CONFIG.BORDER_RADIUS,
    )
      .setMass(COIN_CONFIG.MASS)
      .setFriction(COIN_CONFIG.FRICTION)
      .setRestitution(COIN_CONFIG.RESTITUTION);

    world.createCollider(colliderDesc, this.rigidBody);
  }

  update(): void {
    // Optimization: If body is already sleeping, we don't need to check anything
    if (this.rigidBody.isSleeping()) {
      this.sleepTimer = 0;
      return;
    }

    const linvel = this.rigidBody.linvel();
    const angvel = this.rigidBody.angvel();

    // Calculate velocity squared (avoid sqrt — compare squared values)
    const vSq = linvel.x ** 2 + linvel.y ** 2 + linvel.z ** 2;
    const wSq = angvel.x ** 2 + angvel.y ** 2 + angvel.z ** 2;

    // Sleep check
    if (vSq < Coin.LIN_THRESHOLD_SQ && wSq < Coin.ANG_THRESHOLD_SQ) {
      this.sleepTimer += PHYSICS_PARAMS.DELTA_TIME;
      if (this.sleepTimer >= PHYSICS_PARAMS.SLEEP_TIME_UNTIL_SLEEP) {
        if (PHYSICS_PARAMS.DEBUG_SLEEP) {
          const position = this.rigidBody.translation();
          console.log(
            `💤 Coin ${this.id} sleeping. ` +
              `Lin: ${Math.sqrt(vSq).toFixed(3)}, ` +
              `Ang: ${Math.sqrt(wSq).toFixed(3)}, ` +
              `Y: ${position.y.toFixed(3)}`,
          );
        }
        this.rigidBody.sleep();
        this.sleepTimer = 0;
      }
    } else {
      this.sleepTimer = 0;
    }

    // Only fetch position when CCD is still enabled and we need to check height
    if (this.ccdEnabled && vSq < Coin.CCD_DISABLE_VEL_SQ) {
      const position = this.rigidBody.translation();
      if (position.y < COIN_CONFIG.CCD_DISABLE_HEIGHT) {
        this.rigidBody.enableCcd(false);
        this.ccdEnabled = false;
      }
    }
  }

  getId(): number {
    return this.id;
  }

  getPosition(): { x: number; y: number; z: number } {
    return this.rigidBody.translation();
  }

  getRotation(): { x: number; y: number; z: number; w: number } {
    return this.rigidBody.rotation();
  }

  getLinearVelocity(): { x: number; y: number; z: number } {
    return this.rigidBody.linvel();
  }

  isSleeping(): boolean {
    return this.rigidBody.isSleeping();
  }

  getRigidBody(): RAPIER.RigidBody {
    return this.rigidBody;
  }

  shouldDespawn(): boolean {
    const pos = this.getPosition();
    return pos.y < COIN_CONFIG.DESPAWN_Y;
  }

  destroy(physicsWorld: PhysicsWorld): void {
    const world = physicsWorld.getWorld();
    world.removeRigidBody(this.rigidBody);
    this.rigidBody = null as any;
  }
}
