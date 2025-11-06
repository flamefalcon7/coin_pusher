import {
  Scene,
  MeshBuilder,
  StandardMaterial,
  Color3,
  Vector3,
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

    // Back wall
    const {
      WIDTH: BACK_WIDTH,
      HEIGHT: BACK_HEIGHT,
      THICKNESS: BACK_THICKNESS,
      POSITION: BACK_POS,
    } = SCENE_CONFIG.BACK_WALL;
    const backWall = MeshBuilder.CreateBox(
      "backWall",
      { width: BACK_WIDTH, height: BACK_HEIGHT, depth: BACK_THICKNESS },
      this.scene
    );
    backWall.position = new Vector3(BACK_POS.x, BACK_POS.y, BACK_POS.z);
    backWall.material = wallMat;

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
}
