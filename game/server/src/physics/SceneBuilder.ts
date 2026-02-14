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

  /** Compute the platform's front half-width from the flare config. */
  private static getFrontHalfWidth(): number {
    const { WIDTH, DEPTH, FLARE_Z, FLARE_ANGLE, POSITION } = SCENE_CONFIG.PLATFORM;
    const hw = WIDTH / 2;
    const frontZ = POSITION.z + DEPTH / 2; // world z of front edge
    const flareDepth = frontZ - FLARE_Z;   // how far the flare extends
    const flareOffset = Math.tan(FLARE_ANGLE * Math.PI / 180) * flareDepth;
    return hw + flareOffset;
  }

  private createPlatform(): void {
    const { WIDTH, DEPTH, THICKNESS, POSITION, FRICTION, RESTITUTION } =
      SCENE_CONFIG.PLATFORM;

    const bodyDesc = RAPIER.RigidBodyDesc.fixed().setTranslation(
      POSITION.x,
      POSITION.y,
      POSITION.z
    );
    const body = this.world.createRigidBody(bodyDesc);

    const hw = WIDTH / 2;
    const fhw = SceneBuilder.getFrontHalfWidth();
    const hd = DEPTH / 2;
    const ht = THICKNESS / 2;

    // Pentagon prism: back rect + front flare (convex hull = outer trapezoid)
    // Since convex hull ignores the concave midpoint, we use the full trapezoid.
    // The side walls enforce the actual straight-then-angled boundary.
    const vertices = new Float32Array([
      // Top face
      -hw,   ht, -hd,         hw,  ht, -hd,
      -fhw,  ht,  hd,         fhw, ht,  hd,
      // Bottom face
      -hw,  -ht, -hd,         hw, -ht, -hd,
      -fhw, -ht,  hd,         fhw,-ht,  hd,
    ]);

    const colliderDesc = RAPIER.ColliderDesc.convexHull(vertices)!
      .setFriction(FRICTION)
      .setRestitution(RESTITUTION);

    this.world.createCollider(colliderDesc, body);

    console.log(`  ✓ Platform created (back=${WIDTH}m, front=${(fhw * 2).toFixed(1)}m)`);
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
      // Embed pins slightly (0.01) into the wall to prevent gaps where coins can get stuck
      const relativeZ = THICKNESS / 2 + HEIGHT / 2 - 0.01;

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
      HEIGHT,
      THICKNESS,
      INNER_TILT_ANGLE,
      FRICTION,
      RESTITUTION,
    } = SCENE_CONFIG.SIDE_WALLS;

    const { WIDTH, DEPTH, FLARE_Z, POSITION } = SCENE_CONFIG.PLATFORM;
    const hw = WIDTH / 2;
    const fhw = SceneBuilder.getFrontHalfWidth();
    const backZ = POSITION.z - DEPTH / 2; // z=-0.5
    const frontZ = POSITION.z + DEPTH / 2; // z=+0.5
    const centerY = SCENE_CONFIG.SIDE_WALLS.LEFT_POSITION.y;
    const innerTilt = INNER_TILT_ANGLE * (Math.PI / 180);

    // --- Back segments: straight walls from backZ to FLARE_Z ---
    const backDepth = FLARE_Z - backZ;
    const backCenterZ = (backZ + FLARE_Z) / 2;

    // Left back
    this.createWall(
      -hw, centerY, backCenterZ,
      THICKNESS / 2, HEIGHT / 2, backDepth / 2,
      this.quatFromAxisAngle(0, 0, 1, -innerTilt),
      FRICTION, RESTITUTION
    );
    // Right back
    this.createWall(
      hw, centerY, backCenterZ,
      THICKNESS / 2, HEIGHT / 2, backDepth / 2,
      this.quatFromAxisAngle(0, 0, 1, innerTilt),
      FRICTION, RESTITUTION
    );

    // --- Front segments: angled outward from FLARE_Z to frontZ ---
    const flareDepth = frontZ - FLARE_Z;
    const dx = fhw - hw; // outward offset
    const frontLen = Math.sqrt(dx * dx + flareDepth * flareDepth);
    const yAngle = Math.atan2(dx, flareDepth); // outward angle around Y

    const frontCenterZ = (FLARE_Z + frontZ) / 2;
    const frontCenterXOffset = (hw + fhw) / 2;

    // Left front (flares outward = negative X direction)
    const leftFrontQ = this.quatMultiply(
      this.quatFromAxisAngle(0, 1, 0, -yAngle),
      this.quatFromAxisAngle(0, 0, 1, -innerTilt)
    );
    this.createWall(
      -frontCenterXOffset, centerY, frontCenterZ,
      THICKNESS / 2, HEIGHT / 2, frontLen / 2,
      leftFrontQ,
      FRICTION, RESTITUTION
    );

    // Right front (flares outward = positive X direction)
    const rightFrontQ = this.quatMultiply(
      this.quatFromAxisAngle(0, 1, 0, yAngle),
      this.quatFromAxisAngle(0, 0, 1, innerTilt)
    );
    this.createWall(
      frontCenterXOffset, centerY, frontCenterZ,
      THICKNESS / 2, HEIGHT / 2, frontLen / 2,
      rightFrontQ,
      FRICTION, RESTITUTION
    );

    console.log("  ✓ Side walls created (straight back + flared front)");
  }

  private createWall(
    x: number, y: number, z: number,
    hx: number, hy: number, hz: number,
    rotation: { x: number; y: number; z: number; w: number },
    friction: number, restitution: number
  ): void {
    const body = this.world.createRigidBody(
      RAPIER.RigidBodyDesc.fixed().setTranslation(x, y, z).setRotation(rotation)
    );
    const collider = RAPIER.ColliderDesc.cuboid(hx, hy, hz)
      .setFriction(friction)
      .setRestitution(restitution);
    this.world.createCollider(collider, body);
  }

  private quatFromAxisAngle(ax: number, ay: number, az: number, angle: number) {
    const half = angle / 2;
    const s = Math.sin(half);
    return { x: ax * s, y: ay * s, z: az * s, w: Math.cos(half) };
  }

  private quatMultiply(
    a: { x: number; y: number; z: number; w: number },
    b: { x: number; y: number; z: number; w: number }
  ) {
    return {
      x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
      y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
      z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
      w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
    };
  }
}
