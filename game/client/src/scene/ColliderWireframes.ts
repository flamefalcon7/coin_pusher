import {
  MeshBuilder,
  StandardMaterial,
  Color3,
  TransformNode,
  Quaternion,
  Vector3,
} from "@babylonjs/core";
import type { Scene, Mesh, AbstractMesh } from "@babylonjs/core";
import { SCENE_CONFIG, COIN_CONFIG, PUSHER_CONFIG } from "@coin-pusher/shared";

/**
 * Rapier collider wireframe overlay (R3, agent-perception plan).
 *
 * Static collider shapes are rebuilt CLIENT-SIDE from the same SCENE_CONFIG
 * constants the server's SceneBuilder uses — the geometry math below mirrors
 * game/server/src/physics/SceneBuilder.ts piece by piece, so one screenshot
 * shows "rendered vs physical" drift directly.
 *
 * Dynamic bodies (coins, pusher) track the latest authoritative network pose
 * via a provider injected from App (same source as debugDump's network block).
 * Coin wireframes are capped at MAX_COIN_WIREFRAMES as a perf guard.
 *
 * Debug-only (?debug=1); hidden by default until `wireframe(true)`.
 */

export const MAX_COIN_WIREFRAMES = 20;

export interface WireframePoseProvider {
  (): {
    pusherZ: number;
    coins: { id: number; pos: [number, number, number]; rot: [number, number, number, number] }[];
  } | null;
}

type Quat = { x: number; y: number; z: number; w: number };

function quatFromAxisAngle(ax: number, ay: number, az: number, angle: number): Quat {
  const half = angle / 2;
  const s = Math.sin(half);
  return { x: ax * s, y: ay * s, z: az * s, w: Math.cos(half) };
}

function quatMultiply(a: Quat, b: Quat): Quat {
  return {
    x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
    y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
    z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
    w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
  };
}

/** Mirror of SceneBuilder.getFrontHalfWidth (platform flare). */
function getFrontHalfWidth(): number {
  const { WIDTH, DEPTH, FLARE_Z, FLARE_ANGLE, POSITION } = SCENE_CONFIG.PLATFORM;
  const hw = WIDTH / 2;
  const frontZ = POSITION.z + DEPTH / 2;
  const flareDepth = frontZ - FLARE_Z;
  const flareOffset = Math.tan((FLARE_ANGLE * Math.PI) / 180) * flareDepth;
  return hw + flareOffset;
}

export class ColliderWireframes {
  private readonly scene: Scene;
  private root: TransformNode | null;
  private staticMat: StandardMaterial | null;
  private dynamicMat: StandardMaterial | null;
  private staticMeshes: AbstractMesh[] = [];
  private coinPool: Mesh[] = [];
  private pusherBox: Mesh | null = null;
  private observer: ReturnType<Scene["onBeforeRenderObservable"]["add"]> | null;
  private visible = false;
  private getPoses: WireframePoseProvider | null = null;

  constructor(scene: Scene) {
    this.scene = scene;
    this.root = new TransformNode("colliderWireframes", scene);

    // One shared material per role (never per-mesh — see babylon-rapier-lifecycle).
    this.staticMat = new StandardMaterial("wfStaticMat", scene);
    this.staticMat.wireframe = true;
    this.staticMat.emissiveColor = new Color3(0.2, 1, 0.35);
    this.staticMat.disableLighting = true;

    this.dynamicMat = new StandardMaterial("wfDynamicMat", scene);
    this.dynamicMat.wireframe = true;
    this.dynamicMat.emissiveColor = new Color3(1, 0.75, 0.15);
    this.dynamicMat.disableLighting = true;

    this.buildPlatform();
    this.buildBackWallWithPins();
    this.buildSideWalls();
    this.buildPusher();

    this.root.setEnabled(false);
    this.observer = scene.onBeforeRenderObservable.add(() => this.updateDynamic());
  }

  /** Inject the authoritative-pose source (wired from App, like dump()). */
  setPoseProvider(provider: WireframePoseProvider | null): void {
    this.getPoses = provider;
  }

