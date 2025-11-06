import {
  Scene,
  MeshBuilder,
  StandardMaterial,
  Color3,
  Vector3,
  Mesh,
} from "@babylonjs/core";
import { SCENE_CONFIG } from "@coin-pusher/shared";

export class PusherMesh {
  private mesh: Mesh;

  constructor(scene: Scene) {
    const { WIDTH, HEIGHT, DEPTH, POSITION } = SCENE_CONFIG.PUSHER;

    // Create pusher plate
    this.mesh = MeshBuilder.CreateBox(
      "pusher",
      { width: WIDTH, height: HEIGHT, depth: DEPTH },
      scene
    );

    this.mesh.position = new Vector3(POSITION.x, POSITION.y, POSITION.z);

    // Create material
    const material = new StandardMaterial("pusherMat", scene);
    material.diffuseColor = new Color3(0.3, 0.5, 0.8); // Blue-ish
    material.specularColor = new Color3(0.5, 0.5, 0.5);
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
