/**
 * Shared leak-test harness for client scene managers.
 *
 * This is NOT a test file (no `*.test.ts` suffix, so vitest never collects it).
 * It factors the `vi.mock("@babylonjs/core")` idiom that the existing scene
 * tests (`VFXManager.test.ts`, `CoinMeshManager.test.ts`) already use into one
 * reusable mock, plus count-baseline helpers.
 *
 * Why a mock instead of NullEngine: the managers build `DynamicTexture` via
 * `getContext()` + `createRadialGradient` and use `ToonMaterial`/`ShaderMaterial`,
 * none of which load under a bare node NullEngine (no 2D canvas, no GL shader
 * compile). See ADR D-003 / KTD-2 in the plan.
 *
 * Usage from a test file (the factory must be referenced via dynamic import so it
 * survives `vi.mock` hoisting):
 *
 *   vi.mock("@babylonjs/core", async () => {
 *     const { createBabylonCoreMock } = await import("./leakHarness");
 *     return createBabylonCoreMock();
 *   });
 *   vi.mock("../ToonMaterial", async () => {
 *     const { createToonMaterialMock } = await import("./leakHarness");
 *     return createToonMaterialMock();
 *   });
 *
 *   import { VFXManager } from "../VFXManager";
 *   import { createMockScene, snapshotPoolCounters, expectCountersWithin } from "./leakHarness";
 */
import { expect, vi } from "vitest";

// ── Mock Babylon primitives ──────────────────────────────────────────────────

export class MockVector3 {
  constructor(public x = 0, public y = 0, public z = 0) {}
  clone() { return new MockVector3(this.x, this.y, this.z); }
  set(x: number, y: number, z: number) { this.x = x; this.y = y; this.z = z; return this; }
  static Zero() { return new MockVector3(); }
  static Lerp(a: MockVector3, b: MockVector3, t: number) {
    return new MockVector3(
      a.x + (b.x - a.x) * t,
      a.y + (b.y - a.y) * t,
      a.z + (b.z - a.z) * t,
    );
  }
  static Distance(a: MockVector3, b: MockVector3) {
    const dx = a.x - b.x, dy = a.y - b.y, dz = a.z - b.z;
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
  }
}

export class MockColor3 {
  constructor(public r = 0, public g = 0, public b = 0) {}
  clone() { return new MockColor3(this.r, this.g, this.b); }
  set(r: number, g: number, b: number) { this.r = r; this.g = g; this.b = b; return this; }
  static Lerp(a: MockColor3, b: MockColor3, t: number) {
    return new MockColor3(
      a.r + (b.r - a.r) * t,
      a.g + (b.g - a.g) * t,
      a.b + (b.b - a.b) * t,
    );
  }
  static FromHexString() { return new MockColor3(); }
}

export class MockColor4 {
  constructor(public r = 0, public g = 0, public b = 0, public a = 0) {}
  set(r: number, g: number, b: number, a: number) {
    this.r = r; this.g = g; this.b = b; this.a = a; return this;
  }
}

export class MockQuaternion {
  x = 0; y = 0; z = 0; w = 1;
  constructor(x = 0, y = 0, z = 0, w = 1) {
    this.x = x; this.y = y; this.z = z; this.w = w;
  }
  set(x: number, y: number, z: number, w: number) {
    this.x = x; this.y = y; this.z = z; this.w = w; return this;
  }
  clone() { return new MockQuaternion(this.x, this.y, this.z, this.w); }
  multiplyInPlace(_q: MockQuaternion) { return this; }
  static RotationYawPitchRoll() { return new MockQuaternion(); }
  static FromEulerAnglesToRef(_x: number, _y: number, _z: number, out: MockQuaternion) {
    out.set(0, 0, 0, 1);
    return out;
  }
}

export class MockMatrix {
  m = new Float32Array(16);
  copyToArray(arr: Float32Array, offset: number) { arr.set(this.m, offset); }
  static ComposeToRef(_s: unknown, _r: unknown, _p: unknown, out: MockMatrix) {
    out.m.fill(0);
    out.m[0] = 1; out.m[5] = 1; out.m[10] = 1; out.m[15] = 1;
    return out;
  }
}

let _particleSystemCount = 0;
export function resetParticleSystemCount() { _particleSystemCount = 0; }

