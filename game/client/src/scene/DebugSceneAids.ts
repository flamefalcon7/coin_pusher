import { MeshBuilder, Color3, Vector3 } from "@babylonjs/core";
import type { Scene, LinesMesh } from "@babylonjs/core";
import { SCENE_CONFIG } from "@coin-pusher/shared";

/**
 * Debug-only visual aids (R2.2, agent-perception plan): an RGB=XYZ axis gizmo
 * plus a 0.1 m grid on the platform top, so any debug screenshot
 * self-documents orientation (see spatial-contract.md). Constructed alongside
 * DebugReadout behind `?debug=1` — zero footprint otherwise.
 */

const AXIS_LENGTH = 0.4;
const GRID_STEP = 0.1;

export class DebugSceneAids {
  private meshes: LinesMesh[] = [];

  constructor(private readonly scene: Scene) {
    const topY =
      SCENE_CONFIG.PLATFORM.POSITION.y + SCENE_CONFIG.PLATFORM.THICKNESS / 2;
    const centerZ = SCENE_CONFIG.PLATFORM.POSITION.z;

    // Axis gizmo anchored at the platform-top center so it's never buried.
    const oy = topY + 0.001;
    const origin = new Vector3(0, oy, centerZ);
    this.addLine("debugAxisX", origin, new Vector3(AXIS_LENGTH, oy, centerZ), new Color3(1, 0.1, 0.1));
    this.addLine("debugAxisY", origin, new Vector3(0, oy + AXIS_LENGTH, centerZ), new Color3(0.1, 1, 0.1));
    this.addLine("debugAxisZ", origin, new Vector3(0, oy, centerZ + AXIS_LENGTH), new Color3(0.15, 0.4, 1));

    this.createPlatformGrid(topY);
  }

  private addLine(name: string, origin: Vector3, end: Vector3, color: Color3): void {
    const line = MeshBuilder.CreateLines(
      name,
      { points: [origin, end] },
      this.scene,
    );
    line.color = color;
    line.isPickable = false;
    this.meshes.push(line);
  }

  private createPlatformGrid(topY: number): void {
    const { POSITION, DEPTH } = SCENE_CONFIG.PLATFORM;
    const { LEFT_POSITION, RIGHT_POSITION, THICKNESS } = SCENE_CONFIG.SIDE_WALLS;

    const y = topY + 0.0005;
    const minX = LEFT_POSITION.x - THICKNESS / 2;
    const maxX = RIGHT_POSITION.x + THICKNESS / 2;
    const minZ = POSITION.z - DEPTH / 2;
    const maxZ = POSITION.z + DEPTH / 2 + GRID_STEP; // include the front lip

    const lines: Vector3[][] = [];
    for (let x = minX; x <= maxX + 1e-6; x += GRID_STEP) {
      lines.push([new Vector3(x, y, minZ), new Vector3(x, y, maxZ)]);
    }
    for (let z = minZ; z <= maxZ + 1e-6; z += GRID_STEP) {
      lines.push([new Vector3(minX, y, z), new Vector3(maxX, y, z)]);
    }

    const grid = MeshBuilder.CreateLineSystem("debugPlatformGrid", { lines }, this.scene);
    grid.color = new Color3(0.45, 0.45, 0.5);
    grid.isPickable = false;
    this.meshes.push(grid);
  }

  /** Number of live aid meshes (for leak tests). */
  getMeshCount(): number {
    return this.meshes.length;
  }

  dispose(): void {
    for (const mesh of this.meshes) {
      mesh.dispose();
    }
    this.meshes = [];
  }
}