  setVisible(on: boolean): void {
    this.visible = on;
    this.root?.setEnabled(on);
  }

  isVisible(): boolean {
    return this.visible;
  }

  // ── Static colliders (mirror SceneBuilder) ────────────────────────────────

  private addBox(
    name: string,
    parent: TransformNode,
    w: number,
    h: number,
    d: number,
    x: number,
    y: number,
    z: number,
    rotation?: Quat,
  ): Mesh {
    const box = MeshBuilder.CreateBox(name, { width: w, height: h, depth: d }, this.scene);
    box.parent = parent;
    box.position = new Vector3(x, y, z);
    if (rotation) {
      box.rotationQuaternion = new Quaternion(rotation.x, rotation.y, rotation.z, rotation.w);
    }
    box.material = this.staticMat;
    box.isPickable = false;
    this.staticMeshes.push(box);
    return box;
  }

  /**
   * Wireframe for a convex prism collider: top polygon extruded down to
   * `bottomY` (mirrors SceneBuilder's addFlareCollider vertex layout).
   * Optionally the bottom keeps the top's per-vertex x/z (always true here).
   */
  private addPrismLines(
    name: string,
    parent: TransformNode,
    topVerts: [number, number, number][],
    bottomY: number,
  ): void {
    const top = topVerts.map(([x, y, z]) => new Vector3(x, y, z));
    const bottom = topVerts.map(([x, , z]) => new Vector3(x, bottomY, z));
    const lines: Vector3[][] = [
      [...top, top[0]],
      [...bottom, bottom[0]],
      ...top.map((t, i) => [t, bottom[i]]),
    ];
    const mesh = MeshBuilder.CreateLineSystem(name, { lines }, this.scene);
    mesh.parent = parent;
    mesh.color = new Color3(0.2, 1, 0.35);
    mesh.isPickable = false;
    this.staticMeshes.push(mesh);
  }

