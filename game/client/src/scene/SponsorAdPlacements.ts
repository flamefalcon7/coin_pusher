import {
  Scene,
  Mesh,
  MeshBuilder,
  TransformNode,
  DynamicTexture,
  Color3,
} from "@babylonjs/core";
import type { SponsorConfigMessage } from "@coin-pusher/shared";
import { createToonMaterial } from "./ToonMaterial";

export class SponsorAdPlacements {
  private backWallPlane: Mesh | null = null;
  private sideWallPlanes: Mesh[] = [];
  private platformPlane: Mesh | null = null;
  private scene: Scene;

  // Track textures/materials for proper disposal
  private activeMaterials: { material: ReturnType<typeof createToonMaterial>; texture: DynamicTexture | null }[] = [];

  constructor(scene: Scene) {
    this.scene = scene;
  }

  createBackWallAd(backWallGroup: TransformNode): void {
    const plane = MeshBuilder.CreatePlane("sponsorBackWall", { width: 1.0, height: 0.5 }, this.scene);
    plane.parent = backWallGroup;
    plane.position.y = 1.4;
    plane.position.z = 0.03;

    // Placeholder gray toon material (no texture)
    const mat = createToonMaterial(this.scene, {
      name: "sponsorBackWallMat",
      baseColor: new Color3(0.3, 0.3, 0.3),
      useCelShading: false,
    });
    plane.material = mat;
    this.activeMaterials.push({ material: mat, texture: null });

    this.backWallPlane = plane;
  }

  createSideWallAds(leftWallGroup: TransformNode, rightWallGroup: TransformNode): void {
    // 0.4m x 0.4m planes on inner face of each wall's back segment
    const createSidePlane = (name: string, parent: TransformNode): Mesh => {
      const plane = MeshBuilder.CreatePlane(name, { width: 0.4, height: 0.4 }, this.scene);
      plane.parent = parent;
      // Position on inner face, roughly centered vertically
      plane.position.y = 0.3;
      plane.position.z = -0.1;
      plane.position.x = 0.06; // slight offset to sit on inner face

      const mat = createToonMaterial(this.scene, {
        name: name + "Mat",
        baseColor: new Color3(0.3, 0.3, 0.3),
        useCelShading: false,
      });
      plane.material = mat;
      this.activeMaterials.push({ material: mat, texture: null });

      return plane;
    };

    const leftPlane = createSidePlane("sponsorLeftWall", leftWallGroup);
    const rightPlane = createSidePlane("sponsorRightWall", rightWallGroup);
    // Mirror right plane X offset
    rightPlane.position.x = -0.06;

    this.sideWallPlanes = [leftPlane, rightPlane];
  }

  createPlatformAd(platformGroup: TransformNode): void {
    // Skip on mobile (detect via engine aspect ratio < 1.0)
    const engine = this.scene.getEngine();
    const aspect = engine.getRenderWidth() / engine.getRenderHeight();
    if (aspect < 1.0) return;

    const plane = MeshBuilder.CreatePlane("sponsorPlatform", { width: 0.8, height: 0.4 }, this.scene);
    plane.parent = platformGroup;
    plane.position.y = 0.251;
    // Face up
    plane.rotation.x = -Math.PI / 2;

    const mat = createToonMaterial(this.scene, {
      name: "sponsorPlatformMat",
      baseColor: new Color3(0.3, 0.3, 0.3),
      useCelShading: false,
    });
    mat.alpha = 0.4;
    plane.material = mat;
    this.activeMaterials.push({ material: mat, texture: null });

    this.platformPlane = plane;
  }

  updateSponsorCreatives(sponsors: SponsorConfigMessage["sponsors"]): void {
    // Dispose old textures before creating new ones
    for (const entry of this.activeMaterials) {
      if (entry.texture) {
        // Null texture reference on material before disposing texture
        entry.material.setTexture("diffuseTex", null as unknown as DynamicTexture);
        entry.texture.dispose();
        entry.texture = null;
      }
    }

    for (const sponsor of sponsors) {
      if (sponsor.placement_tier === "primary" && this.backWallPlane) {
        this.loadAdImage(sponsor.ad_image_url, this.backWallPlane, "sponsorBackWallMat", sponsor.brand_color);
      } else if (sponsor.placement_tier === "secondary") {
        for (const plane of this.sideWallPlanes) {
          this.loadAdImage(sponsor.ad_image_url, plane, plane.name + "Mat", sponsor.brand_color);
        }
      } else if (sponsor.placement_tier === "tertiary" && this.platformPlane) {
        this.loadAdImage(sponsor.ad_image_url, this.platformPlane, "sponsorPlatformMat", sponsor.brand_color);
      }
    }
  }

  private loadAdImage(imageUrl: string, plane: Mesh, matName: string, brandColor: string): void {
    const img = new Image();
    img.crossOrigin = "anonymous";

    img.onload = () => {
      const dt = new DynamicTexture(matName + "Tex", 256, this.scene, false);
      const ctx = dt.getContext();
      ctx.drawImage(img, 0, 0, 256, 256);
      dt.update(false);
      dt.hasAlpha = true;

      // Create toon material AFTER DynamicTexture.update()
      const mat = createToonMaterial(this.scene, {
        name: matName,
        baseColor: Color3.FromHexString(brandColor),
        diffuseTexture: dt,
        useCelShading: false,
      });

      // Dispose old material on this plane
      const oldMat = plane.material;
      if (oldMat) {
        // Remove from activeMaterials tracking
        const idx = this.activeMaterials.findIndex(e => e.material === oldMat);
        if (idx >= 0) {
          const entry = this.activeMaterials[idx];
          if (entry.texture) {
            entry.material.setTexture("diffuseTex", null as unknown as DynamicTexture);
            entry.texture.dispose();
          }
          entry.material.dispose();
          this.activeMaterials.splice(idx, 1);
        }
      }

      plane.material = mat;
      this.activeMaterials.push({ material: mat, texture: dt });
    };

    img.onerror = () => {
      console.warn(`Failed to load sponsor ad image: ${imageUrl}`);
    };

    img.src = imageUrl;
  }

  dispose(): void {
    // Dispose all materials and textures
    for (const entry of this.activeMaterials) {
      if (entry.texture) {
        entry.material.setTexture("diffuseTex", null as unknown as DynamicTexture);
        entry.texture.dispose();
      }
      entry.material.dispose();
    }
    this.activeMaterials = [];

    // Dispose planes
    if (this.backWallPlane) {
      this.backWallPlane.dispose();
      this.backWallPlane = null;
    }
    for (const plane of this.sideWallPlanes) {
      plane.dispose();
    }
    this.sideWallPlanes = [];
    if (this.platformPlane) {
      this.platformPlane.dispose();
      this.platformPlane = null;
    }
  }
}
