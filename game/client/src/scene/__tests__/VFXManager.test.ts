import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Hoisted Mocks (vi.mock is hoisted, so mock classes must be too) ─────────

const {
  MockVector3,
  MockColor3,
  MockColor4,
  MockParticleSystem,
  MockMesh,
  MockStandardMaterial,
  MockShaderMaterial,
  MockDynamicTexture,
  mockMeshBuilder,
  resetParticleSystemCount,
} = vi.hoisted(() => {
  let _particleSystemCount = 0;

  class _MockVector3 {
    constructor(public x = 0, public y = 0, public z = 0) {}
    clone() { return new _MockVector3(this.x, this.y, this.z); }
    set(x: number, y: number, z: number) { this.x = x; this.y = y; this.z = z; }
  }

  class _MockColor3 {
    constructor(public r = 0, public g = 0, public b = 0) {}
    clone() { return new _MockColor3(this.r, this.g, this.b); }
    static Lerp(a: _MockColor3, b: _MockColor3, t: number) {
      return new _MockColor3(
        a.r + (b.r - a.r) * t,
        a.g + (b.g - a.g) * t,
        a.b + (b.b - a.b) * t
      );
    }
  }

  class _MockColor4 {
    constructor(public r = 0, public g = 0, public b = 0, public a = 0) {}
    set(r: number, g: number, b: number, a: number) {
      this.r = r; this.g = g; this.b = b; this.a = a;
    }
  }

  class _MockParticleSystem {
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
  }

  class _MockMesh {
    position = new _MockVector3();
    scaling = new _MockVector3(1, 1, 1);
    rotation = new _MockVector3();
    isPickable = true;
    isVisible = true;
    renderingGroupId = 0;
    billboardMode = 0;
    parent: unknown = null;
    material: unknown = null;
    name: string;

    constructor(name: string) { this.name = name; }
    dispose() {}

    static BILLBOARDMODE_NONE = 0;
  }

  class _MockStandardMaterial {
    diffuseColor = new _MockColor3();
    emissiveColor = new _MockColor3();
    disableLighting = false;
    alpha = 1;
    constructor(public name: string) {}
  }

  class _MockShaderMaterial {
    constructor(public name: string) {}
    setColor3() {}
    setVector3() {}
    setFloat() {}
  }

  class _MockDynamicTexture {
    constructor() {}
    getContext() {
      return {
        createRadialGradient: () => ({
          addColorStop: () => {},
        }),
        fillStyle: "",
        fillRect: () => {},
      };
    }
    update() {}
    dispose() {}
  }

  const _mockMeshBuilder = {
    CreatePlane: (_name: string) => new _MockMesh(_name),
    CreateTorus: (_name: string) => new _MockMesh(_name),
  };

  return {
    MockVector3: _MockVector3,
    MockColor3: _MockColor3,
    MockColor4: _MockColor4,
    MockParticleSystem: _MockParticleSystem,
    MockMesh: _MockMesh,
    MockStandardMaterial: _MockStandardMaterial,
    MockDynamicTexture: _MockDynamicTexture,
    MockShaderMaterial: _MockShaderMaterial,
    mockMeshBuilder: _mockMeshBuilder,
    resetParticleSystemCount: () => { _particleSystemCount = 0; },
  };
});

// ── Module Mock ──────────────────────────────────────────────────────────────

vi.mock("@babylonjs/core", () => ({
  Vector3: MockVector3,
  Color3: MockColor3,
  Color4: MockColor4,
  Mesh: MockMesh,
  MeshBuilder: mockMeshBuilder,
  ParticleSystem: MockParticleSystem,
  DynamicTexture: MockDynamicTexture,
  StandardMaterial: MockStandardMaterial,
  ShaderMaterial: MockShaderMaterial,
}));

// ── Import VFXManager (after mocks) ─────────────────────────────────────────

import { VFXManager } from "../VFXManager";

// ── Helper ───────────────────────────────────────────────────────────────────

