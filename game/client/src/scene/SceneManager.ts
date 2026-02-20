import { Engine, Scene, Color3, Color4, ArcRotateCamera, ShaderMaterial, StandardMaterial, Vector3 } from "@babylonjs/core";
import { CellMaterial } from "@babylonjs/materials/cell/cellMaterial";
import { CameraSetup } from "./CameraSetup";
import { Lighting } from "./Lighting";
import { StaticMeshes } from "./StaticMeshes";
import { PusherMesh } from "./PusherMesh";
import { CoinMeshManager } from "./CoinMeshManager";
import { SoundManager } from "./SoundManager";
import { PostProcessing } from "./PostProcessing";
import { VFXManager } from "./VFXManager";
import { THEMES, ToonTheme } from "./ToonTheme";


// Material names shared between cel and standard versions
const MAT_NAMES = ["platformMat", "wallMat", "pinMat", "pusherMat"] as const;

export class SceneManager {
  private engine: Engine;
  private scene: Scene;
  private pusherMesh: PusherMesh;
  private coinManager: CoinMeshManager;
  private soundManager: SoundManager;
  private vfxManager: VFXManager;
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
    console.log("Initializing BabylonJS scene...");

    this.engine = new Engine(canvas, true, {
      preserveDrawingBuffer: true,
      stencil: true,
    });

    this.scene = new Scene(this.engine);
    this.scene.useRightHandedSystem = true;
    this.scene.clearColor = new Color4(0.02, 0.02, 0.06, 1.0);

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

    // Initialize VFX
    this.vfxManager = new VFXManager(this.scene);

    // Apply default theme (also initializes VFX after theme colors are set)
    this.applyTheme(THEMES[0]);

    // Start VFX after theme is applied so wall colors are cached correctly
    this.vfxManager.init();

    console.log("Scene initialized successfully");

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

    // Refresh VFX wall color cache after theme change
    this.vfxManager.refreshWallColor();

    console.log(`Theme applied: ${theme.label}`);
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

    // Refresh VFX wall reference since material instance may have changed
    this.vfxManager.refreshWallColor();

