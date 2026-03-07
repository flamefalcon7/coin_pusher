import {
  Scene,
  Mesh,
  MeshBuilder,
  Vector3,
  Color3,
  TransformNode,
  DynamicTexture,
  StandardMaterial,
  VertexData,
} from "@babylonjs/core";
import { JACKPOT_WHEEL_CONFIG } from "@coin-pusher/shared";
import { createToonMat } from "./ToonMaterial";

// ── Segment Colors (6 distinct toon-shaded colors) ──────────────────────────
const SEGMENT_COLORS: Color3[] = [
  new Color3(0.85, 0.15, 0.15), // Red
  new Color3(0.15, 0.35, 0.85), // Blue
  new Color3(0.85, 0.68, 0.10), // Gold
  new Color3(0.15, 0.70, 0.25), // Green
  new Color3(0.90, 0.45, 0.10), // Orange
  new Color3(0.55, 0.20, 0.75), // Purple
];

const PANEL_COLOR = new Color3(0.10, 0.10, 0.14);
const BEZEL_COLOR = new Color3(0.85, 0.68, 0.10); // Gold
const POINTER_COLOR = new Color3(0.90, 0.12, 0.12); // Red

const ARC_STEPS = 8; // tessellation per segment arc

export class JackpotWheel {
  private group: TransformNode;
  private wheelPivot: TransformNode;
  private counterTexture: DynamicTexture | null = null;
  private spinning: boolean = false;
  private scene: Scene;

  // Spin animation state
  private spinObserver: ReturnType<Scene["onBeforeRenderObservable"]["add"]> | null = null;

