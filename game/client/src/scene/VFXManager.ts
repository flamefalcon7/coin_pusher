import {
  Scene,
  Vector3,
  Color3,
  Color4,
  Mesh,
  MeshBuilder,
  ParticleSystem,
  DynamicTexture,
  Texture,
  StandardMaterial,
  ShaderMaterial,
  NoiseProceduralTexture,
  TransformNode,
} from "@babylonjs/core";
import { SCENE_CONFIG, SLOT_CONFIG, SUPER_PUSH_CONFIG } from "@coin-pusher/shared";
import { HolePortalVFX } from "./HolePortalVFX";
import { DropZoneVFX } from "./DropZoneVFX";

// ── Configuration ────────────────────────────────────────────────────────────

export interface VFXConfig {
  maxBurstSystems: number;
  comboThreshold: number;
  wallPulseSpeed: number;
  wallPulseIntensity: number;
}

const DEFAULT_CONFIG: VFXConfig = {
  maxBurstSystems: 20,
  comboThreshold: 3,
  wallPulseSpeed: 0.6,
  wallPulseIntensity: 0.5,
};

// Minimum visible Y for despawn effects (below this = out of view)
const DESPAWN_MIN_Y = SCENE_CONFIG.PLATFORM.POSITION.y - 0.05;

// ── VFXManager ───────────────────────────────────────────────────────────────

export class VFXManager {
  private scene: Scene;
  private config: VFXConfig;

  // Shared particle texture
  private particleTexture: Texture | null = null;

  // Active burst systems (auto-cleanup pool)
  private burstSystems: ParticleSystem[] = [];


  // Wall pulse
  private wallPulseTime: number = 0;
  private wallMat: ShaderMaterial | null = null;
  private wallBaseColor: Color3 = new Color3();

  // Combo flash
  private comboFlashMesh: Mesh | null = null;
  private comboFlashAlpha: number = 0;

  // Cached reward textures
  private coinRewardTex: Texture | null = null;
  private ticketRewardTex: Texture | null = null;
  private windNoiseTex: NoiseProceduralTexture | null = null;

  // Ring pool with per-ring scale config
  private ringPool: Mesh[] = [];
  private activeRings: { mesh: Mesh; age: number; maxAge: number; startScale: number; endScale: number }[] = [];

  // Tornado ground ring state
  private tornadoRings: { mesh: Mesh; elapsed: number; duration: number }[] = [];

  // Lightning bolt meshes (tubes with emissive material, fade and dispose)
  private activeBolts: { meshes: Mesh[]; age: number; maxAge: number }[] = [];

  // Hole portal effects
  private holePortalVFX: HolePortalVFX | null = null;

  // Drop zone forging VFX
  private dropZoneVFX: DropZoneVFX | null = null;

  // Active timers (setInterval/setTimeout) — tracked for cleanup on dispose
  private activeTimers: ReturnType<typeof setInterval>[] = [];

  // Max pooled rings — excess rings are disposed instead of pooled
  private static MAX_RING_POOL = 16;
  private static _scratchColor = new Color3();

  // Render observer
  private renderObserver: ReturnType<Scene["onBeforeRenderObservable"]["add"]> | null = null;
  private lastTime: number = 0;

