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

    this.light.intensity = 0.5;
    this.light.diffuse = new Color3(1, 1, 1);
    this.light.specular = new Color3(0.3, 0.3, 0.3);
    this.light.groundColor = new Color3(0.3, 0.3, 0.4);

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
