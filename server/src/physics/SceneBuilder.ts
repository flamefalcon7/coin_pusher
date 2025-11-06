import * as RAPIER from "@dimforge/rapier3d-compat";
import type { PhysicsWorld } from "./PhysicsWorld.js";
import { SCENE_CONFIG } from "@coin-pusher/shared";

export class SceneBuilder {
  private world: RAPIER.World;

  constructor(physicsWorld: PhysicsWorld) {
    this.world = physicsWorld.getWorld();
  }

  buildStaticScene(): void {
    console.log("🏗️  Building static scene...");

    // Main platform: 1.2m × 0.8m × 0.05m at (0, 0.25, 0)
    // Slight front tilt (2-3 degrees) to help coin outflow
    this.createPlatform();

    // Back wall at (0, 0.4, -0.4)
    this.createBackWall();

    // Side walls with inner tilt
    this.createSideWalls();

    console.log("✅ Static scene built");
  }

  private createPlatform(): void {
    const {
      WIDTH,
      DEPTH,
      THICKNESS,
      POSITION,
      TILT_ANGLE,
      FRICTION,
      RESTITUTION,
    } = SCENE_CONFIG.PLATFORM;
    const tiltAngle = TILT_ANGLE * (Math.PI / 180);

    // Create rigid body descriptor
    const bodyDesc = RAPIER.RigidBodyDesc.fixed()
      .setTranslation(POSITION.x, POSITION.y, POSITION.z)
      .setRotation({ x: tiltAngle, y: 0, z: 0, w: 1 }); // Tilt forward

    const body = this.world.createRigidBody(bodyDesc);

    // Create collider
    const colliderDesc = RAPIER.ColliderDesc.cuboid(
      WIDTH / 2,
      THICKNESS / 2,
      DEPTH / 2
    )
      .setFriction(FRICTION)
      .setRestitution(RESTITUTION);

    this.world.createCollider(colliderDesc, body);

    console.log("  ✓ Main platform created");
  }

  private createBackWall(): void {
    const { WIDTH, HEIGHT, THICKNESS, POSITION, FRICTION, RESTITUTION } =
      SCENE_CONFIG.BACK_WALL;

    const bodyDesc = RAPIER.RigidBodyDesc.fixed().setTranslation(
      POSITION.x,
      POSITION.y,
      POSITION.z
    );

    const body = this.world.createRigidBody(bodyDesc);

    const colliderDesc = RAPIER.ColliderDesc.cuboid(
      WIDTH / 2,
      HEIGHT / 2,
      THICKNESS / 2
    )
      .setFriction(FRICTION)
      .setRestitution(RESTITUTION);

    this.world.createCollider(colliderDesc, body);

    console.log("  ✓ Back wall created");
  }

  private createSideWalls(): void {
    const {
      DEPTH,
      HEIGHT,
      THICKNESS,
      LEFT_POSITION,
      RIGHT_POSITION,
      INNER_TILT_ANGLE,
      FRICTION,
      RESTITUTION,
    } = SCENE_CONFIG.SIDE_WALLS;
    const innerTiltAngle = INNER_TILT_ANGLE * (Math.PI / 180);

    // Left wall
    const leftBodyDesc = RAPIER.RigidBodyDesc.fixed()
      .setTranslation(LEFT_POSITION.x, LEFT_POSITION.y, LEFT_POSITION.z)
      .setRotation({ x: 0, y: 0, z: -innerTiltAngle, w: 1 }); // Tilt inward

    const leftBody = this.world.createRigidBody(leftBodyDesc);

    const leftColliderDesc = RAPIER.ColliderDesc.cuboid(
      THICKNESS / 2,
      HEIGHT / 2,
      DEPTH / 2
    )
      .setFriction(FRICTION)
      .setRestitution(RESTITUTION);

    this.world.createCollider(leftColliderDesc, leftBody);

    // Right wall
    const rightBodyDesc = RAPIER.RigidBodyDesc.fixed()
      .setTranslation(RIGHT_POSITION.x, RIGHT_POSITION.y, RIGHT_POSITION.z)
      .setRotation({ x: 0, y: 0, z: innerTiltAngle, w: 1 }); // Tilt inward

    const rightBody = this.world.createRigidBody(rightBodyDesc);

    const rightColliderDesc = RAPIER.ColliderDesc.cuboid(
      THICKNESS / 2,
      HEIGHT / 2,
      DEPTH / 2
    )
      .setFriction(FRICTION)
      .setRestitution(RESTITUTION);

    this.world.createCollider(rightColliderDesc, rightBody);

    console.log("  ✓ Side walls created");
  }
}