  constructor(scene: Scene, config?: Partial<VFXConfig>) {
    this.scene = scene;
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  init(): void {
    this.particleTexture = this.createParticleTexture();
    this.initComboFlash();
    this.cacheWallMaterial();

    // Hook into render loop
    this.lastTime = performance.now();
    this.renderObserver = this.scene.onBeforeRenderObservable.add(() => {
      const now = performance.now();
      const dt = (now - this.lastTime) / 1000;
      this.lastTime = now;
      this.update(dt);
    });
  }

  initHolePortals(leftParent: TransformNode, rightParent: TransformNode): void {
    this.holePortalVFX = new HolePortalVFX(this.scene, leftParent, rightParent);
  }

  initCoinSlots(backWallGroup: TransformNode): void {
    this.dropZoneVFX = new DropZoneVFX(this.scene, backWallGroup);
  }

  updateHoleProgress(holeId: "left" | "right", counter: number, triggerCount: number): void {
    this.holePortalVFX?.setProgress(holeId, counter, triggerCount);
  }

  dispose(): void {
    if (this.renderObserver) {
      this.scene.onBeforeRenderObservable.remove(this.renderObserver);
      this.renderObserver = null;
    }
    this.holePortalVFX?.dispose();
    this.holePortalVFX = null;
    this.dropZoneVFX?.dispose();
    this.dropZoneVFX = null;
    this.comboFlashMesh?.dispose();
    this.comboFlashMesh = null;
    for (const ps of this.burstSystems) ps.dispose();
    this.burstSystems = [];
    for (const r of this.ringPool) r.dispose();
    this.ringPool = [];
    for (const r of this.activeRings) r.mesh.dispose();
    this.activeRings = [];
    for (const r of this.tornadoRings) r.mesh.dispose();
    this.tornadoRings = [];
    for (const t of this.activeTimers) clearInterval(t);
    this.activeTimers = [];
    for (const b of this.activeBolts) {
      for (const m of b.meshes) { m.material?.dispose(); m.dispose(); }
    }
    this.activeBolts = [];
    this.particleTexture?.dispose();
    this.particleTexture = null;
    this.coinRewardTex?.dispose();
    this.coinRewardTex = null;
    this.ticketRewardTex?.dispose();
    this.ticketRewardTex = null;
    this.windNoiseTex?.dispose();
    this.windNoiseTex = null;
  }

  // ── Inspectors (for testing) ───────────────────────────────────────────────

  getActiveBurstCount(): number {
    return this.burstSystems.length;
  }


  getActiveRingCount(): number {
    return this.activeRings.length;
  }

  getRingPoolSize(): number {
    return this.ringPool.length;
  }

  getComboFlashAlpha(): number {
    return this.comboFlashAlpha;
  }

  // ── Event Effects ──────────────────────────────────────────────────────────

  /** Gold spark burst at coin slot opening */
  playCoinInsert(slotIndex: number): ParticleSystem | null {
    if (!this.particleTexture) return null;

    const x = SLOT_CONFIG.POSITIONS[slotIndex] ?? 0;
    const backWallPos = SCENE_CONFIG.BACK_WALL.POSITION;
    const wallThickness = SCENE_CONFIG.BACK_WALL.THICKNESS;
    const pos = new Vector3(
      x,
      backWallPos.y + SCENE_CONFIG.BACK_WALL.HEIGHT / 2,
      backWallPos.z + wallThickness / 2 + 0.05
    );

    const ps = new ParticleSystem("coinInsertVFX", 40, this.scene);
    ps.particleTexture = this.particleTexture;
    ps.emitter = pos;
    ps.minLifeTime = 0.2;
    ps.maxLifeTime = 0.5;
    ps.minSize = 0.01;
    ps.maxSize = 0.03;
    ps.minEmitPower = 0.5;
    ps.maxEmitPower = 1.5;
    ps.direction1 = new Vector3(-0.3, -0.5, 0.3);
    ps.direction2 = new Vector3(0.3, 0.2, 0.8);
    ps.gravity = new Vector3(0, -2, 0);
    ps.emitRate = 200;

    // Gold colors
    ps.color1 = new Color4(0.9, 0.75, 0.3, 1);
    ps.color2 = new Color4(1.0, 0.85, 0.4, 1);
    ps.colorDead = new Color4(0.6, 0.4, 0.1, 0);

    ps.addSizeGradient(0, 0.03);
    ps.addSizeGradient(1, 0.005);

    ps.targetStopDuration = 0.15;
    ps.disposeOnStop = true;
    this.protectSharedTextures(ps);

    ps.start();
    this.trackBurst(ps);
    this.dropZoneVFX?.flash(slotIndex);
    return ps;
  }

  /** Expanding ring at coin landing position */
  playCoinLand(position: Vector3): void {
    const ring = this.getRingMesh();
    ring.position.set(position.x, position.y + 0.01, position.z);
    ring.scaling.set(0.1, 1, 0.1);
    ring.isVisible = true;

    const mat = ring.material as StandardMaterial;
    mat.alpha = 0.7;
    mat.emissiveColor = new Color3(0.8, 0.64, 0.37); // gold

    this.activeRings.push({ mesh: ring, age: 0, maxAge: 0.5, startScale: 0.1, endScale: 0.6 });
  }

  /** Gold particle burst at coin despawn position */
  playCoinDespawn(position: Vector3): ParticleSystem | null {
    if (!this.particleTexture) return null;

    // Skip effect if coin is below visible area
    if (position.y < DESPAWN_MIN_Y) return null;

    const ps = new ParticleSystem("coinDespawnVFX", 40, this.scene);
    ps.particleTexture = this.particleTexture;
    ps.emitter = position.clone();
    ps.minLifeTime = 0.2;
    ps.maxLifeTime = 0.6;
    ps.minSize = 0.015;
    ps.maxSize = 0.04;
    ps.minEmitPower = 1.0;
    ps.maxEmitPower = 3.0;
    ps.direction1 = new Vector3(-1, 0.5, -1);
    ps.direction2 = new Vector3(1, 3, 1);
    ps.gravity = new Vector3(0, -4, 0);
    ps.emitRate = 300;

    // Bright brass/gold colors
    ps.color1 = new Color4(1.0, 0.85, 0.4, 1);
    ps.color2 = new Color4(1.0, 0.7, 0.2, 1);
    ps.colorDead = new Color4(0.6, 0.4, 0.1, 0);

    ps.targetStopDuration = 0.12;
    ps.disposeOnStop = true;
    this.protectSharedTextures(ps);

    ps.start();
    this.trackBurst(ps);
    return ps;
  }

  /** Enhanced shock: ground wave ring + brighter pin flash */
  playShockWave(): void {
    // Ground-level expanding ring — big and visible
    const ring = this.getRingMesh();
    const platformY = SCENE_CONFIG.PLATFORM.POSITION.y + SCENE_CONFIG.PLATFORM.THICKNESS / 2;
    ring.position.set(0, platformY + 0.03, SCENE_CONFIG.PLATFORM.POSITION.z);
    ring.scaling.set(0.15, 1, 0.15);
    ring.isVisible = true;

    const mat = ring.material as StandardMaterial;
    mat.alpha = 0.8;
    mat.emissiveColor = new Color3(0.4, 0.9, 0.9); // Bright teal shock wave

    this.activeRings.push({ mesh: ring, age: 0, maxAge: 0.8, startScale: 0.15, endScale: 2.0 });

    // Pin-area particle burst
    if (this.particleTexture) {
      const ps = new ParticleSystem("shockBurstVFX", 80, this.scene);
      ps.particleTexture = this.particleTexture;
      ps.emitter = new Vector3(0, SCENE_CONFIG.BACK_WALL.POSITION.y, SCENE_CONFIG.BACK_WALL.POSITION.z + 0.1);
      ps.minEmitBox = new Vector3(-0.5, -0.3, 0);
      ps.maxEmitBox = new Vector3(0.5, 0.3, 0);
      ps.minLifeTime = 0.3;
      ps.maxLifeTime = 0.7;
      ps.minSize = 0.02;
      ps.maxSize = 0.06;
      ps.minEmitPower = 1;
      ps.maxEmitPower = 3;
      ps.direction1 = new Vector3(-0.5, -0.5, 1);
      ps.direction2 = new Vector3(0.5, 0.5, 1.5);
      ps.gravity = new Vector3(0, -2, 0);
      ps.emitRate = 400;

      // Teal + parchment colors
      ps.color1 = new Color4(0.3, 0.7, 0.7, 1);
      ps.color2 = new Color4(0.9, 0.86, 0.79, 1);
      ps.colorDead = new Color4(0.2, 0.3, 0.3, 0);

      ps.targetStopDuration = 0.15;
      ps.disposeOnStop = true;
      this.protectSharedTextures(ps);
      ps.start();
      this.trackBurst(ps);
    }
  }

  /** Tornado VFX: spiraling funnel + ground dust ring + debris particles */
  playTornado(position: Vector3, duration: number): void {
    if (!this.particleTexture) return;

    // 1. Funnel spiral — cone emitter + custom updateFunction for real spiral motion
    const funnel = new ParticleSystem("tornadoFunnel", 400, this.scene);
    funnel.particleTexture = this.particleTexture;
    funnel.emitter = position.clone();

    // Cone emitter: wider base for more random spread
    const coneEmitter = funnel.createConeEmitter(0.25, Math.PI / 4);
    coneEmitter.radiusRange = 1;
    coneEmitter.heightRange = 1;

    funnel.minLifeTime = 1.0;
    funnel.maxLifeTime = 3.0;
    funnel.minSize = 0.015;
    funnel.maxSize = 0.06;
    funnel.emitRate = 150;
    funnel.minEmitPower = 0.3;
    funnel.maxEmitPower = 2.0;
    funnel.gravity = new Vector3(0, 0.3, 0);

    // Stretched billboard: particles stretch along velocity → trail/afterimage
    funnel.billboardMode = ParticleSystem.BILLBOARDMODE_STRETCHED;
    funnel.minScaleX = 1.0;
    funnel.maxScaleX = 1.0;
    funnel.minScaleY = 2.5;
    funnel.maxScaleY = 5.0;

    // Colors: grayish-white wind tones (randomized per particle in updateFunction)
    funnel.color1 = new Color4(0.95, 0.95, 1.0, 0.7);
    funnel.color2 = new Color4(0.7, 0.72, 0.75, 0.4);
    funnel.colorDead = new Color4(0.5, 0.5, 0.55, 0);

    // Custom update: spiral force + per-particle randomness
    // updateFunction replaces the default particle update — we handle age, position, color
    const cx = position.x;
    const cz = position.z;
    funnel.updateFunction = (particles) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const scaledSpeed = (funnel as any)._scaledUpdateSpeed as number;
      // Must use index-based loop: recycleParticle swaps current with last & pops,
      // so we decrement index after recycling to re-visit the swapped-in particle.
      for (let index = 0; index < particles.length; index++) {
        const p = particles[index];
        p.age += scaledSpeed;

        // Recycle dead particles (critical — without this, slots fill up permanently)
        if (p.age >= p.lifeTime) {
          funnel.recycleParticle(p);
          index--;
          continue;
        }

        const t = p.age / p.lifeTime;

        // Per-particle random factor derived from lifeTime (stable across frames)
        const pRand = (p.lifeTime - 1.0) / 2.0; // 0–1

        // Relative position from emitter center
        const rx = p.position.x - cx;
        const rz = p.position.z - cz;
        const dist = Math.sqrt(rx * rx + rz * rz);

        // Spiral force with per-particle variation in speed and pull
        const angSpeed = 2.0 + pRand * 3.0;   // 2–5 (wide range)
        const pullStrength = 0.3 + pRand * 0.6; // 0.3–0.9
        const invDist = dist > 0.001 ? 1 / dist : 0;
        const tangentX = -rz * invDist * angSpeed;
        const tangentZ = rx * invDist * angSpeed;
        const inwardX = -rx * invDist * pullStrength;
        const inwardZ = -rz * invDist * pullStrength;

        p.direction.x = tangentX + inwardX;
        p.direction.z = tangentZ + inwardZ;

        // Rise: faster near center, slowing with age — capped at mid-wall
        const maxY = 1.5;
        const heightRatio = Math.max(0, (p.position.y - cx) / (maxY - cx)); // 0 at base → 1 at cap
        const headroom = maxY - p.position.y;

        if (headroom > 0.3) {
          p.direction.y = 0.4 + (1 - t) * 0.7 + pRand * 0.3;
        } else if (headroom > 0) {
          p.direction.y = (headroom / 0.3) * 0.15;
        } else {
          p.direction.y = -0.2;
        }

        // Expand outward as particle rises (funnel shape)
        const expandFactor = (0.2 + pRand * 0.3) * t;
        p.position.x += expandFactor * rx * invDist * 0.01;
        p.position.z += expandFactor * rz * invDist * 0.01;

        // Integrate position from direction
        p.position.x += p.direction.x * scaledSpeed;
        p.position.y += p.direction.y * scaledSpeed;
        p.position.z += p.direction.z * scaledSpeed;

        // Color: grayish-white with per-particle tint variation
        const grey = 0.7 + pRand * 0.25;
        p.color.r = grey;
        p.color.g = grey + 0.02;
        p.color.b = grey + 0.05;
        // Fade based on lifetime AND height — near top fades out fast
        const lifeFade = t < 0.75 ? 1 : (1 - t) / 0.25;
        const heightFade = heightRatio > 0.5 ? 1 - (heightRatio - 0.5) / 0.5 : 1;
        p.color.a = (0.4 + pRand * 0.4) * lifeFade * heightFade;

        // Size grows with age
        p.size = 0.015 + t * 0.035 + pRand * 0.015;
      }
    };

    funnel.targetStopDuration = duration;
    funnel.disposeOnStop = true;
    this.protectSharedTextures(funnel);
    funnel.start();

    // 2. Ground dust ring — pulsing torus at base
    const ring = this.getRingMesh();
    ring.position.set(position.x, position.y + 0.02, position.z);
    ring.scaling.set(0.3, 1, 0.3);
    ring.isVisible = true;
    const ringMat = ring.material as StandardMaterial;
    ringMat.alpha = 0.5;
    ringMat.emissiveColor = new Color3(0.55, 0.42, 0.2); // Warm brown
    this.tornadoRings.push({ mesh: ring, elapsed: 0, duration });

    // 3. Debris particles — small dark particles near base
    const debris = new ParticleSystem("tornadoDebris", 40, this.scene);
    debris.particleTexture = this.particleTexture;
    debris.emitter = position.clone();
    debris.minEmitBox = new Vector3(-0.15, 0, -0.15);
    debris.maxEmitBox = new Vector3(0.15, 0.1, 0.15);
    debris.minLifeTime = 0.3;
    debris.maxLifeTime = 0.8;
    debris.minSize = 0.008;
    debris.maxSize = 0.025;
    debris.minEmitPower = 0.3;
    debris.maxEmitPower = 1.0;
    debris.direction1 = new Vector3(-0.5, 0.1, -0.5);
    debris.direction2 = new Vector3(0.5, 0.5, 0.5);
    debris.gravity = new Vector3(0, -1, 0);
    debris.emitRate = 30;
    debris.minAngularSpeed = -8;
    debris.maxAngularSpeed = 8;

    // Dark brown
    debris.color1 = new Color4(0.35, 0.25, 0.15, 0.8);
    debris.color2 = new Color4(0.5, 0.35, 0.2, 0.6);
    debris.colorDead = new Color4(0.25, 0.2, 0.1, 0);

    debris.targetStopDuration = duration;
    debris.disposeOnStop = true;
    this.protectSharedTextures(debris);
    debris.start();
  }

