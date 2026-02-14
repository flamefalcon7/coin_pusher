import {
  Scene,
  Mesh,
  MeshBuilder,
  StandardMaterial,
  Color3,
  Vector3,
  VertexData,
  TransformNode,
} from "@babylonjs/core";
import { SCENE_CONFIG, SLOT_CONFIG } from "@coin-pusher/shared";

export class StaticMeshes {
  private scene: Scene;

  constructor(scene: Scene) {
    this.scene = scene;
    this.createStaticScene();
  }

  private createStaticScene(): void {
    console.log("🏗️  Building client scene...");

    // Create materials
    const platformMat = this.createPlatformMaterial();
    const wallMat = this.createWallMaterial();

    // Main platform (trapezoid)
    this.createTrapezoidPlatform(platformMat);

    // Back wall with pins
    this.createBackWallWithPins(wallMat);

    // Angled side walls
    this.createAngledSideWalls(wallMat);

    // Drop zone indicator (subtle visual)
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

  private createPlatformMaterial(): StandardMaterial {
    const mat = new StandardMaterial("platformMat", this.scene);
    mat.diffuseColor = new Color3(0.6, 0.6, 0.6);
    mat.specularColor = new Color3(0.2, 0.2, 0.2);
    return mat;
  }

  private createWallMaterial(): StandardMaterial {
    const mat = new StandardMaterial("wallMat", this.scene);
    mat.diffuseColor = new Color3(0.5, 0.5, 0.6);
    mat.specularColor = new Color3(0.1, 0.1, 0.1);
    return mat;
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

  private createTrapezoidPlatform(material: StandardMaterial): void {
    const { WIDTH, DEPTH, FLARE_Z, THICKNESS, POSITION } = SCENE_CONFIG.PLATFORM;
    const hw = WIDTH / 2;
    const fhw = StaticMeshes.getFrontHalfWidth();
    const hd = DEPTH / 2;
    const ht = THICKNESS / 2;
    const flareZLocal = FLARE_Z - POSITION.z; // flare z relative to mesh center

    // Pentagon prism: 6 top vertices + 6 bottom vertices
    // Top view (looking down):
    //   0---1          back edge (width = WIDTH)
    //   |   |
    //   5   2          flare start (same width)
    //  /     \
    // 4-------3        front edge (width = fhw*2)
    const positions = [
      // Top face (y = +ht)
      -hw,  ht, -hd,         // 0: back-left
       hw,  ht, -hd,         // 1: back-right
       hw,  ht,  flareZLocal, // 2: mid-right
       fhw, ht,  hd,         // 3: front-right
      -fhw, ht,  hd,         // 4: front-left
      -hw,  ht,  flareZLocal, // 5: mid-left
      // Bottom face (y = -ht)
      -hw,  -ht, -hd,        // 6
       hw,  -ht, -hd,        // 7
       hw,  -ht,  flareZLocal,// 8
       fhw, -ht,  hd,        // 9
      -fhw, -ht,  hd,        // 10
      -hw,  -ht,  flareZLocal,// 11
    ];

    const indices = [
      // Top face (4 triangles)
      0, 1, 2,   0, 2, 5,   5, 2, 3,   5, 3, 4,
      // Bottom face (4 triangles, wound opposite)
      6, 8, 7,   6, 11, 8,  11, 9, 8,  11, 10, 9,
      // Back side
      0, 7, 1,   0, 6, 7,
      // Right-back side
      1, 7, 8,   1, 8, 2,
      // Right-front side (angled)
      2, 8, 9,   2, 9, 3,
      // Front side
      3, 9, 10,  3, 10, 4,
      // Left-front side (angled)
      4, 10, 11, 4, 11, 5,
      // Left-back side
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

  private createAngledSideWalls(material: StandardMaterial): void {
    const { HEIGHT, THICKNESS, INNER_TILT_ANGLE } = SCENE_CONFIG.SIDE_WALLS;
    const { WIDTH, DEPTH, FLARE_Z, POSITION } = SCENE_CONFIG.PLATFORM;

    const hw = WIDTH / 2;
    const fhw = StaticMeshes.getFrontHalfWidth();
    const backZ = POSITION.z - DEPTH / 2;
    const frontZ = POSITION.z + DEPTH / 2;
    const centerY = SCENE_CONFIG.SIDE_WALLS.LEFT_POSITION.y;
    const tiltRad = INNER_TILT_ANGLE * (Math.PI / 180);

    // Back segments: straight walls from backZ to FLARE_Z
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

    // Front segments: angled outward from FLARE_Z to frontZ
    const flareDepth = frontZ - FLARE_Z;
    const dx = fhw - hw; // outward offset
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

  private createBackWallWithPins(wallMaterial: StandardMaterial): void {
    const {
      WIDTH: BACK_WIDTH,
      HEIGHT: BACK_HEIGHT,
      THICKNESS: BACK_THICKNESS,
      POSITION: BACK_POS,
      TILT_ANGLE,
    } = SCENE_CONFIG.BACK_WALL;

    // Create parent transform node for grouping
    const backWallGroup = new TransformNode("backWallGroup", this.scene);
    backWallGroup.position = new Vector3(BACK_POS.x, BACK_POS.y, BACK_POS.z);

    // Apply 5-degree backward tilt around X-axis
    backWallGroup.rotation.x = TILT_ANGLE * (Math.PI / 180);

    // Create back wall mesh
    const backWall = MeshBuilder.CreateBox(
      "backWall",
      { width: BACK_WIDTH, height: BACK_HEIGHT, depth: BACK_THICKNESS },
      this.scene
    );
    backWall.material = wallMaterial;
    backWall.parent = backWallGroup;

    // Create pins
    this.createPinMeshes(backWallGroup);

    // Create coin slot indicators on back wall
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

    // Create pin material with slightly different color
    const pinMat = new StandardMaterial("pinMat", this.scene);
    pinMat.diffuseColor = new Color3(0.7, 0.7, 0.75);
    pinMat.specularColor = new Color3(0.2, 0.2, 0.2);

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

        // Create cylinder pin
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
        // Rotate 90 degrees around X-axis so pin points perpendicular to wall (along Z-axis)
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

    // Create material for slot indicators
    const slotMat = new StandardMaterial("slotMat", this.scene);
    slotMat.diffuseColor = new Color3(1.0, 0.8, 0.2); // Golden/yellow color
    slotMat.emissiveColor = new Color3(0.3, 0.2, 0.05); // Slight glow
    slotMat.alpha = 0.7; // Semi-transparent

    // Create rectangular slot boxes at each position on the back wall
    SLOT_CONFIG.POSITIONS.forEach((x: number, index: number) => {
      // Create a rectangular box as a slot
      const slot = MeshBuilder.CreateBox(
        `slotIndicator_${index}`,
        {
          width: 0.1, // Width of slot opening
          height: 0.12, // Height of slot opening
          depth: 0.02, // Thin depth (barely protrudes from wall)
        },
        this.scene
      );

      // Position relative to back wall center
      // Y: top of the wall (WALL_HEIGHT/2)
      // Z: just in front of the wall surface
      slot.position = new Vector3(x, WALL_HEIGHT / 2, THICKNESS / 2 + 0.01);

      slot.material = slotMat;
      slot.parent = parentNode;
    });

    console.log(`  ✓ ${SLOT_CONFIG.POSITIONS.length} slot indicators created`);
  }
}
