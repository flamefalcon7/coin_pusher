import {
  Scene,
  MeshBuilder,
  Mesh,
  StandardMaterial,
  Color3,
  Vector3,
  Observer,
} from "@babylonjs/core";

export type TargetingType = "tornado" | "explosion";

interface AbilityConfig {
  radius: number;
  color: Color3;
  fillAlpha: number;
  ringAlpha: number;
}

const ABILITY_CONFIGS: Record<TargetingType, AbilityConfig> = {
  tornado: {
    radius: 0.4,
    color: new Color3(0.2, 0.7, 0.9),
    fillAlpha: 0.12,
    ringAlpha: 0.7,
  },
  explosion: {
    radius: 0.6,
    color: new Color3(1.0, 0.4, 0.1),
    fillAlpha: 0.12,
    ringAlpha: 0.7,
  },
};

// Platform bounds for clamping
const PLATFORM_X_MIN = -0.5;
const PLATFORM_X_MAX = 0.5;
const PLATFORM_Z_MIN = -0.5;
const PLATFORM_Z_MAX = 0.7;
const RETICLE_Y = 0.28; // Slightly above platform surface

export class TargetingReticle {
  private scene: Scene;
  private disc: Mesh;
  private ring: Mesh;
  private centerDot: Mesh;
  private discMat: StandardMaterial;
  private ringMat: StandardMaterial;
  private dotMat: StandardMaterial;
  private renderObserver: Observer<Scene> | null = null;
  private currentType: TargetingType = "tornado";
  private _isVisible: boolean = false;

  // Confirm animation state
  private confirming: boolean = false;
  private confirmStartTime: number = 0;
  private static readonly CONFIRM_DURATION = 200; // ms

  constructor(scene: Scene) {
    this.scene = scene;

    // ── Area disc (semi-transparent fill) ──────────────────────────────
    this.disc = MeshBuilder.CreateDisc("targetingDisc", {
      radius: 0.4,
      tessellation: 48,
    }, scene);
    this.disc.rotation.x = Math.PI / 2; // Lay flat on ground
    this.disc.isPickable = false;
    this.disc.renderingGroupId = 1;
    this.disc.isVisible = false;

    this.discMat = new StandardMaterial("targetingDiscMat", scene);
    this.discMat.disableLighting = true;
    this.discMat.emissiveColor = ABILITY_CONFIGS.tornado.color;
    this.discMat.alpha = ABILITY_CONFIGS.tornado.fillAlpha;
    this.discMat.backFaceCulling = false;
    this.disc.material = this.discMat;

    // ── Outer ring (torus) ─────────────────────────────────────────────
    this.ring = MeshBuilder.CreateTorus("targetingRing", {
      diameter: 0.4 * 2,
      thickness: 0.03,
      tessellation: 48,
    }, scene);
    this.ring.isPickable = false;
    this.ring.renderingGroupId = 1;
    this.ring.isVisible = false;

    this.ringMat = new StandardMaterial("targetingRingMat", scene);
    this.ringMat.disableLighting = true;
    this.ringMat.emissiveColor = ABILITY_CONFIGS.tornado.color;
    this.ringMat.alpha = ABILITY_CONFIGS.tornado.ringAlpha;
    this.ring.material = this.ringMat;

    // ── Center dot ─────────────────────────────────────────────────────
    this.centerDot = MeshBuilder.CreateDisc("targetingDot", {
      radius: 0.025,
      tessellation: 16,
    }, scene);
    this.centerDot.rotation.x = Math.PI / 2;
    this.centerDot.isPickable = false;
    this.centerDot.renderingGroupId = 1;
    this.centerDot.isVisible = false;

    this.dotMat = new StandardMaterial("targetingDotMat", scene);
    this.dotMat.disableLighting = true;
    this.dotMat.emissiveColor = new Color3(1, 1, 1);
    this.dotMat.alpha = 0.9;
    this.centerDot.material = this.dotMat;

    // ── Per-frame animation ────────────────────────────────────────────
    this.renderObserver = scene.onBeforeRenderObservable.add(() => {
      if (!this._isVisible) return;

      const t = performance.now() / 1000;

      // Confirm animation: shrink + fade
      if (this.confirming) {
        const elapsed = performance.now() - this.confirmStartTime;
        const progress = Math.min(elapsed / TargetingReticle.CONFIRM_DURATION, 1);
        const scale = 1 - progress;
        const alpha = 1 - progress;

        this.disc.scaling.setAll(scale);
        this.ring.scaling.setAll(scale);
        this.centerDot.scaling.setAll(scale);
        this.discMat.alpha = ABILITY_CONFIGS[this.currentType].fillAlpha * alpha;
        this.ringMat.alpha = ABILITY_CONFIGS[this.currentType].ringAlpha * alpha;
        this.dotMat.alpha = 0.9 * alpha;

        if (progress >= 1) {
          this.confirming = false;
          this.hideInternal();
        }
        return;
      }

      // Gentle alpha oscillation on fill disc
      const alphaOsc = 0.8 + 0.2 * Math.sin(t * 3);
      this.discMat.alpha = ABILITY_CONFIGS[this.currentType].fillAlpha * alphaOsc;

      if (this.currentType === "tornado") {
        // Tornado: rotate Y slowly
        this.disc.rotation.y += 0.015;
        this.ring.rotation.y += 0.015;
      } else {
        // Explosion: ring pulses scale (0.95 ↔ 1.05)
        const pulse = 1 + 0.05 * Math.sin(t * 4);
        this.ring.scaling.setAll(pulse);
      }
    });
  }

