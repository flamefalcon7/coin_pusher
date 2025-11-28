import * as RAPIER from "@dimforge/rapier3d-compat";
import type { PhysicsWorld } from "./PhysicsWorld.js";
import { SCENE_CONFIG } from "@coin-pusher/shared";

export class SceneBuilder {
  private world: RAPIER.World;
  private physicsWorld: PhysicsWorld;

  constructor(physicsWorld: PhysicsWorld) {
    this.physicsWorld = physicsWorld;
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
    const { WIDTH, DEPTH, THICKNESS, POSITION, FRICTION, RESTITUTION } =
      SCENE_CONFIG.PLATFORM;
    // Create rigid body descriptor (no rotation - flat platform)
    const bodyDesc = RAPIER.RigidBodyDesc.fixed().setTranslation(
      POSITION.x,
      POSITION.y,
      POSITION.z
    );

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
    const {
      WIDTH,
      HEIGHT,
      THICKNESS,
      POSITION,
      TILT_ANGLE,
      FRICTION,
      RESTITUTION,
    } = SCENE_CONFIG.BACK_WALL;

    // Convert tilt angle to radians (backward tilt around X-axis)
    const tiltAngleRad = TILT_ANGLE * (Math.PI / 180);

    // Create single rigid body with 5-degree backward tilt
    // Using quaternion rotation around X-axis
    const cosHalf = Math.cos(tiltAngleRad / 2);
    const sinHalf = Math.sin(tiltAngleRad / 2);

    const bodyDesc = RAPIER.RigidBodyDesc.fixed()
      .setTranslation(POSITION.x, POSITION.y, POSITION.z)
      .setRotation({ x: sinHalf, y: 0, z: 0, w: cosHalf });

    const body = this.world.createRigidBody(bodyDesc);

    // Attach back wall collider
    const wallColliderDesc = RAPIER.ColliderDesc.cuboid(
      WIDTH / 2,
      HEIGHT / 2,
      THICKNESS / 2
    )
      .setFriction(FRICTION)
      .setRestitution(RESTITUTION);

    this.world.createCollider(wallColliderDesc, body);

    // Add pins
    this.createPins(body);

    console.log("  ✓ Back wall with pins created");
  }

  private createPins(parentBody: RAPIER.RigidBody): void {
    const {
      RADIUS,
      HEIGHT,
      ROWS,
      ODD_ROW_COUNT,
      EVEN_ROW_COUNT,
      HORIZONTAL_SPACING,
      VERTICAL_SPACING,
      START_Y,
      Y_OFFSET,
      FRICTION,
      RESTITUTION,
    } = SCENE_CONFIG.PINS;

    const { HEIGHT: WALL_HEIGHT, THICKNESS } = SCENE_CONFIG.BACK_WALL;

    let pinsCreated = 0;

    for (let row = 0; row < ROWS; row++) {
      const isOddRow = row % 2 === 0; // Row 0, 2, 4 are "odd" rows (1st, 3rd, 5th)
      const pinCount = isOddRow ? ODD_ROW_COUNT : EVEN_ROW_COUNT;

      // Calculate starting X position
      const totalWidth = (pinCount - 1) * HORIZONTAL_SPACING;
      const startX = -totalWidth / 2;

      // Calculate Y position relative to back wall center
      // START_Y is offset from bottom of wall, Y_OFFSET for additional adjustment
      const relativeY =
        START_Y + row * VERTICAL_SPACING - WALL_HEIGHT / 2 + Y_OFFSET;

      // Z position: just in front of the back wall (pin height is along Z when rotated)
      const relativeZ = THICKNESS / 2 + HEIGHT / 2;

      for (let col = 0; col < pinCount; col++) {
        const x = startX + col * HORIZONTAL_SPACING;

        // Create cylindrical pin collider perpendicular to back wall
        // Rotate 90 degrees around X-axis so cylinder points along Z-axis (outward from wall)
        const pinRotation = { x: Math.SQRT1_2, y: 0, z: 0, w: Math.SQRT1_2 }; // 90 degrees = sqrt(0.5) for sin/cos of 45 degrees

        const pinColliderDesc = RAPIER.ColliderDesc.cylinder(HEIGHT / 2, RADIUS)
          .setTranslation(x, relativeY, relativeZ)
          .setRotation(pinRotation)
          .setFriction(FRICTION)
          .setRestitution(RESTITUTION)
          .setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS);

        const collider = this.world.createCollider(pinColliderDesc, parentBody);
        this.physicsWorld.registerPinCollider(collider.handle);
        pinsCreated++;
      }
    }

    console.log(`  ✓ ${pinsCreated} pins created`);
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
