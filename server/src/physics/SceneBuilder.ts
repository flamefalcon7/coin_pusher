import * as RAPIER from "@dimforge/rapier3d-compat";
import type { PhysicsWorld } from "./PhysicsWorld.js";

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
    const width = 1.2;
    const depth = 0.8;
    const thickness = 0.05;
    const tiltAngle = 2.0 * (Math.PI / 180); // 2 degrees

    // Create rigid body descriptor
    const bodyDesc = RAPIER.RigidBodyDesc.fixed()
      .setTranslation(0, 0.25, 0)
      .setRotation({ x: tiltAngle, y: 0, z: 0, w: 1 }); // Tilt forward

    const body = this.world.createRigidBody(bodyDesc);

    // Create collider
    const colliderDesc = RAPIER.ColliderDesc.cuboid(
      width / 2,
      thickness / 2,
      depth / 2
    )
      .setFriction(0.35)
      .setRestitution(0.15);

    this.world.createCollider(colliderDesc, body);

    console.log("  ✓ Main platform created");
  }

  private createBackWall(): void {
    const width = 1.2;
    const height = 0.3;
    const thickness = 0.05;

    const bodyDesc = RAPIER.RigidBodyDesc.fixed().setTranslation(0, 0.4, -0.4);

    const body = this.world.createRigidBody(bodyDesc);

    const colliderDesc = RAPIER.ColliderDesc.cuboid(
      width / 2,
      height / 2,
      thickness / 2
    )
      .setFriction(0.3)
      .setRestitution(0.1);

    this.world.createCollider(colliderDesc, body);

    console.log("  ✓ Back wall created");
  }

  private createSideWalls(): void {
    const depth = 0.8;
    const height = 0.3;
    const thickness = 0.05;
    const innerTiltAngle = 1.5 * (Math.PI / 180); // 1.5 degrees inner tilt

    // Left wall (x = -0.6)
    const leftBodyDesc = RAPIER.RigidBodyDesc.fixed()
      .setTranslation(-0.6, 0.4, 0)
      .setRotation({ x: 0, y: 0, z: -innerTiltAngle, w: 1 }); // Tilt inward

    const leftBody = this.world.createRigidBody(leftBodyDesc);

    const leftColliderDesc = RAPIER.ColliderDesc.cuboid(
      thickness / 2,
      height / 2,
      depth / 2
    )
      .setFriction(0.3)
      .setRestitution(0.1);

    this.world.createCollider(leftColliderDesc, leftBody);

    // Right wall (x = 0.6)
    const rightBodyDesc = RAPIER.RigidBodyDesc.fixed()
      .setTranslation(0.6, 0.4, 0)
      .setRotation({ x: 0, y: 0, z: innerTiltAngle, w: 1 }); // Tilt inward

    const rightBody = this.world.createRigidBody(rightBodyDesc);

    const rightColliderDesc = RAPIER.ColliderDesc.cuboid(
      thickness / 2,
      height / 2,
      depth / 2
    )
      .setFriction(0.3)
      .setRestitution(0.1);

    this.world.createCollider(rightColliderDesc, rightBody);

    console.log("  ✓ Side walls created");
  }
}
