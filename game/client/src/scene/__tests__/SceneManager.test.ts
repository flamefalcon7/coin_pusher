import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ── Hoisted Mocks ────────────────────────────────────────────────────────────

const {
  MockVector3,
  MockColor3,
  MockColor4,
  MockShaderMaterial,
  MockMesh,
  MockStandardMaterial,
  mockMeshBuilder,
  mockObservable,
  mockEngine,
  mockScene,
  mockWindow,
  resetAll,
} = vi.hoisted(() => {
  class _MockVector3 {
    constructor(public x = 0, public y = 0, public z = 0) {}
    clone() { return new _MockVector3(this.x, this.y, this.z); }
    set(x: number, y: number, z: number) { this.x = x; this.y = y; this.z = z; }
    copyFrom(v: _MockVector3) { this.x = v.x; this.y = v.y; this.z = v.z; }
    static Zero() { return new _MockVector3(); }
    static Lerp(a: _MockVector3, b: _MockVector3, t: number) {
      return new _MockVector3(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t, a.z + (b.z - a.z) * t);
    }
    static Distance(a: _MockVector3, b: _MockVector3) {
      const dx = a.x - b.x, dy = a.y - b.y, dz = a.z - b.z;
      return Math.sqrt(dx * dx + dy * dy + dz * dz);
    }
  }

  class _MockColor3 {
    constructor(public r = 0, public g = 0, public b = 0) {}
    clone() { return new _MockColor3(this.r, this.g, this.b); }
    static Lerp(a: _MockColor3, b: _MockColor3, t: number) {
      return new _MockColor3(a.r + (b.r - a.r) * t, a.g + (b.g - a.g) * t, a.b + (b.b - a.b) * t);
    }
  }

  class _MockColor4 {
    constructor(public r = 0, public g = 0, public b = 0, public a = 0) {}
  }

  class _MockShaderMaterial {
    constructor(public name: string) {}
    setColor3() {}
    setVector3() {}
    setFloat() {}
  }

  class _MockStandardMaterial {
    diffuseColor = new _MockColor3();
    emissiveColor = new _MockColor3();
    disableLighting = false;
    backFaceCulling = true;
    alpha = 1;
    constructor(public name: string) {}
    dispose() {}
  }

  class _MockMesh {
    position = new _MockVector3();
    scaling = new _MockVector3(1, 1, 1);
    rotation = new _MockVector3();
    isPickable = true;
    isVisible = true;
    billboardMode = 0;
    parent: unknown = null;
    material: unknown = null;
    name: string;
    constructor(name: string) { this.name = name; }
    dispose() {}
    static BILLBOARDMODE_NONE = 0;
  }

  const _mockObservable = {
    add: vi.fn((_cb: () => void) => ({ _cb })),
    remove: vi.fn(),
  };

  const _mockEngine = {
    resize: vi.fn(),
    runRenderLoop: vi.fn(),
    stopRenderLoop: vi.fn(),
    dispose: vi.fn(),
    getFps: vi.fn(() => 60),
  };

  const _mockScene = {
    activeCamera: {
      position: new _MockVector3(0, 2, -3),
      target: new _MockVector3(0, 0, 0),
    },
    useRightHandedSystem: false,
    clearColor: null as unknown,
    getMaterialByName: vi.fn(() => null),
    onBeforeRenderObservable: _mockObservable,
    render: vi.fn(),
    dispose: vi.fn(),
    enableDepthRenderer: vi.fn(() => ({ getDepthMap: vi.fn() })),
  };

  const _mockMeshBuilder = {
    CreatePlane: (_name: string) => new _MockMesh(_name),
    CreateTorus: (_name: string) => {
      const m = new _MockMesh(_name);
      m.material = new _MockStandardMaterial(_name + "_mat");
      return m;
    },
    CreateTube: (_name: string) => {
      const m = new _MockMesh(_name);
      m.material = new _MockStandardMaterial(_name + "_mat");
      return m;
    },
  };

  // Mock window for addEventListener/removeEventListener
  const _mockWindow = {
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  };

  return {
    MockVector3: _MockVector3,
    MockColor3: _MockColor3,
    MockColor4: _MockColor4,
    MockShaderMaterial: _MockShaderMaterial,
    MockStandardMaterial: _MockStandardMaterial,
    MockMesh: _MockMesh,
    mockMeshBuilder: _mockMeshBuilder,
    mockObservable: _mockObservable,
    mockEngine: _mockEngine,
    mockScene: _mockScene,
    mockWindow: _mockWindow,
    resetAll: () => {
      _mockObservable.add.mockClear();
      _mockObservable.remove.mockClear();
      _mockEngine.resize.mockClear();
      _mockEngine.dispose.mockClear();
      _mockScene.dispose.mockClear();
      _mockScene.getMaterialByName.mockClear();
      _mockWindow.addEventListener.mockClear();
      _mockWindow.removeEventListener.mockClear();
      // Reset camera target for each test
      _mockScene.activeCamera.target = new _MockVector3(0, 0, 0);
    },
  };
});

// Provide globalThis.window for SceneManager's window.addEventListener/removeEventListener
(globalThis as any).window = mockWindow;
// Provide document.createElement for canvas
(globalThis as any).document = {
  createElement: () => ({}),
};

// ── Module Mocks ─────────────────────────────────────────────────────────────

