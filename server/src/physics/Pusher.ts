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

    // 計算相位
    const omega = 2 * Math.PI * PUSHER_CONFIG.FREQUENCY;
    const phase = omega * elapsedTime + PUSHER_CONFIG.INITIAL_PHASE;

    // 計算位置 (用於同步給客戶端)
    this.currentZ =
      PUSHER_CONFIG.AMPLITUDE * Math.sin(phase) + PUSHER_CONFIG.Z_OFFSET;

    // 修改 2: 計算並設定速度 (v = dz/dt = A * omega * cos(phase))
    const velocityZ = PUSHER_CONFIG.AMPLITUDE * omega * Math.cos(phase);

    // 設定剛體速度
    this.rigidBody.setLinvel({ x: 0, y: 0, z: velocityZ }, true);

    // 設定剛體位置 (為了修正飄移，最好還是同時設定位置)
    const { POSITION } = SCENE_CONFIG.PUSHER;
    this.rigidBody.setTranslation(
      {
        x: POSITION.x,
        y: POSITION.y,
        z: POSITION.z + this.currentZ,
      },
      true
    );
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
