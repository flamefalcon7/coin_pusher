import GUI from "lil-gui";
import { SceneManager } from "./SceneManager";
import { SCENE_CONFIG } from "@coin-pusher/shared";

export class SceneDebugGUI {
  private gui: GUI;

  constructor(_sceneManager: SceneManager) {
    this.gui = new GUI({ title: "Scene Debug" });

    const defaults = SCENE_CONFIG.SIDE_WALLS;
    const params = {
      HEIGHT: defaults.HEIGHT,
      THICKNESS: defaults.THICKNESS,
      INNER_TILT_ANGLE: defaults.INNER_TILT_ANGLE,
    };

    // Note: rebuildWalls was removed; this GUI is currently non-functional
    const _rebuild = () => { console.log("Wall rebuild not available", params); };

    const folder = this.gui.addFolder("Side Walls");
    folder.add(params, "HEIGHT", 0.5, 3.0, 0.1).onChange(_rebuild);
    folder.add(params, "THICKNESS", 0.01, 0.15, 0.005).onChange(_rebuild);
    folder.add(params, "INNER_TILT_ANGLE", 0, 10, 0.5).onChange(_rebuild);
    folder.open();
  }

  dispose(): void {
    this.gui.destroy();
  }
}
