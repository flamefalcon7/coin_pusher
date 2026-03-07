import {
  Scene,
  Mesh,
  MeshBuilder,
  ShaderMaterial,
  Color3,
  Vector3,
} from "@babylonjs/core";
import { SCENE_CONFIG } from "@coin-pusher/shared";
import { createToonMat } from "./ToonMaterial";

export interface WallRefs {
  leftBack: Mesh;
  rightBack: Mesh;
  leftFront: Mesh;
  rightFront: Mesh;
}

export interface DecorationMaterials {
  emissiveMats: ShaderMaterial[];
  celToggleMats: ShaderMaterial[];
  alphaMats: ShaderMaterial[];
}

interface WallSegment {
  wall: Mesh;
  depth: number;
  outwardSign: number;
}

export class WallDecorations {
  private scene: Scene;
  private celToggleMats: ShaderMaterial[] = [];

  constructor(scene: Scene) {
    this.scene = scene;
  }

  decorate(walls: WallRefs): void {
    const { HEIGHT, THICKNESS } = SCENE_CONFIG.SIDE_WALLS;
    const ARC_SEGMENTS = 8;
    const ARC_BULGE = 0.08;
    const { WIDTH, DEPTH, FLARE_Z, POSITION } = SCENE_CONFIG.PLATFORM;

    const hw = WIDTH / 2;
    const fhw = this.getFrontHalfWidth();
    const backZ = POSITION.z - DEPTH / 2;
    const frontZ = POSITION.z + DEPTH / 2;

    const backDepth = FLARE_Z - backZ;
    const flareDepth = frontZ - FLARE_Z;
    const dx = fhw - hw;
    const frontLen = Math.sqrt(dx * dx + flareDepth * flareDepth);

    // Accent material — toon shaded, themed by accent color (shared for rails + dividers)
    const accentMat = createToonMat("wallAccentMat", new Color3(0.8, 0.8, 0.9), this.scene);
    this.celToggleMats.push(accentMat);
    const bumperRailMat = accentMat;
    const panelDividerMat = accentMat;

    const segments: WallSegment[] = [
      { wall: walls.leftBack, depth: backDepth, outwardSign: -1 },
      { wall: walls.rightBack, depth: backDepth, outwardSign: 1 },
      { wall: walls.leftFront, depth: frontLen, outwardSign: -1 },
      { wall: walls.rightFront, depth: frontLen, outwardSign: 1 },
    ];

    for (const seg of segments) {
      // Walls stay opaque with wallMat from StaticMeshes (no glass override)

      // Bumper rail along top edge
      this.createBumperRail(seg, THICKNESS, HEIGHT, ARC_BULGE, ARC_SEGMENTS, bumperRailMat);

      // Segmented panel groove lines
      this.createPanelDividers(seg, HEIGHT, ARC_BULGE, ARC_SEGMENTS, panelDividerMat);

      // Edge frame (structural, no glow)
      this.createEdgeFrame(seg, THICKNESS, HEIGHT, ARC_BULGE, ARC_SEGMENTS, panelDividerMat);
    }

    console.log("  ✓ Wall decorations created");
  }

  dispose(): void {
    for (const mat of this.celToggleMats) mat.dispose();
    this.celToggleMats = [];
  }

  getMaterials(): DecorationMaterials {
    return {
      emissiveMats: [],
      celToggleMats: this.celToggleMats,
      alphaMats: [],
    };
  }

  // ── Arc path helper ───────────────────────────────────────────────────

  private getArcPath(
    depth: number, bulge: number, outwardSign: number, segments: number, y: number,
  ): Vector3[] {
    const points: Vector3[] = [];
    for (let i = 0; i <= segments; i++) {
      const t = i / segments;
      const z = -depth / 2 + t * depth;
      const x = outwardSign * bulge * Math.sin(Math.PI * t);
      points.push(new Vector3(x, y, z));
    }
    return points;
  }

  // ── Decoration builders ─────────────────────────────────────────────────

  private createBumperRail(
    seg: WallSegment, thickness: number, height: number,
    bulge: number, arcSegments: number, mat: ShaderMaterial,
  ): void {
    const path = this.getArcPath(seg.depth, bulge, seg.outwardSign, arcSegments, height / 2);
    const tube = MeshBuilder.CreateTube(
      `${seg.wall.name}_bumperRail`,
      { path, radius: thickness, tessellation: 16, cap: Mesh.CAP_ALL },
      this.scene,
    );
    tube.material = mat;
    tube.parent = seg.wall;
  }

  private createPanelDividers(
    seg: WallSegment, _height: number,
    bulge: number, arcSegments: number, mat: ShaderMaterial,
  ): void {
    const offsets = [-0.3, 0, 0.3];
    for (let i = 0; i < offsets.length; i++) {
      const path = this.getArcPath(seg.depth, bulge, seg.outwardSign, arcSegments, offsets[i]);
      const tube = MeshBuilder.CreateTube(
        `${seg.wall.name}_divider${i}`,
        { path, radius: 0.004, tessellation: 8, cap: Mesh.CAP_ALL },
        this.scene,
      );
      tube.material = mat;
      tube.parent = seg.wall;
    }
  }

  private createEdgeFrame(
    seg: WallSegment, thickness: number, height: number,
    bulge: number, arcSegments: number, mat: ShaderMaterial,
  ): void {
    const barRadius = 0.0075;
    const halfH = height / 2;
    const halfD = seg.depth / 2;
    const barThickness = 0.015;

    // Top bar — tube along arc path
    const topPath = this.getArcPath(seg.depth, bulge, seg.outwardSign, arcSegments, halfH - barRadius);
    const top = MeshBuilder.CreateTube(
      `${seg.wall.name}_frameTop`,
      { path: topPath, radius: barRadius, tessellation: 8, cap: Mesh.CAP_ALL },
      this.scene,
    );
    top.material = mat;
    top.parent = seg.wall;

    // Bottom bar — tube along arc path
    const bottomPath = this.getArcPath(seg.depth, bulge, seg.outwardSign, arcSegments, -halfH + barRadius);
    const bottom = MeshBuilder.CreateTube(
      `${seg.wall.name}_frameBottom`,
      { path: bottomPath, radius: barRadius, tessellation: 8, cap: Mesh.CAP_ALL },
      this.scene,
    );
    bottom.material = mat;
    bottom.parent = seg.wall;

    // Side bars — straight vertical boxes at wall endpoints
    const left = MeshBuilder.CreateBox(
      `${seg.wall.name}_frameLeft`,
      { width: thickness + 0.012, height: height, depth: barThickness },
      this.scene,
    );
    left.position = new Vector3(0, 0, -halfD + barThickness / 2);
    left.material = mat;
    left.parent = seg.wall;

    const right = MeshBuilder.CreateBox(
      `${seg.wall.name}_frameRight`,
      { width: thickness + 0.012, height: height, depth: barThickness },
      this.scene,
    );
    right.position = new Vector3(0, 0, halfD - barThickness / 2);
    right.material = mat;
    right.parent = seg.wall;
  }

  // ── Helpers ─────────────────────────────────────────────────────────────

  private getFrontHalfWidth(): number {
    const { WIDTH, DEPTH, FLARE_Z, FLARE_ANGLE, POSITION } = SCENE_CONFIG.PLATFORM;
    const hw = WIDTH / 2;
    const frontZ = POSITION.z + DEPTH / 2;
    const flareDepth = frontZ - FLARE_Z;
    const flareOffset = Math.tan((FLARE_ANGLE * Math.PI) / 180) * flareDepth;
    return hw + flareOffset;
  }
}