export class MockParticleSystem {
  id: number;
  particleTexture: unknown = null;
  emitter: unknown = null;
  minLifeTime = 0; maxLifeTime = 0;
  minSize = 0; maxSize = 0;
  minEmitPower = 0; maxEmitPower = 0;
  direction1: unknown = null; direction2: unknown = null;
  gravity: unknown = null;
  emitRate = 0;
  color1: unknown = null; color2: unknown = null; colorDead: unknown = null;
  targetStopDuration = 0;
  disposeOnStop = false;
  minEmitBox: unknown = null; maxEmitBox: unknown = null;
  blendMode = 0;
  minAngularSpeed = 0; maxAngularSpeed = 0;
  minInitialRotation = 0; maxInitialRotation = 0;
  minScaleX = 1; maxScaleX = 1; minScaleY = 1; maxScaleY = 1;
  billboardMode = 0;
  noiseTexture: unknown = null;
  noiseStrength: unknown = null;
  updateFunction: unknown = null;
  private _alive = true;
  private _started = false;

  constructor(public name: string, public capacity: number) {
    this.id = _particleSystemCount++;
  }
  start() { this._started = true; }
  stop() { this._alive = false; }
  dispose() { this._alive = false; }
  isAlive() { return this._alive; }
  isStarted() { return this._started; }
  addSizeGradient() {}
  addColorGradient() {}
  addDragGradient() {}
  createConeEmitter() { return { radiusRange: 0, heightRange: 0 }; }
  recycleParticle() {}

  static BLENDMODE_ADD = 1;
  static BLENDMODE_STANDARD = 0;
  static BILLBOARDMODE_STRETCHED = 7;
}

export class MockMesh {
  position = new MockVector3();
  scaling = new MockVector3(1, 1, 1);
  rotation = new MockVector3();
  rotationQuaternion: MockQuaternion | null = null;
  isPickable = true;
  isVisible = true;
  renderingGroupId = 0;
  billboardMode = 0;
  thinInstanceEnablePicking = true;
  alwaysSelectAsActiveMesh = false;
  parent: unknown = null;
  material: unknown = null;
  name: string;
  private _enabled = true;

  constructor(name: string) { this.name = name; }
  thinInstanceSetBuffer() {}
  setEnabled(v: boolean) { this._enabled = v; }
  isEnabled() { return this._enabled; }
  dispose() {}

  static BILLBOARDMODE_NONE = 0;
}

export class MockStandardMaterial {
  diffuseColor = new MockColor3();
  emissiveColor = new MockColor3();
  disableLighting = false;
  backFaceCulling = true;
  alpha = 1;
  constructor(public name: string) {}
  setColor3() {}
  dispose() {}
}

export class MockShaderMaterial {
  constructor(public name: string) {}
  setColor3() {}
  setVector3() {}
  setFloat() {}
}

export class MockDynamicTexture {
  hasAlpha = false;
  constructor() {}
  getContext() {
    return {
      createRadialGradient: () => ({ addColorStop: () => {} }),
      fillStyle: "",
      strokeStyle: "",
      lineWidth: 0,
      font: "",
      textAlign: "",
      textBaseline: "",
      fillRect: () => {},
      clearRect: () => {},
      beginPath: () => {},
      arc: () => {},
      arcTo: () => {},
      moveTo: () => {},
      lineTo: () => {},
      closePath: () => {},
      stroke: () => {},
      fill: () => {},
      fillText: () => {},
      setLineDash: () => {},
      drawImage: () => {},
    };
  }
  update() {}
  dispose() {}
}

const mockMeshBuilder = {
  CreatePlane: (name: string) => new MockMesh(name),
  CreateTorus: (name: string) => {
    const m = new MockMesh(name);
    m.material = new MockStandardMaterial(name + "_mat");
    return m;
  },
  CreateTube: (name: string) => {
    const m = new MockMesh(name);
    m.material = new MockStandardMaterial(name + "_mat");
    return m;
  },
  CreateCylinder: (name: string) => new MockMesh(name),
  CreateLines: (name: string) => new MockMesh(name),
  CreateLineSystem: (name: string) => new MockMesh(name),
  CreateBox: (name: string) => new MockMesh(name),
};

/**
 * Returns the mock object to feed `vi.mock("@babylonjs/core", () => ...)`.
 * Superset that satisfies both VFXManager and CoinMeshManager.
 */