  private buildPlatform(): void {
    const { WIDTH, DEPTH, THICKNESS, POSITION } = SCENE_CONFIG.PLATFORM;
    const { DROP } = SCENE_CONFIG.SIDE_RAMP;
    const { FRONT_OPENING_SIZE, FRONT_OPENING_CENTER } = SCENE_CONFIG.SIDE_WALLS;

    const group = new TransformNode("wf_platform", this.scene);
    group.parent = this.root;
    group.position = new Vector3(POSITION.x, POSITION.y, POSITION.z);

    const hw = WIDTH / 2;
    const fhw = getFrontHalfWidth();
    const hd = DEPTH / 2;
    const ht = THICKNESS / 2;
    const flareZLocal = SCENE_CONFIG.PLATFORM.FLARE_Z - POSITION.z;

    // 1. Central rectangle collider
    this.addBox("wf_platform_center", group, WIDTH, THICKNESS, DEPTH, 0, 0, 0);

    // Flared edge geometry (identical math to SceneBuilder.createPlatform)
    const dx = fhw - hw;
    const flareLen = hd - flareZLocal;
    const edgeLen = Math.sqrt(dx * dx + flareLen * flareLen);
    const tHalf = FRONT_OPENING_SIZE / 2 / edgeLen;
    const tStart = FRONT_OPENING_CENTER - tHalf;
    const tEnd = FRONT_OPENING_CENTER + tHalf;
    const p1x = hw + tStart * dx;
    const p1z = flareZLocal + tStart * flareLen;
    const p2x = hw + tEnd * dx;
    const p2z = flareZLocal + tEnd * flareLen;

    // 2. Left flare pieces (triangle, depressed ramp, trapezoid)
    this.addPrismLines("wf_flare_L1", group, [
      [-hw, ht, flareZLocal],
      [-hw, ht, p1z],
      [-p1x, ht, p1z],
    ], -ht);
    this.addPrismLines("wf_flare_Lramp", group, [
      [-hw, ht, p1z],
      [-hw, ht, p2z],
      [-p2x, ht - DROP, p2z],
      [-p1x, ht - DROP, p1z],
    ], -ht);
    this.addPrismLines("wf_flare_L2", group, [
      [-hw, ht, p2z],
      [-hw, ht, hd],
      [-fhw, ht, hd],
      [-p2x, ht, p2z],
    ], -ht);

    // 3. Right flare pieces (mirror)
    this.addPrismLines("wf_flare_R1", group, [
      [hw, ht, flareZLocal],
      [hw, ht, p1z],
      [p1x, ht, p1z],
    ], -ht);
    this.addPrismLines("wf_flare_Rramp", group, [
      [hw, ht, p1z],
      [hw, ht, p2z],
      [p2x, ht - DROP, p2z],
      [p1x, ht - DROP, p1z],
    ], -ht);
    this.addPrismLines("wf_flare_R2", group, [
      [hw, ht, p2z],
      [hw, ht, hd],
      [fhw, ht, hd],
      [p2x, ht, p2z],
    ], -ht);

    // 4. Front lip wedge (8-vertex convex hull, drawn as its two quad rings)
    const { HEIGHT: LIP_H, DEPTH: LIP_D, BASE: LIP_BASE } = SCENE_CONFIG.FRONT_LIP;
    const lipHd = LIP_D / 2;
    const lipZ = hd - lipHd;
    const zb = lipZ - lipHd;
    const zf = lipZ + lipHd;
    const topRing = [
      new Vector3(-fhw, ht, zb),
      new Vector3(fhw, ht, zb),
      new Vector3(fhw, ht + LIP_H, zf),
      new Vector3(-fhw, ht + LIP_H, zf),
    ];
    const bottomRing = [
      new Vector3(-fhw, ht - LIP_BASE, zb),
      new Vector3(fhw, ht - LIP_BASE, zb),
      new Vector3(fhw, ht - LIP_BASE, zf),
      new Vector3(-fhw, ht - LIP_BASE, zf),
    ];
    const lipLines: Vector3[][] = [
      [...topRing, topRing[0]],
      [...bottomRing, bottomRing[0]],
      ...topRing.map((t, i) => [t, bottomRing[i]]),
    ];
    const lip = MeshBuilder.CreateLineSystem("wf_frontLip", { lines: lipLines }, this.scene);
    lip.parent = group;
    lip.color = new Color3(0.2, 1, 0.35);
    lip.isPickable = false;
    this.staticMeshes.push(lip);
  }

  private buildBackWallWithPins(): void {
    const { WIDTH, HEIGHT, THICKNESS, POSITION, TILT_ANGLE } = SCENE_CONFIG.BACK_WALL;

    const group = new TransformNode("wf_backWall", this.scene);
    group.parent = this.root;
    group.position = new Vector3(POSITION.x, POSITION.y, POSITION.z);
    const tilt = quatFromAxisAngle(1, 0, 0, (TILT_ANGLE * Math.PI) / 180);
    group.rotationQuaternion = new Quaternion(tilt.x, tilt.y, tilt.z, tilt.w);

    this.addBox("wf_backWall_slab", group, WIDTH, HEIGHT, THICKNESS, 0, 0, 0);

    // Pins (children of the tilted wall body, like the server's colliders)
    const {
      RADIUS,
      HEIGHT: PIN_H,
      ROWS,
      ODD_ROW_COUNT,
      EVEN_ROW_COUNT,
      HORIZONTAL_SPACING,
      VERTICAL_SPACING,
      START_Y,
      Y_OFFSET,
    } = SCENE_CONFIG.PINS;

    const pinRotation = new Quaternion(Math.SQRT1_2, 0, 0, Math.SQRT1_2); // 90° about X → axis along Z

    for (let row = 0; row < ROWS; row++) {
      const isOddRow = row % 2 === 0;
      const pinCount = isOddRow ? ODD_ROW_COUNT : EVEN_ROW_COUNT;
      const startX = -((pinCount - 1) * HORIZONTAL_SPACING) / 2;
      const relativeY = START_Y + row * VERTICAL_SPACING - HEIGHT / 2 + Y_OFFSET;
      const relativeZ = PIN_H / 2;

      for (let col = 0; col < pinCount; col++) {
        const pin = MeshBuilder.CreateCylinder(
          `wf_pin_${row}_${col}`,
          { height: PIN_H, diameter: RADIUS * 2, tessellation: 8 },
          this.scene,
        );
        pin.parent = group;
        pin.position = new Vector3(startX + col * HORIZONTAL_SPACING, relativeY, relativeZ);
        pin.rotationQuaternion = pinRotation.clone();
        pin.material = this.staticMat;
        pin.isPickable = false;
        this.staticMeshes.push(pin);
      }
    }
  }

