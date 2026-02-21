import {
  Scene,
  Mesh,
  MeshBuilder,
  StandardMaterial,
  Color3,
  Vector3,
  VertexData,
  TransformNode,
  Material,
} from "@babylonjs/core";
import { SCENE_CONFIG, SLOT_CONFIG } from "@coin-pusher/shared";
import { DoodleDecorations } from "./DoodleDecorations";
import { SlotMachine } from "./SlotMachine";
import { createToonMat } from "./ToonMaterial";
import { createHoneycombWallMaterial } from "./HoneycombWallMaterial";

export class StaticMeshes {
  private scene: Scene;
  private slotMachine: SlotMachine | null = null;

  constructor(scene: Scene) {
    this.scene = scene;
    this.createStaticScene();
  }

  getSlotMachine(): SlotMachine | null {
    return this.slotMachine;
  }

  private createStaticScene(): void {
    console.log("🏗️  Building client scene...");

    // Toon materials for platform, walls, pins — colors overridden by theme
    const platformMat = createToonMat("platformMat", new Color3(0.12, 0.12, 0.18), this.scene);
    const wallMat = createToonMat("wallMat", new Color3(1.0, 1.0, 1.0), this.scene);
    const rampMat = createToonMat("rampMat", new Color3(0.45, 0.2, 0.1), this.scene);
    rampMat.backFaceCulling = false;

    // Decomposed platform (center rect + flare pieces with depressed ramps)
    this.createDecomposedPlatform(platformMat, rampMat);

    // Back wall with pins
    this.createBackWallWithPins(wallMat);

    // Honeycomb wall material for side walls
    const honeycombWallMat = createHoneycombWallMaterial(
      "honeycombWallMat", new Color3(1.0, 1.0, 1.0), this.scene,
    );

    // Angled side walls
    this.createAngledSideWalls(honeycombWallMat);

    // Doodle decorations (wavy edges + blob corners + starburst frames)
    // Also applies doodle texture to wall meshes
    new DoodleDecorations(this.scene);

    // Slot machine embedded in the front-left side wall (above coin opening)
    this.createEmbeddedSlotMachine();

    // Drop zone indicator (stays StandardMaterial — needs alpha)
    const {
      WIDTH: DROP_WIDTH,
      HEIGHT: DROP_HEIGHT,
      DEPTH: DROP_DEPTH,
      POSITION: DROP_POS,
    } = SCENE_CONFIG.DROP_ZONE;
    const dropZone = MeshBuilder.CreateBox(
      "dropZone",
      { width: DROP_WIDTH, height: DROP_HEIGHT, depth: DROP_DEPTH },
      this.scene
    );
    dropZone.position = new Vector3(DROP_POS.x, DROP_POS.y, DROP_POS.z);
    const dropZoneMat = new StandardMaterial("dropZoneMat", this.scene);
    dropZoneMat.diffuseColor = new Color3(0.2, 0.3, 0.2);
    dropZoneMat.alpha = 0.3;
    dropZone.material = dropZoneMat;

    console.log("  ✓ Static meshes created");
  }

  /** Compute the platform's front half-width from the flare config. */
  private static getFrontHalfWidth(): number {
    const { WIDTH, DEPTH, FLARE_Z, FLARE_ANGLE, POSITION } = SCENE_CONFIG.PLATFORM;
    const hw = WIDTH / 2;
    const frontZ = POSITION.z + DEPTH / 2;
    const flareDepth = frontZ - FLARE_Z;
    const flareOffset = Math.tan(FLARE_ANGLE * Math.PI / 180) * flareDepth;
    return hw + flareOffset;
  }