  constructor(scene: Scene, position: Vector3, parent?: TransformNode) {
    this.scene = scene;
    this.group = new TransformNode("jackpotWheel", scene);
    this.group.position = position;
    if (parent) {
      this.group.parent = parent;
    }

    const cfg = JACKPOT_WHEEL_CONFIG;
    const radius = cfg.WIDTH / 2;
    const depth = 0.02; // thickness of the wheel disc

    // ── Backplate ──────────────────────────────────────────────────────
    const backplateMat = createToonMat("wheelPanelMat", PANEL_COLOR, scene);
    const backplate = MeshBuilder.CreateBox("wheelBackplate", {
      width: cfg.WIDTH * 1.2,
      height: cfg.HEIGHT,
      depth: 0.015,
    }, scene);
    backplate.position = new Vector3(0, cfg.HEIGHT * 0.15, -0.005);
    backplate.material = backplateMat;
    backplate.parent = this.group;

    // ── Wheel Pivot (rotates for spin) ────────────────────────────────
    this.wheelPivot = new TransformNode("wheelPivot", scene);
    this.wheelPivot.position = new Vector3(0, cfg.HEIGHT * 0.22, depth / 2 + 0.005);
    this.wheelPivot.parent = this.group;

    // ── Segments (pie slices) ─────────────────────────────────────────
    const segAngle = (Math.PI * 2) / cfg.SEGMENTS;

    for (let i = 0; i < cfg.SEGMENTS; i++) {
      const startAngle = i * segAngle;
      const endAngle = (i + 1) * segAngle;

      const segMesh = this.createPieSlice(
        `wheelSeg${i}`, radius, depth, startAngle, endAngle, scene
      );
      const segMat = createToonMat(`wheelSeg${i}`, SEGMENT_COLORS[i], scene);
      segMesh.material = segMat;
      segMesh.parent = this.wheelPivot;

      // ── Label plane (reward text) ────────────────────────────────
      const midAngle = (startAngle + endAngle) / 2;
      const labelDist = radius * 0.58;
      const labelSize = radius * 0.35;

      const labelPlane = MeshBuilder.CreatePlane(`wheelLabel${i}`, {
        width: labelSize,
        height: labelSize,
      }, scene);
      // Position at the mid-angle of the segment
      labelPlane.position = new Vector3(
        Math.cos(midAngle) * labelDist,
        Math.sin(midAngle) * labelDist,
        depth / 2 + 0.001,
      );
      labelPlane.rotation.z = midAngle;
      labelPlane.parent = this.wheelPivot;

      // DynamicTexture for reward label
      const texSize = 128;
      const dynTex = new DynamicTexture(`wheelLabelTex${i}`, texSize, scene, false);
      dynTex.hasAlpha = true;
      const ctx = dynTex.getContext() as unknown as CanvasRenderingContext2D;
      ctx.clearRect(0, 0, texSize, texSize);

      // Black outline + white fill
      const fontSize = Math.floor(texSize * 0.55);
      ctx.font = `900 ${fontSize}px Arial, sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.strokeStyle = "#000000";
      ctx.lineWidth = 6;
      const rewardText = `x${cfg.SEGMENT_REWARDS[i]}`;
      ctx.strokeText(rewardText, texSize / 2, texSize / 2);
      ctx.fillStyle = "#FFFFFF";
      ctx.fillText(rewardText, texSize / 2, texSize / 2);
      dynTex.update();

      const labelMat = new StandardMaterial(`wheelLabelMat${i}`, scene);
      labelMat.diffuseTexture = dynTex;
      labelMat.emissiveColor = new Color3(0.8, 0.8, 0.8);
      labelMat.useAlphaFromDiffuseTexture = true;
      labelMat.backFaceCulling = false;
      labelPlane.material = labelMat;
    }

    // ── Center disc ──────────────────────────────────────────────────
    const centerDisc = MeshBuilder.CreateCylinder("wheelCenter", {
      height: depth + 0.005,
      diameter: radius * 0.25,
      tessellation: 24,
    }, scene);
    centerDisc.rotation.x = Math.PI / 2;
    centerDisc.position.z = 0;
    const centerMat = createToonMat("wheelCenterMat", BEZEL_COLOR, scene);
    centerDisc.material = centerMat;
    centerDisc.parent = this.wheelPivot;

    // ── Bezel (torus ring) ───────────────────────────────────────────
    const bezelMat = createToonMat("wheelBezelMat", BEZEL_COLOR, scene);
    const bezel = MeshBuilder.CreateTorus("wheelBezel", {
      diameter: radius * 2 + 0.01,
      thickness: 0.018,
      tessellation: 48,
    }, scene);
    bezel.rotation.x = Math.PI / 2;
    bezel.position = new Vector3(0, cfg.HEIGHT * 0.22, depth / 2 + 0.005);
    bezel.material = bezelMat;
    bezel.parent = this.group;

    // ── Pointer (triangle at top) ────────────────────────────────────
    const pointerMat = createToonMat("wheelPointerMat", POINTER_COLOR, scene);
    const pointer = MeshBuilder.CreateCylinder("wheelPointer", {
      height: 0.035,
      diameterTop: 0,
      diameterBottom: 0.03,
      tessellation: 3,
    }, scene);
    // Rotate triangle to point downward toward wheel center
    pointer.rotation.x = Math.PI;
    pointer.position = new Vector3(
      0,
      cfg.HEIGHT * 0.22 + radius + 0.02,
      depth / 2 + 0.01,
    );
    pointer.material = pointerMat;
    pointer.parent = this.group;

    // ── Counter panel (bottom) ───────────────────────────────────────
    const counterPanelW = cfg.WIDTH * 0.9;
    const counterPanelH = cfg.HEIGHT * 0.12;
    const counterPanelD = 0.012;
    const counterPanelY = cfg.HEIGHT * 0.22 - radius - 0.06;

    const counterPanel = MeshBuilder.CreateBox("wheelCounterPanel", {
      width: counterPanelW,
      height: counterPanelH,
      depth: counterPanelD,
    }, scene);
    counterPanel.position = new Vector3(0, counterPanelY, 0.002);
    counterPanel.material = backplateMat;
    counterPanel.parent = this.group;

    // Counter display plane
    const counterPlane = MeshBuilder.CreatePlane("wheelCounter", {
      width: counterPanelW * 0.9,
      height: counterPanelH * 0.8,
    }, scene);
    counterPlane.position = new Vector3(0, counterPanelY, counterPanelD / 2 + 0.003);
    counterPlane.parent = this.group;

    const counterTex = new DynamicTexture("wheelCounterTex", { width: 256, height: 64 }, scene, false);
    counterTex.hasAlpha = true;
    const counterMat = new StandardMaterial("wheelCounterMat", scene);
    counterMat.diffuseTexture = counterTex;
    counterMat.emissiveColor = new Color3(0.9, 0.9, 0.9);
    counterMat.useAlphaFromDiffuseTexture = true;
    counterMat.backFaceCulling = false;
    counterPlane.material = counterMat;
    this.counterTexture = counterTex;

    // Draw initial counter
    this.drawCounter(0);

    console.log("  \u2713 Jackpot wheel created");
  }

  // ── Pie Slice Geometry ──────────────────────────────────────────────────

  private createPieSlice(
    name: string,
    radius: number,
    depth: number,
    startAngle: number,
    endAngle: number,
    scene: Scene,
  ): Mesh {
    const hd = depth / 2;
    const steps = ARC_STEPS;
    const angleStep = (endAngle - startAngle) / steps;

    // Vertices: center + arc points, for front and back faces
    // Front face: z = +hd, Back face: z = -hd
    const positions: number[] = [];
    const indices: number[] = [];

    // Front center (index 0)
    positions.push(0, 0, hd);
    // Front arc points (indices 1..steps+1)
    for (let i = 0; i <= steps; i++) {
      const a = startAngle + i * angleStep;
      positions.push(Math.cos(a) * radius, Math.sin(a) * radius, hd);
    }

    // Back center (index steps+2)
    const backOffset = steps + 2;
    positions.push(0, 0, -hd);
    // Back arc points (indices backOffset+1..backOffset+steps+1)
    for (let i = 0; i <= steps; i++) {
      const a = startAngle + i * angleStep;
      positions.push(Math.cos(a) * radius, Math.sin(a) * radius, -hd);
    }

    // Front face triangles (fan from center)
    for (let i = 0; i < steps; i++) {
      indices.push(0, i + 1, i + 2);
    }

    // Back face triangles (fan, reversed winding)
    for (let i = 0; i < steps; i++) {
      indices.push(backOffset, backOffset + i + 2, backOffset + i + 1);
    }

    // Side faces: outer arc (connect front arc to back arc)
    for (let i = 0; i < steps; i++) {
      const f0 = i + 1;
      const f1 = i + 2;
      const b0 = backOffset + i + 1;
      const b1 = backOffset + i + 2;
      indices.push(f0, b0, f1);
      indices.push(f1, b0, b1);
    }

    // Side face: start edge (center to first arc point)
    indices.push(0, backOffset, 1);
    indices.push(1, backOffset, backOffset + 1);

    // Side face: end edge (last arc point to center)
    const lastFront = steps + 1;
    const lastBack = backOffset + steps + 1;
    indices.push(lastFront, lastBack, 0);
    indices.push(0, lastBack, backOffset);

    const normals: number[] = [];
    VertexData.ComputeNormals(positions, indices, normals);

    const mesh = new Mesh(name, scene);
    const vd = new VertexData();
    vd.positions = positions;
    vd.indices = indices;
    vd.normals = normals;
    vd.applyToMesh(mesh);

    return mesh;
  }

  // ── Counter Drawing ──────────────────────────────────────────────────

  private drawCounter(count: number): void {
    const tex = this.counterTexture;
    if (!tex) return;

    const ctx = tex.getContext() as unknown as CanvasRenderingContext2D;
    const w = tex.getSize().width;
    const h = tex.getSize().height;
    ctx.clearRect(0, 0, w, h);

    const fontSize = Math.floor(h * 0.85);
    ctx.font = `900 ${fontSize}px monospace`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = "#FFD700";
    ctx.fillText(`${count}/${JACKPOT_WHEEL_CONFIG.TRIGGER_COUNT}`, w / 2, h / 2);

    tex.update();
  }

  // ── Public API ────────────────────────────────────────────────────────

  updateCounter(count: number): void {
    this.drawCounter(count);
  }

  spinWheel(resultSegment: number, _reward: number, onComplete?: () => void): void {
    if (this.spinning) return;
    this.spinning = true;

    const cfg = JACKPOT_WHEEL_CONFIG;
    const segAngle = (Math.PI * 2) / cfg.SEGMENTS;

    // Pointer is at top (angle = PI/2). Target: segment midpoint aligns with pointer.
    const segMidAngle = resultSegment * segAngle + segAngle / 2;
    // Wheel rotates clockwise in the Z axis (negative Z rotation in BabylonJS left-hand rotation)
    // We want the segment's mid angle to end up at the pointer (PI/2).
    // Target rotation = -(pointerAngle - segMidAngle) + full rotations
    const pointerAngle = Math.PI / 2;
    const targetRotation = (pointerAngle - segMidAngle) + 5 * Math.PI * 2;

    const startRotation = this.wheelPivot.rotation.z;
    const totalRotation = targetRotation - (startRotation % (Math.PI * 2));

    const duration = cfg.SPIN_DURATION;
    let elapsed = 0;
    let lastTime = performance.now();

    // easeOutQuart: decelerating to zero velocity
    const easeOutQuart = (t: number): number => {
      return 1 - Math.pow(1 - t, 4);
    };

    this.spinObserver = this.scene.onBeforeRenderObservable.add(() => {
      const now = performance.now();
      const dt = now - lastTime;
      lastTime = now;
      elapsed += dt;

      const t = Math.min(elapsed / duration, 1);
      const eased = easeOutQuart(t);

      this.wheelPivot.rotation.z = startRotation + totalRotation * eased;

      if (t >= 1) {
        // Snap to exact target
        this.wheelPivot.rotation.z = startRotation + totalRotation;
        this.spinning = false;

        if (this.spinObserver) {
          this.scene.onBeforeRenderObservable.remove(this.spinObserver);
          this.spinObserver = null;
        }
        onComplete?.();
      }
    });
  }

  getGroup(): TransformNode {
    return this.group;
  }

  dispose(): void {
    if (this.spinObserver) {
      this.scene.onBeforeRenderObservable.remove(this.spinObserver);
      this.spinObserver = null;
    }
    this.counterTexture?.dispose();
    this.group.dispose(false, true);
  }
}
