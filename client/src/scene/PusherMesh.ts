import {
  Scene,
  MeshBuilder,
  StandardMaterial,
  Color3,
  Vector3,
  Mesh,
} from "@babylonjs/core";

export class PusherMesh {
  private mesh: Mesh;

  constructor(scene: Scene) {
    // Create pusher plate: 1.1m × 0.05m × 0.7m
    this.mesh = MeshBuilder.CreateBox(
      "pusher",
      { width: 1.1, height: 0.05, depth: 0.7 },
      scene
    );

    this.mesh.position = new Vector3(0, 0.3, 0);

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