  show(type: TargetingType): void {
    this.currentType = type;
    const config = ABILITY_CONFIGS[type];

    // Configure colors
    this.discMat.emissiveColor = config.color;
    this.discMat.alpha = config.fillAlpha;
    this.ringMat.emissiveColor = config.color;
    this.ringMat.alpha = config.ringAlpha;

    // Resize disc
    const radiusScale = config.radius / 0.4; // 0.4 is base disc radius
    this.disc.scaling.set(radiusScale, radiusScale, radiusScale);

    // Resize ring — recreate with correct diameter
    // Scale ring: base was built at diameter 0.8 (radius 0.4)
    const ringScale = config.radius / 0.4;
    this.ring.scaling.setAll(ringScale);

    // Reset center dot scale
    this.centerDot.scaling.setAll(1);

    // Reset rotations
    this.disc.rotation.y = 0;
    this.ring.rotation.y = 0;

    // Make visible
    this.disc.isVisible = true;
    this.ring.isVisible = true;
    this.centerDot.isVisible = true;
    this._isVisible = true;
    this.confirming = false;
  }

  hide(): void {
    this.confirming = false;
    this.hideInternal();
  }

  private hideInternal(): void {
    this.disc.isVisible = false;
    this.ring.isVisible = false;
    this.centerDot.isVisible = false;
    this._isVisible = false;

    // Reset scaling
    this.disc.scaling.setAll(1);
    this.ring.scaling.setAll(1);
    this.centerDot.scaling.setAll(1);
  }

  update(worldPos: Vector3): void {
    // Clamp to platform bounds
    const x = Math.max(PLATFORM_X_MIN, Math.min(PLATFORM_X_MAX, worldPos.x));
    const z = Math.max(PLATFORM_Z_MIN, Math.min(PLATFORM_Z_MAX, worldPos.z));

    this.disc.position.set(x, RETICLE_Y, z);
    this.ring.position.set(x, RETICLE_Y, z);
    this.centerDot.position.set(x, RETICLE_Y + 0.001, z);
  }

  playConfirm(): void {
    if (!this._isVisible) return;
    this.confirming = true;
    this.confirmStartTime = performance.now();
  }

  isVisible(): boolean {
    return this._isVisible;
  }

  dispose(): void {
    if (this.renderObserver) {
      this.scene.onBeforeRenderObservable.remove(this.renderObserver);
      this.renderObserver = null;
    }
    this.disc.dispose();
    this.ring.dispose();
    this.centerDot.dispose();
    this.discMat.dispose();
    this.ringMat.dispose();
    this.dotMat.dispose();
  }
}
