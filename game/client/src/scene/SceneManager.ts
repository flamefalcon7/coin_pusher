import { Engine, Scene, Color3, Color4, ArcRotateCamera, ShaderMaterial, Vector3 } from "@babylonjs/core";
import type { SlotSymbol } from "@coin-pusher/shared";
import { SLOT_MACHINE_CONFIG, SUPER_PUSH_CONFIG, JACKPOT_WHEEL_CONFIG } from "@coin-pusher/shared";
import { CameraSetup } from "./CameraSetup";
import { Lighting } from "./Lighting";
import { StaticMeshes } from "./StaticMeshes";
import { PusherMesh } from "./PusherMesh";
import { CoinMeshManager } from "./CoinMeshManager";
import { SoundManager } from "./SoundManager";
import { PostProcessing } from "./PostProcessing";
import { VFXManager } from "./VFXManager";
import { maybeInstallDebugReadout, extendDebugApi, type DebugReadout } from "./DebugReadout";
import { DebugCameraController } from "./DebugCamera";
import { DebugSceneAids } from "./DebugSceneAids";
import { TargetingReticle, type TargetingType } from "./TargetingReticle";
import { THEMES, ToonTheme, deriveShadow, deriveHighlight } from "./ToonTheme";
import { SponsorAdPlacements } from "./SponsorAdPlacements";
import type { SponsorConfigMessage } from "@coin-pusher/shared";

