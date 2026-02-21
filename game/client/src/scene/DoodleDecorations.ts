import {
  Scene,
  Mesh,
  MeshBuilder,
  Vector3,
  Color3,
  TransformNode,
  ShaderMaterial,
  VertexData,
} from "@babylonjs/core";
import { SCENE_CONFIG } from "@coin-pusher/shared";
import { createDoodleTexture } from "./DoodleTexture";
import { createToonMat } from "./ToonMaterial";

// ── Scallop (half-circle bumps) ──────────────────────────────────────────────
const SCALLOP_R = 0.028;
const SCALLOP_SPACING = 0.058;

// ── Corner star ──────────────────────────────────────────────────────────────
const STAR_OUTER_R = 0.065;
const STAR_INNER_R = 0.03;
const STAR_POINTS = 5;
const STAR_THICKNESS = 0.04;

// ── Starburst frame (around openings) ────────────────────────────────────────
const BURST_OUTER_R = 0.14;
const BURST_INNER_R = 0.10;
const BURST_POINTS = 10;

// ── Thick outline ────────────────────────────────────────────────────────────
const OUTLINE_THICKNESS = 0.014;

// ── Colors ───────────────────────────────────────────────────────────────────
const OUTLINE_COLOR = new Color3(0.08, 0.08, 0.08);

// Alternating scallop colors (bright pop)
const SCALLOP_COLORS = [
  new Color3(0.95, 0.30, 0.35),  // red
  new Color3(1.0, 0.85, 0.20),   // yellow
  new Color3(0.30, 0.80, 0.45),  // green
  new Color3(0.30, 0.55, 0.95),  // blue
  new Color3(0.90, 0.45, 0.70),  // pink
  new Color3(1.0, 0.55, 0.20),   // orange
];

const STAR_COLOR = new Color3(1.0, 0.85, 0.15);       // gold
const BURST_COLOR = new Color3(0.95, 0.35, 0.25);     // red-orange

export class DoodleDecorations {
  private scene: Scene;
  private outlineMat: ShaderMaterial;
  private scallopMats: ShaderMaterial[];
  private starMat: ShaderMaterial;
  private burstMat: ShaderMaterial;
  private group: TransformNode;

  constructor(scene: Scene) {
    this.scene = scene;
    this.group = new TransformNode("doodleDecorations", scene);

    // ── Materials ─────────────────────────────────────────────────────
    this.outlineMat = createToonMat("doodleOutlineMat", OUTLINE_COLOR, scene);

    // Create a material for each scallop color
    this.scallopMats = SCALLOP_COLORS.map((c, i) =>
      createToonMat(`doodleBumpMat${i > 0 ? i : ""}`, c, scene)
    );

    this.starMat = createToonMat("doodleBlobMat", STAR_COLOR, scene);
    this.burstMat = createToonMat("doodleBurstMat", BURST_COLOR, scene);

    // Apply doodle texture to existing wall meshes
    this.reskinWalls();
    this.build();
  }

  /** Apply doodle texture to existing wall meshes. */
  private reskinWalls(): void {
    const doodleTex = createDoodleTexture(this.scene, "doodleWallTex", 77777);
    const wallMat = createToonMat("doodleWallMat", new Color3(1.0, 1.0, 1.0), this.scene, {
      diffuseTexture: doodleTex,
    });

    // Back wall
    const backWall = this.scene.getMeshByName("backWall");
    if (backWall) backWall.material = wallMat;

    // Side walls
    const sideWallNames = [
      "leftWallBack", "rightWallBack",
      "leftWallFront_bottom", "leftWallFront_top", "leftWallFront_left", "leftWallFront_right",
      "rightWallFront_bottom", "rightWallFront_top", "rightWallFront_left", "rightWallFront_right",
    ];
    for (const name of sideWallNames) {
      const mesh = this.scene.getMeshByName(name);
      if (mesh) {
        mesh.material = wallMat;
        this.rotateSideWallUVs(mesh as Mesh);
      }
    }
  }

