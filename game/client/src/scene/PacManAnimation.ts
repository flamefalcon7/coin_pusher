import {
  Scene,
  Mesh,
  MeshBuilder,
  Vector3,
  Color3,
  TransformNode,
  Observer,
} from "@babylonjs/core";
import { SCENE_CONFIG } from "@coin-pusher/shared";
import { createToonMat } from "./ToonMaterial";

/**
 * 3D Pac-Man walking along wall tops from front-left to front-right and back.
 *
 * Path: front-left → left-flare → back-left → back-right → right-flare → front-right
 * Then reverses. Dots spawn when heading forward (left→right), eaten along the way.
 * When it returns to the start, dots respawn.
 */

const PAC_RADIUS = 0.06;
const PAC_COLOR = new Color3(1.0, 0.85, 0.0);    // classic yellow
const EYE_COLOR = new Color3(0.05, 0.05, 0.08);   // near-black
const DOT_COLOR = new Color3(1.0, 0.95, 0.75);    // pale yellow dots
const SPEED = 0.35;            // meters per second
const MOUTH_SPEED = 6.0;       // open/close cycles per second
const MAX_MOUTH_ANGLE = 0.35;  // radians (~20°)
const WALL_TOP_OFFSET = 0.04;  // hover above wall top
const DOT_RADIUS = 0.015;      // small pellet size
const DOT_SPACING = 0.08;      // distance between dots
const EAT_DISTANCE = 0.04;     // how close pac-man must be to eat a dot

export class PacManAnimation {
  private scene: Scene;
  private group: TransformNode;
  private upperJaw: Mesh;
  private lowerJaw: Mesh;

  // Multi-segment path waypoints
  private waypoints: Vector3[];
  // Cumulative distances at each waypoint (for uniform speed)
  private cumulativeDist: number[];
  private totalLength: number;

  // State
  private progress: number = 0;    // 0 = start, 1 = end
  private direction: number = 1;   // 1 = forward (eating), -1 = returning

  // Dots
  private dots: Mesh[] = [];
  private dotDistances: number[] = [];  // distance along path for each dot
  private dotMat: ReturnType<typeof createToonMat>;

  private observer: Observer<Scene> | null = null;

  constructor(scene: Scene) {
    this.scene = scene;
    this.group = new TransformNode("pacMan", scene);

    // ── Materials ──────────────────────────────────────────────────────
    const bodyMat = createToonMat("pacManMat", PAC_COLOR, scene);
    const eyeMat = createToonMat("pacManEyeMat", EYE_COLOR, scene);
    this.dotMat = createToonMat("pacDotMat", DOT_COLOR, scene);

    // ── Upper jaw (top hemisphere) ────────────────────────────────────
    this.upperJaw = MeshBuilder.CreateSphere("pacUpper", {
      diameter: PAC_RADIUS * 2,
      segments: 12,
      slice: 0.5,
    }, scene);
    this.upperJaw.material = bodyMat;
    this.upperJaw.parent = this.group;

    // ── Lower jaw (bottom hemisphere, flipped) ────────────────────────
    this.lowerJaw = MeshBuilder.CreateSphere("pacLower", {
      diameter: PAC_RADIUS * 2,
      segments: 12,
      slice: 0.5,
    }, scene);
    this.lowerJaw.rotation.z = Math.PI;
    this.lowerJaw.material = bodyMat;
    this.lowerJaw.parent = this.group;

    // ── Eye (on top of head) ──────────────────────────────────────────
    const eye = MeshBuilder.CreateSphere("pacEye", {
      diameter: PAC_RADIUS * 0.35,
      segments: 6,
    }, scene);
    eye.position = new Vector3(0, PAC_RADIUS * 0.5, PAC_RADIUS * 0.55);
    eye.material = eyeMat;
    eye.parent = this.group;

    // ── Build path waypoints ──────────────────────────────────────────
    this.waypoints = this.buildWaypoints();

    // Pre-compute cumulative distances for uniform speed
    this.cumulativeDist = [0];
    for (let i = 1; i < this.waypoints.length; i++) {
      const d = Vector3.Distance(this.waypoints[i - 1], this.waypoints[i]);
      this.cumulativeDist.push(this.cumulativeDist[i - 1] + d);
    }
    this.totalLength = this.cumulativeDist[this.cumulativeDist.length - 1];

    // Start at first waypoint
    this.group.position = this.waypoints[0].clone();
    this.faceDirection(0);

    // ── Spawn initial dots ────────────────────────────────────────────
    this.spawnDots();

    // ── Animation loop ────────────────────────────────────────────────
    this.observer = scene.onBeforeRenderObservable.add(() => {
      const dt = scene.getEngine().getDeltaTime() / 1000;
      this.update(dt);
    });

    console.log(`  ✓ Pac-Man animation created (${this.waypoints.length} waypoints, total ${this.totalLength.toFixed(2)}m)`);
  }