  /** Explosion VFX: white-hot flash → fireball → embers → thick smoke */
  playExplosion(position: Vector3, _radius: number = 0.5): void {
    // 1. White-hot flash ring — fast, bright, sells the initial "bang"
    const flashRing = this.getRingMesh();
    flashRing.position.set(position.x, position.y + 0.02, position.z);
    flashRing.scaling.set(0.05, 1, 0.05);
    flashRing.isVisible = true;
    const flashMat = flashRing.material as StandardMaterial;
    flashMat.alpha = 1.0;
    flashMat.emissiveColor = new Color3(1.0, 0.95, 0.7); // White-hot
    this.activeRings.push({ mesh: flashRing, age: 0, maxAge: 0.3, startScale: 0.05, endScale: 1.5 });

    // 2. Outer shockwave ring — slower, orange, gives sense of scale
    const shockRing = this.getRingMesh();
    shockRing.position.set(position.x, position.y + 0.01, position.z);
    shockRing.scaling.set(0.1, 1, 0.1);
    shockRing.isVisible = true;
    const shockMat = shockRing.material as StandardMaterial;
    shockMat.alpha = 0.8;
    shockMat.emissiveColor = new Color3(1.0, 0.4, 0.05); // Deep orange
    this.activeRings.push({ mesh: shockRing, age: 0, maxAge: 0.7, startScale: 0.1, endScale: 3.0 });

    if (!this.particleTexture) return;

    // 3. Fireball core — big, bright, fast expanding then fading
    //    White-hot center → yellow → orange → red → disappears
    const fireball = new ParticleSystem("explosionFireball", 200, this.scene);
    fireball.particleTexture = this.particleTexture;
    fireball.emitter = position.clone();
    fireball.minEmitBox = new Vector3(-0.03, 0, -0.03);
    fireball.maxEmitBox = new Vector3(0.03, 0.05, 0.03);
    fireball.minLifeTime = 0.4;
    fireball.maxLifeTime = 0.9;
    fireball.minSize = 0.05;
    fireball.maxSize = 0.15;
    fireball.minEmitPower = 1.5;
    fireball.maxEmitPower = 4.0;
    fireball.direction1 = new Vector3(-1.2, 1.0, -1.2);
    fireball.direction2 = new Vector3(1.2, 4.0, 1.2);
    fireball.gravity = new Vector3(0, -1.5, 0);
    fireball.emitRate = 1500;
    fireball.blendMode = ParticleSystem.BLENDMODE_ADD;

    // Color over lifetime: white-hot → yellow → orange → red
    fireball.addColorGradient(0, new Color4(1.0, 1.0, 0.9, 1.0));    // White-hot
    fireball.addColorGradient(0.15, new Color4(1.0, 0.9, 0.3, 1.0)); // Bright yellow
    fireball.addColorGradient(0.4, new Color4(1.0, 0.5, 0.05, 0.9)); // Orange
    fireball.addColorGradient(0.7, new Color4(0.8, 0.15, 0.0, 0.6)); // Deep red
    fireball.addColorGradient(1.0, new Color4(0.3, 0.05, 0.0, 0.0)); // Dark red → transparent

    // Size: expand then shrink
    fireball.addSizeGradient(0, 0.04);
    fireball.addSizeGradient(0.2, 0.15);
    fireball.addSizeGradient(0.6, 0.10);
    fireball.addSizeGradient(1.0, 0.02);

    fireball.targetStopDuration = 0.12;
    fireball.disposeOnStop = true;
    this.protectSharedTextures(fireball);
    fireball.start();
    this.trackBurst(fireball);

    // 4. Embers — small hot sparks arcing outward
    const embers = new ParticleSystem("explosionEmbers", 100, this.scene);
    embers.particleTexture = this.particleTexture;
    embers.emitter = position.clone();
    embers.minLifeTime = 0.5;
    embers.maxLifeTime = 1.2;
    embers.minSize = 0.008;
    embers.maxSize = 0.025;
    embers.minEmitPower = 3.0;
    embers.maxEmitPower = 7.0;
    embers.direction1 = new Vector3(-1.5, 0.5, -1.5);
    embers.direction2 = new Vector3(1.5, 5.0, 1.5);
    embers.gravity = new Vector3(0, -5, 0);
    embers.emitRate = 800;
    embers.blendMode = ParticleSystem.BLENDMODE_ADD;
    embers.minAngularSpeed = -10;
    embers.maxAngularSpeed = 10;

    // Embers: bright yellow → orange → dark
    embers.addColorGradient(0, new Color4(1.0, 0.95, 0.5, 1.0));
    embers.addColorGradient(0.3, new Color4(1.0, 0.6, 0.1, 1.0));
    embers.addColorGradient(0.7, new Color4(0.8, 0.2, 0.0, 0.7));
    embers.addColorGradient(1.0, new Color4(0.3, 0.05, 0.0, 0.0));

    embers.targetStopDuration = 0.1;
    embers.disposeOnStop = true;
    this.protectSharedTextures(embers);
    embers.start();
    this.trackBurst(embers);

    // 5. Thick smoke — dark, big, rises slowly, lingers
    const smoke = new ParticleSystem("explosionSmoke", 100, this.scene);
    smoke.particleTexture = this.particleTexture;
    smoke.emitter = position.clone();
    smoke.minEmitBox = new Vector3(-0.08, 0, -0.08);
    smoke.maxEmitBox = new Vector3(0.08, 0.05, 0.08);
    smoke.minLifeTime = 1.2;
    smoke.maxLifeTime = 2.5;
    smoke.minSize = 0.06;
    smoke.maxSize = 0.18;
    smoke.minEmitPower = 0.2;
    smoke.maxEmitPower = 0.8;
    smoke.direction1 = new Vector3(-0.4, 0.5, -0.4);
    smoke.direction2 = new Vector3(0.4, 1.5, 0.4);
    smoke.gravity = new Vector3(0, 0.3, 0); // Rises
    smoke.emitRate = 300;

    // Smoke: starts orange-tinted (hot) → dark grey → fades
    smoke.addColorGradient(0, new Color4(0.5, 0.3, 0.1, 0.7));
    smoke.addColorGradient(0.2, new Color4(0.25, 0.2, 0.15, 0.5));
    smoke.addColorGradient(0.6, new Color4(0.15, 0.12, 0.1, 0.35));
    smoke.addColorGradient(1.0, new Color4(0.08, 0.06, 0.04, 0.0));

    // Smoke expands as it rises
    smoke.addSizeGradient(0, 0.04);
    smoke.addSizeGradient(0.3, 0.12);
    smoke.addSizeGradient(0.7, 0.18);
    smoke.addSizeGradient(1.0, 0.12);

    smoke.targetStopDuration = 0.4;
    smoke.disposeOnStop = true;
    this.protectSharedTextures(smoke);
    smoke.start();
    this.trackBurst(smoke);

    // 6. Screen flash — brief bright flash for impact
    this.comboFlashAlpha = 0.25;
  }

