import {
  Scene,
  MeshBuilder,
  StandardMaterial,
  Color3,
  Color4,
  Vector3,
  ParticleSystem,
  Texture,
  DynamicTexture,
  Mesh,
  TransformNode,
} from "@babylonjs/core";
import { SCENE_CONFIG, SLOT_CONFIG } from "@coin-pusher/shared";

interface SlotIndicator {
  mesh: Mesh;
  material: StandardMaterial;
  heatParticles: ParticleSystem;
  flashIntensity: number;
}

export class DropZoneVFX {
  private scene: Scene;
  private slots: SlotIndicator[] = [];
  private particleTexture: Texture;

  // Breathing pulse state
  private elapsed: number = 0;
  private static PULSE_HZ = 0.8;
  private static PULSE_MIN = 0.4;
  private static PULSE_MAX = 1.0;

  // Base emissive
  private static BASE_EMISSIVE = new Color3(0.9, 0.3, 0.1);
  private static FLASH_EMISSIVE = new Color3(1.0, 0.95, 0.8);

  constructor(scene: Scene, backWallGroup: TransformNode) {
    this.scene = scene;
    this.particleTexture = this.createParticleTexture();

    const { HEIGHT: WALL_HEIGHT, THICKNESS } = SCENE_CONFIG.BACK_WALL;

    SLOT_CONFIG.POSITIONS.forEach((x: number, index: number) => {
      const mesh = MeshBuilder.CreateTorus(
        `slotIndicator_${index}`,
        { diameter: 0.1, thickness: 0.02, tessellation: 24 },
        this.scene,
      );
      mesh.rotation.x = Math.PI / 2; // Face toward player (ring plane along Z)
      mesh.position = new Vector3(x, WALL_HEIGHT / 2, THICKNESS / 2 + 0.01);
      mesh.parent = backWallGroup;
      mesh.isPickable = false;

      const material = new StandardMaterial(`slotIndicatorMat_${index}`, this.scene);
      material.diffuseColor = new Color3(0.15, 0.05, 0.02);
      material.emissiveColor = DropZoneVFX.BASE_EMISSIVE.clone();
      material.alpha = 0.25;
      material.disableLighting = true;
      material.backFaceCulling = false;
      mesh.material = material;

      // Heat particles — compute world position from back wall group
      const worldMatrix = backWallGroup.computeWorldMatrix(true);
      const localPos = new Vector3(x, WALL_HEIGHT / 2, THICKNESS / 2 + 0.02);
      const worldPos = Vector3.TransformCoordinates(localPos, worldMatrix);

      const heatParticles = this.createHeatParticles(index, worldPos);
      heatParticles.start();

      this.slots.push({ mesh, material, heatParticles, flashIntensity: 0 });
    });

    console.log(`  ✓ ${this.slots.length} forging slot indicators created`);
  }

  update(dt: number): void {
    this.elapsed += dt;

    // Shared breathing pulse
    const pulse = Math.sin(this.elapsed * DropZoneVFX.PULSE_HZ * Math.PI * 2);
    const t = (pulse + 1) * 0.5; // 0..1
    const intensity = DropZoneVFX.PULSE_MIN + t * (DropZoneVFX.PULSE_MAX - DropZoneVFX.PULSE_MIN);

    for (const slot of this.slots) {
      // Flash decay per slot
      if (slot.flashIntensity > 0) {
        slot.flashIntensity = Math.max(0, slot.flashIntensity - dt * 4.0);

        const base = DropZoneVFX.BASE_EMISSIVE;
        const flash = DropZoneVFX.FLASH_EMISSIVE;
        const fi = slot.flashIntensity;
        slot.material.emissiveColor.set(
          (base.r * intensity) * (1 - fi) + flash.r * fi,
          (base.g * intensity) * (1 - fi) + flash.g * fi,
          (base.b * intensity) * (1 - fi) + flash.b * fi,
        );
        // Alpha brightens during flash
        slot.material.alpha = 0.25 + fi * 0.55;
      } else {
        slot.material.emissiveColor.set(
          DropZoneVFX.BASE_EMISSIVE.r * intensity,
          DropZoneVFX.BASE_EMISSIVE.g * intensity,
          DropZoneVFX.BASE_EMISSIVE.b * intensity,
        );
        slot.material.alpha = 0.25;
      }
    }
  }

