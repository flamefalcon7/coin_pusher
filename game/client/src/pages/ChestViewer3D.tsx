import { forwardRef, useEffect, useRef, useImperativeHandle } from 'react';
import { Engine } from '@babylonjs/core/Engines/engine';
import { Scene } from '@babylonjs/core/scene';
import { ArcRotateCamera } from '@babylonjs/core/Cameras/arcRotateCamera';
import { HemisphericLight } from '@babylonjs/core/Lights/hemisphericLight';
import { DirectionalLight } from '@babylonjs/core/Lights/directionalLight';
import { PointLight } from '@babylonjs/core/Lights/pointLight';
import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import { Color3, Color4 } from '@babylonjs/core/Maths/math.color';
import { SceneLoader } from '@babylonjs/core/Loading/sceneLoader';
import { Animation } from '@babylonjs/core/Animations/animation';
import { CubicEase, BackEase, EasingFunction } from '@babylonjs/core/Animations/easing';
import { ParticleSystem } from '@babylonjs/core/Particles/particleSystem';
import { GlowLayer } from '@babylonjs/core/Layers/glowLayer';
import { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial';
import { DynamicTexture } from '@babylonjs/core/Materials/Textures/dynamicTexture';
import type { AbstractMesh } from '@babylonjs/core/Meshes/abstractMesh';
import type { Mesh } from '@babylonjs/core/Meshes/mesh';
import '@babylonjs/loaders/glTF';

/* ── Types & Config ─────────────────────────────────────────────────── */

export type RarityTier = 'common' | 'rare' | 'epic' | 'legendary';
type ChestState = 'idle' | 'buildup' | 'burst' | 'reveal';

interface TierConfig {
  primary: Color3;
  secondary: Color3;
  particleLayers: number;      // 1-4
  shakeMaxAmplitude: number;
  cameraZoom: number;          // target radius
  cameraRotation: number;      // radians of alpha rotation during reveal
  lidStyle: 'normal' | 'backease' | 'fly' | 'explode';
  hasShockwave: boolean;
  hasGroundGlow: boolean;
  hasSecondaryBurst: boolean;
  pauseBeforeBurst: number;    // ms of eerie calm before burst (0 = none)
}

const TIER: Record<RarityTier, TierConfig> = {
  common: {
    primary: new Color3(0.30, 0.78, 0.40),   // green #4DC766
    secondary: Color3.White(),
    particleLayers: 1,
    shakeMaxAmplitude: 0.04,
    cameraZoom: 2.6,
    cameraRotation: 0,
    lidStyle: 'normal',
    hasShockwave: false,
    hasGroundGlow: false,
    hasSecondaryBurst: false,
    pauseBeforeBurst: 0,
  },
  rare: {
    primary: new Color3(0.38, 0.65, 0.98),   // blue #60A5FA
    secondary: new Color3(0.56, 0.85, 1.0),   // light blue #8FD9FF
    particleLayers: 2,
    shakeMaxAmplitude: 0.07,
    cameraZoom: 2.3,
    cameraRotation: Math.PI / 6,
    lidStyle: 'backease',
    hasShockwave: true,
    hasGroundGlow: false,
    hasSecondaryBurst: false,
    pauseBeforeBurst: 0,
  },
  epic: {
    primary: new Color3(0.66, 0.33, 0.97),   // purple #A855F7
    secondary: new Color3(0.85, 0.55, 1.0),   // light purple #D98CFF
    particleLayers: 3,
    shakeMaxAmplitude: 0.12,
    cameraZoom: 2.0,
    cameraRotation: Math.PI,
    lidStyle: 'fly',
    hasShockwave: true,
    hasGroundGlow: false,
    hasSecondaryBurst: false,
    pauseBeforeBurst: 0,
  },
  legendary: {
    primary: new Color3(1, 0.60, 0.15),       // orange #FF9926
    secondary: new Color3(1, 0.84, 0),         // gold #FFD700
    particleLayers: 4,
    shakeMaxAmplitude: 0.18,
    cameraZoom: 1.8,
    cameraRotation: Math.PI * 2,
    lidStyle: 'explode',
    hasShockwave: true,
    hasGroundGlow: true,
    hasSecondaryBurst: true,
    pauseBeforeBurst: 300,
  },
};

export const RARITY_COLORS: Record<RarityTier, string> = {
  common: '#4DC766',
  rare: '#60A5FA',
  epic: '#A855F7',
  legendary: '#FF9926',
};

export const RARITY_LABELS: Record<RarityTier, string> = {
  common: 'Item Acquired!',
  rare: 'Rare Item!',
  epic: 'EPIC SCROLL!',
  legendary: 'LEGENDARY!',
};

export const BUILDUP_MS: Record<RarityTier, number> = {
  common: 800,
  rare: 1200,
  epic: 2000,
  legendary: 3000,
};

export const BURST_MS: Record<RarityTier, number> = {
  common: 400,
  rare: 600,
  epic: 800,
  legendary: 1200,
};

/* Camera defaults */
const CAM_ALPHA = Math.PI * 0.75;
const CAM_BETA = Math.PI / 4;
const CAM_RADIUS = 3.0;
const CAM_TARGET = new Vector3(0, 0.55, 0);

/* ── Animation Engine ───────────────────────────────────────────────── */

class ChestAnimationEngine {
  private engine: Engine;
  private scene: Scene;
  private camera: ArcRotateCamera;
  private glowLayer: GlowLayer;
  private innerLight: PointLight;
  private particleTex: DynamicTexture;

  // Model
  private rootMesh: AbstractMesh | null = null;
  private lidMesh: AbstractMesh | null = null;
  private basePosition = Vector3.Zero();

  // State
  private tier: RarityTier = 'common';

  // Tracked disposables
  private particles: ParticleSystem[] = [];
  private tempMeshes: Mesh[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private animatables: any[] = [];
  private shakeRafId: number | null = null;
  private idleBobRafId: number | null = null;
  private camShakeRafId: number | null = null;
  private glowRafId: number | null = null;
  private seamLeakPs: ParticleSystem | null = null;
  private timers: number[] = [];
  private rewardMesh: Mesh | null = null;

  constructor(canvas: HTMLCanvasElement) {
    const engine = new Engine(canvas, true, {
      preserveDrawingBuffer: false,
      stencil: false,
      adaptToDeviceRatio: true,
      alpha: true,
    });
    this.engine = engine;

    const scene = new Scene(engine);
    scene.clearColor = new Color4(0, 0, 0, 0);
    this.scene = scene;

    // Camera — locked arc rotate
    const camera = new ArcRotateCamera('chestCam', CAM_ALPHA, CAM_BETA, CAM_RADIUS, CAM_TARGET.clone(), scene);
    camera.inputs.clear();
    this.camera = camera;

    // Lighting
    const hemi = new HemisphericLight('hemi', new Vector3(0, 1, 0), scene);
    hemi.intensity = 0.7;
    hemi.groundColor = new Color3(0.15, 0.1, 0.25);
    const dir = new DirectionalLight('dir', new Vector3(-0.5, -1, 0.5), scene);
    dir.intensity = 0.8;

    // Inner glow light (inside chest, off by default)
    const inner = new PointLight('innerGlow', new Vector3(0, 0.4, 0), scene);
    inner.intensity = 0;
    inner.diffuse = TIER.common.primary;
    inner.range = 3;
    this.innerLight = inner;

    // GlowLayer
    this.glowLayer = new GlowLayer('glow', scene, { blurKernelSize: 16 });
    this.glowLayer.intensity = 0.5;

    // Particle texture (procedural soft circle)
    this.particleTex = this.createParticleTexture();

    // Render loop + resize
    engine.runRenderLoop(() => scene.render());
    const onResize = () => engine.resize();
    window.addEventListener('resize', onResize);
    (this as any)._onResize = onResize;

    engine.resize();
  }

  /* ── Model Loading ─────────────────────────────────────────────────── */

  async loadModel(path: string) {
    const lastSlash = path.lastIndexOf('/');
    const rootUrl = path.substring(0, lastSlash + 1);
    const fileName = path.substring(lastSlash + 1);

    const result = await SceneLoader.ImportMeshAsync('', rootUrl, fileName, this.scene);

    // Stop all baked animations
    for (const ag of result.animationGroups ?? []) {
      ag.stop();
      ag.reset();
    }

    const root = result.meshes[0];
    this.rootMesh = root;

    // GLB imports use rotationQuaternion by default, which overrides euler rotation.
    // Clear it so we can animate rotation.x / rotation.z directly.
    for (const mesh of result.meshes) {
      mesh.rotationQuaternion = null;
    }

    // Find lid mesh
    this.lidMesh = result.meshes.find(m => {
      const n = m.name.toLowerCase();
      return n.includes('lid') || n.includes('top') || n.includes('cover');
    }) ?? null;

    // Sit on ground
    let minY = Infinity;
    for (const mesh of result.meshes) {
      mesh.computeWorldMatrix(true);
      const bb = mesh.getBoundingInfo();
      if (bb && bb.boundingBox.minimumWorld.y < minY) {
        minY = bb.boundingBox.minimumWorld.y;
      }
    }
    if (root && isFinite(minY)) {
      root.position.y -= minY;
    }

    this.basePosition = root.position.clone();
    this.startIdleBob();
  }

  /* ── Phase: Buildup ────────────────────────────────────────────────── */

  startBuildup() {
    this.stopIdleBob();
    this.startProgressiveShake();
    this.startInnerGlow();
    this.startSeamLeak();
  }

  /** Upgrade effects mid-buildup when tier becomes known. */
  setRarityTier(tier: RarityTier) {
    this.tier = tier;
    const cfg = TIER[tier];
    this.innerLight.diffuse = cfg.primary;
  }

  /* ── Phase: Burst ──────────────────────────────────────────────────── */

  startBurst() {
    this.stopShake();
    const cfg = TIER[this.tier];

    // Flash inner light then fade
    this.innerLight.intensity = 4;
    this.animateValue(this.innerLight, 'intensity', 4, 0, 800, new CubicEase(), EasingFunction.EASINGMODE_EASEOUT);

    // Lid animation
    this.animateLid(cfg.lidStyle);

    // Particles
    this.spawnMainBurst(cfg);
    if (cfg.particleLayers >= 2) this.spawnRisingTrail(cfg);
    if (cfg.particleLayers >= 3) this.spawnFallingSparks(cfg);
    if (cfg.hasSecondaryBurst) {
      this.schedule(() => this.spawnMainBurst(cfg, 0.7), 300);
    }

    // Shockwave
    if (cfg.hasShockwave) this.spawnShockwave(cfg);
    if (cfg.hasGroundGlow) this.spawnGroundGlow(cfg);

    // Camera zoom
    this.animateCamera('radius', this.camera.radius, cfg.cameraZoom, 600, new CubicEase(), EasingFunction.EASINGMODE_EASEOUT);
  }

  /* ── Phase: Reveal ─────────────────────────────────────────────────── */

  startReveal() {
    const cfg = TIER[this.tier];

    // Camera rotation
    if (cfg.cameraRotation > 0) {
      this.animateCamera('alpha', this.camera.alpha, this.camera.alpha + cfg.cameraRotation,
        cfg.cameraRotation >= Math.PI * 2 ? 3000 : 2000,
        new CubicEase(), EasingFunction.EASINGMODE_EASEINOUT);
    }

    // Camera shake (legendary only)
    if (this.tier === 'legendary') {
      this.startCameraShake(1500, 0.015);
    }

    // Falling sparks persist during reveal
    this.spawnRevealSparks(cfg);

    // Legendary: ambient floating particles
    if (this.tier === 'legendary') {
      this.spawnAmbientParticles(cfg);
    }

    // Spawn reward item
    this.spawnRewardItem(cfg);
  }

  /* ── Phase: Reset ──────────────────────────────────────────────────── */

  resetToIdle() {
    this.cleanupEffects();
    this.tier = 'common';

    // Close lid
    if (this.lidMesh) {
      this.animateValue(this.lidMesh, 'rotation.x', this.lidMesh.rotation.x, 0, 300,
        new CubicEase(), EasingFunction.EASINGMODE_EASEIN);
    }

    // Restore chest position
    if (this.rootMesh) {
      this.rootMesh.position.copyFrom(this.basePosition);
      this.rootMesh.rotation.set(0, 0, 0);
    }

    // Camera back
    this.animateCamera('radius', this.camera.radius, CAM_RADIUS, 400, new CubicEase(), EasingFunction.EASINGMODE_EASEOUT);
    this.animateCamera('alpha', this.camera.alpha, CAM_ALPHA, 400, new CubicEase(), EasingFunction.EASINGMODE_EASEOUT);

    this.innerLight.intensity = 0;
    this.startIdleBob();
  }

  /* ── Skip ──────────────────────────────────────────────────────────── */

  skipToEnd() {
    this.cleanupEffects();

    // Snap lid open
    if (this.lidMesh) {
      this.lidMesh.rotation.x = -Math.PI * 0.7;
    }

    // Snap camera
    const cfg = TIER[this.tier];
    this.camera.radius = cfg.cameraZoom;

    this.innerLight.intensity = 0;
  }

  /* ── Cleanup ───────────────────────────────────────────────────────── */

  private cleanupEffects() {
    this.stopShake();
    this.stopIdleBob();
    this.stopCameraShake();
    this.stopSeamLeak();
    this.stopInnerGlow();

    for (const t of this.timers) clearTimeout(t);
    this.timers = [];

    for (const ps of this.particles) {
      ps.stop();
      ps.particleTexture = null; // prevent dispose from destroying shared texture
      ps.dispose();
    }
    this.particles = [];

    for (const m of this.tempMeshes) m.dispose();
    this.tempMeshes = [];

    if (this.rewardMesh) { this.rewardMesh.dispose(); this.rewardMesh = null; }

    for (const a of this.animatables) { try { a.stop(); } catch { /* */ } }
    this.animatables = [];
  }

  dispose() {
    this.cleanupEffects();
    this.particleTex.dispose();
    window.removeEventListener('resize', (this as any)._onResize);
    this.scene.dispose();
    this.engine.dispose();
  }

  /* ── Progressive Shake ─────────────────────────────────────────────── */

  private startProgressiveShake() {
    const root = this.rootMesh;
    if (!root) return;

    const startTime = performance.now();
    const baseX = this.basePosition.x;
    const baseZ = this.basePosition.z;

    const animate = () => {
      const elapsed = performance.now() - startTime;
      const cfg = TIER[this.tier];
      const duration = BUILDUP_MS[this.tier] - cfg.pauseBeforeBurst;
      const t = Math.min(elapsed / duration, 1);

      // Legendary pause: if in pause zone, amplitude drops to 0
      if (cfg.pauseBeforeBurst > 0 && elapsed > duration && elapsed < duration + cfg.pauseBeforeBurst) {
        root.position.x = baseX;
        root.position.z = baseZ;
        root.rotation.z = 0;
        this.shakeRafId = requestAnimationFrame(animate);
        return;
      }

      const amp = cfg.shakeMaxAmplitude * t * t;
      root.position.x = baseX + Math.sin(elapsed * 0.025) * amp * 0.8 + Math.sin(elapsed * 0.063) * amp * 0.2;
      root.position.z = baseZ + Math.cos(elapsed * 0.031) * amp * 0.3;
      root.rotation.z = Math.sin(elapsed * 0.041) * amp * 0.4;

      this.shakeRafId = requestAnimationFrame(animate);
    };
    this.shakeRafId = requestAnimationFrame(animate);
  }

  private stopShake() {
    if (this.shakeRafId !== null) {
      cancelAnimationFrame(this.shakeRafId);
      this.shakeRafId = null;
    }
    // Snap back
    if (this.rootMesh) {
      this.rootMesh.position.x = this.basePosition.x;
      this.rootMesh.position.z = this.basePosition.z;
      this.rootMesh.rotation.z = 0;
    }
  }

  /* ── Inner Glow (buildup) ──────────────────────────────────────────── */

  private startInnerGlow() {
    this.stopInnerGlow();
    const startTime = performance.now();
    const animate = () => {
      const elapsed = performance.now() - startTime;
      const duration = BUILDUP_MS[this.tier];
      const t = Math.min(elapsed / duration, 1);
      this.innerLight.intensity = t * t * 2.5;
      if (t < 1) {
        this.glowRafId = requestAnimationFrame(animate);
      }
    };
    this.glowRafId = requestAnimationFrame(animate);
  }

  private stopInnerGlow() {
    if (this.glowRafId !== null) {
      cancelAnimationFrame(this.glowRafId);
      this.glowRafId = null;
    }
  }

  /* ── Idle Bob ──────────────────────────────────────────────────────── */

  private startIdleBob() {
    this.stopIdleBob();
    const root = this.rootMesh;
    if (!root) return;
    const baseY = root.position.y;
    let t = 0;
    const animate = () => {
      t += 0.02;
      root.position.y = baseY + Math.sin(t) * 0.03;
      this.idleBobRafId = requestAnimationFrame(animate);
    };
    this.idleBobRafId = requestAnimationFrame(animate);
  }

  private stopIdleBob() {
    if (this.idleBobRafId !== null) {
      cancelAnimationFrame(this.idleBobRafId);
      this.idleBobRafId = null;
    }
  }

  /* ── Seam Leak Particles (buildup) ───────────────────────────────── */

  private startSeamLeak() {
    this.stopSeamLeak();
    const ps = new ParticleSystem('seamLeak', 100, this.scene);
    ps.particleTexture = this.particleTex;
    ps.emitter = new Vector3(0, 0.55, 0);
    ps.minEmitBox = new Vector3(-0.25, 0, -0.25);
    ps.maxEmitBox = new Vector3(0.25, 0, 0.25);
    ps.emitRate = 30;
    ps.minLifeTime = 0.5;
    ps.maxLifeTime = 1.2;
    ps.minSize = 0.05;
    ps.maxSize = 0.15;
    ps.minEmitPower = 0.5;
    ps.maxEmitPower = 2.5;
    ps.direction1 = new Vector3(-0.4, 1, -0.4);
    ps.direction2 = new Vector3(0.4, 2, 0.4);
    ps.gravity = new Vector3(0, -0.3, 0);
    ps.blendMode = ParticleSystem.BLENDMODE_ADD;

    ps.addSizeGradient(0, 0.15);
    ps.addSizeGradient(1.0, 0);

    const cfg = TIER[this.tier];
    ps.addColorGradient(0, new Color4(1, 1, 1, 0.9));
    ps.addColorGradient(0.4, new Color4(cfg.primary.r, cfg.primary.g, cfg.primary.b, 0.7));
    ps.addColorGradient(1.0, new Color4(cfg.primary.r, cfg.primary.g, cfg.primary.b, 0));

    ps.start();
    this.seamLeakPs = ps;
  }

  private stopSeamLeak() {
    if (this.seamLeakPs) {
      this.seamLeakPs.stop();
      this.seamLeakPs.particleTexture = null; // prevent dispose from destroying shared texture
      this.seamLeakPs.dispose();
      this.seamLeakPs = null;
    }
  }

  /* ── Camera Shake (legendary reveal) ──────────────────────────────── */

  private startCameraShake(durationMs: number, amplitude: number) {
    this.stopCameraShake();
    const startTime = performance.now();
    const baseBeta = this.camera.beta;
    const baseTarget = this.camera.target.clone();

    const animate = () => {
      const elapsed = performance.now() - startTime;
      if (elapsed > durationMs) {
        this.camera.beta = baseBeta;
        this.camera.target.copyFrom(baseTarget);
        this.camShakeRafId = null;
        return;
      }
      // Decay over time
      const decay = 1 - elapsed / durationMs;
      const amp = amplitude * decay;
      this.camera.beta = baseBeta + Math.sin(elapsed * 0.04) * amp;
      this.camera.target.y = baseTarget.y + Math.cos(elapsed * 0.053) * amp * 3;

      this.camShakeRafId = requestAnimationFrame(animate);
    };
    this.camShakeRafId = requestAnimationFrame(animate);
  }

  private stopCameraShake() {
    if (this.camShakeRafId !== null) {
      cancelAnimationFrame(this.camShakeRafId);
      this.camShakeRafId = null;
    }
  }

  /* ── Reveal Sparks (persistent falling sparks during reveal) ──────── */

  private spawnRevealSparks(cfg: TierConfig) {
    const ps = new ParticleSystem('revealSparks', 80, this.scene);
    ps.particleTexture = this.particleTex;
    ps.emitter = new Vector3(0, 1.0, 0);
    ps.minEmitBox = new Vector3(-0.6, 0, -0.6);
    ps.maxEmitBox = new Vector3(0.6, 0.3, 0.6);
    ps.emitRate = 25;
    ps.minLifeTime = 1.2;
    ps.maxLifeTime = 2.5;
    ps.minSize = 0.05;
    ps.maxSize = 0.12;
    ps.minEmitPower = 0.1;
    ps.maxEmitPower = 0.5;
    ps.direction1 = new Vector3(-0.15, -0.3, -0.15);
    ps.direction2 = new Vector3(0.15, 0, 0.15);
    ps.gravity = new Vector3(0, -0.8, 0);
    ps.blendMode = ParticleSystem.BLENDMODE_ADD;

    ps.addSizeGradient(0, 0.12);
    ps.addSizeGradient(1.0, 0.02);

    const c = cfg.primary;
    ps.addColorGradient(0, new Color4(c.r, c.g, c.b, 0.9));
    ps.addColorGradient(0.5, new Color4(c.r * 0.7, c.g * 0.7, c.b * 0.7, 0.5));
    ps.addColorGradient(1.0, new Color4(c.r * 0.3, c.g * 0.3, c.b * 0.3, 0));

    ps.start();
    this.particles.push(ps);
  }

  /* ── Ambient Particles (legendary post-burst) ─────────────────────── */

  private spawnAmbientParticles(cfg: TierConfig) {
    const ps = new ParticleSystem('ambient', 100, this.scene);
    ps.particleTexture = this.particleTex;
    ps.emitter = new Vector3(0, 0.7, 0);
    ps.minEmitBox = new Vector3(-0.8, -0.3, -0.8);
    ps.maxEmitBox = new Vector3(0.8, 1.0, 0.8);
    ps.emitRate = 25;
    ps.minLifeTime = 2.0;
    ps.maxLifeTime = 3.5;
    ps.minSize = 0.05;
    ps.maxSize = 0.15;
    ps.minEmitPower = 0.1;
    ps.maxEmitPower = 0.3;
    ps.direction1 = new Vector3(-0.1, 0.1, -0.1);
    ps.direction2 = new Vector3(0.1, 0.4, 0.1);
    ps.gravity = new Vector3(0, 0.05, 0);
    ps.blendMode = ParticleSystem.BLENDMODE_ADD;

    const c1 = cfg.primary;
    const c2 = cfg.secondary;
    ps.addColorGradient(0, new Color4(c1.r, c1.g, c1.b, 0.1));
    ps.addColorGradient(0.15, new Color4(c1.r, c1.g, c1.b, 0.7));
    ps.addColorGradient(0.8, new Color4(c2.r, c2.g, c2.b, 0.5));
    ps.addColorGradient(1.0, new Color4(c2.r, c2.g, c2.b, 0));

    ps.addSizeGradient(0, 0.05);
    ps.addSizeGradient(0.3, 0.15);
    ps.addSizeGradient(1.0, 0.03);

    ps.start();
    this.particles.push(ps);
  }

  /* ── Lid Animation ─────────────────────────────────────────────────── */

  private animateLid(style: TierConfig['lidStyle']) {
    const lid = this.lidMesh;
    if (!lid) return;

    const scene = this.scene;
    const fps = 60;

    // All tiers: pure lid open with increasing drama (angle, speed, bounce)
    const a = new Animation('lidOpen', 'rotation.x', fps, Animation.ANIMATIONTYPE_FLOAT, Animation.ANIMATIONLOOPMODE_CONSTANT);

    switch (style) {
      case 'normal': {
        // Common: smooth gentle open
        const ease = new CubicEase();
        ease.setEasingMode(EasingFunction.EASINGMODE_EASEOUT);
        a.setEasingFunction(ease);
        a.setKeys([
          { frame: 0, value: lid.rotation.x },
          { frame: 36, value: -Math.PI * 0.55 },
        ]);
        this.animatables.push(scene.beginDirectAnimation(lid, [a], 0, 36, false));
        break;
      }
      case 'backease': {
        // Rare: slight overshoot bounce
        const ease = new BackEase(0.4);
        ease.setEasingMode(EasingFunction.EASINGMODE_EASEOUT);
        a.setEasingFunction(ease);
        a.setKeys([
          { frame: 0, value: lid.rotation.x },
          { frame: 28, value: -Math.PI * 0.65 },
        ]);
        this.animatables.push(scene.beginDirectAnimation(lid, [a], 0, 28, false));
        break;
      }
      case 'fly': {
        // Epic: strong overshoot, opens wider and faster
        const ease = new BackEase(0.8);
        ease.setEasingMode(EasingFunction.EASINGMODE_EASEOUT);
        a.setEasingFunction(ease);
        a.setKeys([
          { frame: 0, value: lid.rotation.x },
          { frame: 20, value: -Math.PI * 0.75 },
        ]);
        this.animatables.push(scene.beginDirectAnimation(lid, [a], 0, 20, false));
        break;
      }
      case 'explode': {
        // Legendary: violent snap open, maximum overshoot
        const ease = new BackEase(1.2);
        ease.setEasingMode(EasingFunction.EASINGMODE_EASEOUT);
        a.setEasingFunction(ease);
        a.setKeys([
          { frame: 0, value: lid.rotation.x },
          { frame: 14, value: -Math.PI * 0.85 },
        ]);
        this.animatables.push(scene.beginDirectAnimation(lid, [a], 0, 14, false));
        break;
      }
    }
  }

  /* ── Particles ─────────────────────────────────────────────────────── */

  private createParticleTexture(): DynamicTexture {
    const size = 64;
    const dt = new DynamicTexture('particleTex', size, this.scene, false);
    const ctx = dt.getContext();
    const half = size / 2;
    const grad = ctx.createRadialGradient(half, half, 0, half, half, half);
    grad.addColorStop(0, 'rgba(255,255,255,1)');
    grad.addColorStop(0.4, 'rgba(255,255,255,0.6)');
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(half, half, half, 0, Math.PI * 2);
    ctx.fill();
    dt.update();
    dt.hasAlpha = true;
    return dt;
  }

  private spawnMainBurst(cfg: TierConfig, scale = 1) {
    const ps = new ParticleSystem('mainBurst', Math.round(200 * scale), this.scene);
    ps.particleTexture = this.particleTex;
    ps.emitter = new Vector3(0, 0.5, 0);
    ps.emitRate = 0;
    ps.minLifeTime = 0.6;
    ps.maxLifeTime = 1.2;
    ps.minSize = 0.05 * scale;
    ps.maxSize = 0.15 * scale;
    ps.minEmitPower = 3 * scale;
    ps.maxEmitPower = 6 * scale;
    ps.direction1 = new Vector3(-1, 1, -1);
    ps.direction2 = new Vector3(1, 3, 1);
    ps.gravity = new Vector3(0, -2, 0);
    ps.blendMode = ParticleSystem.BLENDMODE_ADD;

    // Shrink over lifetime
    ps.addSizeGradient(0, 0.15 * scale);
    ps.addSizeGradient(0.5, 0.08 * scale);
    ps.addSizeGradient(1.0, 0);

    // Fade out alpha
    ps.addColorGradient(0, new Color4(cfg.primary.r, cfg.primary.g, cfg.primary.b, 1));
    ps.addColorGradient(0.6, new Color4(cfg.secondary.r, cfg.secondary.g, cfg.secondary.b, 0.8));
    ps.addColorGradient(1.0, new Color4(cfg.primary.r * 0.3, cfg.primary.g * 0.3, cfg.primary.b * 0.3, 0));

    ps.manualEmitCount = Math.round(120 * scale);
    ps.targetStopDuration = 2;
    ps.start();
    this.particles.push(ps);
  }

  private spawnRisingTrail(cfg: TierConfig) {
    const ps = new ParticleSystem('risingTrail', 100, this.scene);
    ps.particleTexture = this.particleTex;
    ps.emitter = new Vector3(0, 0.5, 0);
    ps.emitRate = 0;
    ps.minLifeTime = 0.4;
    ps.maxLifeTime = 0.9;
    ps.minSize = 0.02;
    ps.maxSize = 0.06;
    ps.minEmitPower = 4;
    ps.maxEmitPower = 8;
    ps.direction1 = new Vector3(-0.3, 1, -0.3);
    ps.direction2 = new Vector3(0.3, 1, 0.3);
    ps.gravity = new Vector3(0, 0.5, 0);
    ps.blendMode = ParticleSystem.BLENDMODE_ADD;

    ps.addSizeGradient(0, 0.06);
    ps.addSizeGradient(1, 0);

    ps.addColorGradient(0, new Color4(1, 1, 1, 1));
    ps.addColorGradient(0.5, new Color4(cfg.primary.r, cfg.primary.g, cfg.primary.b, 0.8));
    ps.addColorGradient(1.0, new Color4(1, 1, 1, 0));

    ps.manualEmitCount = 80;
    ps.targetStopDuration = 1.5;
    ps.start();
    this.particles.push(ps);
  }

  private spawnFallingSparks(cfg: TierConfig) {
    const ps = new ParticleSystem('fallingSparks', 80, this.scene);
    ps.particleTexture = this.particleTex;
    ps.emitter = new Vector3(0, 0.8, 0);
    ps.emitRate = 0;
    ps.minLifeTime = 0.8;
    ps.maxLifeTime = 1.8;
    ps.minSize = 0.01;
    ps.maxSize = 0.03;
    ps.minEmitPower = 2;
    ps.maxEmitPower = 5;
    ps.direction1 = new Vector3(-1.5, 2, -1.5);
    ps.direction2 = new Vector3(1.5, 4, 1.5);
    ps.gravity = new Vector3(0, -5, 0);
    ps.blendMode = ParticleSystem.BLENDMODE_ADD;

    const c = cfg.secondary;
    ps.color1 = new Color4(c.r, c.g, c.b, 1);
    ps.color2 = new Color4(1, 1, 1, 1);
    ps.colorDead = new Color4(c.r * 0.2, c.g * 0.2, c.b * 0.2, 0);

    ps.manualEmitCount = 60;
    ps.targetStopDuration = 2;
    ps.start();
    this.particles.push(ps);
  }

  /* ── Shockwave ─────────────────────────────────────────────────────── */

  private spawnShockwave(cfg: TierConfig) {
    const torus = MeshBuilder.CreateTorus('shockwave', {
      diameter: 0.3,
      thickness: 0.03,
      tessellation: 32,
    }, this.scene);
    torus.position.y = 0.5;

    const mat = new StandardMaterial('swMat', this.scene);
    mat.emissiveColor = cfg.primary;
    mat.disableLighting = true;
    mat.alpha = 0.8;
    torus.material = mat;
    this.tempMeshes.push(torus);

    const fps = 60;
    const frames = 30;

    // Scale up
    for (const axis of ['x', 'y', 'z'] as const) {
      const a = new Animation(`swScale${axis}`, `scaling.${axis}`, fps, Animation.ANIMATIONTYPE_FLOAT, Animation.ANIMATIONLOOPMODE_CONSTANT);
      a.setKeys([
        { frame: 0, value: 1 },
        { frame: frames, value: this.tier === 'legendary' ? 15 : 10 },
      ]);
      this.animatables.push(this.scene.beginDirectAnimation(torus, [a], 0, frames, false));
    }

    // Fade out
    const aAlpha = new Animation('swAlpha', 'material.alpha', fps, Animation.ANIMATIONTYPE_FLOAT, Animation.ANIMATIONLOOPMODE_CONSTANT);
    aAlpha.setKeys([
      { frame: 0, value: 0.8 },
      { frame: frames, value: 0 },
    ]);
    const animatable = this.scene.beginDirectAnimation(torus, [aAlpha], 0, frames, false);
    animatable.onAnimationEnd = () => {
      torus.dispose();
      const idx = this.tempMeshes.indexOf(torus);
      if (idx >= 0) this.tempMeshes.splice(idx, 1);
    };
    this.animatables.push(animatable);
  }

  /* ── Ground Glow (legendary) ───────────────────────────────────────── */

  private spawnGroundGlow(cfg: TierConfig) {
    const disc = MeshBuilder.CreateDisc('groundGlow', { radius: 2, tessellation: 32 }, this.scene);
    disc.rotation.x = Math.PI / 2;
    disc.position.y = 0.02;

    const mat = new StandardMaterial('discMat', this.scene);
    mat.emissiveColor = cfg.primary;
    mat.disableLighting = true;
    mat.alpha = 0;
    disc.material = mat;
    this.tempMeshes.push(disc);

    // Fade in then pulse
    const fps = 60;
    const a = new Animation('discAlpha', 'material.alpha', fps, Animation.ANIMATIONTYPE_FLOAT, Animation.ANIMATIONLOOPMODE_CYCLE);
    a.setKeys([
      { frame: 0, value: 0 },
      { frame: 15, value: 0.4 },
      { frame: 45, value: 0.2 },
      { frame: 60, value: 0.4 },
    ]);
    this.animatables.push(this.scene.beginDirectAnimation(disc, [a], 0, 60, true));
  }

  /* ── Reward Item ───────────────────────────────────────────────────── */

  private spawnRewardItem(cfg: TierConfig) {
    if (this.rewardMesh) { this.rewardMesh.dispose(); this.rewardMesh = null; }

    const sphere = MeshBuilder.CreateSphere('reward', { diameter: 0.25, segments: 16 }, this.scene);
    sphere.position.set(0, 0.5, 0);

    const mat = new StandardMaterial('rewardMat', this.scene);
    mat.emissiveColor = cfg.primary;
    mat.diffuseColor = cfg.primary.scale(0.5);
    mat.specularColor = Color3.White();
    sphere.material = mat;
    this.rewardMesh = sphere;

    // Float up
    const fps = 60;
    const aY = new Animation('rewardY', 'position.y', fps, Animation.ANIMATIONTYPE_FLOAT, Animation.ANIMATIONLOOPMODE_CONSTANT);
    const ease = new CubicEase();
    ease.setEasingMode(EasingFunction.EASINGMODE_EASEOUT);
    aY.setEasingFunction(ease);
    aY.setKeys([
      { frame: 0, value: 0.5 },
      { frame: 40, value: 1.4 },
    ]);
    this.animatables.push(this.scene.beginDirectAnimation(sphere, [aY], 0, 40, false));

    // Continuous rotation
    const aRot = new Animation('rewardRot', 'rotation.y', fps, Animation.ANIMATIONTYPE_FLOAT, Animation.ANIMATIONLOOPMODE_CYCLE);
    aRot.setKeys([
      { frame: 0, value: 0 },
      { frame: 120, value: Math.PI * 2 },
    ]);
    this.animatables.push(this.scene.beginDirectAnimation(sphere, [aRot], 0, 120, true));
  }

  /* ── Animation Helpers ─────────────────────────────────────────────── */

  private animateValue(
    target: any, property: string,
    from: number, to: number, durationMs: number,
    easeFn: CubicEase | BackEase, easeMode: number,
  ) {
    const fps = 60;
    const frames = Math.round((durationMs / 1000) * fps);
    const a = new Animation('anim_' + property, property, fps, Animation.ANIMATIONTYPE_FLOAT, Animation.ANIMATIONLOOPMODE_CONSTANT);
    easeFn.setEasingMode(easeMode);
    a.setEasingFunction(easeFn);
    a.setKeys([
      { frame: 0, value: from },
      { frame: frames, value: to },
    ]);
    this.animatables.push(this.scene.beginDirectAnimation(target, [a], 0, frames, false));
  }

  private animateCamera(
    property: string, from: number, to: number, durationMs: number,
    easeFn: CubicEase | BackEase, easeMode: number,
  ) {
    this.animateValue(this.camera, property, from, to, durationMs, easeFn, easeMode);
  }

  private schedule(fn: () => void, ms: number) {
    const id = window.setTimeout(fn, ms);
    this.timers.push(id);
    return id;
  }
}

/* ── React Component ────────────────────────────────────────────────── */

export interface ChestViewer3DHandle {
  setRarityTier: (tier: RarityTier) => void;
  skipToEnd: () => void;
}

interface ChestViewer3DProps {
  chestState: ChestState;
  rarityTier: RarityTier;
  modelPath?: string;
}

export const ChestViewer3D = forwardRef<ChestViewer3DHandle, ChestViewer3DProps>(
  ({ chestState, rarityTier, modelPath = '/models/chest.glb' }, ref) => {
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const engineRef = useRef<ChestAnimationEngine | null>(null);
    const prevStateRef = useRef<ChestState>('idle');

    // Init engine
    useEffect(() => {
      if (!canvasRef.current) return;
      const eng = new ChestAnimationEngine(canvasRef.current);
      engineRef.current = eng;
      eng.loadModel(modelPath).catch(err => console.warn('[ChestViewer3D] Load failed:', err));
      return () => { eng.dispose(); engineRef.current = null; };
    }, [modelPath]);

    // React to state changes
    useEffect(() => {
      const eng = engineRef.current;
      if (!eng) return;

      const prev = prevStateRef.current;
      prevStateRef.current = chestState;
      if (prev === chestState) return;

      switch (chestState) {
        case 'idle':
          eng.resetToIdle();
          break;
        case 'buildup':
          eng.setRarityTier(rarityTier);
          eng.startBuildup();
          break;
        case 'burst':
          eng.startBurst();
          break;
        case 'reveal':
          eng.startReveal();
          break;
      }
    }, [chestState, rarityTier]);

    // React to rarity tier upgrade mid-buildup
    useEffect(() => {
      if (chestState === 'buildup') {
        engineRef.current?.setRarityTier(rarityTier);
      }
    }, [rarityTier, chestState]);

    useImperativeHandle(ref, () => ({
      setRarityTier: (tier: RarityTier) => engineRef.current?.setRarityTier(tier),
      skipToEnd: () => engineRef.current?.skipToEnd(),
    }));

    return (
      <canvas
        ref={canvasRef}
        style={{ width: '100%', height: '100%', display: 'block', outline: 'none', touchAction: 'none' }}
      />
    );
  },
);

ChestViewer3D.displayName = 'ChestViewer3D';
