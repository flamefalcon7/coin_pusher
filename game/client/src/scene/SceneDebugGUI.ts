import GUI from "lil-gui";
import type { Scene } from "@babylonjs/core";
import { SCENE_CONFIG } from "@coin-pusher/shared";
import {
  collectNumericLeaves,
  buildTuningExport,
  diffTuningParams,
} from "./tuningExport";

/**
 * Tuning HUD (R4, agent-perception plan): lil-gui sliders over the numeric
 * leaves of SCENE_CONFIG. The human does the last 10% by direct manipulation;
 * "Export changes" copies a ready-to-paste snippet (changed constants only,
 * old → new in comments) so mm-level tuning never goes through text
 * description. Live-apply moves client meshes only — physics stays
 * server-authoritative (restart-based loop; see plan scope boundaries).
 *
 * Debug-only: constructed from App behind the ?debug=1 gate.
 */

const SECTIONS = ["PLATFORM", "BACK_WALL", "SIDE_WALLS", "PINS", "PUSHER"] as const;

/** Config paths that can be previewed live on client meshes. */
type LiveApplyFn = (scene: Scene, value: number) => void;

function moveNode(scene: Scene, name: string, axis: "x" | "y" | "z", value: number): void {
  const node =
    (scene.getTransformNodeByName?.(name) as { position?: Record<string, number> } | null) ??
    (scene.getMeshByName?.(name) as { position?: Record<string, number> } | null);
  if (node?.position) node.position[axis] = value;
}

const LIVE_APPLY: Record<string, LiveApplyFn> = {
  "PLATFORM.POSITION.x": (s, v) => moveNode(s, "platformGroup", "x", v),
  "PLATFORM.POSITION.y": (s, v) => moveNode(s, "platformGroup", "y", v),
  "PLATFORM.POSITION.z": (s, v) => moveNode(s, "platformGroup", "z", v),
  "BACK_WALL.POSITION.x": (s, v) => moveNode(s, "backWallGroup", "x", v),
  "BACK_WALL.POSITION.y": (s, v) => moveNode(s, "backWallGroup", "y", v),
  "BACK_WALL.POSITION.z": (s, v) => moveNode(s, "backWallGroup", "z", v),
  "BACK_WALL.TILT_ANGLE": (s, v) => {
    const node = s.getTransformNodeByName?.("backWallGroup") as
      | { rotation?: { x: number } }
      | null;
    if (node?.rotation) node.rotation.x = (v * Math.PI) / 180;
  },
  "SIDE_WALLS.LEFT_POSITION.x": (s, v) => moveNode(s, "leftWallBack", "x", v),
  "SIDE_WALLS.LEFT_POSITION.y": (s, v) => {
    moveNode(s, "leftWallBack", "y", v);
    moveNode(s, "leftWallFront", "y", v);
  },
  "SIDE_WALLS.RIGHT_POSITION.x": (s, v) => moveNode(s, "rightWallBack", "x", v),
  "SIDE_WALLS.RIGHT_POSITION.y": (s, v) => {
    moveNode(s, "rightWallBack", "y", v);
    moveNode(s, "rightWallFront", "y", v);
  },
  "PUSHER.POSITION.x": (s, v) => moveNode(s, "pusher", "x", v),
  "PUSHER.POSITION.y": (s, v) => moveNode(s, "pusher", "y", v),
};

export class SceneDebugGUI {
  private gui: GUI;
  private readonly original = new Map<string, number>();
  private readonly current = new Map<string, number>();

  constructor(private readonly scene: Scene) {
    this.gui = new GUI({ title: "Scene Tuning" });

    for (const section of SECTIONS) {
      const folder = this.gui.addFolder(section);
      const leaves = collectNumericLeaves(
        SCENE_CONFIG[section] as unknown as Record<string, unknown>,
      );

      for (const leaf of leaves) {
        const fullPath = `${section}.${leaf.path}`;
        this.original.set(fullPath, leaf.value);
        this.current.set(fullPath, leaf.value);

        const proxy = { [leaf.path]: leaf.value };
        const span = Math.max(0.3, Math.abs(leaf.value) * 2);
        folder
          .add(proxy, leaf.path, leaf.value - span, leaf.value + span, span / 200)
          .onChange((v: number) => {
            this.current.set(fullPath, v);
            LIVE_APPLY[fullPath]?.(this.scene, v);
          });
      }
      folder.close();
    }

    const controls = {
      "collider wireframes": false,
      "export changes": () => this.exportChanges(),
    };
    this.gui
      .add(controls, "collider wireframes")
      .onChange((v: boolean) => window.__coinpusher_debug?.wireframe?.(v));
    this.gui.add(controls, "export changes");
  }

  /** Changed constants only, as a paste-ready snippet (R4.3). */
  exportChanges(): string {
    const snippet = buildTuningExport(diffTuningParams(this.original, this.current));
    console.log(snippet);
    // Clipboard is best-effort (requires a secure context + user activation).
    void navigator.clipboard?.writeText(snippet).catch(() => {});
    return snippet;
  }

  dispose(): void {
    this.gui.destroy();
  }
}
