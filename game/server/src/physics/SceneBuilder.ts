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

    // Decomposed platform: center rect + 6 flare pieces (with depressed ramps) + front lip
    this.createPlatform();

    // Back wall at (0, 0.4, -0.4)
    this.createBackWall();

    // Side walls with inner tilt and front openings
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
    const { DROP, FRICTION: RAMP_FRICTION } = SCENE_CONFIG.SIDE_RAMP;
    const { FRONT_OPENING_SIZE, FRONT_OPENING_CENTER } = SCENE_CONFIG.SIDE_WALLS;

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
    const flareZLocal = SCENE_CONFIG.PLATFORM.FLARE_Z - POSITION.z;

    // 1. Central rectangle collider
    const centerDesc = RAPIER.ColliderDesc.cuboid(hw, ht, hd)
      .setFriction(FRICTION)
      .setRestitution(RESTITUTION);
    this.world.createCollider(centerDesc, body);

    // Flared edge geometry: from (hw, flareZLocal) to (fhw, hd) in x-z
    const dx = fhw - hw;
    const flareLen = hd - flareZLocal;
    const edgeLen = Math.sqrt(dx * dx + flareLen * flareLen);

    // Opening boundary t-values along flared edge
    const tHalf = (FRONT_OPENING_SIZE / 2) / edgeLen;
    const tStart = FRONT_OPENING_CENTER - tHalf;
    const tEnd = FRONT_OPENING_CENTER + tHalf;

    const p1x = hw + tStart * dx;
    const p1z = flareZLocal + tStart * flareLen;
    const p2x = hw + tEnd * dx;
    const p2z = flareZLocal + tEnd * flareLen;

    // Helper: create convex hull collider from top-face vertices extruded to -ht
    const addFlareCollider = (topVerts: [number, number, number][], friction: number) => {
      const verts: number[] = [];
      for (const [x, y, z] of topVerts) verts.push(x, y, z);
      for (const [x, , z] of topVerts) verts.push(x, -ht, z);
      const desc = RAPIER.ColliderDesc.convexHull(new Float32Array(verts));
      if (desc) {
        desc.setFriction(friction).setRestitution(RESTITUTION);
        this.world.createCollider(desc, body);
      }
    };

    // 2. Left flare pieces
    // Before opening (triangle)
    addFlareCollider([
      [-hw, ht, flareZLocal],
      [-hw, ht, p1z],
      [-p1x, ht, p1z],
    ], FRICTION);
    // Ramp (trapezoid, outer edge depressed by DROP)
    addFlareCollider([
      [-hw, ht, p1z],
      [-hw, ht, p2z],
      [-p2x, ht - DROP, p2z],
      [-p1x, ht - DROP, p1z],
    ], RAMP_FRICTION);
    // After opening (trapezoid)
    addFlareCollider([
      [-hw, ht, p2z],
      [-hw, ht, hd],
      [-fhw, ht, hd],
      [-p2x, ht, p2z],
    ], FRICTION);

    // 3. Right flare pieces (mirror: negate x)
    addFlareCollider([
      [hw, ht, flareZLocal],
      [hw, ht, p1z],
      [p1x, ht, p1z],
    ], FRICTION);
    addFlareCollider([
      [hw, ht, p1z],
      [hw, ht, p2z],
      [p2x, ht - DROP, p2z],
      [p1x, ht - DROP, p1z],
    ], RAMP_FRICTION);
    addFlareCollider([
      [hw, ht, p2z],
      [hw, ht, hd],
      [fhw, ht, hd],
      [p2x, ht, p2z],
    ], FRICTION);

    // 4. Front lip: wedge collider (back flush, front raised)
    const { HEIGHT: LIP_H, DEPTH: LIP_D, BASE: LIP_BASE } = SCENE_CONFIG.FRONT_LIP;
    const lipHd = LIP_D / 2;
    const lipZ = hd - lipHd;
    const lipVerts = new Float32Array([
      // Top back edge (flush with platform surface)
      -fhw, ht, lipZ - lipHd,   fhw, ht, lipZ - lipHd,
      // Top front edge (raised)
       fhw, ht + LIP_H, lipZ + lipHd,  -fhw, ht + LIP_H, lipZ + lipHd,
      // Bottom back
      -fhw, ht - LIP_BASE, lipZ - lipHd,   fhw, ht - LIP_BASE, lipZ - lipHd,
      // Bottom front
       fhw, ht - LIP_BASE, lipZ + lipHd,  -fhw, ht - LIP_BASE, lipZ + lipHd,
    ]);
    const lipDesc = RAPIER.ColliderDesc.convexHull(lipVerts);
    if (lipDesc) {
      lipDesc.setFriction(FRICTION).setRestitution(RESTITUTION);
      this.world.createCollider(lipDesc, body);
    }

    console.log(`  ✓ Platform created (decomposed: center + 6 flare + lip, back=${WIDTH}m, front=${(fhw * 2).toFixed(1)}m)`);
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

    const { HEIGHT: WALL_HEIGHT } = SCENE_CONFIG.BACK_WALL;

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

      // Z position: pin rear flush with wall front surface (no gap for coins to slip behind)
      const relativeZ = HEIGHT / 2;

      for (let col = 0; col < pinCount; col++) {
        const x = startX + col * HORIZONTAL_SPACING;

        // Create cylindrical pin collider perpendicular to back wall
        // Rotate 90 degrees around X-axis so cylinder points along Z-axis (outward from wall)
        const pinRotation = { x: Math.SQRT1_2, y: 0, z: 0, w: Math.SQRT1_2 }; // 90 degrees = sqrt(0.5) for sin/cos of 45 degrees

        const pinColliderDesc = RAPIER.ColliderDesc.cylinder(HEIGHT / 2, RADIUS)
          .setTranslation(x, relativeY, relativeZ)
          .setRotation(pinRotation)
          .setFriction(FRICTION)
          .setRestitution(RESTITUTION);

        this.world.createCollider(pinColliderDesc, parentBody);
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
    const frontZ = POSITION.z + DEPTH / 2; // z=+0.7
    const centerY = SCENE_CONFIG.SIDE_WALLS.LEFT_POSITION.y;
    const innerTilt = INNER_TILT_ANGLE * (Math.PI / 180);

    // --- Back segments: straight walls from backZ to FLARE_Z (no openings) ---
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

    // --- Front segments: angled outward with square openings ---
    const flareDepth = frontZ - FLARE_Z;
    const dx = fhw - hw;
    const frontLen = Math.sqrt(dx * dx + flareDepth * flareDepth);
    const yAngle = Math.atan2(dx, flareDepth);

    const frontCenterZ = (FLARE_Z + frontZ) / 2;
    const frontCenterXOffset = (hw + fhw) / 2;

    // Left front with opening
    const leftFrontQ = this.quatMultiply(
      this.quatFromAxisAngle(0, 1, 0, -yAngle),
      this.quatFromAxisAngle(0, 0, 1, -innerTilt)
    );
    this.createWallWithOpening(
      -frontCenterXOffset, centerY, frontCenterZ,
      THICKNESS, HEIGHT, frontLen,
      leftFrontQ, FRICTION, RESTITUTION
    );

    // Right front with opening
    const rightFrontQ = this.quatMultiply(
      this.quatFromAxisAngle(0, 1, 0, yAngle),
      this.quatFromAxisAngle(0, 0, 1, innerTilt)
    );
    this.createWallWithOpening(
      frontCenterXOffset, centerY, frontCenterZ,
      THICKNESS, HEIGHT, frontLen,
      rightFrontQ, FRICTION, RESTITUTION
    );

    console.log("  ✓ Side walls created (straight back + flared front with openings)");
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

  /** Create a wall with a square opening (4 cuboid colliders forming a frame). */
  private createWallWithOpening(
    x: number, y: number, z: number,
    width: number, height: number, depth: number,
    rotation: { x: number; y: number; z: number; w: number },
    friction: number, restitution: number
  ): void {
    const { FRONT_OPENING_SIZE, FRONT_OPENING_CENTER, FRONT_OPENING_Y } =
      SCENE_CONFIG.SIDE_WALLS;
    const hs = FRONT_OPENING_SIZE / 2;
    const hh = height / 2;
    const hl = depth / 2;
    const hw = width / 2;
    const holeLocalY = FRONT_OPENING_Y - y;
    const holeLocalZ = (FRONT_OPENING_CENTER - 0.5) * depth;

    const body = this.world.createRigidBody(
      RAPIER.RigidBodyDesc.fixed().setTranslation(x, y, z).setRotation(rotation)
    );

    const addBox = (hx: number, hy: number, hz: number, lx: number, ly: number, lz: number) => {
      if (hy <= 0 || hz <= 0) return;
      const desc = RAPIER.ColliderDesc.cuboid(hx, hy, hz)
        .setTranslation(lx, ly, lz)
        .setFriction(friction)
        .setRestitution(restitution);
      this.world.createCollider(desc, body);
    };

    // Bottom strip (full length, below hole)
    const bottomH = (holeLocalY - hs) + hh;
    addBox(hw, bottomH / 2, hl, 0, -hh + bottomH / 2, 0);

    // Top strip (full length, above hole)
    const topH = hh - (holeLocalY + hs);
    addBox(hw, topH / 2, hl, 0, hh - topH / 2, 0);

    // Left strip (hole height, before hole along Z)
    const leftLen = (holeLocalZ - hs) + hl;
    addBox(hw, hs, leftLen / 2, 0, holeLocalY, -hl + leftLen / 2);

    // Right strip (hole height, after hole along Z)
    const rightLen = hl - (holeLocalZ + hs);
    addBox(hw, hs, rightLen / 2, 0, holeLocalY, hl - rightLen / 2);
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
