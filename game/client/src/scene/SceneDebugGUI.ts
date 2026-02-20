import GUI from "lil-gui";
import { SceneManager } from "./SceneManager";
import { SCENE_CONFIG } from "@coin-pusher/shared";
import type { WallOverrides } from "./StaticMeshes";

export class SceneDebugGUI {
  private gui: GUI;

  constructor(sceneManager: SceneManager) {
    this.gui = new GUI({ title: "Scene Debug" });

    const defaults = SCENE_CONFIG.SIDE_WALLS;
    const params: Required<WallOverrides> = {
      ARC_BULGE: defaults.ARC_BULGE,
      ARC_SEGMENTS: defaults.ARC_SEGMENTS,
      HEIGHT: defaults.HEIGHT,
      THICKNESS: defaults.THICKNESS,
      INNER_TILT_ANGLE: defaults.INNER_TILT_ANGLE,
    };

    const rebuild = () => sceneManager.rebuildWalls({ ...params });

    const folder = this.gui.addFolder("Side Walls");
    folder.add(params, "ARC_BULGE", 0, 0.4, 0.01).onChange(rebuild);
    folder.add(params, "ARC_SEGMENTS", 2, 16, 1).onChange(rebuild);
    folder.add(params, "HEIGHT", 0.5, 3.0, 0.1).onChange(rebuild);
    folder.add(params, "THICKNESS", 0.01, 0.15, 0.005).onChange(rebuild);
    folder.add(params, "INNER_TILT_ANGLE", 0, 10, 0.5).onChange(rebuild);
    folder.open();
  }

  dispose(): void {
    this.gui.destroy();
  }
}