  private buildSideWalls(): void {
    const { HEIGHT, THICKNESS, INNER_TILT_ANGLE, FRONT_OPENING_SIZE, FRONT_OPENING_CENTER, FRONT_OPENING_Y } =
      SCENE_CONFIG.SIDE_WALLS;
    const { WIDTH, DEPTH, FLARE_Z, POSITION } = SCENE_CONFIG.PLATFORM;

    const hw = WIDTH / 2;
    const fhw = getFrontHalfWidth();
    const backZ = POSITION.z - DEPTH / 2;
    const frontZ = POSITION.z + DEPTH / 2;
    const centerY = SCENE_CONFIG.SIDE_WALLS.LEFT_POSITION.y;
    const innerTilt = (INNER_TILT_ANGLE * Math.PI) / 180;

    // Back segments (straight, tilted about Z)
    const backDepth = FLARE_Z - backZ;
    const backCenterZ = (backZ + FLARE_Z) / 2;
    this.addBox(
      "wf_sideWall_L_back", this.root!, THICKNESS, HEIGHT, backDepth,
      -hw, centerY, backCenterZ, quatFromAxisAngle(0, 0, 1, -innerTilt),
    );
    this.addBox(
      "wf_sideWall_R_back", this.root!, THICKNESS, HEIGHT, backDepth,
      hw, centerY, backCenterZ, quatFromAxisAngle(0, 0, 1, innerTilt),
    );

    // Front segments: angled outward, 4-cuboid frame around the opening
    const flareDepth = frontZ - FLARE_Z;
    const dx = fhw - hw;
    const frontLen = Math.sqrt(dx * dx + flareDepth * flareDepth);
    const yAngle = Math.atan2(dx, flareDepth);
    const frontCenterZ = (FLARE_Z + frontZ) / 2;
    const frontCenterXOffset = (hw + fhw) / 2;

    const buildFrame = (name: string, x: number, rotation: Quat) => {
      const group = new TransformNode(name, this.scene);
      group.parent = this.root;
      group.position = new Vector3(x, centerY, frontCenterZ);
      group.rotationQuaternion = new Quaternion(rotation.x, rotation.y, rotation.z, rotation.w);

      // Mirror of SceneBuilder.createWallWithOpening local strip layout
      const hs = FRONT_OPENING_SIZE / 2;
      const hh = HEIGHT / 2;
      const hl = frontLen / 2;
      const holeLocalY = FRONT_OPENING_Y - centerY;
      const holeLocalZ = (FRONT_OPENING_CENTER - 0.5) * frontLen;

      const bottomH = holeLocalY - hs + hh;
      if (bottomH > 0) {
        this.addBox(`${name}_bottom`, group, THICKNESS, bottomH, frontLen, 0, -hh + bottomH / 2, 0);
      }
      const topH = hh - (holeLocalY + hs);
      if (topH > 0) {
        this.addBox(`${name}_top`, group, THICKNESS, topH, frontLen, 0, hh - topH / 2, 0);
      }
      const leftLen = holeLocalZ - hs + hl;
      if (leftLen > 0) {
        this.addBox(`${name}_left`, group, THICKNESS, FRONT_OPENING_SIZE, leftLen, 0, holeLocalY, -hl + leftLen / 2);
      }
      const rightLen = hl - (holeLocalZ + hs);
      if (rightLen > 0) {
        this.addBox(`${name}_right`, group, THICKNESS, FRONT_OPENING_SIZE, rightLen, 0, holeLocalY, hl - rightLen / 2);
      }
    };

    buildFrame(
      "wf_sideWall_L_front",
      -frontCenterXOffset,
      quatMultiply(quatFromAxisAngle(0, 1, 0, -yAngle), quatFromAxisAngle(0, 0, 1, -innerTilt)),
    );
    buildFrame(
      "wf_sideWall_R_front",
      frontCenterXOffset,
      quatMultiply(quatFromAxisAngle(0, 1, 0, yAngle), quatFromAxisAngle(0, 0, 1, innerTilt)),
    );
  }

