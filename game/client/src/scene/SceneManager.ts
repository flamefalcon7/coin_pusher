import { Engine, Scene, Color3, Color4, ArcRotateCamera, ShaderMaterial, StandardMaterial } from "@babylonjs/core";
import { CellMaterial } from "@babylonjs/materials/cell/cellMaterial";
import { CameraSetup } from "./CameraSetup";
import { Lighting } from "./Lighting";
import { StaticMeshes } from "./StaticMeshes";
import { PusherMesh } from "./PusherMesh";
import { CoinMeshManager } from "./CoinMeshManager";
import { SoundManager } from "./SoundManager";
import { PostProcessing } from "./PostProcessing";
import { THEMES, ToonTheme } from "./ToonTheme";


// Material names shared between cel and standard versions
const MAT_NAMES = ["platformMat", "wallMat", "pinMat", "pusherMat"] as const;

export class SceneManager {
  private engine: Engine;
  private scene: Scene;
  private pusherMesh: PusherMesh;
  private coinManager: CoinMeshManager;
  private soundManager: SoundManager;
  private running: boolean = false;
  private fpsCallback?: (fps: number) => void;
  private currentThemeIndex: number = 0;

  // Cel shading toggle state
  private celShadingEnabled: boolean = true;
  private standardMats: Map<string, StandardMaterial> = new Map();
  private cellMats: Map<string, CellMaterial> = new Map();
  // Coin materials (ShaderMaterial for cel, StandardMaterial for standard)
  private coinCellMat: ShaderMaterial | null = null;
  private coinStdMat: StandardMaterial | null = null;

  constructor(canvas: HTMLCanvasElement) {
    console.log("🎮 Initializing BabylonJS scene...");

    this.engine = new Engine(canvas, true, {
      preserveDrawingBuffer: true,
      stencil: true,
    });

    this.scene = new Scene(this.engine);
    this.scene.useRightHandedSystem = true;
    this.scene.clearColor = new Color4(0.02, 0.02, 0.06, 1.0);

    console.log("✅ Right-handed coordinate system enabled");

    new CameraSetup(this.scene, canvas);
    new Lighting(this.scene);
    new StaticMeshes(this.scene);
    this.pusherMesh = new PusherMesh(this.scene);
    this.coinManager = new CoinMeshManager(this.scene);
    this.soundManager = new SoundManager();

    new PostProcessing(this.scene);

    // Cache CellMaterial references
    for (const name of MAT_NAMES) {
      const mat = this.scene.getMaterialByName(name);
      if (mat && mat instanceof CellMaterial) {
        this.cellMats.set(name, mat);
      }
    }

    // Cache coin ShaderMaterial
    const coinMat = this.scene.getMaterialByName("coinMat");
    if (coinMat && coinMat instanceof ShaderMaterial) {
      this.coinCellMat = coinMat;
    }

    // Apply default theme
    this.applyTheme(THEMES[0]);

    console.log("✅ Scene initialized successfully");

    window.addEventListener("resize", () => {
      this.engine.resize();
    });
  }

  // ── Theme ────────────────────────────────────────────────────────────────

  applyTheme(theme: ToonTheme): void {
    this.scene.clearColor = theme.clearColor;

    const colorMap: Record<string, Color3> = {
      platformMat: theme.platform,
      wallMat: theme.wall,
      pinMat: theme.pin,
      pusherMat: theme.pusher,
    };

    // Update whichever material type is currently active
    for (const name of MAT_NAMES) {
      const color = colorMap[name];
      const cellMat = this.cellMats.get(name);
      if (cellMat) cellMat.diffuseColor = color;

      const stdMat = this.standardMats.get(name);
      if (stdMat) stdMat.diffuseColor = color;
    }

    // Coin materials
    if (this.coinCellMat) {
      this.coinCellMat.setColor3("baseColor", theme.coin);
      this.coinCellMat.setColor3("shadowTint", theme.shadowTint);
    }
    if (this.coinStdMat) {
      this.coinStdMat.diffuseColor = theme.coin;
    }

    console.log(`🎨 Theme applied: ${theme.label}`);
  }

  cycleTheme(): string {
    this.currentThemeIndex = (this.currentThemeIndex + 1) % THEMES.length;
    const theme = THEMES[this.currentThemeIndex];
    this.applyTheme(theme);
    return theme.label;
  }

  getCurrentThemeLabel(): string {
    return THEMES[this.currentThemeIndex].label;
  }

  // ── Cel Shading Toggle ───────────────────────────────────────────────────

  toggleCelShading(): boolean {
    this.celShadingEnabled = !this.celShadingEnabled;
    const theme = THEMES[this.currentThemeIndex];

    if (this.celShadingEnabled) {
      this.switchToCel(theme);
    } else {
      this.switchToStandard(theme);
    }

    console.log(`🎨 Cel shading: ${this.celShadingEnabled ? "ON" : "OFF"}`);
    return this.celShadingEnabled;
  }

  isCelShadingEnabled(): boolean {
    return this.celShadingEnabled;
  }