  /** Lightning storm VFX: bolts rain down over duration with impact effects.
   *  Uses setInterval to spawn bolts periodically across the full play area. */
  playLightning(duration: number = 3.0): void {
    const platformY = SCENE_CONFIG.PLATFORM.POSITION.y + SCENE_CONFIG.PLATFORM.THICKNESS / 2;
    const { POSITION: PLAT_POS, DEPTH: PLAT_DEPTH, WIDTH, FLARE_Z, FLARE_ANGLE } = SCENE_CONFIG.PLATFORM;
    const { POSITION: PUSH_POS, DEPTH: PUSH_DEPTH } = SCENE_CONFIG.PUSHER;
    const hw = WIDTH / 2;
    const flareRad = FLARE_ANGLE * Math.PI / 180;

    // Full strike zone: pusher back edge to platform front edge
    const backZ = PUSH_POS.z - PUSH_DEPTH / 2;
    const frontZ = PLAT_POS.z + PLAT_DEPTH / 2;

    let boltIndex = 0;
    const intervalMs = 180;

    const timer = setInterval(() => {
      // Pick random position within the full zone
      const sz = backZ + Math.random() * (frontZ - backZ);
      let halfW: number;
      if (sz < FLARE_Z) {
        halfW = hw;
      } else {
        halfW = hw + Math.tan(flareRad) * (sz - FLARE_Z);
      }
      halfW -= 0.05;
      const sx = (Math.random() * 2 - 1) * halfW;
      const impactPos = new Vector3(sx, platformY, sz);

      const allMeshes: Mesh[] = [];

      // Bolt origin: above impact with slight horizontal drift
      const boltStart = new Vector3(
        impactPos.x + (Math.random() - 0.5) * 0.3,
        platformY + 1.5,
        impactPos.z + (Math.random() - 0.5) * 0.2,
      );

      // Main bolt
      allMeshes.push(...this.createBoltTube(boltStart, impactPos, 0.005, 4, 0.45));

      // 2-3 branches
      const branchCount = 2 + Math.floor(Math.random() * 2);
      for (let b = 0; b < branchCount; b++) {
        const t = 0.15 + Math.random() * 0.6;
        const branchOrigin = Vector3.Lerp(boltStart, impactPos, t);
        branchOrigin.x += (Math.random() - 0.5) * 0.05;
        branchOrigin.z += (Math.random() - 0.5) * 0.05;

        const branchEnd = new Vector3(
          branchOrigin.x + (Math.random() - 0.5) * 0.5,
          branchOrigin.y - (0.2 + Math.random() * 0.5),
          branchOrigin.z + (Math.random() - 0.5) * 0.5,
        );
        allMeshes.push(...this.createBoltTube(branchOrigin, branchEnd, 0.003, 3, 0.5));
      }

      // Track for animated fade-out
      this.activeBolts.push({ meshes: allMeshes, age: 0, maxAge: 0.35 });

      // Impact ring
      const ring = this.getRingMesh();
      ring.position.set(impactPos.x, platformY + 0.02, impactPos.z);
      ring.scaling.set(0.05, 1, 0.05);
      ring.isVisible = true;
      const ringMat = ring.material as StandardMaterial;
      ringMat.alpha = 0.9;
      ringMat.emissiveColor = new Color3(0.7, 0.9, 1.0);
      this.activeRings.push({ mesh: ring, age: 0, maxAge: 0.4, startScale: 0.05, endScale: 1.5 });

      // Spark burst at impact
      if (this.particleTexture) {
        const sparks = new ParticleSystem(`lightningSparks_${boltIndex}`, 40, this.scene);
        sparks.particleTexture = this.particleTexture;
        sparks.emitter = impactPos.clone();
        sparks.minLifeTime = 0.25;
        sparks.maxLifeTime = 0.6;
        sparks.minSize = 0.01;
        sparks.maxSize = 0.04;
        sparks.minEmitPower = 2;
        sparks.maxEmitPower = 6;
        sparks.direction1 = new Vector3(-1.5, 0.5, -1.5);
        sparks.direction2 = new Vector3(1.5, 3, 1.5);
        sparks.gravity = new Vector3(0, -4, 0);
        sparks.emitRate = 500;
        sparks.blendMode = ParticleSystem.BLENDMODE_ADD;

        sparks.addColorGradient(0, new Color4(0.9, 0.95, 1.0, 1.0));
        sparks.addColorGradient(0.4, new Color4(0.6, 0.7, 1.0, 0.8));
        sparks.addColorGradient(1.0, new Color4(0.4, 0.2, 0.7, 0.0));

        sparks.targetStopDuration = 0.1;
        sparks.disposeOnStop = true;
        this.protectSharedTextures(sparks);
        sparks.start();
        this.trackBurst(sparks);
      }

      // Screen flash every 4th bolt
      if (boltIndex % 4 === 0) {
        this.comboFlashAlpha = 0.12;
      }

      boltIndex++;
    }, intervalMs);
    this.activeTimers.push(timer);

    // Stop spawning after duration
    const stopTimer = setTimeout(() => clearInterval(timer), duration * 1000);
    this.activeTimers.push(stopTimer as unknown as ReturnType<typeof setInterval>);
  }

