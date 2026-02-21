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

// ── Spiral spawn animation constants ─────────────────────────────────
const BATCH_THRESHOLD = 10;       // coins added in one frame to trigger animation
const LAYER_STAGGER = 0.08;       // seconds delay between layers (bottom → top)
const ANIM_DURATION = 0.35;       // seconds per coin scale-up + spiral
const SPIRAL_REVOLUTIONS = 1.5;   // full Y-axis turns during scale-up

/** Per-coin animation state for spiral spawn effect. */
interface SpawnAnim {
  delay: number;       // seconds to wait before starting (based on layer)
  elapsed: number;     // seconds elapsed since spawn (including delay)
  targetPos: [number, number, number];
  targetRot: [number, number, number, number];
  centerX: number;     // spiral center X (batch centroid)
  centerZ: number;     // spiral center Z (batch centroid)
}

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

  // ── Spiral spawn animation state ───────────────────────────────────
  private spawnAnims: Map<number, SpawnAnim> = new Map(); // coinId -> anim
  private pendingNewCoins: { id: number; pos: [number, number, number]; rot: [number, number, number, number] }[] = [];

  // Reusable temporary objects to avoid GC per coin per frame
  private static tmpVector = new Vector3();
  private static tmpQuaternion = new Quaternion();
  private static tmpMatrix = new Matrix();
  private static tmpScale = new Vector3(1, 1, 1);
  private static tmpAnimScale = new Vector3();
  private static tmpAnimQuat = new Quaternion();

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
        diameter: RADIUS * 2,
        tessellation: 32,
      },
      this.scene
    );

    // Toon material with thin instances
    const material = createToonMaterial(this.scene, {
      name: "coinMat",
      baseColor: new Color3(0.22, 1.0, 0.08), // Default — overridden by theme
      thinInstances: true,
    });
    this.prototypeMesh.material = material;

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

    // Collect into pending batch — commitNewCoins() decides if animated or instant
    this.pendingNewCoins.push({ id, pos, rot });
  }

  /**
   * Call once per frame AFTER all addCoin() calls for this tick.
   * Detects batch spawns and sets up spiral animation or instant placement.
   */
  commitNewCoins(): void {
    const batch = this.pendingNewCoins;
    if (batch.length === 0) return;
    this.pendingNewCoins = [];

    const isBatch = batch.length >= BATCH_THRESHOLD;

    if (isBatch) {
      // Sort by Y (bottom first) for staggered reveal
      batch.sort((a, b) => a.pos[1] - b.pos[1]);

      // Compute centroid for spiral center
      let cx = 0, cz = 0;
      for (const c of batch) { cx += c.pos[0]; cz += c.pos[2]; }
      cx /= batch.length;
      cz /= batch.length;

      // Assign layers by Y — coins at similar Y share the same layer
      const layerThreshold = COIN_CONFIG.THICKNESS * 1.5;
      let currentLayerY = batch[0].pos[1];
      let layerIndex = 0;

      for (const coin of batch) {
        if (coin.pos[1] > currentLayerY + layerThreshold) {
          layerIndex++;
          currentLayerY = coin.pos[1];
        }

        // Allocate buffer slot
        this.allocateCoin(coin.id, coin.pos, coin.rot);

        // Register animation — start at scale 0
        this.spawnAnims.set(coin.id, {
          delay: layerIndex * LAYER_STAGGER,
          elapsed: 0,
          targetPos: coin.pos,
          targetRot: coin.rot,
          centerX: cx,
          centerZ: cz,
        });

        // Write scale-0 matrix so coin is invisible initially
        const index = this.idToIndex.get(coin.id)!;
        this.writeAnimatedMatrix(index, coin.pos, coin.rot, 0, 0, cx, cz);
      }

      console.log(`🌀 Spiral spawn: ${batch.length} coins, ${layerIndex + 1} layers`);
    } else {
      // Normal instant placement
      for (const coin of batch) {
        this.allocateCoin(coin.id, coin.pos, coin.rot);
      }
    }
  }

  /** Internal: allocate buffer slot for a coin (no animation). */
  private allocateCoin(
    id: number,
    pos: [number, number, number],
    rot: [number, number, number, number]
  ): void {
    if (this.activeCoins >= this.capacity) {
      this.resizeBuffer();
    }

    const index = this.activeCoins;
    this.activeCoins++;

    this.idToIndex.set(id, index);
    this.indexToId[index] = id;

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

    // If animating, update target position but don't write to buffer yet
    const anim = this.spawnAnims.get(id);
    if (anim) {
      anim.targetPos = pos;
      anim.targetRot = rot;
      return;
    }

    // Update transform in buffer
    this.writeMatrixToBuffer(index, pos, rot);
  }

  /**
   * Advance all active spawn animations. Call once per frame with delta time.
   */
  updateAnimations(dt: number): void {
    if (this.spawnAnims.size === 0) return;

    for (const [coinId, anim] of this.spawnAnims) {
      anim.elapsed += dt;

      const index = this.idToIndex.get(coinId);
      if (index === undefined) {
        // Coin was removed during animation
        this.spawnAnims.delete(coinId);
        continue;
      }

      const activeTime = anim.elapsed - anim.delay;

      if (activeTime < 0) {
        // Still waiting — keep at scale 0
        this.writeAnimatedMatrix(index, anim.targetPos, anim.targetRot, 0, 0, anim.centerX, anim.centerZ);
      } else if (activeTime < ANIM_DURATION) {
        // Animating — ease-out scale + spiral rotation
        const t = activeTime / ANIM_DURATION;
        const eased = 1 - Math.pow(1 - t, 3); // cubic ease-out
        this.writeAnimatedMatrix(index, anim.targetPos, anim.targetRot, eased, t, anim.centerX, anim.centerZ);
      } else {
        // Animation complete — write final server position and remove
        this.writeMatrixToBuffer(index, anim.targetPos, anim.targetRot);
        this.spawnAnims.delete(coinId);
      }
    }
  }

  /**
   * Write a matrix with animated scale and spiral Y rotation around a center point.
   * The coin scales from 0→1 while rotating around the batch centroid.
   */
  private writeAnimatedMatrix(
    index: number,
    pos: [number, number, number],
    rot: [number, number, number, number],
    scaleFactor: number,
    t: number,
    centerX: number,
    centerZ: number,
  ): void {
    // Spiral rotation angle (decreases as t→1, so it "settles")
    const spiralAngle = (1 - t) * SPIRAL_REVOLUTIONS * Math.PI * 2;

    // Rotate the coin's offset from center around Y axis
    const dx = pos[0] - centerX;
    const dz = pos[2] - centerZ;
    const cosA = Math.cos(spiralAngle);
    const sinA = Math.sin(spiralAngle);
    const rotX = centerX + dx * cosA - dz * sinA;
    const rotZ = centerZ + dx * sinA + dz * cosA;

    CoinMeshManager.tmpVector.set(rotX, pos[1], rotZ);

    // Combine original rotation with spiral Y rotation
    CoinMeshManager.tmpQuaternion.set(rot[0], rot[1], rot[2], rot[3]);
    Quaternion.FromEulerAnglesToRef(0, spiralAngle, 0, CoinMeshManager.tmpAnimQuat);
    CoinMeshManager.tmpAnimQuat.multiplyInPlace(CoinMeshManager.tmpQuaternion);

    CoinMeshManager.tmpAnimScale.set(scaleFactor, scaleFactor, scaleFactor);

    Matrix.ComposeToRef(
      CoinMeshManager.tmpAnimScale,
      CoinMeshManager.tmpAnimQuat,
      CoinMeshManager.tmpVector,
      CoinMeshManager.tmpMatrix
    );

    CoinMeshManager.tmpMatrix.copyToArray(this.matrixBuffer, index * 16);
  }

  removeCoin(id: number): void {
    const index = this.idToIndex.get(id);
    if (index === undefined) {
      return;
    }

    // Clean up animation state
    this.spawnAnims.delete(id);

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
      this.prototypeMesh.isVisible = false;
      return;
    }

    this.prototypeMesh.isVisible = true;
    // Pass the active portion of the buffer to BabylonJS
    const activeMatrixData = this.matrixBuffer.subarray(0, this.activeCoins * 16);
    this.prototypeMesh.thinInstanceSetBuffer("matrix", activeMatrixData, 16, false);
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
    this.spawnAnims.clear();
    this.pendingNewCoins = [];
    // No need to zero indexToId — entries beyond activeCoins are never read
    this.activeCoins = 0;
    this.updateInstances();
  }
}
