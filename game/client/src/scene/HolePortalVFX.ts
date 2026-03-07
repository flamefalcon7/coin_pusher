import {
  Scene,
  TransformNode,
  MeshBuilder,
  StandardMaterial,
  Color3,
  Color4,
  Vector3,
  ParticleSystem,
  Texture,
  DynamicTexture,
  Mesh,
} from "@babylonjs/core";
import { SCENE_CONFIG } from "@coin-pusher/shared";

interface HolePortal {
  wallParent: TransformNode;
  frame: Mesh;
  cornerGems: Mesh[];
  particles: ParticleSystem;
  hitbox: Mesh;
  holeId: "left" | "right";
}

export class HolePortalVFX {
  private scene: Scene;
  private portals: HolePortal[] = [];
  private particleTexture: Texture;
  private elapsed: number = 0;

  // Per-side progress
  private leftProgress: number = 0; // 0..1
  private rightProgress: number = 0; // 0..1

  // Color constants
  private static TEAL = new Color3(0.3, 0.9, 0.85);
  private static GOLD = new Color3(1.0, 0.8, 0.2);
  private static _scratchColor = new Color3();

  constructor(
    scene: Scene,
    leftParent: TransformNode,
    rightParent: TransformNode,
  ) {
    this.scene = scene;
    this.particleTexture = this.createParticleTexture();

    this.portals.push(this.createPortal(leftParent, "left"));
    this.portals.push(this.createPortal(rightParent, "right"));
  }

  private createPortal(wallParent: TransformNode, holeId: "left" | "right"): HolePortal {
    const { FRONT_OPENING_SIZE, FRONT_OPENING_CENTER, FRONT_OPENING_Y, THICKNESS } =
      SCENE_CONFIG.SIDE_WALLS;

    // Hole local coordinates within wall parent
    const parentY = wallParent.position.y;

    // Compute front wall depth (same as in StaticMeshes)
    const { WIDTH, DEPTH, FLARE_Z, POSITION } = SCENE_CONFIG.PLATFORM;
    const hw = WIDTH / 2;
    const fhw = this.getFrontHalfWidth();
    const frontZ = POSITION.z + DEPTH / 2;
    const flareDepth = frontZ - FLARE_Z;
    const dx = fhw - hw;
    const frontLen = Math.sqrt(dx * dx + flareDepth * flareDepth);

    const holeLocalY = FRONT_OPENING_Y - parentY;
    const holeLocalZ = (FRONT_OPENING_CENTER - 0.5) * frontLen;
    const hs = FRONT_OPENING_SIZE / 2;

    // Left wall inner face is at +X local, right wall inner face is at -X local
    const xSign = holeId === "left" ? 1 : -1;
    const innerX = xSign * (THICKNESS / 2);

    // Frame: square border around the hole
    const barThickness = 0.018;
    const barDepth = 0.01;
    const topBar = MeshBuilder.CreateBox(`_ft_${holeId}`, { width: barDepth, height: barThickness, depth: FRONT_OPENING_SIZE }, this.scene);
    topBar.position.y = hs;
    const bottomBar = MeshBuilder.CreateBox(`_fb_${holeId}`, { width: barDepth, height: barThickness, depth: FRONT_OPENING_SIZE }, this.scene);
    bottomBar.position.y = -hs;
    const leftBar = MeshBuilder.CreateBox(`_fl_${holeId}`, { width: barDepth, height: FRONT_OPENING_SIZE, depth: barThickness }, this.scene);
    leftBar.position.z = -hs;
    const rightBar = MeshBuilder.CreateBox(`_fr_${holeId}`, { width: barDepth, height: FRONT_OPENING_SIZE, depth: barThickness }, this.scene);
    rightBar.position.z = hs;

    const frame = Mesh.MergeMeshes([topBar, bottomBar, leftBar, rightBar], true, true, undefined, false, true)!;
    frame.name = `holeFrame_${holeId}`;
    frame.position = new Vector3(innerX + xSign * 0.005, holeLocalY, holeLocalZ);
    frame.parent = wallParent;
    frame.isPickable = false;

    const frameMat = new StandardMaterial(`holeFrameMat_${holeId}`, this.scene);
    frameMat.emissiveColor = HolePortalVFX.TEAL.clone();
    frameMat.diffuseColor = new Color3(0, 0, 0);
    frameMat.disableLighting = true;
    frameMat.backFaceCulling = false;
    frame.material = frameMat;

    // 4 corner accent gems
    const cornerGems: Mesh[] = [];
    const offsets = [
      new Vector3(0, hs, hs),
      new Vector3(0, hs, -hs),
      new Vector3(0, -hs, hs),
      new Vector3(0, -hs, -hs),
    ];
    for (let i = 0; i < 4; i++) {
      const gem = MeshBuilder.CreateSphere(
        `holeGem_${holeId}_${i}`,
        { diameter: 0.03, segments: 8 },
        this.scene,
      );
      gem.position = new Vector3(
        innerX + xSign * 0.01,
        holeLocalY + offsets[i].y,
        holeLocalZ + offsets[i].z,
      );
      gem.parent = wallParent;
      gem.isPickable = false;

      const gemMat = new StandardMaterial(`holeGemMat_${holeId}_${i}`, this.scene);
      gemMat.emissiveColor = HolePortalVFX.GOLD.clone();
      gemMat.diffuseColor = new Color3(0, 0, 0);
      gemMat.disableLighting = true;
      gem.material = gemMat;

      cornerGems.push(gem);
    }

    // Suction particles
    const particles = this.createSuctionParticles(wallParent, holeId, holeLocalY, holeLocalZ, xSign);

    // Hitbox for hover detection (visible with fully transparent material so scene.pick() works)
    const hitbox = MeshBuilder.CreatePlane(
      `holeHitbox_${holeId}`,
      { width: FRONT_OPENING_SIZE, height: FRONT_OPENING_SIZE },
      this.scene,
    );
    hitbox.position = new Vector3(innerX + xSign * 0.015, holeLocalY, holeLocalZ);
    hitbox.rotation.y = Math.PI / 2; // face outward along wall normal
    hitbox.parent = wallParent;
    hitbox.isPickable = true;
    hitbox.metadata = { holeId };

    const hitboxMat = new StandardMaterial(`holeHitboxMat_${holeId}`, this.scene);
    hitboxMat.alpha = 0;
    hitbox.material = hitboxMat;

    return { wallParent, frame, cornerGems, particles, hitbox, holeId };
  }

