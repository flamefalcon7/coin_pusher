import * as RAPIER from "@dimforge/rapier3d-compat";
import type { PhysicsWorld } from "./PhysicsWorld.js";
import { PUSHER_CONFIG } from "@coin-pusher/shared";

export class Pusher {
  private rigidBody: RAPIER.RigidBody;
  private startTime: number;
  private currentZ: number = 0;

  constructor(physicsWorld: PhysicsWorld) {
    const world = physicsWorld.getWorld();
    this.startTime = Date.now();

    // Create kinematic rigid body
    const bodyDesc =
      RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(0, 0.3, 0);

    this.rigidBody = world.createRigidBody(bodyDesc);

    // Create collider: 1.1m × 0.05m × 0.7m
    const colliderDesc = RAPIER.ColliderDesc.cuboid(1.1 / 2, 0.05 / 2, 0.7 / 2)
      .setFriction(0.5)
      .setRestitution(0.1);

    world.createCollider(colliderDesc, this.rigidBody);

    console.log("🔨 Pusher created");
    console.log(
      `   Amplitude: ${PUSHER_CONFIG.AMPLITUDE}m, Frequency: ${PUSHER_CONFIG.FREQUENCY}Hz`
    );
  }

  update(): void {
    const elapsedTime = (Date.now() - this.startTime) / 1000; // seconds
    const phase =
      2 * Math.PI * PUSHER_CONFIG.FREQUENCY * elapsedTime +
      PUSHER_CONFIG.INITIAL_PHASE;

    // Calculate new z position using sinusoidal motion
    this.currentZ = PUSHER_CONFIG.AMPLITUDE * Math.sin(phase);

    // Update kinematic body position
    this.rigidBody.setNextKinematicTranslation({
      x: 0,
      y: 0.3,
      z: this.currentZ,
    });
  }

  getCurrentZ(): number {
    return this.currentZ;
  }

  getRigidBody(): RAPIER.RigidBody {
    return this.rigidBody;
  }
}