  private buildPusher(): void {
    const { WIDTH, HEIGHT, DEPTH, POSITION } = SCENE_CONFIG.PUSHER;

    // Swept envelope: config-derived max travel (Z_OFFSET ± AMPLITUDE_MAX).
    this.addBox(
      "wf_pusherEnvelope", this.root!,
      WIDTH, HEIGHT, DEPTH + 2 * PUSHER_CONFIG.AMPLITUDE_MAX,
      POSITION.x, POSITION.y, POSITION.z + PUSHER_CONFIG.Z_OFFSET,
    );

    // Live pusher body: tracks authoritative pusherZ (world z, like PusherMesh).
    const live = MeshBuilder.CreateBox(
      "wf_pusher_live",
      { width: WIDTH, height: HEIGHT, depth: DEPTH },
      this.scene,
    );
    live.parent = this.root;
    live.position = new Vector3(POSITION.x, POSITION.y, POSITION.z);
    live.material = this.dynamicMat;
    live.isPickable = false;
    this.pusherBox = live;
  }

  // ── Dynamic bodies (coins + pusher at network pose) ───────────────────────

  private updateDynamic(): void {
    if (!this.visible) return;
    const state = this.getPoses?.() ?? null;
    if (!state) return;

    if (this.pusherBox) {
      this.pusherBox.position.z = state.pusherZ;
    }

    const count = Math.min(state.coins.length, MAX_COIN_WIREFRAMES);
    // Grow pool on demand, hard-capped (a pool that only grows is a leak).
    while (this.coinPool.length < count) {
      const coin = MeshBuilder.CreateCylinder(
        `wf_coin_${this.coinPool.length}`,
        { height: COIN_CONFIG.THICKNESS, diameter: COIN_CONFIG.RADIUS * 2, tessellation: 12 },
        this.scene,
      );
      coin.parent = this.root;
      coin.material = this.dynamicMat;
      coin.isPickable = false;
      coin.rotationQuaternion = new Quaternion(0, 0, 0, 1);
      this.coinPool.push(coin);
    }

    for (let i = 0; i < this.coinPool.length; i++) {
      const mesh = this.coinPool[i];
      if (i < count) {
        const c = state.coins[i];
        mesh.setEnabled(true);
        mesh.position.set(c.pos[0], c.pos[1], c.pos[2]);
        mesh.rotationQuaternion!.set(c.rot[0], c.rot[1], c.rot[2], c.rot[3]);
      } else {
        mesh.setEnabled(false);
      }
    }
  }

  // ── Introspection (for leak tests) ────────────────────────────────────────

  getStaticMeshCount(): number {
    return this.staticMeshes.length;
  }

  getCoinPoolSize(): number {
    return this.coinPool.length;
  }

  dispose(): void {
    if (this.observer) {
      this.scene.onBeforeRenderObservable.remove(this.observer);
      this.observer = null;
    }
    for (const mesh of this.coinPool) mesh.dispose();
    this.coinPool = [];
    if (this.pusherBox) {
      this.pusherBox.dispose();
      this.pusherBox = null;
    }
    for (const mesh of this.staticMeshes) mesh.dispose();
    this.staticMeshes = [];
    this.staticMat?.dispose();
    this.staticMat = null;
    this.dynamicMat?.dispose();
    this.dynamicMat = null;
    this.root?.dispose();
    this.root = null;
    this.getPoses = null;
  }
}
