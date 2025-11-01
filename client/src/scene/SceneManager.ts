import { Engine, Scene } from '@babylonjs/core';
import { CameraSetup } from './CameraSetup';
import { Lighting } from './Lighting';
import { StaticMeshes } from './StaticMeshes';
import { PusherMesh } from './PusherMesh';
import { CoinMeshManager } from './CoinMeshManager';

export class SceneManager {
  private engine: Engine;
  private scene: Scene;
  private pusherMesh: PusherMesh;
  private coinManager: CoinMeshManager;
  private running: boolean = false;
  private fpsCallback?: (fps: number) => void;

  constructor(canvas: HTMLCanvasElement) {
    console.log('🎮 Initializing BabylonJS scene...');

    // Create engine
    this.engine = new Engine(canvas, true, {
      preserveDrawingBuffer: true,
      stencil: true,
    });

    // Create scene
    this.scene = new Scene(this.engine);

    // IMPORTANT: Set right-handed coordinate system
    this.scene.useRightHandedSystem = true;

    console.log('✅ Right-handed coordinate system enabled');

    // Initialize components
    new CameraSetup(this.scene, canvas);
    new Lighting(this.scene);
    new StaticMeshes(this.scene);
    this.pusherMesh = new PusherMesh(this.scene);
    this.coinManager = new CoinMeshManager(this.scene);

    console.log('✅ Scene initialized successfully');

    // Handle window resize
    window.addEventListener('resize', () => {
      this.engine.resize();
    });
  }

  startRenderLoop(): void {
    if (this.running) return;

    this.running = true;
    console.log('▶️  Render loop started');

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
    console.log('⏸️  Render loop stopped');
  }

  updatePusherPosition(z: number): void {
    this.pusherMesh.updatePosition(z);
  }

  addCoin(id: number, pos: [number, number, number], rot: [number, number, number, number]): void {
    this.coinManager.addCoin(id, pos, rot);
  }

  updateCoin(id: number, pos: [number, number, number], rot: [number, number, number, number]): void {
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

  setFpsCallback(callback: (fps: number) => void): void {
    this.fpsCallback = callback;
  }

  dispose(): void {
    this.stopRenderLoop();
    this.scene.dispose();
    this.engine.dispose();
    console.log('🗑️  Scene disposed');
  }

  getScene(): Scene {
    return this.scene;
  }

  getEngine(): Engine {
    return this.engine;
  }
}

