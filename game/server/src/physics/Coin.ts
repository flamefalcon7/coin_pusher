import * as RAPIER from "@dimforge/rapier3d-compat";
import type { PhysicsWorld } from "./PhysicsWorld.js";
import { COIN_CONFIG } from "@coin-pusher/shared";
import { PHYSICS_PARAMS } from "./config.js";

export class Coin {
  private rigidBody: RAPIER.RigidBody;
  private id: number;
  private ccdEnabled: boolean = false;
  private sleepTimer: number = 0;
  private frozen: boolean = false;
  private freezeTimer: number = 0;

  // Pre-computed constants (avoid recomputing every update())
  private static readonly LIN_THRESHOLD_SQ =
    PHYSICS_PARAMS.SLEEP_LINEAR_THRESHOLD ** 2;
  private static readonly ANG_THRESHOLD_SQ =
    PHYSICS_PARAMS.SLEEP_ANGULAR_THRESHOLD ** 2;
  private static readonly CCD_DISABLE_VEL_SQ =
    COIN_CONFIG.CCD_DISABLE_VELOCITY ** 2;
  private static readonly FREEZE_LIN_SQ =
    PHYSICS_PARAMS.FREEZE_LINEAR_THRESHOLD ** 2;
  private static readonly FREEZE_ANG_SQ =
    PHYSICS_PARAMS.FREEZE_ANGULAR_THRESHOLD ** 2;

  constructor(
    physicsWorld: PhysicsWorld,
    id: number,
    x: number,
    y: number,
    z: number,
    rotation?: { x: number; y: number; z: number; w: number }
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
      .setLinearDamping(5.0)
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
      COIN_CONFIG.BORDER_RADIUS
    )
      .setMass(COIN_CONFIG.MASS)
      .setFriction(COIN_CONFIG.FRICTION)
      .setRestitution(COIN_CONFIG.RESTITUTION);

    world.createCollider(colliderDesc, this.rigidBody);
  }

  update(): void {
    // Frozen coins are Fixed bodies — skip all checks
    if (this.frozen) return;

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
              `Y: ${position.y.toFixed(3)}`
          );
        }
        this.rigidBody.sleep();
        this.sleepTimer = 0;
      }
    } else {
      this.sleepTimer = 0;
    }

    // Freeze timer (accumulates independently of sleep)
    if (vSq < Coin.FREEZE_LIN_SQ && wSq < Coin.FREEZE_ANG_SQ) {
      this.freezeTimer += PHYSICS_PARAMS.DELTA_TIME;
    } else {
      this.freezeTimer = 0;
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

  /** Returns true if the coin has been slow long enough to freeze */
  shouldFreeze(): boolean {
    return !this.frozen && this.freezeTimer >= PHYSICS_PARAMS.FREEZE_TIME;
  }

  /** Convert to Fixed body — zero solver cost, still acts as static obstacle */
  freeze(physicsWorld: PhysicsWorld): void {
    if (this.frozen) return;
    this.rigidBody.setBodyType(RAPIER.RigidBodyType.Fixed, true);
    this.frozen = true;
    this.freezeTimer = 0;
    this.sleepTimer = 0;

    // Enable collision events so we detect when a Dynamic coin hits us
    const collider = this.rigidBody.collider(0);
    collider.setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS);
    physicsWorld.registerFrozenCollider(collider.handle, this.id);
  }

  /** Convert back to Dynamic body — rejoins the solver */
  unfreeze(physicsWorld: PhysicsWorld): void {
    if (!this.frozen) return;
    this.rigidBody.setBodyType(RAPIER.RigidBodyType.Dynamic, true);
    this.frozen = false;
    this.freezeTimer = 0;
    this.sleepTimer = 0;

    // Disable collision events (not needed while dynamic)
    const collider = this.rigidBody.collider(0);
    collider.setActiveEvents(0 as RAPIER.ActiveEvents);
    physicsWorld.unregisterFrozenCollider(collider.handle);

    this.rigidBody.wakeUp();
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

  isSleeping(): boolean {
    return this.rigidBody.isSleeping();
  }

  isFrozen(): boolean {
    return this.frozen;
  }

  getRigidBody(): RAPIER.RigidBody {
    return this.rigidBody;
  }

  shouldDespawn(): boolean {
    const pos = this.getPosition();
    return pos.y < COIN_CONFIG.DESPAWN_Y;
  }

  destroy(physicsWorld: PhysicsWorld): void {
    // Clean up frozen state if needed
    if (this.frozen) {
      const collider = this.rigidBody.collider(0);
      physicsWorld.unregisterFrozenCollider(collider.handle);
    }

    const world = physicsWorld.getWorld();
    world.removeRigidBody(this.rigidBody);
    this.rigidBody = null as any;
  }
}