  /** Super push VFX: charge phase (converging particles + contracting rings)
   *  then thrust phase (red push wave + energy trail + impact sparks + flash). */
  playSuperPush(): void {
    if (!this.particleTexture) return;

    const pusherPos = SCENE_CONFIG.PUSHER.POSITION;
    const platformY = SCENE_CONFIG.PLATFORM.POSITION.y + SCENE_CONFIG.PLATFORM.THICKNESS / 2;
    const chargeCenter = new Vector3(pusherPos.x, platformY + 0.15, pusherPos.z);
    const { PULLBACK_DURATION, THRUST_DURATION } = SUPER_PUSH_CONFIG;

    // ── CHARGE PHASE (0 - PULLBACK_DURATION ms) ──

    // 1. Converging energy particles — spiral inward toward pusher center
    const charge = new ParticleSystem("superPushCharge", 150, this.scene);
    charge.particleTexture = this.particleTexture;
    charge.emitter = chargeCenter.clone();
    charge.minEmitBox = new Vector3(-0.8, -0.3, -0.5);
    charge.maxEmitBox = new Vector3(0.8, 0.3, 0.5);
    charge.minLifeTime = 0.3;
    charge.maxLifeTime = 0.5;
    charge.minSize = 0.015;
    charge.maxSize = 0.04;
    charge.minEmitPower = 0.1;
    charge.maxEmitPower = 0.3;
    charge.emitRate = 350;
    charge.blendMode = ParticleSystem.BLENDMODE_ADD;

    // Cyan/white colors
    charge.addColorGradient(0, new Color4(0.3, 0.9, 1.0, 0.9));
    charge.addColorGradient(0.5, new Color4(0.6, 0.95, 1.0, 0.7));
    charge.addColorGradient(1.0, new Color4(1.0, 1.0, 1.0, 0.0));

    const cx = chargeCenter.x;
    const cz = chargeCenter.z;
    charge.updateFunction = (particles) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const scaledSpeed = (charge as any)._scaledUpdateSpeed as number;
      for (let i = 0; i < particles.length; i++) {
        const p = particles[i];
        p.age += scaledSpeed;
        if (p.age >= p.lifeTime) {
          charge.recycleParticle(p);
          i--;
          continue;
        }
        const t = p.age / p.lifeTime;
        // Pull toward center with increasing force
        const dx = cx - p.position.x;
        const dz = cz - p.position.z;
        const dy = chargeCenter.y - p.position.y;
        const pull = 2.0 + t * 4.0;
        p.position.x += dx * pull * scaledSpeed;
        p.position.y += dy * pull * scaledSpeed;
        p.position.z += dz * pull * scaledSpeed;
        // Slight spiral
        const dist = Math.sqrt(dx * dx + dz * dz);
        if (dist > 0.01) {
          p.position.x += (-dz / dist) * 0.5 * scaledSpeed;
          p.position.z += (dx / dist) * 0.5 * scaledSpeed;
        }
        p.color.a = (1 - t) * 0.8;
        p.size = 0.02 + (1 - t) * 0.03;
      }
    };

    charge.targetStopDuration = PULLBACK_DURATION / 1000;
    charge.disposeOnStop = true;
    this.protectSharedTextures(charge);
    charge.start();
    this.trackBurst(charge);

    // 2. Converging rings (reverse shockwave) — 2 rings
    for (let i = 0; i < 2; i++) {
      const delay = i * 150;
      const ringTimer = setTimeout(() => {
        const ring = this.getRingMesh();
        ring.position.set(chargeCenter.x, platformY + 0.03, chargeCenter.z);
        ring.scaling.set(2.0, 1, 2.0); // Start large
        ring.isVisible = true;
        const mat = ring.material as StandardMaterial;
        mat.alpha = 0.6;
        mat.emissiveColor = new Color3(0.3, 0.85, 0.95);
        // Contracting ring: large → small
        this.activeRings.push({ mesh: ring, age: 0, maxAge: 0.35, startScale: 2.0, endScale: 0.1 });
      }, delay);
      this.activeTimers.push(ringTimer as unknown as ReturnType<typeof setInterval>);
    }

    // ── THRUST PHASE (after PULLBACK_DURATION ms) ──