  private createSuctionParticles(
    wallParent: TransformNode,
    holeId: string,
    holeLocalY: number,
    holeLocalZ: number,
    xSign: number,
  ): ParticleSystem {
    const { THICKNESS } = SCENE_CONFIG.SIDE_WALLS;

    // Get world position of the hole center from the wall parent
    const worldMatrix = wallParent.computeWorldMatrix(true);
    const holeLocalPos = new Vector3(xSign * (THICKNESS / 2), holeLocalY, holeLocalZ);
    const holeWorldPos = Vector3.TransformCoordinates(holeLocalPos, worldMatrix);

    const ps = new ParticleSystem(`holeSuction_${holeId}`, 30, this.scene);
    ps.particleTexture = this.particleTexture;
    ps.emitter = holeWorldPos;
    ps.minEmitBox = new Vector3(-0.15, -0.15, -0.15);
    ps.maxEmitBox = new Vector3(0.15, 0.15, 0.15);

    ps.minLifeTime = 0.6;
    ps.maxLifeTime = 1.2;
    ps.minSize = 0.008;
    ps.maxSize = 0.02;
    ps.emitRate = 15;
    ps.minEmitPower = 0.05;
    ps.maxEmitPower = 0.15;

    // Gold / teal colors
    ps.color1 = new Color4(1.0, 0.85, 0.3, 0.8);
    ps.color2 = new Color4(0.3, 0.9, 0.85, 0.6);
    ps.colorDead = new Color4(0.5, 0.7, 0.5, 0);

    ps.gravity = Vector3.Zero();
    ps.blendMode = ParticleSystem.BLENDMODE_ADD;

    // Spiral inward toward hole center
    const cx = holeWorldPos.x;
    const cy = holeWorldPos.y;
    const cz = holeWorldPos.z;

    ps.updateFunction = (particles) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const scaledSpeed = (ps as any)._scaledUpdateSpeed as number;

      for (let index = 0; index < particles.length; index++) {
        const p = particles[index];
        p.age += scaledSpeed;

        if (p.age >= p.lifeTime) {
          ps.recycleParticle(p);
          index--;
          continue;
        }

        const t = p.age / p.lifeTime;

        // Pull toward center
        const dx = cx - p.position.x;
        const dy = cy - p.position.y;
        const dz = cz - p.position.z;
        const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
        const invDist = dist > 0.001 ? 1 / dist : 0;

        // Spiral tangent (rotation around the pull vector)
        const tangentX = -dz * invDist * 1.5;
        const tangentZ = dx * invDist * 1.5;

        // Inward pull strengthens over lifetime
        const pull = 0.5 + t * 1.5;
        p.direction.x = dx * invDist * pull + tangentX;
        p.direction.y = dy * invDist * pull * 0.5;
        p.direction.z = dz * invDist * pull + tangentZ;

        p.position.x += p.direction.x * scaledSpeed;
        p.position.y += p.direction.y * scaledSpeed;
        p.position.z += p.direction.z * scaledSpeed;

        // Fade out near end of life
        const lifeFade = t < 0.7 ? 1 : (1 - t) / 0.3;
        p.color.a = 0.6 * lifeFade;
        p.size = 0.01 + (1 - t) * 0.01;
      }
    };

