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
import { CellMaterial } from "@babylonjs/materials/cell/cellMaterial";
import { SCENE_CONFIG, SLOT_CONFIG } from "@coin-pusher/shared";

function createCellMat(name: string, color: Color3, scene: Scene): CellMaterial {
  const mat = new CellMaterial(name, scene);
  mat.diffuseColor = color;
  mat.computeHighLevel = true;
  return mat;
}

export class StaticMeshes {
  private scene: Scene;

  constructor(scene: Scene) {
    this.scene = scene;
    this.createStaticScene();
  }

  private createStaticScene(): void {
    console.log("🏗️  Building client scene...");

    // CellMaterial for platform, walls, pins — colors overridden by theme
    const platformMat = createCellMat("platformMat", new Color3(0.12, 0.12, 0.18), this.scene);
    const wallMat = createCellMat("wallMat", new Color3(0.12, 0.32, 1.0), this.scene);

    // Main platform (trapezoid)
    this.createTrapezoidPlatform(platformMat);

    // Back wall with pins
    this.createBackWallWithPins(wallMat);

    // Angled side walls
    this.createAngledSideWalls(wallMat);

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

  private createTrapezoidPlatform(material: Material): void {
    const { WIDTH, DEPTH, FLARE_Z, THICKNESS, POSITION } = SCENE_CONFIG.PLATFORM;
    const hw = WIDTH / 2;
    const fhw = StaticMeshes.getFrontHalfWidth();
    const hd = DEPTH / 2;
    const ht = THICKNESS / 2;
    const flareZLocal = FLARE_Z - POSITION.z;

    const positions = [
      -hw,  ht, -hd,
       hw,  ht, -hd,
       hw,  ht,  flareZLocal,
       fhw, ht,  hd,
      -fhw, ht,  hd,
      -hw,  ht,  flareZLocal,
      -hw,  -ht, -hd,
       hw,  -ht, -hd,
       hw,  -ht,  flareZLocal,
       fhw, -ht,  hd,
      -fhw, -ht,  hd,
      -hw,  -ht,  flareZLocal,
    ];

    const indices = [
      0, 1, 2,   0, 2, 5,   5, 2, 3,   5, 3, 4,
      6, 8, 7,   6, 11, 8,  11, 9, 8,  11, 10, 9,
      0, 7, 1,   0, 6, 7,
      1, 7, 8,   1, 8, 2,
      2, 8, 9,   2, 9, 3,
      3, 9, 10,  3, 10, 4,
      4, 10, 11, 4, 11, 5,
      5, 11, 6,  5, 6, 0,
    ];

    const normals: number[] = [];
    VertexData.ComputeNormals(positions, indices, normals);

    const mesh = new Mesh("platform", this.scene);
    const vertexData = new VertexData();
    vertexData.positions = positions;
    vertexData.indices = indices;
    vertexData.normals = normals;
    vertexData.applyToMesh(mesh);

    mesh.position = new Vector3(POSITION.x, POSITION.y, POSITION.z);
    mesh.material = material;
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

    const leftFront = MeshBuilder.CreateBox("leftWallFront",
      { width: THICKNESS, height: HEIGHT, depth: frontLen }, this.scene);
    leftFront.position = new Vector3(-frontCenterXOff, centerY, frontCenterZ);
    leftFront.rotation.y = -yAngle;
    leftFront.rotation.z = -tiltRad;
    leftFront.material = material;

    const rightFront = MeshBuilder.CreateBox("rightWallFront",
      { width: THICKNESS, height: HEIGHT, depth: frontLen }, this.scene);
    rightFront.position = new Vector3(frontCenterXOff, centerY, frontCenterZ);
    rightFront.rotation.y = yAngle;
    rightFront.rotation.z = tiltRad;
    rightFront.material = material;
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

    // CellMaterial for pins
    const pinMat = createCellMat("pinMat", new Color3(0.7, 0.7, 0.85), this.scene);

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
