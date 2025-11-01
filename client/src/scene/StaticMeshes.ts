import {
  Scene,
  MeshBuilder,
  StandardMaterial,
  Color3,
  Vector3,
} from '@babylonjs/core';

export class StaticMeshes {
  private scene: Scene;

  constructor(scene: Scene) {
    this.scene = scene;
    this.createStaticScene();
  }

  private createStaticScene(): void {
    console.log('🏗️  Building client scene...');

    // Create materials
    const platformMat = this.createPlatformMaterial();
    const wallMat = this.createWallMaterial();

    // Main platform: 1.2m × 0.8m × 0.05m at (0, 0.25, 0)
    const platform = MeshBuilder.CreateBox(
      'platform',
      { width: 1.2, height: 0.05, depth: 0.8 },
      this.scene
    );
    platform.position = new Vector3(0, 0.25, 0);
    
    // Slight forward tilt (2 degrees)
    platform.rotation.x = 2 * (Math.PI / 180);
    platform.material = platformMat;

    // Back wall
    const backWall = MeshBuilder.CreateBox(
      'backWall',
      { width: 1.2, height: 0.3, depth: 0.05 },
      this.scene
    );
    backWall.position = new Vector3(0, 0.4, -0.4);
    backWall.material = wallMat;

    // Left wall
    const leftWall = MeshBuilder.CreateBox(
      'leftWall',
      { width: 0.05, height: 0.3, depth: 0.8 },
      this.scene
    );
    leftWall.position = new Vector3(-0.6, 0.4, 0);
    // Inner tilt
    leftWall.rotation.z = -1.5 * (Math.PI / 180);
    leftWall.material = wallMat;

    // Right wall
    const rightWall = MeshBuilder.CreateBox(
      'rightWall',
      { width: 0.05, height: 0.3, depth: 0.8 },
      this.scene
    );
    rightWall.position = new Vector3(0.6, 0.4, 0);
    // Inner tilt
    rightWall.rotation.z = 1.5 * (Math.PI / 180);
    rightWall.material = wallMat;

    // Drop zone indicator (subtle visual)
    const dropZone = MeshBuilder.CreateBox(
      'dropZone',
      { width: 1.0, height: 0.05, depth: 0.2 },
      this.scene
    );
    dropZone.position = new Vector3(0, 0.15, 0.45);
    const dropZoneMat = new StandardMaterial('dropZoneMat', this.scene);
    dropZoneMat.diffuseColor = new Color3(0.2, 0.3, 0.2);
    dropZoneMat.alpha = 0.3;
    dropZone.material = dropZoneMat;

    console.log('  ✓ Static meshes created');
  }

  private createPlatformMaterial(): StandardMaterial {
    const mat = new StandardMaterial('platformMat', this.scene);
    mat.diffuseColor = new Color3(0.6, 0.6, 0.6);
    mat.specularColor = new Color3(0.2, 0.2, 0.2);
    return mat;
  }

  private createWallMaterial(): StandardMaterial {
    const mat = new StandardMaterial('wallMat', this.scene);
    mat.diffuseColor = new Color3(0.5, 0.5, 0.6);
    mat.specularColor = new Color3(0.1, 0.1, 0.1);
    return mat;
  }
}

