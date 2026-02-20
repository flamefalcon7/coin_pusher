import { HemisphericLight, DirectionalLight, Vector3, Scene, Color3 } from '@babylonjs/core';

export class Lighting {
  private light: HemisphericLight;
  private dirLight: DirectionalLight;

  constructor(scene: Scene) {
    // Hemispheric light (ambient fill only)
    this.light = new HemisphericLight(
      'light',
      new Vector3(0, 1, 0),
      scene
    );

    this.light.intensity = 0.65;
    this.light.diffuse = new Color3(1.0, 0.85, 0.95);    // Pink-warm tint
    this.light.specular = new Color3(0.3, 0.25, 0.3);
    this.light.groundColor = new Color3(0.15, 0.08, 0.25); // Purple ambient

    // Directional light — intensity 0, used only as direction vector for toon shader
    this.dirLight = new DirectionalLight(
      'dirLight',
      new Vector3(0.3, -0.7, 0.5),
      scene
    );
    this.dirLight.intensity = 0;

    console.log('💡 Lighting initialized');
  }

  getLight(): HemisphericLight {
    return this.light;
  }

  getLightDirection(): Vector3 {
    return this.dirLight.direction;
  }
}
