import {
  Scene,
  MeshBuilder,
  Color3,
  Vector3,
  Mesh,
} from "@babylonjs/core";
import { CellMaterial } from "@babylonjs/materials/cell/cellMaterial";
import { SCENE_CONFIG } from "@coin-pusher/shared";

export class PusherMesh {
  private mesh: Mesh;

  constructor(scene: Scene) {
    const { WIDTH, HEIGHT, DEPTH, POSITION } = SCENE_CONFIG.PUSHER;

    this.mesh = MeshBuilder.CreateBox(
      "pusher",
      { width: WIDTH, height: HEIGHT, depth: DEPTH },
      scene
    );

    this.mesh.position = new Vector3(POSITION.x, POSITION.y, POSITION.z);

    // CellMaterial — color overridden by theme
    const material = new CellMaterial("pusherMat", scene);
    material.diffuseColor = new Color3(1.0, 0.0, 0.5);
    material.computeHighLevel = true;
    this.mesh.material = material;

    console.log("🔨 Pusher mesh created");
  }

  updatePosition(z: number): void {
    this.mesh.position.z = z;
  }

  getMesh(): Mesh {
    return this.mesh;
  }
}
