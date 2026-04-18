import {
  Scene,
  MeshBuilder,
  Color3,
  Vector3,
  Quaternion,
  Mesh,
  Matrix,
  DynamicTexture,
} from "@babylonjs/core";
import { COIN_CONFIG, KEY_COIN_CONFIG, SPONSOR_COIN_CONFIG, RANK_COLORS, RANK_NONE } from "@coin-pusher/shared";
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

  // ── Key coin separate prototype + thin-instance buffers ─────────────
  private keyCoinPrototype!: Mesh;
  private kcBuffer: Float32Array;
  private kcIdToIndex: Map<number, number> = new Map();
  private kcIndexToId: Int32Array;
  private kcActive: number = 0;
  private kcCapacity: number = 200;
  private keyCoinIds: Set<number> = new Set();

  // ── Sponsor coin separate prototypes + thin-instance buffers ────────
  private sponsorPrototypes: Map<string, Mesh> = new Map();
  private sponsorBuffers: Map<string, { matrix: Float32Array; indices: Map<number, number>; indexToId: Int32Array; count: number; capacity: number }> = new Map();
  private coinSponsorLookup: Map<number, string> = new Map(); // coinId -> sponsorId

  // ── Spiral spawn animation state ───────────────────────────────────
  private spawnAnims: Map<number, SpawnAnim> = new Map(); // coinId -> anim
  private pendingNewCoins: { id: number; pos: [number, number, number]; rot: [number, number, number, number]; isKeyCoin?: boolean; sponsorId?: string }[] = [];
  private batchAnimationUntil: number = 0; // timestamp until which batch animation is allowed

  // ── Rank-colored highlight meshes (one per rank + grey) ────────────
  private rankHl: {
    mesh: Mesh;
    buffer: Float32Array;
    idToIndex: Map<number, number>;
    indexToId: Int32Array;
    active: number;
    capacity: number;
    timers: Map<number, number>;
    pending: Set<number>;
  }[] = [];
  private coinToColorIndex: Map<number, number> = new Map(); // coinId -> RANK_COLORS index
  private static readonly HIGHLIGHT_DURATION = 2000; // 2 seconds in ms
  private static readonly RANK_HL_COUNT = RANK_COLORS.length; // 6 (5 ranks + grey)

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
    // Initialize key coin buffers
    this.kcBuffer = new Float32Array(this.kcCapacity * 16);
    this.kcIndexToId = new Int32Array(this.kcCapacity);
    this.createPrototype();
    this.createKeyCoinPrototype();
    this.createRankHighlightPrototypes();
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

    console.log("Coin prototype created");
  }

  private createKeyCoinPrototype(): void {
    const { RADIUS, THICKNESS } = KEY_COIN_CONFIG;
    this.keyCoinPrototype = MeshBuilder.CreateCylinder(
      "keyCoinPrototype",
      {
        height: THICKNESS,
        diameter: RADIUS * 2,
        tessellation: 32,
      },
      this.scene
    );

    const keyCoinTex = this.createKeyCoinTexture();

    const material = createToonMaterial(this.scene, {
      name: "keyCoinMat",
      baseColor: new Color3(0.85, 0.88, 0.92), // silver
      highlightColor: new Color3(1.0, 1.0, 1.0),
      shadowColor: new Color3(0.45, 0.48, 0.55),
      rimColor: new Color3(0.7, 0.85, 1.0), // cool blue-ish rim
      rimPower: 2.0,
      specPower: 64.0,
      thinInstances: true,
      diffuseTexture: keyCoinTex,
    });
    material.setColor3("emissiveColor", new Color3(0.3, 0.4, 0.6));
    this.keyCoinPrototype.material = material;
    this.keyCoinPrototype.thinInstanceEnablePicking = false;
  }

  /** Create a DynamicTexture with a key icon for the key coin face. */
  private createKeyCoinTexture(): DynamicTexture {
    const size = 256;
    const dt = new DynamicTexture("keyCoinTex", size, this.scene, false);
    const ctx = dt.getContext();

    // White background — multiplies as identity with silver base color
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, size, size);

    // Key silhouette in darker blue-grey for engraved look
    const color = "#586890";
    ctx.fillStyle = color;
    ctx.strokeStyle = color;

    const cx = size / 2;
    const cy = size / 2;

    // ── Bow (ring handle) ──
    const bowR = 30;
    const bowY = cy - 22;
    ctx.lineWidth = 10;
    ctx.beginPath();
    ctx.arc(cx, bowY, bowR, 0, Math.PI * 2);
    ctx.stroke();

    // ── Shaft ──
    const sw = 10;
    const shaftTop = bowY + bowR;
    const shaftEnd = cy + 62;
    ctx.fillRect(cx - sw / 2, shaftTop, sw, shaftEnd - shaftTop);

    // ── Teeth (notches on the right) ──
    const th = 8;
    ctx.fillRect(cx + sw / 2, shaftEnd - th * 1.5, 16, th);
    ctx.fillRect(cx + sw / 2, shaftEnd - th * 4, 12, th);

    dt.update();
    return dt;
  }

  private createRankHighlightPrototypes(): void {
    const { RADIUS, THICKNESS } = COIN_CONFIG;
    for (let i = 0; i < CoinMeshManager.RANK_HL_COUNT; i++) {
      const capacity = i === RANK_NONE ? 20 : 10;
      const mesh = MeshBuilder.CreateCylinder(
        `rankHighlight_${i}`,
        {
          height: THICKNESS + 0.001,
          diameter: RADIUS * 2 + 0.001,
          tessellation: 32,
        },
        this.scene
      );
      const material = createToonMaterial(this.scene, {
        name: `rankHighlightMat_${i}`,
        baseColor: Color3.FromHexString(RANK_COLORS[i]),
        thinInstances: true,
      });
      mesh.material = material;
      mesh.thinInstanceEnablePicking = false;

      this.rankHl.push({
        mesh,
        buffer: new Float32Array(capacity * 16),
        idToIndex: new Map(),
        indexToId: new Int32Array(capacity),
        active: 0,
        capacity,
        timers: new Map(),
        pending: new Set(),
      });
    }
  }

  addCoin(
    id: number,
    pos: [number, number, number],
    rot: [number, number, number, number],
    isKeyCoin?: boolean,
    sponsorId?: string
  ): void {
    if (this.idToIndex.has(id) || this.kcIdToIndex.has(id) || this.coinSponsorLookup.has(id)) {
      console.warn(`Coin ${id} already exists`);
      return;
    }

    if (isKeyCoin) {
      this.keyCoinIds.add(id);
    }

    // Collect into pending batch — commitNewCoins() decides if animated or instant
    this.pendingNewCoins.push({ id, pos, rot, isKeyCoin, sponsorId });
  }

  /** Allow batch spiral animation for the next `durationMs` milliseconds. */
  enableBatchAnimation(durationMs: number = 2000): void {
    this.batchAnimationUntil = Date.now() + durationMs;
  }

  /**
   * Call once per frame AFTER all addCoin() calls for this tick.
   * Detects batch spawns and sets up spiral animation or instant placement.
   */
  commitNewCoins(): void {
    const batch = this.pendingNewCoins;
    if (batch.length === 0) return;
    this.pendingNewCoins = [];

    // Separate key coins, sponsor coins, and regular coins for batch handling
    const regularBatch: typeof batch = [];
    const keyCoinBatch: typeof batch = [];
    const sponsorBatch: typeof batch = [];

    for (const coin of batch) {
      if (coin.isKeyCoin) {
        keyCoinBatch.push(coin);
      } else if (coin.sponsorId && this.sponsorPrototypes.has(coin.sponsorId)) {
        sponsorBatch.push(coin);
      } else {
        regularBatch.push(coin);
      }
    }

    // Key coins: always instant placement into key coin buffer
    for (const coin of keyCoinBatch) {
      this.allocateKeyCoin(coin.id, coin.pos, coin.rot);
    }

    // Sponsor coins: instant placement into per-sponsor buffers
    for (const coin of sponsorBatch) {
      this.allocateSponsorCoin(coin.id, coin.pos, coin.rot, coin.sponsorId!);
    }

    // Regular coins: batch animation only during explicit animation window (admin spawn)
    const isBatch = regularBatch.length >= BATCH_THRESHOLD && Date.now() < this.batchAnimationUntil;

    if (isBatch) {
      // Sort by Y (bottom first) for staggered reveal
      regularBatch.sort((a, b) => a.pos[1] - b.pos[1]);

      // Compute centroid for spiral center
      let cx = 0, cz = 0;
      for (const c of regularBatch) { cx += c.pos[0]; cz += c.pos[2]; }
      cx /= regularBatch.length;
      cz /= regularBatch.length;

      // Assign layers by Y — coins at similar Y share the same layer
      const layerThreshold = COIN_CONFIG.THICKNESS * 1.5;
      let currentLayerY = regularBatch[0].pos[1];
      let layerIndex = 0;

      for (const coin of regularBatch) {
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

      console.log(`Spiral spawn: ${regularBatch.length} coins, ${layerIndex + 1} layers`);
    } else {
      // Normal instant placement
      for (const coin of regularBatch) {
        this.allocateCoin(coin.id, coin.pos, coin.rot);
      }
    }

    // Flush deferred highlights for coins that are now allocated
    for (const hl of this.rankHl) {
      if (hl.pending.size === 0) continue;
      for (const coinId of hl.pending) {
        if (this.idToIndex.has(coinId) || this.kcIdToIndex.has(coinId)) {
          hl.pending.delete(coinId);
          const colorIndex = this.coinToColorIndex.get(coinId);
          if (colorIndex !== undefined) {
            // Remove from map so addRankHighlight doesn't early-return
            this.coinToColorIndex.delete(coinId);
            this.addRankHighlight(coinId, colorIndex);
          }
        }
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

  /** Internal: allocate buffer slot for a key coin. */
  private allocateKeyCoin(
    id: number,
    pos: [number, number, number],
    rot: [number, number, number, number]
  ): void {
    if (this.kcActive >= this.kcCapacity) {
      this.resizeKeyCoinBuffer();
    }

    const index = this.kcActive;
    this.kcActive++;

    this.kcIdToIndex.set(id, index);
    this.kcIndexToId[index] = id;

    this.writeMatrixToBuffer2(this.kcBuffer, index, pos, rot);
  }

  updateCoin(
    id: number,
    pos: [number, number, number],
    rot: [number, number, number, number]
  ): void {
    // Check key coin buffer first
    const kcIndex = this.kcIdToIndex.get(id);
    if (kcIndex !== undefined) {
      this.writeMatrixToBuffer2(this.kcBuffer, kcIndex, pos, rot);
      return;
    }

    // Check sponsor coin buffers
    const sponsorId = this.coinSponsorLookup.get(id);
    if (sponsorId) {
      const buf = this.sponsorBuffers.get(sponsorId);
      if (buf) {
        const sIdx = buf.indices.get(id);
        if (sIdx !== undefined) {
          this.writeMatrixToBuffer2(buf.matrix, sIdx, pos, rot);
          return;
        }
      }
    }

    const index = this.idToIndex.get(id);
    if (index === undefined) {
      // Coin doesn't exist yet, add it (as regular coin — key coin status comes from addCoin)
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
    // Check sponsor coin lookup first
    const sponsorId = this.coinSponsorLookup.get(id);
    if (sponsorId) {
      this.removeSponsorCoin(id, sponsorId);
      return;
    }

    // Check if it's a key coin
    if (this.keyCoinIds.has(id)) {
      this.removeKeyCoin(id);
      return;
    }

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

    // Clean up highlight if present
    this.removeRankHighlight(id);
  }

  private removeKeyCoin(id: number): void {
    const index = this.kcIdToIndex.get(id);
    if (index === undefined) return;

    const lastIndex = this.kcActive - 1;

    if (index !== lastIndex) {
      const lastCoinId = this.kcIndexToId[lastIndex];
      this.kcBuffer.copyWithin(index * 16, lastIndex * 16, (lastIndex + 1) * 16);
      this.kcIdToIndex.set(lastCoinId, index);
      this.kcIndexToId[index] = lastCoinId;
    }

    this.kcIdToIndex.delete(id);
    this.keyCoinIds.delete(id);
    this.kcActive--;

    // Clean up highlight if present
    this.removeRankHighlight(id);
  }

  // ── Sponsor Coin Methods ──────────────────────────────────────────────

  createSponsorCoinPrototype(sponsorId: string, brandColor: string, logoUrl: string): void {
    if (this.sponsorPrototypes.has(sponsorId)) return;

    const { RADIUS, THICKNESS } = SPONSOR_COIN_CONFIG;
    const prototype = MeshBuilder.CreateCylinder(
      "sponsorCoin_" + sponsorId,
      {
        height: THICKNESS,
        diameter: RADIUS * 2,
        tessellation: 32,
      },
      this.scene
    );

    const engine = this.scene.getEngine();
    const isMobile = (engine.getRenderWidth() / engine.getRenderHeight()) < 1.0;

    if (isMobile) {
      // On mobile: skip DynamicTexture, use flat brand-color material only
      const mat = createToonMaterial(this.scene, {
        name: "sponsor_" + sponsorId,
        baseColor: Color3.FromHexString(brandColor),
        thinInstances: true,
        useCelShading: true,
      });
      prototype.material = mat;
      prototype.alwaysSelectAsActiveMesh = true;
      prototype.thinInstanceEnablePicking = false;
    } else {
      // Load logo image, create DynamicTexture after load
      const img = new Image();
      img.crossOrigin = "anonymous";

      img.onload = () => {
        const dt = new DynamicTexture("sponsorTex_" + sponsorId, 256, this.scene, false);
        const ctx = dt.getContext();

        // White background
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(0, 0, 256, 256);

        // Draw logo centered
        ctx.drawImage(img, 0, 0, 256, 256);

        dt.update(false);
        dt.hasAlpha = true;

        // Create toon material AFTER DynamicTexture.update()
        const mat = createToonMaterial(this.scene, {
          name: "sponsor_" + sponsorId,
          baseColor: Color3.FromHexString(brandColor),
          diffuseTexture: dt,
          thinInstances: true,
          useCelShading: true,
        });
        prototype.material = mat;
      };

      img.onerror = () => {
        console.warn(`Failed to load sponsor logo: ${logoUrl}`);
        // Fallback: flat brand-color material
        const mat = createToonMaterial(this.scene, {
          name: "sponsor_" + sponsorId,
          baseColor: Color3.FromHexString(brandColor),
          thinInstances: true,
          useCelShading: true,
        });
        prototype.material = mat;
      };

      // Assign a temporary material while image loads
      const tempMat = createToonMaterial(this.scene, {
        name: "sponsor_temp_" + sponsorId,
        baseColor: Color3.FromHexString(brandColor),
        thinInstances: true,
        useCelShading: true,
      });
      prototype.material = tempMat;

      img.src = logoUrl;
    }

    prototype.alwaysSelectAsActiveMesh = true;
    prototype.thinInstanceEnablePicking = false;

    this.sponsorPrototypes.set(sponsorId, prototype);

    // Initialize buffer (capacity 100)
    const capacity = 100;
    this.sponsorBuffers.set(sponsorId, {
      matrix: new Float32Array(capacity * 16),
      indices: new Map(),
      indexToId: new Int32Array(capacity),
      count: 0,
      capacity,
    });
  }

  private allocateSponsorCoin(
    id: number,
    pos: [number, number, number],
    rot: [number, number, number, number],
    sponsorId: string
  ): void {
    const buf = this.sponsorBuffers.get(sponsorId);
    if (!buf) return;

    if (buf.count >= buf.capacity) {
      this.resizeSponsorBuffer(sponsorId);
    }

    const index = buf.count;
    buf.count++;
    buf.indices.set(id, index);
    buf.indexToId[index] = id;
    this.coinSponsorLookup.set(id, sponsorId);

    this.writeMatrixToBuffer2(buf.matrix, index, pos, rot);
  }

  private removeSponsorCoin(id: number, sponsorId: string): void {
    const buf = this.sponsorBuffers.get(sponsorId);
    if (!buf) return;

    const index = buf.indices.get(id);
    if (index === undefined) return;

    const lastIndex = buf.count - 1;

    if (index !== lastIndex) {
      // Swap-and-pop
      const lastCoinId = buf.indexToId[lastIndex];
      buf.matrix.copyWithin(index * 16, lastIndex * 16, (lastIndex + 1) * 16);
      buf.indices.set(lastCoinId, index);
      buf.indexToId[index] = lastCoinId;
    }

    buf.indices.delete(id);
    this.coinSponsorLookup.delete(id);
    buf.count--;

    // Clean up highlight if present
    this.removeRankHighlight(id);
  }

  private resizeSponsorBuffer(sponsorId: string): void {
    const buf = this.sponsorBuffers.get(sponsorId);
    if (!buf) return;

    const newCapacity = buf.capacity * 2;
    const newMatrix = new Float32Array(newCapacity * 16);
    newMatrix.set(buf.matrix);
    buf.matrix = newMatrix;

    const newIndexToId = new Int32Array(newCapacity);
    newIndexToId.set(buf.indexToId);
    buf.indexToId = newIndexToId;

    buf.capacity = newCapacity;
  }

  disposeSponsorPrototypes(): void {
    for (const [, prototype] of this.sponsorPrototypes) {
      const mat = prototype.material;
      if (mat) {
        // If material has a diffuse texture, null it before dispose
        if ("getTextureMatrix" in mat) {
          // ShaderMaterial doesn't have getTextureMatrix, but we can just dispose
        }
        mat.dispose();
      }
      prototype.dispose();
    }
    this.sponsorPrototypes.clear();
    this.sponsorBuffers.clear();
    this.coinSponsorLookup.clear();
  }

  // ── Rank Highlight Methods ────────────────────────────────────────────

  addRankHighlight(coinId: number, colorIndex: number): void {
    if (this.coinToColorIndex.has(coinId)) return;

    const hl = this.rankHl[colorIndex];
    if (!hl) return;

    const mainIndex = this.idToIndex.get(coinId);
    const kcIndex = this.kcIdToIndex.get(coinId);
    const srcBuffer = mainIndex !== undefined ? this.matrixBuffer : (kcIndex !== undefined ? this.kcBuffer : null);
    const srcIndex = mainIndex !== undefined ? mainIndex : kcIndex;

    if (srcBuffer === null || srcIndex === undefined) {
      this.coinToColorIndex.set(coinId, colorIndex);
      hl.pending.add(coinId);
      return;
    }

    if (hl.active >= hl.capacity) {
      this.resizeRankHlBuffer(colorIndex);
    }

    const index = hl.active;
    hl.active++;
    hl.idToIndex.set(coinId, index);
    hl.indexToId[index] = coinId;
    this.coinToColorIndex.set(coinId, colorIndex);

    hl.buffer.set(
      srcBuffer.subarray(srcIndex * 16, (srcIndex + 1) * 16),
      index * 16
    );

    hl.timers.set(coinId, Date.now() + CoinMeshManager.HIGHLIGHT_DURATION);
  }

  removeRankHighlight(coinId: number): void {
    const colorIndex = this.coinToColorIndex.get(coinId);
    if (colorIndex === undefined) {
      // Also clean from any pending sets
      for (const hl of this.rankHl) hl.pending.delete(coinId);
      return;
    }

    const hl = this.rankHl[colorIndex];
    const index = hl.idToIndex.get(coinId);

    if (index !== undefined) {
      const lastIndex = hl.active - 1;
      if (index !== lastIndex) {
        const lastCoinId = hl.indexToId[lastIndex];
        hl.buffer.copyWithin(index * 16, lastIndex * 16, (lastIndex + 1) * 16);
        hl.idToIndex.set(lastCoinId, index);
        hl.indexToId[index] = lastCoinId;
      }
      hl.idToIndex.delete(coinId);
      hl.timers.delete(coinId);
      hl.active--;
    }

    hl.pending.delete(coinId);
    this.coinToColorIndex.delete(coinId);
  }

  updateHighlights(): void {
    const now = Date.now();

    for (const hl of this.rankHl) {
      // Expire
      for (const [coinId, expiry] of hl.timers) {
        if (now >= expiry) {
          this.removeRankHighlight(coinId);
        }
      }

      // Sync positions
      for (const [coinId, hlIndex] of hl.idToIndex) {
        const mainIndex = this.idToIndex.get(coinId);
        const kcIndex = this.kcIdToIndex.get(coinId);
        if (mainIndex !== undefined) {
          hl.buffer.set(
            this.matrixBuffer.subarray(mainIndex * 16, (mainIndex + 1) * 16),
            hlIndex * 16
          );
        } else if (kcIndex !== undefined) {
          hl.buffer.set(
            this.kcBuffer.subarray(kcIndex * 16, (kcIndex + 1) * 16),
            hlIndex * 16
          );
        } else {
          this.removeRankHighlight(coinId);
          continue;
        }
      }

      // Push to GPU
      if (hl.active === 0) {
        hl.mesh.thinInstanceSetBuffer("matrix", null);
        hl.mesh.isVisible = false;
      } else {
        hl.mesh.isVisible = true;
        const activeData = hl.buffer.subarray(0, hl.active * 16);
        hl.mesh.thinInstanceSetBuffer("matrix", activeData, 16, false);
      }
    }
  }

  private resizeRankHlBuffer(colorIndex: number): void {
    const hl = this.rankHl[colorIndex];
    const newCapacity = hl.capacity * 2;
    const newBuffer = new Float32Array(newCapacity * 16);
    newBuffer.set(hl.buffer);
    hl.buffer = newBuffer;
    const newIndexToId = new Int32Array(newCapacity);
    newIndexToId.set(hl.indexToId);
    hl.indexToId = newIndexToId;
    hl.capacity = newCapacity;
  }

  public updateInstances(): void {
    // Regular coins
    if (this.activeCoins === 0) {
      this.prototypeMesh.thinInstanceSetBuffer("matrix", null);
      this.prototypeMesh.isVisible = false;
    } else {
      this.prototypeMesh.isVisible = true;
      const activeMatrixData = this.matrixBuffer.subarray(0, this.activeCoins * 16);
      this.prototypeMesh.thinInstanceSetBuffer("matrix", activeMatrixData, 16, false);
    }

    // Key coins
    if (this.kcActive === 0) {
      this.keyCoinPrototype.thinInstanceSetBuffer("matrix", null);
      this.keyCoinPrototype.isVisible = false;
    } else {
      this.keyCoinPrototype.isVisible = true;
      const kcMatrixData = this.kcBuffer.subarray(0, this.kcActive * 16);
      this.keyCoinPrototype.thinInstanceSetBuffer("matrix", kcMatrixData, 16, false);
    }

    // Sponsor coins (per-sponsor prototype)
    for (const [sponsorId, prototype] of this.sponsorPrototypes) {
      const buf = this.sponsorBuffers.get(sponsorId);
      if (!buf || buf.count === 0) {
        prototype.thinInstanceSetBuffer("matrix", null);
        prototype.isVisible = false;
      } else {
        prototype.isVisible = true;
        const sponsorMatrixData = buf.matrix.subarray(0, buf.count * 16);
        prototype.thinInstanceSetBuffer("matrix", sponsorMatrixData, 16, false);
      }
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

  private writeMatrixToBuffer2(
    buffer: Float32Array,
    index: number,
    pos: [number, number, number],
    rot: [number, number, number, number]
  ): void {
    CoinMeshManager.tmpVector.set(pos[0], pos[1], pos[2]);
    CoinMeshManager.tmpQuaternion.set(rot[0], rot[1], rot[2], rot[3]);

    Matrix.ComposeToRef(
      CoinMeshManager.tmpScale,
      CoinMeshManager.tmpQuaternion,
      CoinMeshManager.tmpVector,
      CoinMeshManager.tmpMatrix
    );

    CoinMeshManager.tmpMatrix.copyToArray(buffer, index * 16);
  }

  private resizeKeyCoinBuffer(): void {
    const newCapacity = this.kcCapacity * 2;
    const newBuffer = new Float32Array(newCapacity * 16);
    newBuffer.set(this.kcBuffer);
    this.kcBuffer = newBuffer;
    const newIndexToId = new Int32Array(newCapacity);
    newIndexToId.set(this.kcIndexToId);
    this.kcIndexToId = newIndexToId;
    this.kcCapacity = newCapacity;
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
    if (index !== undefined) {
      const off = index * 16;
      return [this.matrixBuffer[off + 12], this.matrixBuffer[off + 13], this.matrixBuffer[off + 14]];
    }
    const kcIndex = this.kcIdToIndex.get(id);
    if (kcIndex !== undefined) {
      const off = kcIndex * 16;
      return [this.kcBuffer[off + 12], this.kcBuffer[off + 13], this.kcBuffer[off + 14]];
    }
    // Check sponsor buffers
    const sponsorId = this.coinSponsorLookup.get(id);
    if (sponsorId) {
      const buf = this.sponsorBuffers.get(sponsorId);
      if (buf) {
        const sIdx = buf.indices.get(id);
        if (sIdx !== undefined) {
          const off = sIdx * 16;
          return [buf.matrix[off + 12], buf.matrix[off + 13], buf.matrix[off + 14]];
        }
      }
    }
    return null;
  }

  dispose(): void {
    this.clear();
    this.disposeSponsorPrototypes();
    this.prototypeMesh.material?.dispose();
    this.prototypeMesh.dispose();
    this.keyCoinPrototype.material?.dispose();
    this.keyCoinPrototype.dispose();
    for (const hl of this.rankHl) {
      hl.mesh.material?.dispose();
      hl.mesh.dispose();
    }
  }

  clear(): void {
    this.idToIndex.clear();
    this.spawnAnims.clear();
    this.pendingNewCoins = [];
    // No need to zero indexToId — entries beyond activeCoins are never read
    this.activeCoins = 0;
    // Clear key coins
    this.kcIdToIndex.clear();
    this.keyCoinIds.clear();
    this.kcActive = 0;
    // Clear sponsor coins
    this.coinSponsorLookup.clear();
    for (const [, buf] of this.sponsorBuffers) {
      buf.indices.clear();
      buf.count = 0;
    }
    this.updateInstances();
    // Clear highlights
    this.coinToColorIndex.clear();
    for (const hl of this.rankHl) {
      hl.idToIndex.clear();
      hl.timers.clear();
      hl.pending.clear();
      hl.active = 0;
      hl.mesh.thinInstanceSetBuffer("matrix", null);
      hl.mesh.isVisible = false;
    }
  }
}