  /** Swap U↔V on box meshes so doodle texture runs horizontally on side faces. */
  private rotateSideWallUVs(mesh: Mesh): void {
    const uvs = mesh.getVerticesData("uv");
    if (!uvs) return;
    const rotated = new Float32Array(uvs.length);
    for (let i = 0; i < uvs.length; i += 2) {
      rotated[i] = uvs[i + 1];
      rotated[i + 1] = uvs[i];
    }
    mesh.setVerticesData("uv", rotated);
  }

  private build(): void {
    const { WIDTH: PW, DEPTH: PD, FLARE_Z, FLARE_ANGLE, POSITION: PP } = SCENE_CONFIG.PLATFORM;
    const { HEIGHT: WH, THICKNESS: WT } = SCENE_CONFIG.SIDE_WALLS;
    const { WIDTH: BW, HEIGHT: BH, THICKNESS: BT, POSITION: BP, TILT_ANGLE: B_TILT } = SCENE_CONFIG.BACK_WALL;

    const hw = PW / 2;
    const frontZ = PP.z + PD / 2;
    const backZ = PP.z - PD / 2;
    const flareDepth = frontZ - FLARE_Z;
    const flareOffset = Math.tan(FLARE_ANGLE * Math.PI / 180) * flareDepth;
    const fhw = hw + flareOffset;

    const wallTopY = SCENE_CONFIG.SIDE_WALLS.LEFT_POSITION.y + WH / 2;

    // ── Back wall scalloped top edge ────────────────────────────────────
    const backWallDeco = new TransformNode("backWallDeco", this.scene);
    backWallDeco.position = new Vector3(BP.x, BP.y, BP.z);
    backWallDeco.rotation.x = B_TILT * (Math.PI / 180);
    backWallDeco.parent = this.group;

    this.addScallopEdge(
      backWallDeco,
      new Vector3(-BW / 2, BH / 2, 0),
      new Vector3(BW / 2, BH / 2, 0),
      BT, 0,
    );

    // ── Side wall scalloped top edges ───────────────────────────────────
    this.addScallopEdge(this.group,
      new Vector3(-hw, wallTopY, backZ),
      new Vector3(-hw, wallTopY, FLARE_Z), WT, 10);
    this.addScallopEdge(this.group,
      new Vector3(hw, wallTopY, backZ),
      new Vector3(hw, wallTopY, FLARE_Z), WT, 20);
    this.addScallopEdge(this.group,
      new Vector3(-hw, wallTopY, FLARE_Z),
      new Vector3(-fhw, wallTopY, frontZ), WT, 30);
    this.addScallopEdge(this.group,
      new Vector3(hw, wallTopY, FLARE_Z),
      new Vector3(fhw, wallTopY, frontZ), WT, 40);

    // ── Star corners ────────────────────────────────────────────────────
    const corners = [
      new Vector3(-hw, wallTopY, backZ),
      new Vector3(hw, wallTopY, backZ),
      new Vector3(-hw, wallTopY, FLARE_Z),
      new Vector3(hw, wallTopY, FLARE_Z),
      new Vector3(-fhw, wallTopY, frontZ),
      new Vector3(fhw, wallTopY, frontZ),
    ];
    corners.forEach((pos, i) => this.addCornerStar(pos, i * 0.4));

    // ── Starburst frames over side wall openings ────────────────────────
    const { FRONT_OPENING_CENTER, FRONT_OPENING_SIZE, FRONT_OPENING_Y } = SCENE_CONFIG.SIDE_WALLS;
    const dx = fhw - hw;
    const yAngle = Math.atan2(dx, flareDepth);
    const tCenter = FRONT_OPENING_CENTER;
    const openX = hw + tCenter * dx;
    const openZ = FLARE_Z + tCenter * flareDepth;
    const archTopY = FRONT_OPENING_Y + FRONT_OPENING_SIZE / 2;

    this.addStarburst(new Vector3(-openX, archTopY, openZ), -yAngle);
    this.addStarburst(new Vector3(openX, archTopY, openZ), yAngle);

    // ── Thick black outline strips along wall edges ─────────────────────
    this.addOutlineStrip(
      new Vector3(-hw, wallTopY, backZ),
      new Vector3(-hw, wallTopY, FLARE_Z), WH);
    this.addOutlineStrip(
      new Vector3(hw, wallTopY, backZ),
      new Vector3(hw, wallTopY, FLARE_Z), WH);
    this.addOutlineStrip(
      new Vector3(-hw, wallTopY, FLARE_Z),
      new Vector3(-fhw, wallTopY, frontZ), WH);
    this.addOutlineStrip(
      new Vector3(hw, wallTopY, FLARE_Z),
      new Vector3(fhw, wallTopY, frontZ), WH);

    // ── Top outline strips (along the very top) ─────────────────────────
    this.addTopOutlineStrip(
      new Vector3(-hw, wallTopY, backZ),
      new Vector3(-hw, wallTopY, FLARE_Z));
    this.addTopOutlineStrip(
      new Vector3(hw, wallTopY, backZ),
      new Vector3(hw, wallTopY, FLARE_Z));
    this.addTopOutlineStrip(
      new Vector3(-hw, wallTopY, FLARE_Z),
      new Vector3(-fhw, wallTopY, frontZ));
    this.addTopOutlineStrip(
      new Vector3(hw, wallTopY, FLARE_Z),
      new Vector3(fhw, wallTopY, frontZ));

    console.log("  ✓ Doodle decorations created (scallops + stars + starbursts + outlines)");
  }

