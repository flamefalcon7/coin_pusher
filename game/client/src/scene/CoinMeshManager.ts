import {
  Scene,
  MeshBuilder,
  Color3,
  Vector3,
  Quaternion,
  Mesh,
  Matrix,
  DynamicTexture,
  ShaderMaterial,
} from "@babylonjs/core";
import { COIN_CONFIG } from "@coin-pusher/shared";
import { createToonMaterial } from "./ToonMaterial";

const COIN_SYMBOLS = [
  "₿", "Ξ", "Ð", "¤", "◈", "★", "✦", "⚡",
  "☀", "Ψ", "Ω", "♠", "⚜", "◉", "⬡", "⊛",
];

export class CoinMeshManager {
  private scene: Scene;
  private prototypeMesh!: Mesh;

  // Optimized storage: pre-allocated buffer for instance matrices
  // 16 floats per instance (4x4 matrix)
  private matrixBuffer: Float32Array;
  // Per-instance vec2: (symbolIndex, glowFlag)
  private coinDataBuffer: Float32Array;
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
  private singleSymbolTexture!: DynamicTexture;

  constructor(scene: Scene) {
    this.scene = scene;
    // Initialize buffers with default capacity
    this.matrixBuffer = new Float32Array(this.capacity * 16);
    this.coinDataBuffer = new Float32Array(this.capacity * 2);
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
        diameter: RADIUS * 2,
        tessellation: 32,
      },
      this.scene
    );

    // Create textures: atlas for toon shader, single ₿ for standard fallback
    const atlasTexture = this.createCoinAtlas();
    this.singleSymbolTexture = this.createSingleSymbolTexture();

    // Toon material with thin instances
    const material = createToonMaterial(this.scene, {
      name: "coinMat",
      baseColor: new Color3(0.22, 1.0, 0.08), // Default — overridden by theme
      thinInstances: true,
      texture: atlasTexture,
    });
    this.prototypeMesh.material = material;

    this.prototypeMesh.thinInstanceEnablePicking = false;

    console.log("🪙 Coin prototype created (symbol atlas)");
  }

  private createCoinAtlas(): DynamicTexture {
    const size = 1024;
    const cellSize = size / 4;
    const dt = new DynamicTexture("coinAtlas", size, this.scene, true);
    const ctx = dt.getContext() as unknown as CanvasRenderingContext2D;

    ctx.fillStyle = "black";
    ctx.fillRect(0, 0, size, size);

    ctx.fillStyle = "white";
    ctx.font = "bold 160px sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";

    for (let i = 0; i < COIN_SYMBOLS.length; i++) {
      const col = i % 4;
      const row = Math.floor(i / 4);
      const cx = col * cellSize + cellSize / 2;
      const cy = row * cellSize + cellSize / 2;
      ctx.fillText(COIN_SYMBOLS[i], cx, cy);
    }

    dt.update();
    return dt;
  }

  private createSingleSymbolTexture(): DynamicTexture {
    const size = 256;
    const dt = new DynamicTexture("coinSymbol", size, this.scene, true);
    dt.drawText("₿", null, null, "bold 160px sans-serif", "white", "black", true, true);
    return dt;
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

    // Assign random symbol and glow
    const off = index * 2;
    this.coinDataBuffer[off] = Math.floor(Math.random() * 16);
    this.coinDataBuffer[off + 1] = Math.random() < 0.1 ? 1 : 0;
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
      this.matrixBuffer.copyWithin(
        index * 16,
        lastIndex * 16,
        (lastIndex + 1) * 16
      );

      // Copy coinData: from lastIndex to index
      this.coinDataBuffer.copyWithin(
        index * 2,
        lastIndex * 2,
        (lastIndex + 1) * 2
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
      this.prototypeMesh.thinInstanceSetBuffer("coinData", null);
      return;
    }

    // Pass the active portion of the buffer to BabylonJS
    const activeMatrixData = this.matrixBuffer.subarray(0, this.activeCoins * 16);
    this.prototypeMesh.thinInstanceSetBuffer("matrix", activeMatrixData, 16, false);

    const activeCoinData = this.coinDataBuffer.subarray(0, this.activeCoins * 2);
    this.prototypeMesh.thinInstanceSetBuffer("coinData", activeCoinData, 2, false);

    // Update time uniform for glow animation (only on custom ShaderMaterial)
    const mat = this.prototypeMesh.material;
    if (mat instanceof ShaderMaterial) {
      mat.setFloat("time", performance.now() / 1000);
    }
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

    const newCoinDataBuffer = new Float32Array(newCapacity * 2);
    newCoinDataBuffer.set(this.coinDataBuffer);
    this.coinDataBuffer = newCoinDataBuffer;

    const newIndexToId = new Int32Array(newCapacity);
    newIndexToId.set(this.indexToId);
    this.indexToId = newIndexToId;

    this.capacity = newCapacity;
  }

  getCoinTexture(): DynamicTexture {
    return this.singleSymbolTexture;
  }

  getCoinCount(): number {
    return this.activeCoins;
  }

  /** Get world position of a coin by id (reads translation from matrix buffer). */
  getCoinPosition(id: number): [number, number, number] | null {
    const index = this.idToIndex.get(id);
    if (index === undefined) return null;
    const off = index * 16;
    // Translation is at indices 12, 13, 14 of the 4x4 row-major matrix
    return [this.matrixBuffer[off + 12], this.matrixBuffer[off + 13], this.matrixBuffer[off + 14]];
  }

  clear(): void {
    this.idToIndex.clear();
    // No need to zero indexToId — entries beyond activeCoins are never read
    this.activeCoins = 0;
    this.updateInstances();
  }
}
