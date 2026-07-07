import GUI from "lil-gui";
import type { Scene } from "@babylonjs/core";
import { SCENE_CONFIG } from "@coin-pusher/shared";
import {
  collectNumericLeaves,
  buildTuningExport,
  diffTuningParams,
} from "./tuningExport";
import { debugSetParam } from "./debugParamSet";

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

/** debugSetParam, but tolerant: absent nodes just skip the live preview. */
function applyParam(scene: Scene, path: string, value: number): void {
  try {
    debugSetParam(scene, path, value);
  } catch {
    // Node not present in this scene variant — slider still records the value.
  }
}

const LIVE_APPLY: Record<string, LiveApplyFn> = {
  "PLATFORM.POSITION.x": (s, v) => applyParam(s, "platformGroup.position.x", v),
  "PLATFORM.POSITION.y": (s, v) => applyParam(s, "platformGroup.position.y", v),
  "PLATFORM.POSITION.z": (s, v) => applyParam(s, "platformGroup.position.z", v),
  "BACK_WALL.POSITION.x": (s, v) => applyParam(s, "backWallGroup.position.x", v),
  "BACK_WALL.POSITION.y": (s, v) => applyParam(s, "backWallGroup.position.y", v),
  "BACK_WALL.POSITION.z": (s, v) => applyParam(s, "backWallGroup.position.z", v),
  "BACK_WALL.TILT_ANGLE": (s, v) =>
    applyParam(s, "backWallGroup.rotation.x", (v * Math.PI) / 180),
  "SIDE_WALLS.LEFT_POSITION.x": (s, v) => applyParam(s, "leftWallBack.position.x", v),
  "SIDE_WALLS.LEFT_POSITION.y": (s, v) => {
    applyParam(s, "leftWallBack.position.y", v);
    applyParam(s, "leftWallFront.position.y", v);
  },
  "SIDE_WALLS.RIGHT_POSITION.x": (s, v) => applyParam(s, "rightWallBack.position.x", v),
  "SIDE_WALLS.RIGHT_POSITION.y": (s, v) => {
    applyParam(s, "rightWallBack.position.y", v);
    applyParam(s, "rightWallFront.position.y", v);
  },
  "PUSHER.POSITION.x": (s, v) => applyParam(s, "pusher.position.x", v),
  "PUSHER.POSITION.y": (s, v) => applyParam(s, "pusher.position.y", v),
};

export class SceneDebugGUI {
  private gui: GUI;
  private readonly original = new Map<string, number>();
  private readonly current = new Map<string, number>();

  constructor(
    private readonly scene: Scene,
    private readonly setWireframe: (on: boolean) => void = () => {},
  ) {
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

    // LIVE_APPLY keys are free-form strings; catch drift against SCENE_CONFIG
    // renames at construction (debug-only, so a warn is enough).
    for (const key of Object.keys(LIVE_APPLY)) {
      if (!this.original.has(key)) {
        console.warn(`SceneDebugGUI: LIVE_APPLY key "${key}" is not a SCENE_CONFIG leaf`);
      }
    }

    const controls = {
      "collider wireframes": false,
      "export changes": () => this.exportChanges(),
    };
    this.gui
      .add(controls, "collider wireframes")
      .onChange((v: boolean) => this.setWireframe(v));
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
