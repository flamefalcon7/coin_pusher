import {
  Scene,
  MeshBuilder,
  Color3,
  Vector3,
  Mesh,
} from "@babylonjs/core";
import { SCENE_CONFIG } from "@coin-pusher/shared";
import { createToonMat } from "./ToonMaterial";

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

    this.mesh.material = createToonMat("pusherMat", new Color3(1.0, 0.0, 0.5), scene);

    console.log("🔨 Pusher mesh created");
  }

  updatePosition(z: number): void {
    this.mesh.position.z = z;
  }

  getMesh(): Mesh {
    return this.mesh;
  }
}