  private createDecomposedPlatform(platformMat: Material, rampMat: Material): void {
    const { WIDTH, DEPTH, FLARE_Z, THICKNESS, POSITION } = SCENE_CONFIG.PLATFORM;
    const { DROP } = SCENE_CONFIG.SIDE_RAMP;
    const { FRONT_OPENING_SIZE, FRONT_OPENING_CENTER } = SCENE_CONFIG.SIDE_WALLS;

    const hw = WIDTH / 2;
    const fhw = StaticMeshes.getFrontHalfWidth();
    const hd = DEPTH / 2;
    const ht = THICKNESS / 2;
    const flareZLocal = FLARE_Z - POSITION.z;

    // Flared edge: from (hw, flareZLocal) to (fhw, hd) in x-z
    const dx = fhw - hw;
    const flareLen = hd - flareZLocal;
    const edgeLen = Math.sqrt(dx * dx + flareLen * flareLen);

    // Opening boundary t-values along flared edge
    const tHalf = (FRONT_OPENING_SIZE / 2) / edgeLen;
    const tStart = FRONT_OPENING_CENTER - tHalf;
    const tEnd = FRONT_OPENING_CENTER + tHalf;

    // Opening boundary points (positive x, use ± for left/right)
    const p1x = hw + tStart * dx;
    const p1z = flareZLocal + tStart * flareLen;
    const p2x = hw + tEnd * dx;
    const p2z = flareZLocal + tEnd * flareLen;

    // Parent node
    const group = new TransformNode("platformGroup", this.scene);
    group.position = new Vector3(POSITION.x, POSITION.y, POSITION.z);

    // 1. Central rectangle
    const rect = MeshBuilder.CreateBox("platform_center",
      { width: WIDTH, height: THICKNESS, depth: DEPTH }, this.scene);
    rect.parent = group;
    rect.material = platformMat;

    // 2-3. Left and right flare pieces
    // Left side top-face vertices (CCW from above for correct BabylonJS RH normals)
    const leftBefore: [number, number, number][] = [
      [-hw, ht, flareZLocal],
      [-hw, ht, p1z],
      [-p1x, ht, p1z],
    ];
    const leftRamp: [number, number, number][] = [
      [-hw, ht, p1z],
      [-hw, ht, p2z],
      [-p2x, ht - DROP, p2z],
      [-p1x, ht - DROP, p1z],
    ];
    const leftAfter: [number, number, number][] = [
      [-hw, ht, p2z],
      [-hw, ht, hd],
      [-fhw, ht, hd],
      [-p2x, ht, p2z],
    ];

    // Mirror: negate x + reverse order preserves CCW winding
    const mirror = (v: [number, number, number][]): [number, number, number][] =>
      v.map(([x, y, z]) => [-x, y, z] as [number, number, number]).reverse();

    // Left side
    this.createPrismMesh("platform_L_before", leftBefore, -ht, platformMat, group);
    this.createPrismMesh("platform_L_ramp", leftRamp, -ht, rampMat, group);
    this.createPrismMesh("platform_L_after", leftAfter, -ht, platformMat, group);

    // Right side (mirrored)
    this.createPrismMesh("platform_R_before", mirror(leftBefore), -ht, platformMat, group);
    this.createPrismMesh("platform_R_ramp", mirror(leftRamp), -ht, rampMat, group);
    this.createPrismMesh("platform_R_after", mirror(leftAfter), -ht, platformMat, group);

    // 4. Front lip: wedge at front edge (back flush, front raised)
    const { HEIGHT: LIP_H, DEPTH: LIP_D, BASE: LIP_BASE } = SCENE_CONFIG.FRONT_LIP;
    const lipHd = LIP_D / 2;
    const lipZ = hd - lipHd; // center Z in local space
    // 8 vertices: 4 back (flush) + 4 front (raised), with embedded base
    const lipMesh = this.createPrismMesh("frontLip", [
      [-fhw, ht, -lipHd],
      [ fhw, ht, -lipHd],
      [ fhw, ht + LIP_H, lipHd],
      [-fhw, ht + LIP_H, lipHd],
    ], ht - LIP_BASE, rampMat, group);
    lipMesh.position.z = lipZ;

    console.log("  ✓ Decomposed platform created (center + 6 flare pieces + front lip)");
  }

