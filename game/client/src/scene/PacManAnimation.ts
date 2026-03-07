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
const DOT_SPAWN_DURATION = 0.25; // seconds for each dot to scale up
const DOT_SPAWN_STAGGER = 0.03;  // seconds delay between each dot's animation start

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
  private dotSpawnTimers: number[] = []; // elapsed time since each dot started spawning (-ve = waiting)
  private dotMat: ReturnType<typeof createToonMat>;

  private activeDotCount: number = 0;
  private observer: Observer<Scene> | null = null;

  // Reusable scratch vectors to avoid per-frame allocation
  private static _scratchPos = new Vector3();
  private static _scratchDir = new Vector3();

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

  /** Get position at a given distance along the path (writes to out). */
  private posAtDistRef(dist: number, out: Vector3): void {
    if (dist <= 0) { out.copyFrom(this.waypoints[0]); return; }
    if (dist >= this.totalLength) { out.copyFrom(this.waypoints[this.waypoints.length - 1]); return; }

    for (let i = 1; i < this.cumulativeDist.length; i++) {
      if (dist <= this.cumulativeDist[i]) {
        const segStart = this.cumulativeDist[i - 1];
        const segLen = this.cumulativeDist[i] - segStart;
        const t = (dist - segStart) / segLen;
        Vector3.LerpToRef(this.waypoints[i - 1], this.waypoints[i], t, out);
        return;
      }
    }
    out.copyFrom(this.waypoints[this.waypoints.length - 1]);
  }

  /** Get the direction vector at a given distance along the path (writes to out). */
  private dirAtDistRef(dist: number, out: Vector3): void {
    for (let i = 1; i < this.cumulativeDist.length; i++) {
      if (dist <= this.cumulativeDist[i]) {
        this.waypoints[i].subtractToRef(this.waypoints[i - 1], out);
        out.normalize();
        return;
      }
    }
    const n = this.waypoints.length;
    this.waypoints[n - 1].subtractToRef(this.waypoints[n - 2], out);
    out.normalize();
  }

  /** Face Pac-Man along the current travel direction. */
  private faceDirection(dist: number): void {
    this.dirAtDistRef(dist, PacManAnimation._scratchDir);
    const sign = this.direction;
    this.group.rotation.y = Math.atan2(PacManAnimation._scratchDir.x * sign, PacManAnimation._scratchDir.z * sign);
  }

  /** Create or reset dots along the entire path with staggered scale-in animation. */
  private spawnDots(): void {
    const count = Math.floor(this.totalLength / DOT_SPACING);
    const startOffset = (this.totalLength - (count - 1) * DOT_SPACING) / 2;

    // Grow pool if needed, reuse existing meshes
    while (this.dots.length < count) {
      const dot = MeshBuilder.CreateSphere(`pacDot${this.dots.length}`, {
        diameter: DOT_RADIUS * 2,
        segments: 6,
      }, this.scene);
      dot.material = this.dotMat;
      dot.isPickable = false;
      this.dots.push(dot);
    }

    this.dotDistances = [];
    this.dotSpawnTimers = [];

    for (let i = 0; i < count; i++) {
      const d = startOffset + i * DOT_SPACING;
      this.posAtDistRef(d, PacManAnimation._scratchPos);

      const dot = this.dots[i];
      dot.position.copyFrom(PacManAnimation._scratchPos);
      dot.scaling.setAll(0);
      dot.setEnabled(true);

      this.dotDistances.push(d);
      this.dotSpawnTimers.push(-i * DOT_SPAWN_STAGGER);
    }

    // Hide excess pooled dots
    for (let i = count; i < this.dots.length; i++) {
      this.dots[i].setEnabled(false);
    }

    this.activeDotCount = count;
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
    this.posAtDistRef(currentDist, PacManAnimation._scratchPos);
    this.group.position.copyFrom(PacManAnimation._scratchPos);

    // ── Face direction of travel ─────────────────────────────────────
    this.faceDirection(currentDist);

    // ── Eat dots (only when going forward) ───────────────────────────
    if (this.direction === 1) {
      for (let i = this.activeDotCount - 1; i >= 0; i--) {
        if (this.dotDistances[i] <= currentDist + EAT_DISTANCE) {
          this.dots[i].setEnabled(false);
          // Swap with last active dot to keep active range contiguous
          this.activeDotCount--;
          if (i < this.activeDotCount) {
            // Swap entries
            const tmpDot = this.dots[i]; this.dots[i] = this.dots[this.activeDotCount]; this.dots[this.activeDotCount] = tmpDot;
            const tmpDist = this.dotDistances[i]; this.dotDistances[i] = this.dotDistances[this.activeDotCount]; this.dotDistances[this.activeDotCount] = tmpDist;
            const tmpTimer = this.dotSpawnTimers[i]; this.dotSpawnTimers[i] = this.dotSpawnTimers[this.activeDotCount]; this.dotSpawnTimers[this.activeDotCount] = tmpTimer;
          }
        }
      }
    }

    // ── Dot spawn animation (scale up with ease-out) ─────────────────
    for (let i = 0; i < this.activeDotCount; i++) {
      const timer = this.dotSpawnTimers[i];
      if (timer < DOT_SPAWN_DURATION) {
        this.dotSpawnTimers[i] = timer + dt;
        if (this.dotSpawnTimers[i] > 0) {
          const t = Math.min(this.dotSpawnTimers[i] / DOT_SPAWN_DURATION, 1);
          // Ease-out: overshoot then settle (back-out)
          const s = 1 - Math.pow(1 - t, 3);
          this.dots[i].scaling.setAll(s);
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
