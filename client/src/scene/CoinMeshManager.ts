import {
  Scene,
  MeshBuilder,
  StandardMaterial,
  Color3,
  Vector3,
  Quaternion,
  Mesh,
  Matrix,
} from '@babylonjs/core';

export class CoinMeshManager {
  private scene: Scene;
  private prototypeMesh!: Mesh;
  private coinInstances: Map<number, { matrixIndex: number }> = new Map();
  private matrices: Matrix[] = [];
  private nextMatrixIndex: number = 0;

  constructor(scene: Scene) {
    this.scene = scene;
    this.createPrototype();
  }

  private createPrototype(): void {
    // Create coin cylinder: radius 0.02m, thickness 0.009m
    this.prototypeMesh = MeshBuilder.CreateCylinder(
      'coinPrototype',
      {
        height: 0.009,
        diameter: 0.04, // radius * 2
        tessellation: 32,
      },
      this.scene
    );

    // Create gold-like material
    const material = new StandardMaterial('coinMat', this.scene);
    material.diffuseColor = new Color3(1, 0.84, 0); // Gold
    material.specularColor = new Color3(0.8, 0.7, 0.3);
    material.specularPower = 64;
    this.prototypeMesh.material = material;

    // Rotate 90 degrees to align with physics (cylinder defaults to Y-up)
    this.prototypeMesh.rotation.x = Math.PI / 2;

    // Enable thin instances
    this.prototypeMesh.thinInstanceEnablePicking = false;

    console.log('🪙 Coin prototype created');
  }

  addCoin(id: number, pos: [number, number, number], rot: [number, number, number, number]): void {
    if (this.coinInstances.has(id)) {
      console.warn(`Coin ${id} already exists`);
      return;
    }

    const matrixIndex = this.nextMatrixIndex++;

    // Create transformation matrix
    const matrix = this.createTransformMatrix(pos, rot);
    
    if (matrixIndex < this.matrices.length) {
      this.matrices[matrixIndex] = matrix;
    } else {
      this.matrices.push(matrix);
    }

    this.coinInstances.set(id, { matrixIndex });

    // Update thin instances
    this.updateInstances();
  }

  updateCoin(id: number, pos: [number, number, number], rot: [number, number, number, number]): void {
    const instance = this.coinInstances.get(id);
    if (!instance) {
      // Coin doesn't exist yet, add it
      this.addCoin(id, pos, rot);
      return;
    }

    // Update matrix
    const matrix = this.createTransformMatrix(pos, rot);
    this.matrices[instance.matrixIndex] = matrix;

    // Update thin instances
    this.updateInstances();
  }

  removeCoin(id: number): void {
    const instance = this.coinInstances.get(id);
    if (!instance) {
      return;
    }

    // Mark matrix as unused by setting it far away (optimization)
    this.matrices[instance.matrixIndex] = Matrix.Translation(0, -100, 0);
    this.coinInstances.delete(id);

    // Update thin instances
    this.updateInstances();
  }

  private createTransformMatrix(
    pos: [number, number, number],
    rot: [number, number, number, number]
  ): Matrix {
    const position = new Vector3(pos[0], pos[1], pos[2]);
    const quaternion = new Quaternion(rot[0], rot[1], rot[2], rot[3]);

    // Combine rotation and translation
    return Matrix.Compose(
      Vector3.One(), // scale
      quaternion,
      position
    );
  }

  private updateInstances(): void {
    if (this.matrices.length === 0) {
      this.prototypeMesh.thinInstanceSetBuffer('matrix', null);
      return;
    }

    // Convert matrices to Float32Array
    const matrixData = new Float32Array(this.matrices.length * 16);
    this.matrices.forEach((matrix, index) => {
      matrix.copyToArray(matrixData, index * 16);
    });

    this.prototypeMesh.thinInstanceSetBuffer('matrix', matrixData, 16);
  }

  getCoinCount(): number {
    return this.coinInstances.size;
  }

  clear(): void {
    this.coinInstances.clear();
    this.matrices = [];
    this.nextMatrixIndex = 0;
    this.updateInstances();
  }
}