vi.mock("@babylonjs/core", () => ({
  Engine: function() { return mockEngine; },
  Scene: function() { return mockScene; },
  Vector3: MockVector3,
  Color3: MockColor3,
  Color4: MockColor4,
  Mesh: MockMesh,
  MeshBuilder: mockMeshBuilder,
  ArcRotateCamera: vi.fn(),
  ShaderMaterial: MockShaderMaterial,
  StandardMaterial: MockStandardMaterial,
  ParticleSystem: class {
    particleTexture: unknown = null;
    emitter: unknown = null;
    start() {}
    stop() {}
    dispose() {}
    isAlive() { return false; }
    addSizeGradient() {}
    addColorGradient() {}
    addDragGradient() {}
    createConeEmitter() { return { radiusRange: 0, heightRange: 0 }; }
    recycleParticle() {}
    static BLENDMODE_ADD = 1;
    static BLENDMODE_STANDARD = 0;
    static BILLBOARDMODE_STRETCHED = 7;
  },
  DynamicTexture: class {
    getContext() {
      return { createRadialGradient: () => ({ addColorStop: () => {} }), fillStyle: "", fillRect: () => {} };
    }
    update() {}
    dispose() {}
  },
  Texture: class {},
  NoiseProceduralTexture: class {
    animationSpeedFactor = 0; persistence = 0; brightness = 0; octaves = 0;
  },
  PostProcess: class {
    width = 800; height = 600;
    onApply = null;
    dispose() {}
  },
  Effect: { ShadersStore: {} },
  DefaultRenderingPipeline: class {
    imageProcessingEnabled = false;
    imageProcessing = {
      contrast: 1, exposure: 1, colorCurvesEnabled: false,
      vignetteEnabled: false, vignetteWeight: 0, vignetteColor: null,
    };
    bloomEnabled = false; bloomThreshold = 0; bloomWeight = 0; bloomKernel = 0; bloomScale = 0;
    chromaticAberrationEnabled = false;
    chromaticAberration = { aberrationAmount: 0 };
    fxaaEnabled = false;
    dispose() {}
  },
}));

vi.mock("../CameraSetup", () => ({ CameraSetup: class {} }));
vi.mock("../Lighting", () => ({ Lighting: class {} }));
vi.mock("../StaticMeshes", () => ({
  StaticMeshes: class {
    // Real getters return `T | null`; null makes SceneManager's sponsor-ad and
    // hole-portal branches cleanly skip under test.
    getBackWallGroup() { return null; }
    getLeftWallFrontParent() { return null; }
    getRightWallFrontParent() { return null; }
    getSlotMachine() { return null; }
    getJackpotWheel() { return null; }
  },
}));
vi.mock("../PusherMesh", () => ({
  PusherMesh: class { updatePosition() {} },
}));
vi.mock("../CoinMeshManager", () => ({
  CoinMeshManager: class {
    addCoin() {} updateCoin() {} removeCoin() {}
    getCoinCount() { return 0; } clear() {} updateInstances() {}
    getCoinPosition() { return null; }
  },
}));
vi.mock("../SoundManager", () => ({
  SoundManager: class {
    dispose() {} playTornado() {} playExplosion() {} playLightning() {}
  },
}));
vi.mock("../VFXManager", () => ({
  VFXManager: class {
    init() {} refreshWallColor() {} initHolePortals() {} initCoinSlots() {}
    dispose() {} playShockWave() {}
  },
}));
vi.mock("../PostProcessing", () => ({ PostProcessing: class { dispose() {} } }));
vi.mock("../TargetingReticle", () => ({
  TargetingReticle: class { show() {} hide() {} dispose() {} },
}));
vi.mock("../SponsorAdPlacements", () => ({
  SponsorAdPlacements: class {
    createBackWallAd() {} createSideWallAds() {} updateSponsorCreatives() {} dispose() {}
  },
}));
vi.mock("../DebugReadout", () => ({
  maybeInstallDebugReadout: () => null,
  extendDebugApi: () => {},
}));
vi.mock("../ToonTheme", () => ({
  THEMES: [{
    label: "Test",
    clearColor: new MockColor4(),
    platform: new MockColor3(),
    wall: new MockColor3(),
    pin: new MockColor3(),
    pusher: new MockColor3(),
    coin: new MockColor3(),
    rim: new MockColor3(),
    shadowTint: new MockColor3(),
  }],
  deriveShadow: () => new MockColor3(),
  deriveHighlight: () => new MockColor3(),
}));

// ── Import SceneManager (after mocks) ────────────────────────────────────────

import { SceneManager } from "../SceneManager";

// ── Tests ────────────────────────────────────────────────────────────────────

describe("SceneManager", () => {
  let sm: SceneManager;

  beforeEach(() => {
    resetAll();
    sm = new SceneManager({} as HTMLCanvasElement);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("dispose", () => {
    it("removes onBeforeRenderObservable", () => {
      sm.dispose();
      expect(mockObservable.remove).toHaveBeenCalled();
    });

    it("removes resize listener", () => {
      sm.dispose();
      expect(mockWindow.removeEventListener).toHaveBeenCalledWith("resize", expect.any(Function));
    });

    it("clears camera effect timers on dispose mid-effect", () => {
      vi.useFakeTimers();

      // Trigger an effect that creates setInterval timers
      sm.playShockEffect();

      // Dispose mid-effect
      sm.dispose();

      // Advance timers — should not throw or cause errors
      expect(() => vi.advanceTimersByTime(5000)).not.toThrow();

      vi.useRealTimers();
    });
  });
});
