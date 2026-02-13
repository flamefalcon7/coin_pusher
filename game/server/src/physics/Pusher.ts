import * as RAPIER from "@dimforge/rapier3d-compat";
import type { PhysicsWorld } from "./PhysicsWorld.js";
import { PUSHER_CONFIG, SCENE_CONFIG } from "@coin-pusher/shared";

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

  constructor(physicsWorld: PhysicsWorld) {
    const world = physicsWorld.getWorld();
    this.startTime = Date.now();

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
    const elapsedTime = (Date.now() - this.startTime) / 1000;

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

  getCurrentZ(): number {
    return this.baseZ + this.currentZ;
  }

  getRigidBody(): RAPIER.RigidBody {
    return this.rigidBody;
  }
}