function createMockScene(): any {
  const wallMat = new MockShaderMaterial("wallMat");

  return {
    activeCamera: { position: new MockVector3(0, 2, -3) },
    meshes: [],
    particleSystems: [],
    getMaterialByName: (name: string) => {
      if (name === "wallMat") return wallMat;
      return null;
    },
    getMeshByName: (name: string) => {
      if (name === "pusher") return new MockMesh("pusher");
      return null;
    },
    onBeforeRenderObservable: {
      add: vi.fn((cb: () => void) => cb),
      remove: vi.fn(),
    },
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("VFXManager", () => {
  let scene: ReturnType<typeof createMockScene>;
  let vfx: VFXManager;

  beforeEach(() => {
    resetParticleSystemCount();
    scene = createMockScene();
    vfx = new VFXManager(scene);
    vfx.init();
  });

  // ── Lifecycle ──────────────────────────────────────────────────────────

  describe("lifecycle", () => {
    it("initializes without error", () => {
      expect(vfx).toBeDefined();
    });

    it("dispose cleans up all systems", () => {
      vfx.playCoinInsert(0);
      vfx.playCoinInsert(1);
      expect(vfx.getActiveBurstCount()).toBeGreaterThan(0);

      vfx.dispose();

      expect(vfx.getActiveBurstCount()).toBe(0);
    });

    it("double dispose does not throw", () => {
      vfx.dispose();
      expect(() => vfx.dispose()).not.toThrow();
    });
  });

  // ── Coin Insert ────────────────────────────────────────────────────────

  describe("playCoinInsert", () => {
    it("creates a particle system", () => {
      const ps = vfx.playCoinInsert(0);
      expect(ps).not.toBeNull();
      expect(vfx.getActiveBurstCount()).toBeGreaterThanOrEqual(1);
    });

    it("particle system has gold colors", () => {
      const ps = vfx.playCoinInsert(2) as any;
      expect(ps.color1.r).toBeGreaterThan(0.8);
      expect(ps.color1.g).toBeGreaterThan(0.5);
    });

    it("auto-disposes after targetStopDuration", () => {
      const ps = vfx.playCoinInsert(0) as any;
      expect(ps.disposeOnStop).toBe(true);
      expect(ps.targetStopDuration).toBeGreaterThan(0);
    });

    it("handles out-of-range slot index gracefully", () => {
      expect(() => vfx.playCoinInsert(99)).not.toThrow();
    });
  });

  // ── Coin Despawn ───────────────────────────────────────────────────────

  describe("playCoinDespawn", () => {
    it("creates a particle burst at given position", () => {
      const pos = new MockVector3(0.2, 0.3, 0.5) as any;
      const ps = vfx.playCoinDespawn(pos);
      expect(ps).not.toBeNull();
    });

    it("particle system uses brass/gold colors", () => {
      const ps = vfx.playCoinDespawn(new MockVector3(0, 0.3, 0) as any) as any;
      expect(ps.color1.r).toBeGreaterThan(0.7);
    });

    it("skips effect if position is below visible area", () => {
      const ps = vfx.playCoinDespawn(new MockVector3(0, -0.2, 0) as any);
      expect(ps).toBeNull();
    });
  });

  // ── Coin Land ──────────────────────────────────────────────────────────

  describe("playCoinLand", () => {
    it("creates an expanding ring", () => {
      const pos = new MockVector3(0, 0.3, 0) as any;
      vfx.playCoinLand(pos);
      expect(vfx.getActiveRingCount()).toBe(1);
    });

    it("multiple lands create multiple rings", () => {
      for (let i = 0; i < 5; i++) {
        vfx.playCoinLand(new MockVector3(i * 0.1, 0.3, 0) as any);
      }
      expect(vfx.getActiveRingCount()).toBe(5);
    });
  });

  // ── Shock Wave ─────────────────────────────────────────────────────────

  describe("playShockWave", () => {
    it("creates ring and particle burst", () => {
      const burstBefore = vfx.getActiveBurstCount();
      vfx.playShockWave();
      expect(vfx.getActiveRingCount()).toBeGreaterThan(0);
      expect(vfx.getActiveBurstCount()).toBeGreaterThan(burstBefore);
    });
  });

  // ── Pool Limits ────────────────────────────────────────────────────────

  describe("pool limits", () => {
    it("enforces maxBurstSystems limit", () => {
      const maxBurst = 20;
      for (let i = 0; i < maxBurst + 10; i++) {
        vfx.playCoinInsert(i % 5);
      }
      expect(vfx.getActiveBurstCount()).toBeLessThanOrEqual(maxBurst);
    });

    it("custom maxBurstSystems is respected", () => {
      vfx.dispose();
      vfx = new VFXManager(scene, { maxBurstSystems: 5 });
      vfx.init();

      for (let i = 0; i < 10; i++) {
        vfx.playCoinInsert(0);
      }
      expect(vfx.getActiveBurstCount()).toBeLessThanOrEqual(5);
    });
  });

  // ── Stress Test ────────────────────────────────────────────────────────

  describe("stress", () => {
    it("handles 50 simultaneous despawn effects", () => {
      expect(() => {
        for (let i = 0; i < 50; i++) {
          vfx.playCoinDespawn(new MockVector3(Math.random(), 0, Math.random()) as any);
        }
      }).not.toThrow();
    });

    it("handles rapid insert + despawn interleaving", () => {
      expect(() => {
        for (let i = 0; i < 100; i++) {
          if (i % 2 === 0) {
            vfx.playCoinInsert(i % 5);
          } else {
            vfx.playCoinDespawn(new MockVector3(0, 0, 0) as any);
          }
        }
      }).not.toThrow();
    });
  });
});
