import {
  Scene,
  Mesh,
  MeshBuilder,
  Vector3,
  Color3,
  TransformNode,
  ShaderMaterial,
} from "@babylonjs/core";
import { SCENE_CONFIG } from "@coin-pusher/shared";
import { createStoneWallTexture } from "./WallTexture";
import { createToonMat } from "./ToonMaterial";

// ── Merlon (battlement tooth) dimensions ────────────────────────────────────
const MERLON_W = 0.055;
const MERLON_H = 0.09;
const MERLON_GAP = 0.05;
const MERLON_STEP = MERLON_W + MERLON_GAP;

// ── Turret dimensions (sized to match wall thickness 0.10) ──────────────────
const TURRET_R = 0.06;
const TURRET_H = 0.18;
const ROOF_R = 0.08;
const ROOF_H = 0.08;
const TURRET_TESS = 12;

// ── Arch decoration over wall openings ──────────────────────────────────────
const ARCH_R = 0.14;
const ARCH_THICKNESS = 0.03;

// ── Colors ────────────────────────────────────────────────────────────────────
const STONE_COLOR = new Color3(0.68, 0.60, 0.50);

export class CastleDecorations {
  private scene: Scene;
  private wallMat: ShaderMaterial;    // textured toon — for walls
  private decoMat: ShaderMaterial;    // solid stone — for merlons, turrets, arches
  private roofMat: ShaderMaterial;
  private group: TransformNode;

  constructor(scene: Scene) {
    this.scene = scene;
    this.group = new TransformNode("castleDecorations", scene);

    // ── Wall material: toon shader + procedural cartoon texture ───────
    const castleWallTex = createStoneWallTexture(scene, "castleWallTex", 77777);
    this.wallMat = createToonMat("castleWallMat", new Color3(0.9, 0.85, 0.78), scene, {
      diffuseTexture: castleWallTex,
    });

    // ── Decoration material: solid stone (merlons, turrets, arches) ───────
    this.decoMat = createToonMat("castleDecoMat", STONE_COLOR, scene);

    // ── Roof material for turret cones (warm brown) ───────────────────────
    this.roofMat = createToonMat("castleRoofMat", new Color3(0.55, 0.40, 0.30), scene);

    this.reskinWalls();
    this.build();
  }

  /** Apply stone texture to existing wall meshes + fix UV direction on side walls. */
  private reskinWalls(): void {
    // Back wall — texture direction is correct as-is
    const backWall = this.scene.getMeshByName("backWall");
    if (backWall) backWall.material = this.wallMat;

    // Side walls — need UV rotation so bricks run horizontally along the wall
    const sideWallNames = [
      "leftWallBack", "rightWallBack",
      "leftWallFront_bottom", "leftWallFront_top", "leftWallFront_left", "leftWallFront_right",
      "rightWallFront_bottom", "rightWallFront_top", "rightWallFront_left", "rightWallFront_right",
    ];
    for (const name of sideWallNames) {
      const mesh = this.scene.getMeshByName(name);
      if (mesh) {
        mesh.material = this.wallMat;
        this.rotateSideWallUVs(mesh as Mesh);
      }
    }
  }