  /**
   * Path along wall tops: front-left → left-flare → back-left →
   * back-right → right-flare → front-right.
   */
  private buildWaypoints(): Vector3[] {
    const { WIDTH, DEPTH, FLARE_Z, FLARE_ANGLE, POSITION } = SCENE_CONFIG.PLATFORM;
    const { HEIGHT } = SCENE_CONFIG.SIDE_WALLS;

    const hw = WIDTH / 2;
    const frontZ = POSITION.z + DEPTH / 2;
    const backZ = POSITION.z - DEPTH / 2;
    const flareDepth = frontZ - FLARE_Z;
    const flareOffset = Math.tan(FLARE_ANGLE * Math.PI / 180) * flareDepth;
    const fhw = hw + flareOffset;

    const wallTopY = SCENE_CONFIG.SIDE_WALLS.LEFT_POSITION.y + HEIGHT / 2 + WALL_TOP_OFFSET;

    return [
      new Vector3(-fhw, wallTopY, frontZ),    // front-left corner
      new Vector3(-hw, wallTopY, FLARE_Z),     // left flare start
      new Vector3(-hw, wallTopY, backZ),        // back-left corner
      new Vector3(hw, wallTopY, backZ),          // back-right corner
      new Vector3(hw, wallTopY, FLARE_Z),       // right flare start
      new Vector3(fhw, wallTopY, frontZ),       // front-right corner
    ];
  }

  /** Get position at a given distance along the path. */
  private posAtDist(dist: number): Vector3 {
    if (dist <= 0) return this.waypoints[0].clone();
    if (dist >= this.totalLength) return this.waypoints[this.waypoints.length - 1].clone();

    // Find which segment we're on
    for (let i = 1; i < this.cumulativeDist.length; i++) {
      if (dist <= this.cumulativeDist[i]) {
        const segStart = this.cumulativeDist[i - 1];
        const segLen = this.cumulativeDist[i] - segStart;
        const t = (dist - segStart) / segLen;
        return Vector3.Lerp(this.waypoints[i - 1], this.waypoints[i], t);
      }
    }
    return this.waypoints[this.waypoints.length - 1].clone();
  }

  /** Get the direction vector at a given distance along the path. */
  private dirAtDist(dist: number): Vector3 {
    // Find which segment
    for (let i = 1; i < this.cumulativeDist.length; i++) {
      if (dist <= this.cumulativeDist[i]) {
        return this.waypoints[i].subtract(this.waypoints[i - 1]).normalize();
      }
    }
    const n = this.waypoints.length;
    return this.waypoints[n - 1].subtract(this.waypoints[n - 2]).normalize();
  }

  /** Face Pac-Man along the current travel direction. */
  private faceDirection(dist: number): void {
    const dir = this.dirAtDist(dist);
    const sign = this.direction; // flip when going backwards
    this.group.rotation.y = Math.atan2(dir.x * sign, dir.z * sign);
  }

  /** Create dots along the entire path. */
  private spawnDots(): void {
    for (const dot of this.dots) {
      if (!dot.isDisposed()) dot.dispose();
    }
    this.dots = [];
    this.dotDistances = [];

    const count = Math.floor(this.totalLength / DOT_SPACING);
    const startOffset = (this.totalLength - (count - 1) * DOT_SPACING) / 2;

    for (let i = 0; i < count; i++) {
      const d = startOffset + i * DOT_SPACING;
      const pos = this.posAtDist(d);

      const dot = MeshBuilder.CreateSphere(`pacDot${i}`, {
        diameter: DOT_RADIUS * 2,
        segments: 6,
      }, this.scene);
      dot.position = pos;
      dot.material = this.dotMat;
      dot.isPickable = false;

      this.dots.push(dot);
      this.dotDistances.push(d);
    }
  }

  private update(dt: number): void {
    // ── Move ──────────────────────────────────────────────────────────
    const step = (SPEED * dt) / this.totalLength;
    this.progress += step * this.direction;

    // ── Clamp and reverse at ends ────────────────────────────────────
    if (this.progress >= 1.0) {
      this.progress = 1.0;
      this.direction = -1;
    } else if (this.progress <= 0.0) {
      this.progress = 0.0;
      this.direction = 1;
      // Respawn dots when arriving back at start
      this.spawnDots();
    }

    // ── Position ─────────────────────────────────────────────────────
    const currentDist = this.progress * this.totalLength;
    const pos = this.posAtDist(currentDist);
    this.group.position.copyFrom(pos);

    // ── Face direction of travel ─────────────────────────────────────
    this.faceDirection(currentDist);

    // ── Eat dots (only when going forward) ───────────────────────────
    if (this.direction === 1) {
      for (let i = this.dots.length - 1; i >= 0; i--) {
        const dot = this.dots[i];
        if (!dot.isDisposed() && this.dotDistances[i] <= currentDist + EAT_DISTANCE) {
          dot.setEnabled(false);
          dot.dispose();
          this.dots.splice(i, 1);
          this.dotDistances.splice(i, 1);
        }
      }
    }

    // ── Mouth animation ──────────────────────────────────────────────
    const time = performance.now() / 1000;
    const mouthAngle = Math.abs(Math.sin(time * MOUTH_SPEED * Math.PI)) * MAX_MOUTH_ANGLE;
    this.upperJaw.rotation.x = -mouthAngle;
    this.lowerJaw.rotation.x = mouthAngle;
  }

  dispose(): void {
    if (this.observer) {
      this.scene.onBeforeRenderObservable.remove(this.observer);
    }
    for (const dot of this.dots) {
      if (!dot.isDisposed()) dot.dispose();
    }
    this.group.dispose(false, true);
  }
}
