import { HemisphericLight, Vector3, Scene, Color3 } from '@babylonjs/core';

export class Lighting {
  private light: HemisphericLight;

  constructor(scene: Scene) {
    // Create hemispheric light (no real-time shadows for PoC)
    this.light = new HemisphericLight(
      'light',
      new Vector3(0, 1, 0),
      scene
    );

    // Set light intensity
    this.light.intensity = 0.8;

    // Set light colors
    this.light.diffuse = new Color3(1, 1, 1);
    this.light.specular = new Color3(0.3, 0.3, 0.3);
    this.light.groundColor = new Color3(0.3, 0.3, 0.4);

    console.log('💡 Lighting initialized');
  }

  getLight(): HemisphericLight {
    return this.light;
  }
}