  // ── Decoration Builders ──────────────────────────────────────────────────

  /**
   * Add colorful scalloped bumps (half-spheres) along a wall edge.
   * Each bump gets a different color from the SCALLOP_COLORS cycle.
   */
  private addScallopEdge(
    parent: TransformNode, start: Vector3, end: Vector3,
    _wallDepth: number, colorOffset: number,
  ): void {
    const dir = end.subtract(start);
    const length = dir.length();
    if (length < SCALLOP_SPACING) return;

    const norm = dir.normalize();
    const count = Math.floor(length / SCALLOP_SPACING);
    const offset = (length - count * SCALLOP_SPACING + SCALLOP_SPACING) / 2;

    for (let i = 0; i < count; i++) {
      const t = offset + i * SCALLOP_SPACING;
      const pos = start.add(norm.scale(t));
      const colorIdx = (i + colorOffset) % SCALLOP_COLORS.length;

      // Hemisphere bump
      const bump = MeshBuilder.CreateSphere(
        `scallop_${parent.name}_${i}`,
        { diameter: SCALLOP_R * 2, segments: 8, slice: 0.5 },
        this.scene,
      );
      bump.position = new Vector3(pos.x, pos.y, pos.z);
      bump.material = this.scallopMats[colorIdx];
      bump.isPickable = false;
      bump.parent = parent;
    }
  }

  /**
   * Add a 3D star shape at a corner position.
   * Uses a custom extruded star mesh.
   */
  private addCornerStar(base: Vector3, rotAngle: number): void {
    const starGroup = new TransformNode(
      `star_${base.x.toFixed(2)}_${base.z.toFixed(2)}`, this.scene);
    starGroup.position = base.clone();
    starGroup.position.y += STAR_OUTER_R * 0.6;
    starGroup.parent = this.group;

    // Create star shape vertices
    const n = STAR_POINTS * 2;
    const topPositions: number[] = [];
    const botPositions: number[] = [];
    const ht = STAR_THICKNESS / 2;

    // Center vertices (top and bottom)
    topPositions.push(0, ht, 0);
    botPositions.push(0, -ht, 0);

    for (let i = 0; i < n; i++) {
      const angle = (i / n) * Math.PI * 2 - Math.PI / 2;
      const r = i % 2 === 0 ? STAR_OUTER_R : STAR_INNER_R;
      const x = Math.cos(angle) * r;
      const z = Math.sin(angle) * r;
      topPositions.push(x, ht, z);
      botPositions.push(x, -ht, z);
    }

    // Build indices: top fan + bottom fan + sides
    const positions: number[] = [...topPositions, ...botPositions];
    const indices: number[] = [];
    const offset = n + 1; // offset to bottom vertices

    // Top face fan
    for (let i = 0; i < n; i++) {
      const next = (i + 1) % n;
      indices.push(0, i + 1, next + 1);
    }

    // Bottom face fan (reversed winding)
    for (let i = 0; i < n; i++) {
      const next = (i + 1) % n;
      indices.push(offset, offset + next + 1, offset + i + 1);
    }

    // Side faces
    for (let i = 0; i < n; i++) {
      const next = (i + 1) % n;
      const ti = i + 1;
      const tn = next + 1;
      const bi = offset + i + 1;
      const bn = offset + next + 1;
      indices.push(ti, bi, bn);
      indices.push(ti, bn, tn);
    }

    const normals: number[] = [];
    VertexData.ComputeNormals(positions, indices, normals);

    const starMesh = new Mesh("cornerStar", this.scene);
    const vd = new VertexData();
    vd.positions = positions;
    vd.indices = indices;
    vd.normals = normals;
    vd.applyToMesh(starMesh);

    starMesh.rotation.y = rotAngle;
    starMesh.material = this.starMat;
    starMesh.isPickable = false;
    starMesh.parent = starGroup;

    // Black outline ring around the star
    const outlineRing = MeshBuilder.CreateTorus("starOutline", {
      diameter: STAR_OUTER_R * 2,
      thickness: 0.008,
      tessellation: 24,
    }, this.scene);
    outlineRing.material = this.outlineMat;
    outlineRing.rotation.x = Math.PI / 2;
    outlineRing.isPickable = false;
    outlineRing.parent = starGroup;
  }

