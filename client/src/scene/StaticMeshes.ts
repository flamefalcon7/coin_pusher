import {
  Scene,
  MeshBuilder,
  StandardMaterial,
  Color3,
  Vector3,
  TransformNode,
} from "@babylonjs/core";
import { SCENE_CONFIG } from "@coin-pusher/shared";

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

    // Main platform
    const { WIDTH, DEPTH, THICKNESS, POSITION } = SCENE_CONFIG.PLATFORM;
    const platform = MeshBuilder.CreateBox(
      "platform",
      { width: WIDTH, height: THICKNESS, depth: DEPTH },
      this.scene
    );
    platform.position = new Vector3(POSITION.x, POSITION.y, POSITION.z);
    // No rotation - flat platform
    platform.material = platformMat;

    // Back wall with pins
    this.createBackWallWithPins(wallMat);

    // Side walls
    const {
      THICKNESS: WALL_THICKNESS,
      HEIGHT: WALL_HEIGHT,
      DEPTH: WALL_DEPTH,
      LEFT_POSITION,
      RIGHT_POSITION,
      INNER_TILT_ANGLE,
    } = SCENE_CONFIG.SIDE_WALLS;

    // Left wall
    const leftWall = MeshBuilder.CreateBox(
      "leftWall",
      { width: WALL_THICKNESS, height: WALL_HEIGHT, depth: WALL_DEPTH },
      this.scene
    );
    leftWall.position = new Vector3(
      LEFT_POSITION.x,
      LEFT_POSITION.y,
      LEFT_POSITION.z
    );
    // Inner tilt
    leftWall.rotation.z = -INNER_TILT_ANGLE * (Math.PI / 180);
    leftWall.material = wallMat;

    // Right wall
    const rightWall = MeshBuilder.CreateBox(
      "rightWall",
      { width: WALL_THICKNESS, height: WALL_HEIGHT, depth: WALL_DEPTH },
      this.scene
    );
    rightWall.position = new Vector3(
      RIGHT_POSITION.x,
      RIGHT_POSITION.y,
      RIGHT_POSITION.z
    );
    // Inner tilt
    rightWall.rotation.z = INNER_TILT_ANGLE * (Math.PI / 180);
    rightWall.material = wallMat;

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
      const relativeZ = THICKNESS / 2 + HEIGHT / 2;

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
}
