import { Color4 } from "@babylonjs/core";
import type { Scene, AbstractMesh } from "@babylonjs/core";

/**
 * Isolated render mode (R6, agent-perception plan).
 *
 * `__coinpusher_debug.isolate(name)` hides every mesh except the target
 * (mesh or transform node, including its descendants) and swaps the clear
 * color to neutral gray — combined with the R2 camera presets this gives
 * clean VFX/billboard acceptance screenshots without scene noise.
 * `isolate(null)` restores every saved state; leak test proves no residue.
 */

const NEUTRAL_BACKGROUND = new Color4(0.5, 0.5, 0.5, 1);

interface SavedMeshState {
  mesh: AbstractMesh;
  enabled: boolean;
}

export class IsolateMode {
  private savedMeshes: SavedMeshState[] = [];
  private savedClearColor: Color4 | null = null;
  private active = false;

  constructor(private readonly scene: Scene) {}

  isolate(meshName: string | null): void {
    // Always restore first so switching targets never stacks saved state.
    this.restore();
    if (meshName === null) return;

    const target =
      (this.scene.getMeshByName?.(meshName) as AbstractMesh | null) ??
      (this.scene.getTransformNodeByName?.(meshName) as unknown as AbstractMesh | null);
    if (!target) {
      throw new Error(`debug.isolate: no mesh or transform node named "${meshName}"`);
    }

    const keep = new Set<unknown>([target]);
    const descendants = (target as { getDescendants?: () => unknown[] }).getDescendants?.() ?? [];
    for (const d of descendants) keep.add(d);

    for (const mesh of this.scene.meshes ?? []) {
      if (keep.has(mesh)) continue;
      this.savedMeshes.push({ mesh, enabled: mesh.isEnabled?.() ?? true });
      mesh.setEnabled(false);
    }

    this.savedClearColor = this.scene.clearColor;
    this.scene.clearColor = NEUTRAL_BACKGROUND;
    this.active = true;
  }

  isActive(): boolean {
    return this.active;
  }

  /** Number of meshes currently hidden (for leak tests). */
  getSavedStateCount(): number {
    return this.savedMeshes.length;
  }

  private restore(): void {
    for (const { mesh, enabled } of this.savedMeshes) {
      mesh.setEnabled?.(enabled);
    }
    this.savedMeshes = [];
    if (this.savedClearColor !== null) {
      this.scene.clearColor = this.savedClearColor;
      this.savedClearColor = null;
    }
    this.active = false;
  }

  dispose(): void {
    this.restore();
  }
}
