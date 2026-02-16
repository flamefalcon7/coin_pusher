import {
  Scene,
  MeshBuilder,
  Color3,
  Vector3,
  Quaternion,
  Mesh,
  Matrix,
} from "@babylonjs/core";
import { COIN_CONFIG } from "@coin-pusher/shared";
import { createToonMaterial } from "./ToonMaterial";

export class CoinMeshManager {
  private scene: Scene;
  private prototypeMesh!: Mesh;

  // Optimized storage: pre-allocated buffer for instance matrices
  // 16 floats per instance (4x4 matrix)
  private matrixBuffer: Float32Array;
  private activeCoins: number = 0;
  private capacity: number = 2000;

  // Maps for swap-and-pop management
  // coinId -> buffer index
  private idToIndex: Map<number, number> = new Map();
  // buffer index -> coinId (flat array is faster than Map for integer keys)
  private indexToId: Int32Array;

  // Reusable temporary objects to avoid GC per coin per frame
  private static tmpVector = new Vector3();
  private static tmpQuaternion = new Quaternion();
  private static tmpMatrix = new Matrix();
  private static tmpScale = new Vector3(1, 1, 1);

  constructor(scene: Scene) {
    this.scene = scene;
    // Initialize buffers with default capacity
    this.matrixBuffer = new Float32Array(this.capacity * 16);
    this.indexToId = new Int32Array(this.capacity);
    this.createPrototype();
  }

  private createPrototype(): void {
    // Create coin cylinder using shared configuration
    const { RADIUS, THICKNESS } = COIN_CONFIG;
    this.prototypeMesh = MeshBuilder.CreateCylinder(
      "coinPrototype",
      {
        height: THICKNESS,
        diameter: RADIUS * 2, // radius * 2
        tessellation: 32,
      },
      this.scene
    );

    // Toon material with thin instances — richer cartoon gold
    const material = createToonMaterial(this.scene, {
      name: "coinMat",
      baseColor: new Color3(0.22, 1.0, 0.08), // Default — overridden by theme
      thinInstances: true,
    });
    this.prototypeMesh.material = material;

    // No rotation needed - both BabylonJS and Rapier use Y-up for cylinders

    // Enable thin instances
    this.prototypeMesh.thinInstanceEnablePicking = false;

    console.log("🪙 Coin prototype created");
  }

  addCoin(
    id: number,
    pos: [number, number, number],
    rot: [number, number, number, number]
  ): void {
    if (this.idToIndex.has(id)) {
      console.warn(`Coin ${id} already exists`);
      return;
    }

    // Resize buffer if full
    if (this.activeCoins >= this.capacity) {
      this.resizeBuffer();
    }

    // Assign new index at the end
    const index = this.activeCoins;
    this.activeCoins++;

    // Update mappings
    this.idToIndex.set(id, index);
    this.indexToId[index] = id;

    // Write transform to buffer
    this.writeMatrixToBuffer(index, pos, rot);
  }

  updateCoin(
    id: number,
    pos: [number, number, number],
    rot: [number, number, number, number]
  ): void {
    const index = this.idToIndex.get(id);
    if (index === undefined) {
      // Coin doesn't exist yet, add it
      this.addCoin(id, pos, rot);
      return;
    }

    // Update transform in buffer
    this.writeMatrixToBuffer(index, pos, rot);
  }

  removeCoin(id: number): void {
    const index = this.idToIndex.get(id);
    if (index === undefined) {
      return;
    }

    // Swap-and-pop: replace this coin with the last active coin
    // to keep the array dense and avoid gaps.
    const lastIndex = this.activeCoins - 1;

    if (index !== lastIndex) {
      // If we're not removing the last coin, move the last coin to this slot
      const lastCoinId = this.indexToId[lastIndex];

      // Copy matrix data: from lastIndex to index
      // copyWithin(targetStart, sourceStart, sourceEnd)
      this.matrixBuffer.copyWithin(
        index * 16,
        lastIndex * 16,
        (lastIndex + 1) * 16
      );

      // Update mappings for the moved coin
      this.idToIndex.set(lastCoinId, index);
      this.indexToId[index] = lastCoinId;
    }

    // Remove the deleted coin from id map
    this.idToIndex.delete(id);

    this.activeCoins--;
  }

  public updateInstances(): void {
    if (this.activeCoins === 0) {
      this.prototypeMesh.thinInstanceSetBuffer("matrix", null);
      return;
    }

    // Pass the active portion of the buffer to BabylonJS
    // Using subarray is efficient (creates a view, copies nothing)
    const activeData = this.matrixBuffer.subarray(0, this.activeCoins * 16);

    // Update the thin instance buffer
    // 16 floats per instance, 4th arg false = don't instantiate new buffer if possible (static optimization)
    this.prototypeMesh.thinInstanceSetBuffer("matrix", activeData, 16, false);
  }

  private writeMatrixToBuffer(
    index: number,
    pos: [number, number, number],
    rot: [number, number, number, number]
  ): void {
    // Update temporary objects (reuse to avoid GC)
    CoinMeshManager.tmpVector.set(pos[0], pos[1], pos[2]);
    CoinMeshManager.tmpQuaternion.set(rot[0], rot[1], rot[2], rot[3]);

    // Compose matrix directly into reusable temporary matrix
    Matrix.ComposeToRef(
      CoinMeshManager.tmpScale,
      CoinMeshManager.tmpQuaternion,
      CoinMeshManager.tmpVector,
      CoinMeshManager.tmpMatrix
    );

    // Copy to the Float32Array buffer at the correct offset
    CoinMeshManager.tmpMatrix.copyToArray(this.matrixBuffer, index * 16);
  }

  private resizeBuffer(): void {
    const newCapacity = this.capacity * 2;
    console.log(
      `📈 Resizing coin buffer: ${this.capacity} -> ${newCapacity} coins`
    );

    const newMatrixBuffer = new Float32Array(newCapacity * 16);
    newMatrixBuffer.set(this.matrixBuffer);
    this.matrixBuffer = newMatrixBuffer;

    const newIndexToId = new Int32Array(newCapacity);
    newIndexToId.set(this.indexToId);
    this.indexToId = newIndexToId;

    this.capacity = newCapacity;
  }

  getCoinCount(): number {
    return this.activeCoins;
  }

  clear(): void {
    this.idToIndex.clear();
    // No need to zero indexToId — entries beyond activeCoins are never read
    this.activeCoins = 0;
    this.updateInstances();
  }
}