    ps.start();
    return ps;
  }

  setProgress(holeId: "left" | "right", counter: number, triggerCount: number): void {
    const progress = Math.min(1, counter / triggerCount);
    if (holeId === "left") {
      this.leftProgress = progress;
    } else {
      this.rightProgress = progress;
    }

    // Update particle emit rate for the matching portal
    for (const portal of this.portals) {
      if (portal.holeId === holeId) {
        portal.particles.emitRate = 15 + progress * 15;
      }
    }
  }

  update(dt: number): void {
    this.elapsed += dt;

    for (const portal of this.portals) {
      const progress = portal.holeId === "left" ? this.leftProgress : this.rightProgress;

      // Pulse speed: 1 Hz at 0% -> 4 Hz at 100%
      const pulseHz = 1 + progress * 3;
      const pulse = (Math.sin(this.elapsed * pulseHz * Math.PI * 2) + 1) * 0.5;

      // Frame color: teal at low progress -> gold at high progress
      Color3.LerpToRef(HolePortalVFX.TEAL, HolePortalVFX.GOLD, progress, HolePortalVFX._scratchColor);

      // Frame emissive intensity pulsing
      const intensity = 0.6 + pulse * 0.8;
      const frameMat = portal.frame.material as StandardMaterial;
      frameMat.emissiveColor.set(
        HolePortalVFX._scratchColor.r * intensity,
        HolePortalVFX._scratchColor.g * intensity,
        HolePortalVFX._scratchColor.b * intensity,
      );

      // Corner gem scale pulse (amplified by progress)
      const gemPulseAmp = 0.8 + progress * 0.6;
      const gemScale = 1.0 + pulse * 0.3 * gemPulseAmp;
      for (const gem of portal.cornerGems) {
        gem.scaling.setAll(gemScale);
      }
    }
  }

  dispose(): void {
    for (const portal of this.portals) {
      portal.frame.material?.dispose();
      portal.frame.dispose();
      for (const gem of portal.cornerGems) {
        gem.material?.dispose();
        gem.dispose();
      }
      portal.particles.dispose(false);
      portal.hitbox.material?.dispose();
      portal.hitbox.dispose();
    }
    this.portals = [];
    this.particleTexture.dispose();
  }

  private getFrontHalfWidth(): number {
    const { WIDTH, DEPTH, FLARE_Z, FLARE_ANGLE, POSITION } = SCENE_CONFIG.PLATFORM;
    const hw = WIDTH / 2;
    const frontZ = POSITION.z + DEPTH / 2;
    const flareDepth = frontZ - FLARE_Z;
    const flareOffset = Math.tan(FLARE_ANGLE * Math.PI / 180) * flareDepth;
    return hw + flareOffset;
  }

  private createParticleTexture(): Texture {
    const size = 64;
    const dt = new DynamicTexture("holeParticleTex", size, this.scene, false);
    const ctx = dt.getContext();
    const half = size / 2;

    const gradient = ctx.createRadialGradient(half, half, 0, half, half, half);
    gradient.addColorStop(0, "rgba(255, 255, 255, 1)");
    gradient.addColorStop(0.4, "rgba(255, 255, 255, 0.6)");
    gradient.addColorStop(1, "rgba(255, 255, 255, 0)");

    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, size, size);
    dt.update();

    return dt;
  }
}