  /** Add a starburst/explosion frame around wall openings. */
  private addStarburst(position: Vector3, yRotation: number): void {
    const n = BURST_POINTS * 2;
    const positions: number[] = [];
    const indices: number[] = [];

    // Center vertex
    positions.push(0, 0, 0);

    for (let i = 0; i < n; i++) {
      const angle = (i / n) * Math.PI * 2;
      const r = i % 2 === 0 ? BURST_OUTER_R : BURST_INNER_R;
      positions.push(Math.cos(angle) * r, Math.sin(angle) * r, 0);

      const next = (i + 1) % n;
      indices.push(0, i + 1, next + 1);
    }

    const normals: number[] = [];
    VertexData.ComputeNormals(positions, indices, normals);

    const burstMesh = new Mesh("starburst", this.scene);
    const vd = new VertexData();
    vd.positions = positions;
    vd.indices = indices;
    vd.normals = normals;
    vd.applyToMesh(burstMesh);

    burstMesh.position = position.clone();
    burstMesh.rotation.y = yRotation;
    burstMesh.material = this.burstMat;
    burstMesh.isPickable = false;
    burstMesh.parent = this.group;
  }

  /** Add a thin black outline strip along a wall vertical edge. */
  private addOutlineStrip(start: Vector3, end: Vector3, wallHeight: number): void {
    const dir = end.subtract(start);
    const length = dir.length();
    if (length <= 0) return;

    const center = start.add(end).scale(0.5);
    const yRot = Math.atan2(dir.x, dir.z);

    const strip = MeshBuilder.CreateBox("outline", {
      width: OUTLINE_THICKNESS,
      height: wallHeight,
      depth: length,
    }, this.scene);

    strip.position = new Vector3(center.x, center.y - wallHeight / 2, center.z);
    strip.rotation.y = yRot;
    strip.material = this.outlineMat;
    strip.isPickable = false;
    strip.parent = this.group;
  }

  /** Add a thin black outline strip along the top of a wall. */
  private addTopOutlineStrip(start: Vector3, end: Vector3): void {
    const dir = end.subtract(start);
    const length = dir.length();
    if (length <= 0) return;

    const center = start.add(end).scale(0.5);
    const yRot = Math.atan2(dir.x, dir.z);

    const strip = MeshBuilder.CreateBox("topOutline", {
      width: OUTLINE_THICKNESS,
      height: OUTLINE_THICKNESS,
      depth: length,
    }, this.scene);

    strip.position = new Vector3(center.x, center.y, center.z);
    strip.rotation.y = yRot;
    strip.material = this.outlineMat;
    strip.isPickable = false;
    strip.parent = this.group;
  }

  dispose(): void {
    this.group.dispose(false, true);
  }
}
