import { Engine, Scene, Color3, Color4, ArcRotateCamera, ShaderMaterial, Vector3 } from "@babylonjs/core";
import type { SlotSymbol } from "@coin-pusher/shared";
import { CameraSetup } from "./CameraSetup";
import { Lighting } from "./Lighting";
import { StaticMeshes } from "./StaticMeshes";
import { PusherMesh } from "./PusherMesh";
import { CoinMeshManager } from "./CoinMeshManager";
import { SoundManager } from "./SoundManager";
import { PostProcessing } from "./PostProcessing";
import { VFXManager } from "./VFXManager";
import { THEMES, ToonTheme, deriveShadow, deriveHighlight } from "./ToonTheme";

// All toon material names to track
const TOON_MAT_NAMES = [
  "platformMat", "wallMat", "pinMat", "pusherMat", "rampMat",
  "doodleWallMat", "doodleOutlineMat", "doodleBlobMat", "doodleBurstMat",
  "doodleBumpMat", "doodleBumpMat1", "doodleBumpMat2", "doodleBumpMat3", "doodleBumpMat4", "doodleBumpMat5",
  "slotCabinetMat", "slotTrimMat", "slotWindowMat",
  "slotReelMat0", "slotReelMat1", "slotReelMat2",
  "slotLightMat", "slotPanelMat", "slotOutlineMat",
  "bumperRailMat", "panelDividerMat", "coinMat",
] as const;

export class SceneManager {
  private engine: Engine;
  private scene: Scene;
  private staticMeshes: StaticMeshes;
  private pusherMesh: PusherMesh;
  private coinManager: CoinMeshManager;
  private soundManager: SoundManager;
  private postProcessing: PostProcessing;
  private vfxManager: VFXManager;
  private running: boolean = false;
  private fpsCallback?: (fps: number) => void;
  private currentThemeIndex: number = 0;

  // Unified toon material tracking
  private celShadingEnabled: boolean = true;
  private toonMats: Map<string, ShaderMaterial> = new Map();
  private allToonMats: ShaderMaterial[] = [];

  // Pin flash: cache original color for fade-back
  private pinOrigColor: Color3 = new Color3(0.7, 0.7, 0.85);

  // Observable + timer tracking for cleanup
  private toonObserver: ReturnType<Scene["onBeforeRenderObservable"]["add"]> | null = null;
  private activeTimers: ReturnType<typeof setInterval>[] = [];
  private resizeHandler = () => this.engine.resize();

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
    this.staticMeshes = new StaticMeshes(this.scene);
    this.pusherMesh = new PusherMesh(this.scene);
    this.coinManager = new CoinMeshManager(this.scene);
    this.soundManager = new SoundManager();

    this.postProcessing = new PostProcessing(this.scene);

    // Cache all toon ShaderMaterial references
    for (const name of TOON_MAT_NAMES) {
      const mat = this.scene.getMaterialByName(name);
      if (mat && mat instanceof ShaderMaterial) {
        this.toonMats.set(name, mat);
        this.allToonMats.push(mat);
      }
    }

    // Per-frame uniform updates (time + cameraPosition)
    const camera = this.scene.activeCamera;
    this.toonObserver = this.scene.onBeforeRenderObservable.add(() => {
      const t = performance.now() / 1000;
      const camPos = camera ? (camera as ArcRotateCamera).position : Vector3.Zero();
      for (const mat of this.allToonMats) {
        mat.setFloat("time", t);
        mat.setVector3("cameraPosition", camPos);
      }
    });

    // Initialize VFX
    this.vfxManager = new VFXManager(this.scene);

    // Apply default theme (also initializes VFX after theme colors are set)
    this.applyTheme(THEMES[0]);

    // Start VFX after theme is applied so wall colors are cached correctly
    this.vfxManager.init();

    console.log("Scene initialized successfully");