// All toon material names to track
const TOON_MAT_NAMES = [
  "platformMat", "wallMat", "pinMat", "pusherMat", "rampMat",
  "pacManMat", "pacManEyeMat", "pacDotMat",
  "slotCabinetMat", "slotTrimMat", "slotWindowMat",
  "slotReelMat0", "slotReelMat1", "slotReelMat2",
  "slotLightMat", "slotPanelMat", "slotOutlineMat",
  "bumperRailMat", "panelDividerMat", "coinMat", "keyCoinMat",
  "honeycombWallMat",
  "wheelBezelMat", "wheelPointerMat", "wheelPanelMat", "wheelCenterMat",
  "wheelSeg0", "wheelSeg1", "wheelSeg2", "wheelSeg3",
  "wheelSeg4", "wheelSeg5", "wheelSeg6", "wheelSeg7",
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
  private targetingReticle: TargetingReticle;
  private sponsorAdPlacements: SponsorAdPlacements;
  private debugReadout: DebugReadout | null = null;
  private debugCamera: DebugCameraController | null = null;
  private debugAids: DebugSceneAids | null = null;
  private running: boolean = false;
  private fpsCallback?: (fps: number) => void;
  private currentThemeIndex: number = 0;

  // Unified toon material tracking
  private celShadingEnabled: boolean = true;
  private toonMats: Map<string, ShaderMaterial> = new Map();
  private allToonMats: ShaderMaterial[] = [];

  // Pin flash: cache original color for fade-back
  private pinOrigColor: Color3 = new Color3(0.7, 0.7, 0.85);

  // Reusable scratch Color3 for per-tick lerp (avoids allocation)
  private static _scratchColor = new Color3();

  // Observable + timer tracking for cleanup
  private toonObserver: ReturnType<Scene["onBeforeRenderObservable"]["add"]> | null = null;
  private activeTimers: ReturnType<typeof setInterval>[] = [];
  private resizeHandler = () => this.engine.resize();

  constructor(canvas: HTMLCanvasElement, isAdmin = false) {
    console.log("Initializing BabylonJS scene...");

    this.engine = new Engine(canvas, true, {
      preserveDrawingBuffer: true,
      stencil: true,
      adaptToDeviceRatio: true,
    });

    this.scene = new Scene(this.engine);
    this.scene.useRightHandedSystem = true;
    this.scene.clearColor = new Color4(0.02, 0.02, 0.06, 1.0);

    const cameraSetup = new CameraSetup(this.scene, canvas, isAdmin);
    new Lighting(this.scene);
    this.staticMeshes = new StaticMeshes(this.scene);
    this.pusherMesh = new PusherMesh(this.scene);
    this.coinManager = new CoinMeshManager(this.scene);
    this.soundManager = new SoundManager();

    // Initialize sponsor ad placements
    this.sponsorAdPlacements = new SponsorAdPlacements(this.scene);
    const backWallGroupForAds = this.staticMeshes.getBackWallGroup();
    if (backWallGroupForAds) {
      this.sponsorAdPlacements.createBackWallAd(backWallGroupForAds);
    }
    const leftWallGroup = this.staticMeshes.getLeftWallFrontParent();
    const rightWallGroup = this.staticMeshes.getRightWallFrontParent();
    if (leftWallGroup && rightWallGroup) {
      this.sponsorAdPlacements.createSideWallAds(leftWallGroup, rightWallGroup);
    }

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

    // Initialize targeting reticle (after VFX init)
    this.targetingReticle = new TargetingReticle(this.scene);

    // Initialize hole portal VFX (must be after StaticMeshes + VFXManager init)
    const leftWallParent = this.staticMeshes.getLeftWallFrontParent();
    const rightWallParent = this.staticMeshes.getRightWallFrontParent();
    if (leftWallParent && rightWallParent) {
      this.vfxManager.initHolePortals(leftWallParent, rightWallParent);
    }

    // Initialize forging coin slot VFX on back wall
    const backWallGroup = this.staticMeshes.getBackWallGroup();
    if (backWallGroup) {
      this.vfxManager.initCoinSlots(backWallGroup);
    }

    console.log("Scene initialized successfully");

    // Scrapeable debug HUD (window.__coinpusher_debug) — only when ?debug=1.
    this.debugReadout = maybeInstallDebugReadout({
      engine: this.engine,
      scene: this.scene,
      vfx: this.vfxManager,
      getCoinCount: () => this.coinManager.getCoinCount(),
    });

    // Agent perception aids (R2): deterministic camera presets + axis gizmo
    // and platform grid. Gated on the readout so they share the ?debug=1 gate.
    if (this.debugReadout) {
      this.debugAids = new DebugSceneAids(this.scene);
      this.debugCamera = new DebugCameraController(this.engine, cameraSetup.getCamera());
      extendDebugApi({
        camera: (preset) => this.debugCamera?.applyPreset(preset),
      });
    }

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
      // Pac-Man follows coin color for fun pop
      pacManMat: theme.coin,
      pacManEyeMat: new Color3(0.05, 0.05, 0.08),  // always near-black
      bumperRailMat: theme.pin,
      panelDividerMat: theme.pin,
      honeycombWallMat: theme.wall,
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

    // Set honeycomb glow color from theme rim
    const honeycombMat = this.toonMats.get("honeycombWallMat");
    if (honeycombMat) {
      honeycombMat.setColor3("honeycombGlowColor", theme.rim);
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

  /**
   * Register a callback that runs every frame BEFORE the scene renders.
   * This ensures game state updates and rendering are in the same frame,
   * eliminating the desync between two independent rAF loops.
   */
  onBeforeRender(callback: () => void): void {
    this.scene.registerBeforeRender(callback);
  }

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
    rot: [number, number, number, number],
    isKeyCoin?: boolean
  ): void {
    this.coinManager.addCoin(id, pos, rot, isKeyCoin);
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

  enableBatchAnimation(durationMs?: number): void {
    this.coinManager.enableBatchAnimation(durationMs);
  }

  addCoinHighlight(coinId: number, colorIndex: number): void {
    this.coinManager.addRankHighlight(coinId, colorIndex);
  }

  updateCoinHighlights(): void {
    this.coinManager.updateHighlights();
  }

  /** Finalize pending coins (batch detection) + advance animations + push to GPU. */
  updateCoinBuffers(dt: number): void {
    this.coinManager.commitNewCoins();
    this.coinManager.updateAnimations(dt);
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

    this.debugAids?.dispose();
    this.debugAids = null;
    this.debugCamera = null;
    this.debugReadout?.dispose();
    this.debugReadout = null;
    this.targetingReticle.dispose();
    this.sponsorAdPlacements.dispose();
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
        Color3.LerpToRef(flashColor, origColor, t, SceneManager._scratchColor);
        pinMat.setColor3("baseColor", SceneManager._scratchColor);
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

  // ── Super Push Effect ────────────────────────────────────────────────────

  playSuperPushEffect(): void {
    this.vfxManager.playSuperPush();
    this.soundManager.playSuperPush();

    const camera = this.scene.activeCamera as ArcRotateCamera | null;
    const { PULLBACK_DURATION, RECOVERY_DURATION } = SUPER_PUSH_CONFIG;

    // 1. Camera zoom-in during charge phase (0 - PULLBACK_DURATION ms)
    if (camera) {
      const origRadius = camera.radius;
      const zoomAmount = 0.25;
      const zoomInterval = 30;
      let zoomElapsed = 0;

      const zoomTimer = setInterval(() => {
        zoomElapsed += zoomInterval;
        if (zoomElapsed >= PULLBACK_DURATION) {
          camera.radius = origRadius - zoomAmount;
          clearInterval(zoomTimer);
          return;
        }
        const t = zoomElapsed / PULLBACK_DURATION;
        camera.radius = origRadius - zoomAmount * t;
      }, zoomInterval);
      this.activeTimers.push(zoomTimer);

      // 2. Camera shake at thrust moment
      const shakeTimer = setTimeout(() => {
        const origTarget = camera.target.clone();
        const shakeIntensity = 0.10;
        const shakeDuration = 450;
        const shakeInterval = 16;
        let shakeElapsed = 0;

        const innerShake = setInterval(() => {
          shakeElapsed += shakeInterval;
          if (shakeElapsed >= shakeDuration) {
            camera.target.copyFrom(origTarget);
            clearInterval(innerShake);

            // 3. Snap camera back to original radius over 300ms
            const snapDuration = 300;
            const snapInterval = 30;
            let snapElapsed = 0;
            const snapStart = camera.radius;

            const snapTimer = setInterval(() => {
              snapElapsed += snapInterval;
              if (snapElapsed >= snapDuration) {
                camera.radius = origRadius;
                clearInterval(snapTimer);
                return;
              }
              const st = snapElapsed / snapDuration;
              camera.radius = snapStart + (origRadius - snapStart) * st;
            }, snapInterval);
            this.activeTimers.push(snapTimer);
            return;
          }
          const t = Math.exp(-shakeElapsed / 100);
          camera.target.x = origTarget.x + (Math.random() - 0.5) * shakeIntensity * t;
          camera.target.y = origTarget.y + (Math.random() - 0.5) * shakeIntensity * t;
        }, shakeInterval);
        this.activeTimers.push(innerShake);
      }, PULLBACK_DURATION);
      this.activeTimers.push(shakeTimer as unknown as ReturnType<typeof setInterval>);
    }

    // 4. Pusher glow: change pusher toon material to deep red at thrust, lerp back
    const pusherMat = this.toonMats.get("pusherMat");
    if (pusherMat) {
      const origColor = THEMES[this.currentThemeIndex].pusher.clone();
      const glowColor = new Color3(1.0, 0.15, 0.05);

      const glowTimer = setTimeout(() => {
        pusherMat.setColor3("baseColor", glowColor);

        const fadeDuration = RECOVERY_DURATION;
        const fadeInterval = 30;
        let fadeElapsed = 0;

        const fadeTimer = setInterval(() => {
          fadeElapsed += fadeInterval;
          if (fadeElapsed >= fadeDuration) {
            pusherMat.setColor3("baseColor", origColor);
            clearInterval(fadeTimer);
            return;
          }
          const t = fadeElapsed / fadeDuration;
          Color3.LerpToRef(glowColor, origColor, t, SceneManager._scratchColor);
          pusherMat.setColor3("baseColor", SceneManager._scratchColor);
        }, fadeInterval);
        this.activeTimers.push(fadeTimer);
      }, PULLBACK_DURATION);
      this.activeTimers.push(glowTimer as unknown as ReturnType<typeof setInterval>);
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
    this.vfxManager.updateHoleProgress("left", counter, SLOT_MACHINE_CONFIG.TRIGGER_COUNT);
  }

  // ── Jackpot Wheel ───────────────────────────────────────────────────────

  spinJackpotWheel(resultSegment: number, reward: number, onComplete?: () => void): void {
    const wheel = this.staticMeshes.getJackpotWheel();
    if (!wheel) return;
    this.soundManager.playWheelSpin();
    wheel.spinWheel(resultSegment, reward, onComplete);
  }

  updateWheelCounter(counter: number): void {
    const wheel = this.staticMeshes.getJackpotWheel();
    wheel?.updateCounter(counter);
    this.vfxManager.updateHoleProgress("right", counter, JACKPOT_WHEEL_CONFIG.TRIGGER_COUNT);
  }

  getJackpotWheel() {
    return this.staticMeshes.getJackpotWheel();
  }

  // ── Targeting Reticle ──────────────────────────────────────────────────

  showTargetingReticle(type: TargetingType): void {
    this.targetingReticle.show(type);
  }

  hideTargetingReticle(): void {
    this.targetingReticle.hide();
  }

  updateTargetingReticle(pos: Vector3): void {
    this.targetingReticle.update(pos);
  }

  confirmTargetingReticle(): void {
    this.targetingReticle.playConfirm();
  }

  isTargetingReticleVisible(): boolean {
    return this.targetingReticle.isVisible();
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

  // ── Sponsor Config ───────────────────────────────────────────────────

  updateSponsorConfig(sponsors: SponsorConfigMessage["sponsors"]): void {
    // Create/update coin prototypes
    for (const sponsor of sponsors) {
      this.coinManager.createSponsorCoinPrototype(sponsor.id, sponsor.brand_color, sponsor.logo_url);
    }

    // Update ad placements
    this.sponsorAdPlacements.updateSponsorCreatives(sponsors);
  }

  addCoinWithSponsor(
    id: number,
    pos: [number, number, number],
    rot: [number, number, number, number],
    isKeyCoin?: boolean,
    sponsorId?: string
  ): void {
    this.coinManager.addCoin(id, pos, rot, isKeyCoin, sponsorId);
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
