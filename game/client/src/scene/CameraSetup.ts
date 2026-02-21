import { ArcRotateCamera, Vector3, Scene, Engine } from "@babylonjs/core";

const BASE_RADIUS = 3;
const MIN_RADIUS = 2;
const MAX_RADIUS = 5;

export class CameraSetup {
  private camera: ArcRotateCamera;

  constructor(scene: Scene, canvas: HTMLCanvasElement) {
    this.camera = new ArcRotateCamera(
      "camera",
      Math.PI / 2,
      Math.PI / 2.5,
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

    // Adjust radius for narrow (portrait) screens
    const engine = scene.getEngine();
    this.adjustRadiusForAspect(engine);
    engine.onResizeObservable.add(() => this.adjustRadiusForAspect(engine));

    console.log("Camera initialized");
  }

  private adjustRadiusForAspect(engine: Engine): void {
    const aspect = engine.getAspectRatio(this.camera);
    // Portrait or narrow screens: pull camera back so full table width is visible
    // aspect ~0.5 (phone portrait) → radius ~4.2
    // aspect ~1.0 (square/tablet) → radius ~3
    // aspect ≥1.3 (landscape) → radius stays at BASE_RADIUS
    if (aspect < 1.3) {
      this.camera.radius = Math.min(
        MAX_RADIUS,
        BASE_RADIUS * (1.3 / aspect)
      );
    }
  }

  getCamera(): ArcRotateCamera {
    return this.camera;
  }
}
