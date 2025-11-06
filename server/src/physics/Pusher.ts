import * as RAPIER from "@dimforge/rapier3d-compat";
import type { PhysicsWorld } from "./PhysicsWorld.js";
import { PUSHER_CONFIG, SCENE_CONFIG } from "@coin-pusher/shared";

export class Pusher {
  private rigidBody: RAPIER.RigidBody;
  private startTime: number;
  private currentZ: number = 0;

  constructor(physicsWorld: PhysicsWorld) {
    const world = physicsWorld.getWorld();
    this.startTime = Date.now();

    const { WIDTH, HEIGHT, DEPTH, POSITION, FRICTION, RESTITUTION } =
      SCENE_CONFIG.PUSHER;

    // Create kinematic rigid body
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

  update(): void {
    const elapsedTime = (Date.now() - this.startTime) / 1000; // seconds
    const phase =
      2 * Math.PI * PUSHER_CONFIG.FREQUENCY * elapsedTime +
      PUSHER_CONFIG.INITIAL_PHASE;

    // Calculate new z position using sinusoidal motion
    // currentZ is the offset from POSITION.z
    this.currentZ = PUSHER_CONFIG.AMPLITUDE * Math.sin(phase);

    // Update kinematic body position
    const { POSITION } = SCENE_CONFIG.PUSHER;
    this.rigidBody.setNextKinematicTranslation({
      x: POSITION.x,
      y: POSITION.y,
      z: POSITION.z + this.currentZ, // Add offset to base position
    });
  }

  getCurrentZ(): number {
    // Return absolute z position (base position + offset)
    const { POSITION } = SCENE_CONFIG.PUSHER;
    return POSITION.z + this.currentZ;
  }

  getRigidBody(): RAPIER.RigidBody {
    return this.rigidBody;
  }
}
