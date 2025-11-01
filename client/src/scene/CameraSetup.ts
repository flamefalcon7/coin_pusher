import { ArcRotateCamera, Vector3, Scene } from '@babylonjs/core';

export class CameraSetup {
  private camera: ArcRotateCamera;

  constructor(scene: Scene, canvas: HTMLCanvasElement) {
    // Create ArcRotateCamera
    // Target: center of main platform (0, 0.3, 0)
    // Alpha: -π/2 (view from front-right)
    // Beta: π/3 (45 degrees above horizontal)
    // Radius: 3 meters
    this.camera = new ArcRotateCamera(
      'camera',
      -Math.PI / 2,
      Math.PI / 3,
      3,
      new Vector3(0, 0.3, 0),
      scene
    );

    // Attach controls to canvas
    this.camera.attachControl(canvas, true);

    // Limit zoom range (2-4 meters for mobile)
    this.camera.lowerRadiusLimit = 2;
    this.camera.upperRadiusLimit = 4;

    // Limit vertical rotation (prevent flipping)
    this.camera.lowerBetaLimit = Math.PI / 6; // 30 degrees
    this.camera.upperBetaLimit = Math.PI / 2.2; // ~80 degrees

    // Smooth camera movement
    this.camera.inertia = 0.8;
    this.camera.angularSensibilityX = 1000;
    this.camera.angularSensibilityY = 1000;
    this.camera.wheelPrecision = 50;

    // Panning settings
    this.camera.panningSensibility = 0; // Disable panning

    console.log('📷 Camera initialized');
  }

  getCamera(): ArcRotateCamera {
    return this.camera;
  }
}