  /**
   * Swap U↔V on a box mesh so the brick texture runs horizontally on side faces.
   * CreateBox maps side faces with U along Z, V along Y.
   * We swap them so bricks (horizontal in texture) appear horizontal on the wall.
   */
  private rotateSideWallUVs(mesh: Mesh): void {
    const uvs = mesh.getVerticesData("uv");
    if (!uvs) return;

    const rotated = new Float32Array(uvs.length);
    for (let i = 0; i < uvs.length; i += 2) {
      // Swap U and V → rotates texture 90°
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

    // ── Back wall battlements ────────────────────────────────────────────
    const backWallDeco = new TransformNode("backWallDeco", this.scene);
    backWallDeco.position = new Vector3(BP.x, BP.y, BP.z);
    backWallDeco.rotation.x = B_TILT * (Math.PI / 180);
    backWallDeco.parent = this.group;

    this.addMerlonsAlongLine(
      backWallDeco,
      new Vector3(-BW / 2, BH / 2, 0),
      new Vector3(BW / 2, BH / 2, 0),
      BT,
    );

    // ── Side wall battlements ────────────────────────────────────────────
    this.addMerlonsAlongLine(this.group,
      new Vector3(-hw, wallTopY, backZ),
      new Vector3(-hw, wallTopY, FLARE_Z), WT);
    this.addMerlonsAlongLine(this.group,
      new Vector3(hw, wallTopY, backZ),
      new Vector3(hw, wallTopY, FLARE_Z), WT);

    this.addMerlonsAlongLine(this.group,
      new Vector3(-hw, wallTopY, FLARE_Z),
      new Vector3(-fhw, wallTopY, frontZ), WT);
    this.addMerlonsAlongLine(this.group,
      new Vector3(hw, wallTopY, FLARE_Z),
      new Vector3(fhw, wallTopY, frontZ), WT);

    // ── Corner turrets ───────────────────────────────────────────────────
    this.addTurret(new Vector3(-hw, wallTopY, backZ));
    this.addTurret(new Vector3(hw, wallTopY, backZ));
    this.addTurret(new Vector3(-hw, wallTopY, FLARE_Z));
    this.addTurret(new Vector3(hw, wallTopY, FLARE_Z));
    this.addTurret(new Vector3(-fhw, wallTopY, frontZ));
    this.addTurret(new Vector3(fhw, wallTopY, frontZ));

    // ── Arch over side wall openings ─────────────────────────────────────
    const { FRONT_OPENING_CENTER, FRONT_OPENING_SIZE, FRONT_OPENING_Y } = SCENE_CONFIG.SIDE_WALLS;
    const dx = fhw - hw;
    const yAngle = Math.atan2(dx, flareDepth);
    const tCenter = FRONT_OPENING_CENTER;
    const openX = hw + tCenter * dx;
    const openZ = FLARE_Z + tCenter * flareDepth;
    const archTopY = FRONT_OPENING_Y + FRONT_OPENING_SIZE / 2;

    this.addArch(new Vector3(-openX, archTopY, openZ), -yAngle);
    this.addArch(new Vector3(openX, archTopY, openZ), yAngle);

    console.log("  ✓ Castle decorations created (stone reskin + battlements + turrets)");
  }

  // ── Decoration builders ────────────────────────────────────────────────────

  private addMerlonsAlongLine(
    parent: TransformNode, start: Vector3, end: Vector3, wallDepth: number,
  ): void {
    const dir = end.subtract(start);
    const length = dir.length();
    if (length < MERLON_STEP) return;

    const norm = dir.normalize();
    const count = Math.floor(length / MERLON_STEP);
    const offset = (length - count * MERLON_STEP + MERLON_W) / 2;
    const yRot = Math.atan2(norm.x, norm.z);

    for (let i = 0; i < count; i++) {
      const t = offset + i * MERLON_STEP;
      const pos = start.add(norm.scale(t));

      const merlon = MeshBuilder.CreateBox(
        `merlon_${parent.name}_${i}`,
        { width: MERLON_W, height: MERLON_H, depth: wallDepth },
        this.scene,
      );
      merlon.position = new Vector3(pos.x, pos.y + MERLON_H / 2, pos.z);
      merlon.rotation.y = yRot;
      merlon.material = this.decoMat;
      merlon.isPickable = false;
      merlon.parent = parent;
    }
  }

  private addTurret(base: Vector3): void {
    const turretGroup = new TransformNode(
      `turret_${base.x.toFixed(2)}_${base.z.toFixed(2)}`, this.scene);
    turretGroup.position = base.clone();
    turretGroup.parent = this.group;

    const body = MeshBuilder.CreateCylinder("turretBody",
      { diameter: TURRET_R * 2, height: TURRET_H, tessellation: TURRET_TESS }, this.scene);
    body.position.y = TURRET_H / 2;
    body.material = this.decoMat;
    body.isPickable = false;
    body.parent = turretGroup;

    const roof = MeshBuilder.CreateCylinder("turretRoof",
      { diameterTop: 0, diameterBottom: ROOF_R * 2, height: ROOF_H, tessellation: TURRET_TESS }, this.scene);
    roof.position.y = TURRET_H + ROOF_H / 2;
    roof.material = this.roofMat;
    roof.isPickable = false;
    roof.parent = turretGroup;

    // Mini merlons ring
    const merlonCount = 4;
    for (let i = 0; i < merlonCount; i++) {
      const angle = (i / merlonCount) * Math.PI * 2;
      const mx = Math.cos(angle) * TURRET_R;
      const mz = Math.sin(angle) * TURRET_R;

      const mini = MeshBuilder.CreateBox(`turretMerlon_${i}`,
        { width: 0.018, height: 0.028, depth: 0.018 }, this.scene);
      mini.position = new Vector3(mx, TURRET_H, mz);
      mini.material = this.decoMat;
      mini.isPickable = false;
      mini.parent = turretGroup;
    }
  }

  private addArch(position: Vector3, yRotation: number): void {
    const arch = MeshBuilder.CreateTorus("arch",
      { diameter: ARCH_R * 2, thickness: ARCH_THICKNESS, tessellation: 24 }, this.scene);
    arch.position = position.clone();
    arch.rotation.y = yRotation;
    arch.material = this.decoMat;
    arch.isPickable = false;
    arch.parent = this.group;
  }

  dispose(): void {
    this.group.dispose(false, true);
  }
}
