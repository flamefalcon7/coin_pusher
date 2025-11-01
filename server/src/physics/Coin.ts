import RAPIER from '@dimforge/rapier3d';
import type { PhysicsWorld } from './PhysicsWorld.js';
import { COIN_CONFIG } from '@coin-pusher/shared';

export class Coin {
  private rigidBody: RAPIER.RigidBody;
  private id: number;
  private ccdEnabled: boolean = true;

  constructor(physicsWorld: PhysicsWorld, id: number, x: number, y: number, z: number) {
    const world = physicsWorld.getWorld();
    this.id = id;

    // Create dynamic rigid body at spawn position
    const bodyDesc = RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(x, y, z);

    this.rigidBody = world.createRigidBody(bodyDesc);
    this.rigidBody.enableCcd(true); // Enable CCD on spawn for free-fall

    // Create cylinder collider (coin shape)
    const colliderDesc = RAPIER.ColliderDesc.cylinder(COIN_CONFIG.THICKNESS / 2, COIN_CONFIG.RADIUS)
      .setMass(COIN_CONFIG.MASS)
      .setFriction(COIN_CONFIG.FRICTION)
      .setRestitution(COIN_CONFIG.RESTITUTION);

    world.createCollider(colliderDesc, this.rigidBody);
  }

  update(): void {
    // Check if we should disable CCD
    if (this.ccdEnabled) {
      const linvel = this.rigidBody.linvel();
      const velocity = Math.sqrt(linvel.x ** 2 + linvel.y ** 2 + linvel.z ** 2);
      const position = this.rigidBody.translation();

      // Disable CCD when coin is slow and low (resting on platform)
      if (velocity < COIN_CONFIG.CCD_DISABLE_VELOCITY && position.y < COIN_CONFIG.CCD_DISABLE_HEIGHT) {
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

  getRigidBody(): RAPIER.RigidBody {
    return this.rigidBody;
  }

  shouldDespawn(): boolean {
    const pos = this.getPosition();
    return pos.y < COIN_CONFIG.DESPAWN_Y;
  }
}