    const thrustDelay = PULLBACK_DURATION;
    const thrustTimer = setTimeout(() => {
      // Front face Z during thrust
      const thrustFrontZ = SCENE_CONFIG.PUSHER.POSITION.z + SUPER_PUSH_CONFIG.THRUST_Z + SCENE_CONFIG.PUSHER.DEPTH / 2;
      const thrustPos = new Vector3(0, platformY + 0.05, thrustFrontZ);

      // 1. Red push wave ring
      const pushRing = this.getRingMesh();
      pushRing.position.set(0, platformY + 0.03, thrustPos.z);
      pushRing.scaling.set(0.3, 1, 0.3);
      pushRing.isVisible = true;
      const pushMat = pushRing.material as StandardMaterial;
      pushMat.alpha = 0.9;
      pushMat.emissiveColor = new Color3(1.0, 0.2, 0.05);
      this.activeRings.push({ mesh: pushRing, age: 0, maxAge: 0.5, startScale: 0.3, endScale: 4.0 });

      // 2. Red energy trail particles
      const trail = new ParticleSystem("superPushTrail", 200, this.scene);
      trail.particleTexture = this.particleTexture;
      trail.emitter = thrustPos.clone();
      trail.minEmitBox = new Vector3(-0.5, -0.05, -0.1);
      trail.maxEmitBox = new Vector3(0.5, 0.1, 0.1);
      trail.minLifeTime = 0.2;
      trail.maxLifeTime = 0.5;
      trail.minSize = 0.03;
      trail.maxSize = 0.08;
      trail.minEmitPower = 2;
      trail.maxEmitPower = 5;
      trail.direction1 = new Vector3(-0.5, 0.2, 0.5);
      trail.direction2 = new Vector3(0.5, 1.0, 2.0);
      trail.gravity = new Vector3(0, -2, 0);
      trail.emitRate = 1200;
      trail.blendMode = ParticleSystem.BLENDMODE_ADD;
      trail.billboardMode = ParticleSystem.BILLBOARDMODE_STRETCHED;
      trail.minScaleX = 1.0;
      trail.maxScaleX = 1.0;
      trail.minScaleY = 2.0;
      trail.maxScaleY = 4.0;

      // Red-orange colors
      trail.addColorGradient(0, new Color4(1.0, 0.4, 0.1, 1.0));
      trail.addColorGradient(0.3, new Color4(1.0, 0.2, 0.0, 0.8));
      trail.addColorGradient(1.0, new Color4(0.5, 0.05, 0.0, 0.0));

      trail.targetStopDuration = 0.3;
      trail.disposeOnStop = true;
      this.protectSharedTextures(trail);
      trail.start();
      this.trackBurst(trail);

      // 3. Impact sparks at full extension
      const impactDelay = THRUST_DURATION;
      const sparkTimer = setTimeout(() => {
        const sparks = new ParticleSystem("superPushSparks", 120, this.scene);
        sparks.particleTexture = this.particleTexture!;
        sparks.emitter = thrustPos.clone();
        sparks.minLifeTime = 0.1;
        sparks.maxLifeTime = 0.25;
        sparks.minSize = 0.01;
        sparks.maxSize = 0.03;
        sparks.minEmitPower = 3;
        sparks.maxEmitPower = 7;
        sparks.direction1 = new Vector3(-1.5, 0.5, -0.5);
        sparks.direction2 = new Vector3(1.5, 3, 1.5);
        sparks.gravity = new Vector3(0, -5, 0);
        sparks.emitRate = 1000;
        sparks.blendMode = ParticleSystem.BLENDMODE_ADD;

        // Gold/white sparks
        sparks.addColorGradient(0, new Color4(1.0, 0.95, 0.7, 1.0));
        sparks.addColorGradient(0.4, new Color4(1.0, 0.8, 0.3, 0.8));
        sparks.addColorGradient(1.0, new Color4(0.8, 0.4, 0.1, 0.0));

        sparks.targetStopDuration = 0.1;
        sparks.disposeOnStop = true;
        this.protectSharedTextures(sparks);
        sparks.start();
        this.trackBurst(sparks);
      }, impactDelay);
      this.activeTimers.push(sparkTimer as unknown as ReturnType<typeof setInterval>);

      // 4. Ground impact debris — low brown/grey particles at impact point
      const debris = new ParticleSystem("superPushDebris", 60, this.scene);
      debris.particleTexture = this.particleTexture!;
      debris.emitter = thrustPos.clone();
      debris.minEmitBox = new Vector3(-0.4, -0.02, -0.05);
      debris.maxEmitBox = new Vector3(0.4, 0.02, 0.05);
      debris.minLifeTime = 0.3;
      debris.maxLifeTime = 0.6;
      debris.minSize = 0.01;
      debris.maxSize = 0.03;
      debris.minEmitPower = 0.5;
      debris.maxEmitPower = 1.5;
      debris.direction1 = new Vector3(-1.0, 0.1, -0.5);
      debris.direction2 = new Vector3(1.0, 0.6, 1.0);
      debris.gravity = new Vector3(0, -3, 0);
      debris.emitRate = 400;
      debris.minAngularSpeed = -6;
      debris.maxAngularSpeed = 6;

      // Brown/grey debris colors
      debris.color1 = new Color4(0.45, 0.35, 0.25, 0.9);
      debris.color2 = new Color4(0.55, 0.5, 0.45, 0.7);
      debris.colorDead = new Color4(0.3, 0.25, 0.2, 0);

      debris.targetStopDuration = 0.15;
      debris.disposeOnStop = true;
      this.protectSharedTextures(debris);
      debris.start();
      this.trackBurst(debris);

      // 5. Screen flash — red tinted
      this.comboFlashAlpha = 0.18;
      if (this.comboFlashMesh) {
        const mat = this.comboFlashMesh.material as StandardMaterial;
        mat.diffuseColor = new Color3(1.0, 0.15, 0.05);
        mat.emissiveColor = new Color3(1.0, 0.15, 0.05);
        // Restore gold color after flash fades
        const restoreTimer = setTimeout(() => {
          mat.diffuseColor = new Color3(1.0, 0.85, 0.4);
          mat.emissiveColor = new Color3(1.0, 0.85, 0.4);
        }, 200);
        this.activeTimers.push(restoreTimer as unknown as ReturnType<typeof setInterval>);
      }
    }, thrustDelay);
    this.activeTimers.push(thrustTimer as unknown as ReturnType<typeof setInterval>);
  }

  /** Celebration: gold coins raining from above (no physics).
   *  Self-disposing — not tracked in the burst pool. */
  playRewardCoinRain(duration = 3): void {
    if (!this.coinRewardTex) {
      this.coinRewardTex = this.createCoinRewardTexture();
    }

    const ps = new ParticleSystem("rewardCoinRain", 500, this.scene);
    ps.particleTexture = this.coinRewardTex;
    ps.blendMode = ParticleSystem.BLENDMODE_STANDARD;

    ps.emitter = new Vector3(0, 3.5, 0.3);
    ps.minEmitBox = new Vector3(-1.8, 0, -1.2);
    ps.maxEmitBox = new Vector3(1.8, 0.5, 1.2);

    ps.minLifeTime = 1.5;
    ps.maxLifeTime = 3;
    ps.minSize = 0.06;
    ps.maxSize = 0.12;
    ps.minEmitPower = 0.3;
    ps.maxEmitPower = 1.0;
    ps.direction1 = new Vector3(-0.3, -1, -0.3);
    ps.direction2 = new Vector3(0.3, -0.5, 0.3);
    ps.gravity = new Vector3(0, -2, 0);
    ps.emitRate = 120;

    // Gold colors
    ps.color1 = new Color4(1.0, 0.9, 0.4, 1);
    ps.color2 = new Color4(1.0, 0.65, 0.15, 1);
    ps.colorDead = new Color4(0.8, 0.55, 0.1, 0);

    // Tumble
    ps.minAngularSpeed = -3;
    ps.maxAngularSpeed = 3;

    ps.targetStopDuration = duration;
    ps.disposeOnStop = true;
    this.protectSharedTextures(ps);
    ps.start();
  }

  /** Celebration: lottery tickets fluttering from above (no physics).
   *  Self-disposing — not tracked in the burst pool. */
  playRewardTicketRain(duration = 3): void {
    if (!this.ticketRewardTex) {
      this.ticketRewardTex = this.createTicketRewardTexture();
    }

    // Helper to configure a ticket sub-system
    const makeTicketSystem = (
      name: string,
      capacity: number,
      rate: number,
      c1: Color4,
      c2: Color4,
      cDead: Color4,
    ): void => {
      const ps = new ParticleSystem(name, capacity, this.scene);
      ps.particleTexture = this.ticketRewardTex;
      ps.blendMode = ParticleSystem.BLENDMODE_STANDARD;

      ps.emitter = new Vector3(0, 3.5, 0.3);
      ps.minEmitBox = new Vector3(-2, 0, -1.5);
      ps.maxEmitBox = new Vector3(2, 0.5, 1.5);

      ps.minLifeTime = 3;
      ps.maxLifeTime = 6;
      ps.minSize = 0.05;
      ps.maxSize = 0.1;

      // Gentle initial push — mostly horizontal for sway
      ps.minEmitPower = 0.1;
      ps.maxEmitPower = 0.4;
      ps.direction1 = new Vector3(-1, -0.4, -0.5);
      ps.direction2 = new Vector3(1, 0.1, 0.5);

      // Very light gravity — float, don't drop
      ps.gravity = new Vector3(0, -0.35, 0);
      ps.emitRate = rate;

      ps.color1 = c1;
      ps.color2 = c2;
      ps.colorDead = cDead;

      // Random initial orientation + fast tumble for flutter look
      ps.minInitialRotation = -Math.PI;
      ps.maxInitialRotation = Math.PI;
      ps.minAngularSpeed = -6;
      ps.maxAngularSpeed = 6;

      // Air resistance: increasingly slow down to mimic paper drag
      ps.addDragGradient(0, 0.05);
      ps.addDragGradient(0.3, 0.15);
      ps.addDragGradient(0.6, 0.35);
      ps.addDragGradient(1, 0.6);

      // Wind noise — left-right sway while falling
      if (!this.windNoiseTex) {
        this.windNoiseTex = new NoiseProceduralTexture("windNoise", 256, this.scene);
        this.windNoiseTex.animationSpeedFactor = 3;
        this.windNoiseTex.persistence = 0.8;
        this.windNoiseTex.brightness = 0.5;
        this.windNoiseTex.octaves = 3;
      }
      ps.noiseTexture = this.windNoiseTex;
      ps.noiseStrength = new Vector3(0.8, 0.15, 0.4);

      ps.targetStopDuration = duration;
      ps.disposeOnStop = true;
      this.protectSharedTextures(ps);
      ps.start();
    };

    // Warm colors (red / gold)
    makeTicketSystem(
      "rewardTicket1", 250, 40,
      new Color4(1.0, 0.3, 0.2, 1),
      new Color4(1.0, 0.85, 0.2, 1),
      new Color4(1.0, 0.4, 0.1, 0),
    );

    // Cool colors (purple / cyan)
    makeTicketSystem(
      "rewardTicket2", 200, 30,
      new Color4(0.6, 0.2, 0.9, 1),
      new Color4(0.2, 0.8, 0.9, 1),
      new Color4(0.3, 0.3, 0.8, 0),
    );
  }

  // ── Internal: Persistent Effects ───────────────────────────────────────────

  private initComboFlash(): void {
    const camera = this.scene.activeCamera;
    if (!camera) return;

    // Place plane in front of camera — BabylonJS ArcRotateCamera local Z points toward target
    const mesh = MeshBuilder.CreatePlane("comboFlash", { size: 50 }, this.scene);
    mesh.parent = camera;
    mesh.position = new Vector3(0, 0, 1.5); // In front of camera
    mesh.billboardMode = Mesh.BILLBOARDMODE_NONE;
    mesh.isPickable = false;

    const mat = new StandardMaterial("comboFlashMat", this.scene);
    mat.diffuseColor = new Color3(1.0, 0.85, 0.4);
    mat.emissiveColor = new Color3(1.0, 0.85, 0.4);
    mat.disableLighting = true;
    mat.backFaceCulling = false;
    mat.alpha = 0;
    mesh.material = mat;

    this.comboFlashMesh = mesh;
  }

  private cacheWallMaterial(): void {
    const mat = this.scene.getMaterialByName("wallMat");
    if (mat && mat instanceof ShaderMaterial) {
      this.wallMat = mat;
    }
  }

  /** Refresh cached wall material reference and base color (call after theme change).
   *  ShaderMaterial uniforms are write-only, so base color must be passed from SceneManager. */
  refreshWallColor(baseColor?: Color3): void {
    this.cacheWallMaterial();
    if (baseColor) {
      this.wallBaseColor = baseColor.clone();
    }
  }

  // ── Internal: Update Loop ──────────────────────────────────────────────────

  private update(dt: number): void {
    this.updateWallPulse(dt);
    this.updateRings(dt);
    this.updateTornadoRings(dt);
    this.updateBolts(dt);
    this.updateComboFlash(dt);
    this.holePortalVFX?.update(dt);
    this.dropZoneVFX?.update(dt);
    this.cleanupBurstSystems();
  }

  private updateWallPulse(dt: number): void {
    if (!this.wallMat || !this.wallBaseColor) return;

    this.wallPulseTime += dt * this.config.wallPulseSpeed;
    const pulse = (Math.sin(this.wallPulseTime * Math.PI * 2) + 1) * 0.5; // 0..1
    const intensity = pulse * this.config.wallPulseIntensity;

    // Brighten toward teal-white (magic shimmer)
    VFXManager._scratchColor.set(
      this.wallBaseColor.r + intensity * 0.15,
      this.wallBaseColor.g + intensity * 0.35,
      this.wallBaseColor.b + intensity * 0.35,
    );
    this.wallMat.setColor3("baseColor", VFXManager._scratchColor);
  }

  private updateRings(dt: number): void {
    for (let i = this.activeRings.length - 1; i >= 0; i--) {
      const ring = this.activeRings[i];
      ring.age += dt;
      const t = ring.age / ring.maxAge;

      if (t >= 1) {
        ring.mesh.isVisible = false;
        if (this.ringPool.length >= VFXManager.MAX_RING_POOL) {
          (ring.mesh.material as StandardMaterial)?.dispose?.();
          ring.mesh.dispose();
        } else {
          const mat = ring.mesh.material as StandardMaterial;
          mat.emissiveColor = new Color3(0.6, 0.48, 0.25);
          this.ringPool.push(ring.mesh);
        }
        this.activeRings.splice(i, 1);
        continue;
      }

      // Expand and fade — use per-ring scale range
      const scale = ring.startScale + t * (ring.endScale - ring.startScale);
      ring.mesh.scaling.set(scale, 1, scale);
      const mat = ring.mesh.material as StandardMaterial;
      mat.alpha = 0.7 * (1 - t * t); // Quadratic fade for longer visibility
    }
  }

  private updateTornadoRings(dt: number): void {
    for (let i = this.tornadoRings.length - 1; i >= 0; i--) {
      const tr = this.tornadoRings[i];
      tr.elapsed += dt;

      if (tr.elapsed >= tr.duration) {
        tr.mesh.isVisible = false;
        if (this.ringPool.length >= VFXManager.MAX_RING_POOL) {
          (tr.mesh.material as StandardMaterial)?.dispose?.();
          tr.mesh.dispose();
        } else {
          const mat = tr.mesh.material as StandardMaterial;
          mat.emissiveColor = new Color3(0.6, 0.48, 0.25);
          this.ringPool.push(tr.mesh);
        }
        this.tornadoRings.splice(i, 1);
        continue;
      }

      // Pulsing scale between 0.3 and 0.5
      const pulse = Math.sin(tr.elapsed * 4) * 0.5 + 0.5; // 0..1
      const scale = 0.3 + pulse * 0.2;
      tr.mesh.scaling.set(scale, 1, scale);

      // Fade out in last 0.5s
      const remaining = tr.duration - tr.elapsed;
      const mat = tr.mesh.material as StandardMaterial;
      mat.alpha = remaining < 0.5 ? remaining / 0.5 * 0.5 : 0.5;
    }
  }

  private updateComboFlash(dt: number): void {
    if (this.comboFlashAlpha <= 0) return;

    this.comboFlashAlpha = Math.max(0, this.comboFlashAlpha - dt * 1.5);
    if (this.comboFlashMesh) {
      (this.comboFlashMesh.material as StandardMaterial).alpha = this.comboFlashAlpha;
    }
  }

  private updateBolts(dt: number): void {
    for (let i = this.activeBolts.length - 1; i >= 0; i--) {
      const bolt = this.activeBolts[i];
      bolt.age += dt;

      if (bolt.age >= bolt.maxAge) {
        for (const mesh of bolt.meshes) {
          mesh.material?.dispose();
          mesh.dispose();
        }
        this.activeBolts.splice(i, 1);
        continue;
      }

      const t = bolt.age / bolt.maxAge;
      // Quadratic fade with random flicker for electrical feel
      const baseFade = 1 - t * t;
      const flicker = 0.7 + Math.random() * 0.3;
      const alpha = baseFade * flicker;

      for (const mesh of bolt.meshes) {
        const mat = mesh.material as StandardMaterial;
        if (mat) {
          mat.alpha = alpha;
        }
      }
    }
  }

  private cleanupBurstSystems(): void {
    this.burstSystems = this.burstSystems.filter((ps) => ps.isAlive());
  }

  // ── Internal: Helpers ──────────────────────────────────────────────────────

  private trackBurst(ps: ParticleSystem): void {
    this.burstSystems.push(ps);

    // Enforce pool limit: stop oldest and let disposeOnStop clean up gracefully
    while (this.burstSystems.length > this.config.maxBurstSystems) {
      const oldest = this.burstSystems.shift();
      oldest?.stop();
    }
  }

  /** Prevent a disposeOnStop particle system from destroying shared textures.
   *  BabylonJS dispose(disposeTexture=true) is the default — this overrides to false. */
  private protectSharedTextures(ps: ParticleSystem): void {
    const orig = ps.dispose.bind(ps);
    ps.dispose = () => { orig(false); };
  }

  /** Create a bolt as a thin tube along a recursively-jagged path.
   *  Named "bolt_*" so GlowLayer picks it up for bloom. */
  private createBoltTube(start: Vector3, end: Vector3, radius: number, depth: number, jitter: number): Mesh[] {
    const path = this.generateBoltPath(start, end, depth, jitter);
    const uid = `bolt_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;

    const tube = MeshBuilder.CreateTube(uid, {
      path,
      radius,
      tessellation: 5,
      updatable: false,
    }, this.scene);
    tube.isPickable = false;

    const mat = new StandardMaterial(`${uid}_mat`, this.scene);
    mat.emissiveColor = new Color3(0.85, 0.95, 1.0);
    mat.diffuseColor = new Color3(0.85, 0.95, 1.0);
    mat.disableLighting = true;
    mat.backFaceCulling = false;
    tube.material = mat;

    return [tube];
  }

  /** Recursive midpoint displacement for fractal-jagged bolt paths. */
  private generateBoltPath(start: Vector3, end: Vector3, depth: number, jitter: number): Vector3[] {
    if (depth === 0) return [start, end];

    const mid = Vector3.Lerp(start, end, 0.45 + Math.random() * 0.1);
    const segLen = Vector3.Distance(start, end);
    const offset = jitter * segLen;

    mid.x += (Math.random() - 0.5) * offset;
    mid.z += (Math.random() - 0.5) * offset;
    mid.y += (Math.random() - 0.5) * offset * 0.25; // less vertical jitter

    const left = this.generateBoltPath(start, mid, depth - 1, jitter);
    const right = this.generateBoltPath(mid, end, depth - 1, jitter);

    // Merge, removing duplicate midpoint
    return [...left.slice(0, -1), ...right];
  }

  private getRingMesh(): Mesh {
    if (this.ringPool.length > 0) {
      return this.ringPool.pop()!;
    }

    const ring = MeshBuilder.CreateTorus(
      `vfxRing_${Date.now()}`,
      { diameter: 1, thickness: 0.04, tessellation: 48 },
      this.scene
    );
    ring.isPickable = false;
    ring.rotation.x = Math.PI / 2; // Lay flat

    const mat = new StandardMaterial(`vfxRingMat_${Date.now()}`, this.scene);
    mat.diffuseColor = new Color3(0.8, 0.64, 0.37);
    mat.emissiveColor = new Color3(0.6, 0.48, 0.25);
    mat.disableLighting = true;
    mat.alpha = 0.7;
    mat.backFaceCulling = false;
    ring.material = mat;
    ring.isVisible = false;

    return ring;
  }

  private createCoinRewardTexture(): Texture {
    const size = 128;
    const dt = new DynamicTexture("coinRewardTex", size, this.scene, false);
    const ctx = dt.getContext() as unknown as CanvasRenderingContext2D;
    const half = size / 2;

    // Transparent background
    ctx.clearRect(0, 0, size, size);

    // Solid gold disc
    ctx.beginPath();
    ctx.arc(half, half, half - 6, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(255, 255, 255, 1)";
    ctx.fill();

    // Rim ring
    ctx.beginPath();
    ctx.arc(half, half, half - 6, 0, Math.PI * 2);
    ctx.lineWidth = 4;
    ctx.strokeStyle = "rgba(180, 180, 180, 0.5)";
    ctx.stroke();

    // Inner detail ring
    ctx.beginPath();
    ctx.arc(half, half, half - 20, 0, Math.PI * 2);
    ctx.lineWidth = 2;
    ctx.strokeStyle = "rgba(200, 200, 200, 0.3)";
    ctx.stroke();

    dt.update();
    dt.hasAlpha = true;
    return dt;
  }

  private createTicketRewardTexture(): Texture {
    const size = 128;
    const dt = new DynamicTexture("ticketRewardTex", size, this.scene, false);
    const ctx = dt.getContext() as unknown as CanvasRenderingContext2D;
    const half = size / 2;

    ctx.clearRect(0, 0, size, size);

    // Rectangular ticket shape (wider than tall)
    const w = 110;
    const h = 70;
    const x = (size - w) / 2;
    const y = (size - h) / 2;
    const r = 6;

    // Rounded rectangle body
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.arcTo(x + w, y, x + w, y + r, r);
    ctx.lineTo(x + w, y + h - r);
    ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
    ctx.lineTo(x + r, y + h);
    ctx.arcTo(x, y + h, x, y + h - r, r);
    ctx.lineTo(x, y + r);
    ctx.arcTo(x, y, x + r, y, r);
    ctx.closePath();
    ctx.fillStyle = "rgba(255, 255, 255, 0.95)";
    ctx.fill();

    // Dashed perforation line
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(x + 8, y + 18);
    ctx.lineTo(x + w - 8, y + 18);
    ctx.strokeStyle = "rgba(200, 200, 200, 0.5)";
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.setLineDash([]);

    // Star symbol
    ctx.fillStyle = "rgba(255, 255, 255, 1)";
    ctx.font = "bold 28px sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("★", half, half + 5);

    dt.update();
    dt.hasAlpha = true;
    return dt;
  }

  private createParticleTexture(): Texture {
    const size = 64;
    const dt = new DynamicTexture("vfxParticleTex", size, this.scene, false);
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