  private switchToStandard(theme: ToonTheme): void {
    const colorMap: Record<string, Color3> = {
      platformMat: theme.platform,
      wallMat: theme.wall,
      pinMat: theme.pin,
      pusherMat: theme.pusher,
    };

    // Create StandardMaterial counterparts if not cached
    for (const name of MAT_NAMES) {
      if (!this.standardMats.has(name)) {
        const stdMat = new StandardMaterial(`${name}_std`, this.scene);
        stdMat.specularColor = new Color3(0.2, 0.2, 0.2);
        this.standardMats.set(name, stdMat);
      }
      this.standardMats.get(name)!.diffuseColor = colorMap[name];
    }

    // Create standard coin material if not cached
    if (!this.coinStdMat) {
      this.coinStdMat = new StandardMaterial("coinMat_std", this.scene);
      this.coinStdMat.specularColor = new Color3(0.8, 0.7, 0.3);
      this.coinStdMat.specularPower = 64;
    }
    this.coinStdMat.diffuseColor = theme.coin;

    // Swap on all meshes
    this.swapMaterials(false);
  }

  private switchToCel(theme: ToonTheme): void {
    // Re-apply theme colors to cel materials
    this.applyTheme(theme);
    // Swap on all meshes
    this.swapMaterials(true);
  }

  private swapMaterials(toCel: boolean): void {
    // Swap static mesh materials
    for (const mesh of this.scene.meshes) {
      if (!mesh.material) continue;
      const matName = mesh.material.name;

      // Check if this mesh uses one of our managed materials (cell or std version)
      for (const name of MAT_NAMES) {
        if (matName === name || matName === `${name}_std`) {
          mesh.material = toCel
            ? this.cellMats.get(name)!
            : this.standardMats.get(name)!;
          break;
        }
      }

      // Coin prototype
      if (matName === "coinMat" || matName === "coinMat_std") {
        mesh.material = toCel ? this.coinCellMat! : this.coinStdMat!;
      }
    }
  }

  // ── Render Loop ──────────────────────────────────────────────────────────

  startRenderLoop(): void {
    if (this.running) return;

    this.running = true;
    console.log("▶️  Render loop started");

    this.engine.runRenderLoop(() => {
      this.scene.render();

      if (this.fpsCallback) {
        const fps = Math.round(this.engine.getFps());
        this.fpsCallback(fps);
      }
    });
  }

  stopRenderLoop(): void {
    if (!this.running) return;

    this.running = false;
    this.engine.stopRenderLoop();
    console.log("⏸️  Render loop stopped");
  }

  // ── Coin & Pusher API ────────────────────────────────────────────────────

  updatePusherPosition(z: number): void {
    this.pusherMesh.updatePosition(z);
  }

  addCoin(
    id: number,
    pos: [number, number, number],
    rot: [number, number, number, number]
  ): void {
    this.coinManager.addCoin(id, pos, rot);
  }

  updateCoin(
    id: number,
    pos: [number, number, number],
    rot: [number, number, number, number]
  ): void {
    this.coinManager.updateCoin(id, pos, rot);
  }

  removeCoin(id: number): void {
    this.coinManager.removeCoin(id);
  }

  getCoinCount(): number {
    return this.coinManager.getCoinCount();
  }

  clearCoins(): void {
    this.coinManager.clear();
  }

  updateCoinBuffers(): void {
    this.coinManager.updateInstances();
  }

  setFpsCallback(callback: (fps: number) => void): void {
    this.fpsCallback = callback;
  }

  getSoundManager(): SoundManager {
    return this.soundManager;
  }

  dispose(): void {
    this.stopRenderLoop();
    this.soundManager.dispose();
    this.scene.dispose();
    this.engine.dispose();
    console.log("🗑️  Scene disposed");
  }

  // ── Shock Effect ─────────────────────────────────────────────────────────

  playShockEffect(): void {
    // 1. Camera shake
    const camera = this.scene.activeCamera as ArcRotateCamera | null;
    if (camera) {
      const origTarget = camera.target.clone();
      const shakeIntensity = 0.03;
      const shakeDuration = 300;
      const shakeInterval = 30;
      let elapsed = 0;

      const shakeTimer = setInterval(() => {
        elapsed += shakeInterval;
        if (elapsed >= shakeDuration) {
          camera.target.copyFrom(origTarget);
          clearInterval(shakeTimer);
          return;
        }
        const t = 1 - elapsed / shakeDuration;
        camera.target.x = origTarget.x + (Math.random() - 0.5) * shakeIntensity * t;
        camera.target.y = origTarget.y + (Math.random() - 0.5) * shakeIntensity * t;
      }, shakeInterval);
    }

    // 2. Pin flash — works with both CellMaterial and StandardMaterial
    const pinMatName = this.celShadingEnabled ? "pinMat" : "pinMat_std";
    const pinMat = this.scene.getMaterialByName(pinMatName);

    if (pinMat) {
      // Both CellMaterial and StandardMaterial have diffuseColor
      const mat = pinMat as CellMaterial | StandardMaterial;
      const origColor = mat.diffuseColor.clone();
      const flashColor = new Color3(1.0, 0.6, 0.1);

      mat.diffuseColor = flashColor;

      const fadeDuration = 400;
      const fadeInterval = 30;
      let fadeElapsed = 0;

      const fadeTimer = setInterval(() => {
        fadeElapsed += fadeInterval;
        if (fadeElapsed >= fadeDuration) {
          mat.diffuseColor = origColor;
          clearInterval(fadeTimer);
          return;
        }
        const t = fadeElapsed / fadeDuration;
        mat.diffuseColor = Color3.Lerp(flashColor, origColor, t);
      }, fadeInterval);
    }
  }

  getScene(): Scene {
    return this.scene;
  }

  getEngine(): Engine {
    return this.engine;
  }
}