    window.addEventListener("resize", this.resizeHandler);
  }

  // ── Theme ────────────────────────────────────────────────────────────────

  applyTheme(theme: ToonTheme): void {
    this.scene.clearColor = theme.clearColor;

    const colorMap: Record<string, Color3> = {
      platformMat: theme.platform,
      wallMat: theme.wall,
      pinMat: theme.pin,
      pusherMat: theme.pusher,
      rampMat: theme.platform,
      coinMat: theme.coin,
      // Doodle decorations follow the wall color
      doodleWallMat: theme.wall,
      doodleBumpMat: theme.wall,
      doodleBlobMat: theme.wall,
      doodleBurstMat: theme.coin,       // accent matches coin color
      doodleOutlineMat: new Color3(0.1, 0.1, 0.1),  // always near-black
      bumperRailMat: theme.pin,
      panelDividerMat: theme.pin,
    };

    for (const [name, color] of Object.entries(colorMap)) {
      const mat = this.toonMats.get(name);
      if (mat) {
        mat.setColor3("baseColor", color);
        mat.setColor3("shadowColor", deriveShadow(color, theme.shadowTint));
        mat.setColor3("highlightColor", deriveHighlight(color));
        mat.setColor3("rimColor", theme.rim);
      }
    }

    // Cache pin color for shock effect fade-back
    this.pinOrigColor = theme.pin.clone();

    // Refresh VFX wall color cache after theme change
    this.vfxManager.refreshWallColor(theme.wall);

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
    const value = this.celShadingEnabled ? 1.0 : 0.0;

    for (const mat of this.allToonMats) {
      mat.setFloat("useCelShading", value);
    }

    console.log(`Cel shading: ${this.celShadingEnabled ? "ON" : "OFF"}`);
    return this.celShadingEnabled;
  }

  isCelShadingEnabled(): boolean {
    return this.celShadingEnabled;
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

    // Clear tracked timers from camera effects
    for (const t of this.activeTimers) clearInterval(t);
    this.activeTimers = [];

    // Remove render observable before scene dispose
    if (this.toonObserver) {
      this.scene.onBeforeRenderObservable.remove(this.toonObserver);
      this.toonObserver = null;
    }

    window.removeEventListener("resize", this.resizeHandler);

    this.vfxManager.dispose();
    this.postProcessing.dispose();
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
      this.activeTimers.push(shakeTimer);
    }

    // 2. Pin flash — modify baseColor uniform on ShaderMaterial
    const pinMat = this.toonMats.get("pinMat");
    if (pinMat) {
      const origColor = this.pinOrigColor.clone();
      const flashColor = new Color3(1.0, 0.6, 0.1);

      pinMat.setColor3("baseColor", flashColor);

      const fadeDuration = 400;
      const fadeInterval = 30;
      let fadeElapsed = 0;

      const fadeTimer = setInterval(() => {
        fadeElapsed += fadeInterval;
        if (fadeElapsed >= fadeDuration) {
          pinMat.setColor3("baseColor", origColor);
          clearInterval(fadeTimer);
          return;
        }
        const t = fadeElapsed / fadeDuration;
        pinMat.setColor3("baseColor", Color3.Lerp(flashColor, origColor, t));
      }, fadeInterval);
      this.activeTimers.push(fadeTimer);
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
      this.activeTimers.push(wobbleTimer);
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
      this.activeTimers.push(shakeTimer);
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
      this.activeTimers.push(wobbleTimer);
    }
  }

  // ── Slot Machine ─────────────────────────────────────────────────────────

  playSlotSpin(reels: [SlotSymbol, SlotSymbol, SlotSymbol], jackpot: boolean): void {
    const slotMachine = this.staticMeshes.getSlotMachine();
    if (!slotMachine) return;

    this.soundManager.playSlotSpin();
    slotMachine.spinReels(reels, jackpot, () => {
      if (jackpot) {
        this.soundManager.playJackpot();
        this.vfxManager.playRewardCoinRain(3.0);
      }
    });
  }

  updateSlotCounter(counter: number): void {
    const slotMachine = this.staticMeshes.getSlotMachine();
    slotMachine?.updateCounter(counter);
  }

  // ── VFX Triggers (called from App) ─────────────────────────────────────

  playCoinInsertVFX(slotIndex: number): void {
    this.vfxManager.playCoinInsert(slotIndex);
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

  getPostProcessing(): PostProcessing {
    return this.postProcessing;
  }

  getAllToonMats(): ShaderMaterial[] {
    return this.allToonMats;
  }

  getLightDirection(): Vector3 {
    // Read from the first toon material (all share the same value)
    return new Vector3(0.3, -0.7, 0.5); // default; real value read by GUI from mat uniforms
  }

  setLightDirection(v: Vector3): void {
    for (const mat of this.allToonMats) {
      mat.setVector3("lightDirection", v);
    }
  }
}
