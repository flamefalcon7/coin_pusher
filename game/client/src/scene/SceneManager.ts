import { Engine, Scene, Color3, ArcRotateCamera, StandardMaterial } from "@babylonjs/core";
import { CameraSetup } from "./CameraSetup";
import { Lighting } from "./Lighting";
import { StaticMeshes } from "./StaticMeshes";
import { PusherMesh } from "./PusherMesh";
import { CoinMeshManager } from "./CoinMeshManager";
import { SoundManager } from "./SoundManager";

export class SceneManager {
  private engine: Engine;
  private scene: Scene;
  private pusherMesh: PusherMesh;
  private coinManager: CoinMeshManager;
  private soundManager: SoundManager;
  private running: boolean = false;
  private fpsCallback?: (fps: number) => void;

  constructor(canvas: HTMLCanvasElement) {
    console.log("🎮 Initializing BabylonJS scene...");

    // Create engine
    this.engine = new Engine(canvas, true, {
      preserveDrawingBuffer: true,
      stencil: true,
    });

    // Create scene
    this.scene = new Scene(this.engine);

    // IMPORTANT: Set right-handed coordinate system
    this.scene.useRightHandedSystem = true;

    console.log("✅ Right-handed coordinate system enabled");

    // Initialize components
    new CameraSetup(this.scene, canvas);
    new Lighting(this.scene);
    new StaticMeshes(this.scene);
    this.pusherMesh = new PusherMesh(this.scene);
    this.coinManager = new CoinMeshManager(this.scene);
    this.soundManager = new SoundManager();

    console.log("✅ Scene initialized successfully");

    // Handle window resize
    window.addEventListener("resize", () => {
      this.engine.resize();
    });
  }

  startRenderLoop(): void {
    if (this.running) return;

    this.running = true;
    console.log("▶️  Render loop started");

    this.engine.runRenderLoop(() => {
      this.scene.render();

      // Update FPS callback
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

  playShockEffect(): void {
    // 1. Camera shake
    const camera = this.scene.activeCamera as ArcRotateCamera | null;
    if (camera) {
      const origTarget = camera.target.clone();
      const shakeIntensity = 0.03;
      const shakeDuration = 300; // ms
      const shakeInterval = 30; // ms per frame
      let elapsed = 0;

      const shakeTimer = setInterval(() => {
        elapsed += shakeInterval;
        if (elapsed >= shakeDuration) {
          camera.target.copyFrom(origTarget);
          clearInterval(shakeTimer);
          return;
        }
        // Decay shake over time
        const t = 1 - elapsed / shakeDuration;
        camera.target.x = origTarget.x + (Math.random() - 0.5) * shakeIntensity * t;
        camera.target.y = origTarget.y + (Math.random() - 0.5) * shakeIntensity * t;
      }, shakeInterval);
    }

    // 2. Pin material flash (orange glow → fade back)
    const pinMat = this.scene.getMaterialByName("pinMat") as StandardMaterial | null;
    if (pinMat) {
      const origEmissive = pinMat.emissiveColor.clone();
      const flashColor = new Color3(1.0, 0.5, 0.0); // orange
      pinMat.emissiveColor = flashColor;

      const fadeDuration = 400; // ms
      const fadeInterval = 30;
      let fadeElapsed = 0;

      const fadeTimer = setInterval(() => {
        fadeElapsed += fadeInterval;
        if (fadeElapsed >= fadeDuration) {
          pinMat.emissiveColor = origEmissive;
          clearInterval(fadeTimer);
          return;
        }
        const t = fadeElapsed / fadeDuration;
        pinMat.emissiveColor = Color3.Lerp(flashColor, origEmissive, t);
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