    console.log(`Cel shading: ${this.celShadingEnabled ? "ON" : "OFF"}`);
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
        // Copy diffuseTexture from cel material if it has one
        const cellMat = this.cellMats.get(name);
        if (cellMat?.diffuseTexture) {
          stdMat.diffuseTexture = cellMat.diffuseTexture;
        }
        this.standardMats.set(name, stdMat);
      }
      this.standardMats.get(name)!.diffuseColor = colorMap[name];
    }

    // Create standard coin material if not cached
    if (!this.coinStdMat) {
      this.coinStdMat = new StandardMaterial("coinMat_std", this.scene);
      this.coinStdMat.specularColor = new Color3(0.8, 0.7, 0.3);
      this.coinStdMat.specularPower = 64;
      // Apply ₿ texture as emissive so it glows on the coin face
      const coinTex = this.coinManager.getCoinTexture();
      this.coinStdMat.emissiveTexture = coinTex;
      this.coinStdMat.emissiveColor = new Color3(0.2, 0.2, 0.2);
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
  }

  // ── Coin & Pusher API ────────────────────────────────────────────────────

  updatePusherPosition(z: number): void {
    this.pusherMesh.updatePosition(z);
    this.vfxManager.updatePusherGlow(z);
  }

  addCoin(
    id: number,
    pos: [number, number, number],
    rot: [number, number, number, number]
  ): void {
    this.coinManager.addCoin(id, pos, rot);
    // VFX: landing ring at coin position
    this.vfxManager.playCoinLand(new Vector3(pos[0], pos[1], pos[2]));
  }

  updateCoin(
    id: number,
    pos: [number, number, number],
    rot: [number, number, number, number]
  ): void {
    this.coinManager.updateCoin(id, pos, rot);
  }

  /** Remove a coin and return its last position (for VFX). */
  removeCoinWithEffect(id: number): void {
    const pos = this.coinManager.getCoinPosition(id);
    if (pos) {
      this.vfxManager.playCoinDespawn(new Vector3(pos[0], pos[1], pos[2]));
    }
    this.coinManager.removeCoin(id);
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

  getVFXManager(): VFXManager {
    return this.vfxManager;
  }

  dispose(): void {
    this.stopRenderLoop();
    this.vfxManager.dispose();
    this.soundManager.dispose();
    this.scene.dispose();
    this.engine.dispose();
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

    // 3. VFX: ground wave + pin particles
    this.vfxManager.playShockWave();
  }

  // ── Tornado Effect ──────────────────────────────────────────────────────

  playTornadoEffect(position: Vector3): void {
    this.vfxManager.playTornado(position, 4.0);
    this.soundManager.playTornado();

    // Gentle camera wobble (weaker than shock shake)
    const camera = this.scene.activeCamera as ArcRotateCamera | null;
    if (camera) {
      const origTarget = camera.target.clone();
      const wobbleIntensity = 0.012;
      const wobbleDuration = 4000;
      const wobbleInterval = 50;
      let elapsed = 0;

      const wobbleTimer = setInterval(() => {
        elapsed += wobbleInterval;
        if (elapsed >= wobbleDuration) {
          camera.target.copyFrom(origTarget);
          clearInterval(wobbleTimer);
          return;
        }
        // Ramp down over time
        const t = 1 - elapsed / wobbleDuration;
        camera.target.x = origTarget.x + (Math.random() - 0.5) * wobbleIntensity * t;
        camera.target.y = origTarget.y + (Math.random() - 0.5) * wobbleIntensity * t;
      }, wobbleInterval);
    }
  }

  // ── Explosion Effect ────────────────────────────────────────────────────

  playExplosionEffect(position: Vector3): void {
    this.vfxManager.playExplosion(position);
    this.soundManager.playExplosion();

    // Heavy camera shake — strong initial punch, fast decay
    const camera = this.scene.activeCamera as ArcRotateCamera | null;
    if (camera) {
      const origTarget = camera.target.clone();
      const shakeIntensity = 0.08;
      const shakeDuration = 400;
      const shakeInterval = 16; // ~60fps
      let elapsed = 0;

      const shakeTimer = setInterval(() => {
        elapsed += shakeInterval;
        if (elapsed >= shakeDuration) {
          camera.target.copyFrom(origTarget);
          clearInterval(shakeTimer);
          return;
        }
        // Exponential decay for snappy "punch" feel
        const t = Math.exp(-elapsed / 80) ;
        camera.target.x = origTarget.x + (Math.random() - 0.5) * shakeIntensity * t;
        camera.target.y = origTarget.y + (Math.random() - 0.5) * shakeIntensity * t;
      }, shakeInterval);
    }
  }

  // ── Lightning Effect ───────────────────────────────────────────────────

  playLightningEffect(): void {
    this.vfxManager.playLightning(3.0);
    this.soundManager.playLightning();

    // Gentle camera wobble over 3s (like tornado), linear decay
    const camera = this.scene.activeCamera as ArcRotateCamera | null;
    if (camera) {
      const origTarget = camera.target.clone();
      const wobbleIntensity = 0.02;
      const wobbleDuration = 3000;
      const wobbleInterval = 50;
      let elapsed = 0;

      const wobbleTimer = setInterval(() => {
        elapsed += wobbleInterval;
        if (elapsed >= wobbleDuration) {
          camera.target.copyFrom(origTarget);
          clearInterval(wobbleTimer);
          return;
        }
        const t = 1 - elapsed / wobbleDuration;
        camera.target.x = origTarget.x + (Math.random() - 0.5) * wobbleIntensity * t;
        camera.target.y = origTarget.y + (Math.random() - 0.5) * wobbleIntensity * t;
      }, wobbleInterval);
    }
  }

  // ── VFX Triggers (called from App) ─────────────────────────────────────

  playCoinInsertVFX(slotIndex: number): void {
    this.vfxManager.playCoinInsert(slotIndex);
  }

  playComboVFX(count: number): void {
    this.vfxManager.playCombo(count);
  }

  playRewardCoinRain(duration?: number): void {
    this.vfxManager.playRewardCoinRain(duration);
  }

  playRewardTicketRain(duration?: number): void {
    this.vfxManager.playRewardTicketRain(duration);
  }

  getScene(): Scene {
    return this.scene;
  }

  getEngine(): Engine {
    return this.engine;
  }
}
