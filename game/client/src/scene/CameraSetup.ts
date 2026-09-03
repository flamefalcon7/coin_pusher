import { ArcRotateCamera, Vector3, Scene, Engine } from "@babylonjs/core";

const BASE_RADIUS = 3;
const MIN_RADIUS = 2;
const MAX_RADIUS = 5.5;

export class CameraSetup {
  private camera: ArcRotateCamera;
  private resizeObserver: ReturnType<typeof Engine.prototype.onResizeObservable.add> | null = null;
  private engine: Engine;
  private isAdmin: boolean;

  constructor(scene: Scene, canvas: HTMLCanvasElement, isAdmin = false) {
    this.isAdmin = isAdmin;
    this.camera = new ArcRotateCamera(
      "camera",
      Math.PI / 2,
      Math.PI / 3,
      BASE_RADIUS,
      new Vector3(0, 1, 0),
      scene
    );

    this.camera.attachControl(canvas, true);

    this.camera.lowerRadiusLimit = MIN_RADIUS;
    this.camera.upperRadiusLimit = MAX_RADIUS;

    this.camera.inertia = 0.8;
    this.camera.angularSensibilityX = 1000;
    this.camera.angularSensibilityY = 1000;
    this.camera.wheelPrecision = 50;

    this.camera.panningSensibility = 0;

    this.applyRotationLock();

    // Adjust radius for narrow (portrait) screens
    this.engine = scene.getEngine();
    this.adjustRadiusForAspect(this.engine);
    this.resizeObserver = this.engine.onResizeObservable.add(() => this.adjustRadiusForAspect(this.engine));

    console.log("Camera initialized");
  }

  /**
   * Switch the free-camera privilege at runtime (admin login mid-session).
   * The scene is built once at mount, so the constructor flag alone would
   * leave a freshly signed-in admin with a locked camera until reload.
   */
  setAdmin(isAdmin: boolean): void {
    if (this.isAdmin === isAdmin) return;
    this.isAdmin = isAdmin;
    this.applyRotationLock();
    this.adjustRadiusForAspect(this.engine);
  }

  // Lock camera rotation for non-admin players (radius lock handled in adjustRadiusForAspect)
  private applyRotationLock(): void {
    if (this.isAdmin) {
      this.camera.lowerAlphaLimit = null;
      this.camera.upperAlphaLimit = null;
      this.camera.lowerBetaLimit = 0.01;
      this.camera.upperBetaLimit = Math.PI - 0.01;
      this.camera.lowerRadiusLimit = MIN_RADIUS;
      this.camera.upperRadiusLimit = MAX_RADIUS;
      return;
    }
    this.camera.lowerAlphaLimit = this.camera.alpha;
    this.camera.upperAlphaLimit = this.camera.alpha;
    this.camera.lowerBetaLimit = this.camera.beta;
    this.camera.upperBetaLimit = this.camera.beta;
  }

  private adjustRadiusForAspect(engine: Engine): void {
    const aspect = engine.getAspectRatio(this.camera);
    // Portrait or narrow screens: pull camera back so full table width is visible
    // aspect ~0.5 (phone portrait) → radius ~6.5
    // aspect ~1.0 (square/tablet) → radius ~3.9
    // aspect ≥1.3 (landscape/desktop) → radius stays at BASE_RADIUS
    if (aspect < 1.3) {
      this.camera.radius = Math.min(
        MAX_RADIUS,
        BASE_RADIUS * (1.3 / aspect)
      );
    } else {
      this.camera.radius = BASE_RADIUS;
    }
    // Lock radius for non-admin after adjustment
    if (!this.isAdmin) {
      this.camera.lowerRadiusLimit = this.camera.radius;
      this.camera.upperRadiusLimit = this.camera.radius;
    }
  }

  getCamera(): ArcRotateCamera {
    return this.camera;
  }

  dispose(): void {
    if (this.resizeObserver) {
      this.engine.onResizeObservable.remove(this.resizeObserver);
      this.resizeObserver = null;
    }
  }
}