  /** Create a prism mesh from top-face vertices extruded down to bottomY. */
  private createPrismMesh(
    name: string,
    topVerts: [number, number, number][],
    bottomY: number,
    material: Material,
    parent: TransformNode
  ): Mesh {
    const n = topVerts.length;
    const positions: number[] = [];

    for (const [x, y, z] of topVerts) positions.push(x, y, z);
    for (const [x, , z] of topVerts) positions.push(x, bottomY, z);

    const indices: number[] = [];

    // Top face (fan)
    for (let i = 1; i < n - 1; i++) indices.push(0, i, i + 1);
    // Bottom face (fan, reversed winding)
    for (let i = 1; i < n - 1; i++) indices.push(n, n + i + 1, n + i);
    // Side faces
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      indices.push(i, j + n, j);
      indices.push(i, i + n, j + n);
    }

    const normals: number[] = [];
    VertexData.ComputeNormals(positions, indices, normals);

    const mesh = new Mesh(name, this.scene);
    const vd = new VertexData();
    vd.positions = positions;
    vd.indices = indices;
    vd.normals = normals;
    vd.applyToMesh(mesh);

    mesh.material = material;
    mesh.parent = parent;
    return mesh;
  }

  /**
   * Mount the slot machine on the inner face of the front-left angled wall,
   * sitting just above the platform surface.
   */
  private createEmbeddedSlotMachine(): void {
    const { WIDTH, DEPTH, FLARE_Z, POSITION, THICKNESS: PLAT_THICK } = SCENE_CONFIG.PLATFORM;
    const { THICKNESS, INNER_TILT_ANGLE } = SCENE_CONFIG.SIDE_WALLS;
    const sm_config = SCENE_CONFIG.SLOT_MACHINE;
    const machineScale = 1.5;

    const hw = WIDTH / 2;
    const fhw = StaticMeshes.getFrontHalfWidth();
    const frontZ = POSITION.z + DEPTH / 2;
    const flareDepth = frontZ - FLARE_Z;
    const dx = fhw - hw;

    // Front-left wall center position and angles
    const frontCenterZ = (FLARE_Z + frontZ) / 2;
    const frontCenterXOff = (hw + fhw) / 2;
    const yAngle = Math.atan2(dx, flareDepth);
    const tiltRad = INNER_TILT_ANGLE * (Math.PI / 180);

    // Parent node matching the front-left wall's position & rotation
    const wallParent = new TransformNode("slotMachineWallMount", this.scene);
    wallParent.position = new Vector3(-frontCenterXOff, 0, frontCenterZ);
    wallParent.rotation.y = -yAngle;
    wallParent.rotation.z = -tiltRad;

    // Y: sit just above platform surface
    const platformSurfaceY = POSITION.y + PLAT_THICK / 2;
    const machineY = platformSurfaceY + (sm_config.HEIGHT / 2) * machineScale;

    // Z: centered along wall
    const machineZ = 0;

    const machinePos = new Vector3(
      THICKNESS / 2 + 0.01, // flush against inner wall face
      machineY,
      machineZ,
    );

    this.slotMachine = new SlotMachine(this.scene, machinePos, wallParent);
    // Rotate so front (+Z) faces the wall's inner normal (+X)
    this.slotMachine.getGroup().rotation.y = Math.PI / 2;
    this.slotMachine.getGroup().scaling.setAll(machineScale);

    console.log("  ✓ Slot machine mounted on front-left wall");
  }

  private createAngledSideWalls(material: Material): void {
    const { HEIGHT, THICKNESS, INNER_TILT_ANGLE } = SCENE_CONFIG.SIDE_WALLS;
    const { WIDTH, DEPTH, FLARE_Z, POSITION } = SCENE_CONFIG.PLATFORM;

    const hw = WIDTH / 2;
    const fhw = StaticMeshes.getFrontHalfWidth();
    const backZ = POSITION.z - DEPTH / 2;
    const frontZ = POSITION.z + DEPTH / 2;
    const centerY = SCENE_CONFIG.SIDE_WALLS.LEFT_POSITION.y;
    const tiltRad = INNER_TILT_ANGLE * (Math.PI / 180);

    const backDepth = FLARE_Z - backZ;
    const backCenterZ = (backZ + FLARE_Z) / 2;

    const leftBack = MeshBuilder.CreateBox("leftWallBack",
      { width: THICKNESS, height: HEIGHT, depth: backDepth }, this.scene);
    leftBack.position = new Vector3(-hw, centerY, backCenterZ);
    leftBack.rotation.z = -tiltRad;
    leftBack.material = material;

    const rightBack = MeshBuilder.CreateBox("rightWallBack",
      { width: THICKNESS, height: HEIGHT, depth: backDepth }, this.scene);
    rightBack.position = new Vector3(hw, centerY, backCenterZ);
    rightBack.rotation.z = tiltRad;
    rightBack.material = material;

    const flareDepth = frontZ - FLARE_Z;
    const dx = fhw - hw;
    const frontLen = Math.sqrt(dx * dx + flareDepth * flareDepth);
    const yAngle = Math.atan2(dx, flareDepth);

    const frontCenterZ = (FLARE_Z + frontZ) / 2;
    const frontCenterXOff = (hw + fhw) / 2;

    // Left front wall with square opening
    this.createWallMeshWithOpening(
      "leftWallFront", material,
      -frontCenterXOff, centerY, frontCenterZ,
      THICKNESS, HEIGHT, frontLen,
      -yAngle, -tiltRad
    );

    // Right front wall with square opening
    this.createWallMeshWithOpening(
      "rightWallFront", material,
      frontCenterXOff, centerY, frontCenterZ,
      THICKNESS, HEIGHT, frontLen,
      yAngle, tiltRad
    );
  }

  /** Create a wall mesh with a square hole using a parent node + 4 child boxes. */
  private createWallMeshWithOpening(
    name: string, material: Material,
    x: number, y: number, z: number,
    width: number, height: number, depth: number,
    yRot: number, zRot: number
  ): void {
    const { FRONT_OPENING_SIZE, FRONT_OPENING_CENTER, FRONT_OPENING_Y } =
      SCENE_CONFIG.SIDE_WALLS;
    const hs = FRONT_OPENING_SIZE / 2;
    const hh = height / 2;
    const hl = depth / 2;
    const holeLocalY = FRONT_OPENING_Y - y;
    const holeLocalZ = (FRONT_OPENING_CENTER - 0.5) * depth;

    const parent = new TransformNode(name, this.scene);
    parent.position = new Vector3(x, y, z);
    parent.rotation.y = yRot;
    parent.rotation.z = zRot;

    const makeBox = (n: string, w: number, h: number, d: number,
      lx: number, ly: number, lz: number) => {
      if (h <= 0 || d <= 0) return;
      const box = MeshBuilder.CreateBox(n, { width: w, height: h, depth: d }, this.scene);
      box.position = new Vector3(lx, ly, lz);
      box.material = material;
      box.parent = parent;
    };

    // Bottom strip (full length, below hole)
    const bottomH = (holeLocalY - hs) + hh;
    makeBox(`${name}_bottom`, width, bottomH, depth,
      0, -hh + bottomH / 2, 0);

    // Top strip (full length, above hole)
    const topH = hh - (holeLocalY + hs);
    makeBox(`${name}_top`, width, topH, depth,
      0, hh - topH / 2, 0);

    // Left strip (hole height, before hole along Z)
    const leftLen = (holeLocalZ - hs) + hl;
    makeBox(`${name}_left`, width, FRONT_OPENING_SIZE, leftLen,
      0, holeLocalY, -hl + leftLen / 2);

    // Right strip (hole height, after hole along Z)
    const rightLen = hl - (holeLocalZ + hs);
    makeBox(`${name}_right`, width, FRONT_OPENING_SIZE, rightLen,
      0, holeLocalY, hl - rightLen / 2);
  }

  private createBackWallWithPins(wallMaterial: Material): void {
    const {
      WIDTH: BACK_WIDTH,
      HEIGHT: BACK_HEIGHT,
      THICKNESS: BACK_THICKNESS,
      POSITION: BACK_POS,
      TILT_ANGLE,
    } = SCENE_CONFIG.BACK_WALL;

    const backWallGroup = new TransformNode("backWallGroup", this.scene);
    backWallGroup.position = new Vector3(BACK_POS.x, BACK_POS.y, BACK_POS.z);
    backWallGroup.rotation.x = TILT_ANGLE * (Math.PI / 180);

    const backWall = MeshBuilder.CreateBox(
      "backWall",
      { width: BACK_WIDTH, height: BACK_HEIGHT, depth: BACK_THICKNESS },
      this.scene
    );
    backWall.material = wallMaterial;
    backWall.parent = backWallGroup;

    this.createPinMeshes(backWallGroup);
    this.createSlotIndicators(backWallGroup);

    console.log("  ✓ Back wall with pins rendered");
  }

  private createPinMeshes(parentNode: TransformNode): void {
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
    } = SCENE_CONFIG.PINS;

    const { HEIGHT: WALL_HEIGHT, THICKNESS } = SCENE_CONFIG.BACK_WALL;

    const pinMat = createToonMat("pinMat", new Color3(0.7, 0.7, 0.85), this.scene);

    let pinsCreated = 0;

    for (let row = 0; row < ROWS; row++) {
      const isOddRow = row % 2 === 0;
      const pinCount = isOddRow ? ODD_ROW_COUNT : EVEN_ROW_COUNT;

      const totalWidth = (pinCount - 1) * HORIZONTAL_SPACING;
      const startX = -totalWidth / 2;

      const relativeY =
        START_Y + row * VERTICAL_SPACING - WALL_HEIGHT / 2 + Y_OFFSET;

      const relativeZ = THICKNESS / 2 + HEIGHT / 2 - 0.01;

      for (let col = 0; col < pinCount; col++) {
        const x = startX + col * HORIZONTAL_SPACING;

        const pin = MeshBuilder.CreateCylinder(
          `pin_${row}_${col}`,
          {
            height: HEIGHT,
            diameter: RADIUS * 2,
            tessellation: 16,
          },
          this.scene
        );

        pin.position = new Vector3(x, relativeY, relativeZ);
        pin.rotation.x = Math.PI / 2;
        pin.material = pinMat;
        pin.parent = parentNode;
        pinsCreated++;
      }
    }

    console.log(`  ✓ ${pinsCreated} pin meshes rendered`);
  }

  private createSlotIndicators(parentNode: TransformNode): void {
    const { HEIGHT: WALL_HEIGHT, THICKNESS } = SCENE_CONFIG.BACK_WALL;

    const slotMat = new StandardMaterial("slotMat", this.scene);
    slotMat.diffuseColor = new Color3(1.0, 0.8, 0.2);
    slotMat.emissiveColor = new Color3(0.3, 0.2, 0.05);
    slotMat.alpha = 0.7;

    SLOT_CONFIG.POSITIONS.forEach((x: number, index: number) => {
      const slot = MeshBuilder.CreateBox(
        `slotIndicator_${index}`,
        {
          width: 0.1,
          height: 0.12,
          depth: 0.02,
        },
        this.scene
      );

      slot.position = new Vector3(x, WALL_HEIGHT / 2, THICKNESS / 2 + 0.01);
      slot.material = slotMat;
      slot.parent = parentNode;
    });

    console.log(`  ✓ ${SLOT_CONFIG.POSITIONS.length} slot indicators created`);
  }
}