  flash(slotIndex: number): void {
    const slot = this.slots[slotIndex];
    if (!slot) return;

    slot.flashIntensity = 1.0;
    this.spawnSparkBurst(slotIndex);
  }

  dispose(): void {
    for (const slot of this.slots) {
      slot.heatParticles.stop();
      slot.heatParticles.dispose(false);
      slot.material.dispose();
      slot.mesh.dispose();
    }
    this.slots = [];
    this.particleTexture.dispose();
  }

  private createHeatParticles(index: number, worldPos: Vector3): ParticleSystem {
    const ps = new ParticleSystem(`slotHeat_${index}`, 8, this.scene);
    ps.particleTexture = this.particleTexture;
    ps.emitter = worldPos;
    ps.minEmitBox = new Vector3(-0.04, -0.05, 0);
    ps.maxEmitBox = new Vector3(0.04, 0.05, 0);

    ps.minLifeTime = 0.5;
    ps.maxLifeTime = 1.0;
    ps.minSize = 0.008;
    ps.maxSize = 0.02;
    ps.emitRate = 2;
    ps.minEmitPower = 0.05;
    ps.maxEmitPower = 0.15;

    // Drift outward from wall face
    ps.direction1 = new Vector3(-0.02, 0.1, 0.2);
    ps.direction2 = new Vector3(0.02, 0.3, 0.4);
    ps.gravity = new Vector3(0, 0.1, 0);

    // Orange -> transparent
    ps.color1 = new Color4(0.9, 0.4, 0.1, 0.5);
    ps.color2 = new Color4(1.0, 0.5, 0.15, 0.3);
    ps.colorDead = new Color4(0.5, 0.2, 0.05, 0);

    ps.blendMode = ParticleSystem.BLENDMODE_ADD;

    return ps;
  }

  private spawnSparkBurst(slotIndex: number): void {
    const slot = this.slots[slotIndex];
    if (!slot) return;

    // Get world position from mesh
    slot.mesh.computeWorldMatrix(true);
    const worldPos = slot.mesh.getAbsolutePosition().clone();
    worldPos.z += 0.02; // Slightly in front of wall

    const ps = new ParticleSystem(`slotSpark_${slotIndex}`, 30, this.scene);
    ps.particleTexture = this.particleTexture;
    ps.emitter = worldPos;

    ps.minLifeTime = 0.08;
    ps.maxLifeTime = 0.15;
    ps.minSize = 0.01;
    ps.maxSize = 0.025;
    ps.minEmitPower = 1.5;
    ps.maxEmitPower = 4.0;
    ps.emitRate = 600;

    // Outward from wall + upward
    ps.direction1 = new Vector3(-0.5, -0.3, 0.3);
    ps.direction2 = new Vector3(0.5, 1.0, 1.0);
    ps.gravity = new Vector3(0, -3, 0);

    // Gold / orange sparks
    ps.color1 = new Color4(1.0, 0.9, 0.5, 1);
    ps.color2 = new Color4(1.0, 0.6, 0.15, 1);
    ps.colorDead = new Color4(0.8, 0.3, 0.05, 0);

    ps.blendMode = ParticleSystem.BLENDMODE_ADD;

    ps.targetStopDuration = 0.15;
    ps.disposeOnStop = true;

    // Protect shared texture
    const orig = ps.dispose.bind(ps);
    ps.dispose = () => { orig(false); };

    ps.start();
  }

  private createParticleTexture(): Texture {
    const size = 64;
    const dt = new DynamicTexture("slotParticleTex", size, this.scene, false);
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