export function createBabylonCoreMock() {
  return {
    Vector3: MockVector3,
    Color3: MockColor3,
    Color4: MockColor4,
    Quaternion: MockQuaternion,
    Matrix: MockMatrix,
    Mesh: MockMesh,
    MeshBuilder: mockMeshBuilder,
    ParticleSystem: MockParticleSystem,
    DynamicTexture: MockDynamicTexture,
    Texture: class {},
    StandardMaterial: MockStandardMaterial,
    ShaderMaterial: MockShaderMaterial,
    Scene: class {},
    SceneInstrumentation: class {
      constructor(public scene: unknown) {}
      drawCallsCounter = { current: 0 };
      dispose() {}
    },
    TransformNode: class {
      position = new MockVector3();
      rotationQuaternion: MockQuaternion | null = null;
      parent: unknown = null;
      private _enabled = true;
      constructor(public name?: string) {}
      setEnabled(v: boolean) { this._enabled = v; }
      isEnabled() { return this._enabled; }
      dispose() {}
    },
    NoiseProceduralTexture: class {
      animationSpeedFactor = 0;
      persistence = 0;
      brightness = 0;
      octaves = 0;
      dispose() {}
    },
  };
}

/** Returns the mock for `vi.mock("../ToonMaterial", () => ...)`. */
export function createToonMaterialMock() {
  return {
    createToonMaterial: (_scene: unknown, opts: { name: string }) => ({
      name: opts.name,
      setColor3() {},
      setFloat() {},
      setVector3() {},
      dispose() {},
    }),
  };
}

// ── Mock scene ───────────────────────────────────────────────────────────────

/**
 * A mock Scene sufficient for VFXManager and CoinMeshManager.
 * `getEngine()` reports a portrait aspect ratio so CoinMeshManager's sponsor
 * path takes the mobile branch (flat material, no `new Image()`).
 */
export function createMockScene(): any {
  const wallMat = new MockShaderMaterial("wallMat");
  return {
    activeCamera: { position: new MockVector3(0, 2, -3) },
    meshes: [],
    particleSystems: [],
    getMaterialByName: (name: string) => (name === "wallMat" ? wallMat : null),
    getMeshByName: (name: string) => (name === "pusher" ? new MockMesh("pusher") : null),
    getEngine: () => ({
      getRenderWidth: () => 400,
      getRenderHeight: () => 800,
    }),
    onBeforeRenderObservable: {
      add: vi.fn((cb: () => void) => cb),
      remove: vi.fn(),
    },
    onAfterRenderObservable: {
      add: vi.fn((cb: () => void) => cb),
      remove: vi.fn(),
    },
  };
}

// ── Count-baseline helpers ───────────────────────────────────────────────────

const POOL_GETTERS = [
  "getActiveBurstCount",
  "getActiveRingCount",
  "getRingPoolSize",
  "getCoinCount",
  "getComboFlashAlpha",
] as const;

export type CounterSnapshot = Record<string, number>;

/**
 * Snapshot a manager's own pool counters. Reads every known public getter that
 * exists on the manager, plus any `extra` field names (arrays → length,
 * Map/Set → size, numbers as-is). This measures the leak class we own
 * (forgot-to-dispose / forgot-to-unpool), not engine bookkeeping.
 */
export function snapshotPoolCounters(
  manager: unknown,
  extra: string[] = [],
): CounterSnapshot {
  const m = manager as Record<string, any>;
  const snap: CounterSnapshot = {};
  for (const g of POOL_GETTERS) {
    if (typeof m[g] === "function") snap[g] = m[g]();
  }
  for (const key of extra) {
    const v = m[key];
    if (Array.isArray(v)) snap[key] = v.length;
    else if (v instanceof Map || v instanceof Set) snap[key] = v.size;
    else if (typeof v === "number") snap[key] = v;
    else snap[key] = v == null ? 0 : 1;
  }
  return snap;
}

/**
 * Assert every counter in `after` is within `tolerance` of `baseline`.
 * Tolerance ±1 absorbs engine-internal singletons; pass 0 for exact.
 */
export function expectCountersWithin(
  baseline: CounterSnapshot,
  after: CounterSnapshot,
  tolerance = 1,
): void {
  for (const key of Object.keys(baseline)) {
    const b = baseline[key];
    const a = after[key];
    expect(
      Math.abs(a - b),
      `counter "${key}" drifted from baseline ${b} to ${a} (tolerance ±${tolerance})`,
    ).toBeLessThanOrEqual(tolerance);
  }
}
