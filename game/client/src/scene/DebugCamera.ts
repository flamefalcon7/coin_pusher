import { Camera, Vector3 } from "@babylonjs/core";
import type { ArcRotateCamera, Engine } from "@babylonjs/core";
import { SCENE_CONFIG } from "@coin-pusher/shared";
import type { DebugCameraPreset } from "./DebugReadout";

/**
 * Deterministic debug camera presets (R2, agent-perception plan).
 * top/front/side are orthographic so screenshots are comparable across runs;
 * "default" restores the player camera exactly as CameraSetup configured it.
 * Debug-only — constructed alongside DebugReadout behind `?debug=1`.
 */

interface SavedCameraState {
  alpha: number;
  beta: number;
  radius: number;
  target: Vector3;
  mode: number;
  lowerAlphaLimit: number | null;
  upperAlphaLimit: number | null;
  lowerBetaLimit: number | null;
  upperBetaLimit: number | null;
  lowerRadiusLimit: number | null;
  upperRadiusLimit: number | null;
}

/** Half-width (m) of the orthographic view volume; frames the whole table. */
const ORTHO_HALF_WIDTH = 1.5;

export class DebugCameraController {
  private saved: SavedCameraState;

  constructor(
    private readonly engine: Pick<Engine, "getAspectRatio">,
    private readonly camera: ArcRotateCamera,
  ) {
    this.saved = {
      alpha: camera.alpha,
      beta: camera.beta,
      radius: camera.radius,
      target: camera.target.clone(),
      mode: camera.mode,
      lowerAlphaLimit: camera.lowerAlphaLimit,
      upperAlphaLimit: camera.upperAlphaLimit,
      lowerBetaLimit: camera.lowerBetaLimit,
      upperBetaLimit: camera.upperBetaLimit,
      lowerRadiusLimit: camera.lowerRadiusLimit,
      upperRadiusLimit: camera.upperRadiusLimit,
    };
  }

  applyPreset(preset: DebugCameraPreset): void {
    const platformTopY =
      SCENE_CONFIG.PLATFORM.POSITION.y + SCENE_CONFIG.PLATFORM.THICKNESS / 2;
    const platformZ = SCENE_CONFIG.PLATFORM.POSITION.z;
    // Elevation for the horizontal (front/side) presets: the back-wall center,
    // a documented landmark that sits mid-play-volume so the table stays framed.
    // Config-derived (spatial-contract: never hardcode world coordinates).
    const midY = SCENE_CONFIG.BACK_WALL.POSITION.y;

    if (preset === "default") {
      this.restoreDefault();
      return;
    }

    // Free the camera from player-mode limits while a debug preset is active.
    this.camera.lowerAlphaLimit = null;
    this.camera.upperAlphaLimit = null;
    this.camera.lowerBetaLimit = null;
    this.camera.upperBetaLimit = null;
    this.camera.lowerRadiusLimit = null;
    this.camera.upperRadiusLimit = null;

    // setTarget FIRST: ArcRotateCamera.setTarget rebuilds alpha/beta/radius
    // from the current position, so angles assigned before it are lost.
    switch (preset) {
      case "top":
        // Straight down; -Z (back wall) at the top of the screen.
        this.camera.setTarget(new Vector3(0, platformTopY, platformZ));
        this.camera.alpha = Math.PI / 2;
        this.camera.beta = 0.01; // avoid the beta=0 singularity
        break;
      case "front":
        // From +Z (player side) looking toward the back wall.
        this.camera.setTarget(new Vector3(0, midY, platformZ));
        this.camera.alpha = Math.PI / 2;
        this.camera.beta = Math.PI / 2;
        break;
      case "side":
        // From +X (player's right) looking across the table.
        this.camera.setTarget(new Vector3(0, midY, platformZ));
        this.camera.alpha = 0;
        this.camera.beta = Math.PI / 2;
        break;
    }
    this.camera.radius = this.saved.radius;

    this.applyOrtho();
  }

  private applyOrtho(): void {
    const aspect = this.engine.getAspectRatio(this.camera);
    const halfW = ORTHO_HALF_WIDTH;
    const halfH = halfW / (aspect || 1);
    this.camera.mode = Camera.ORTHOGRAPHIC_CAMERA;
    this.camera.orthoLeft = -halfW;
    this.camera.orthoRight = halfW;
    this.camera.orthoTop = halfH;
    this.camera.orthoBottom = -halfH;
  }

  private restoreDefault(): void {
    const s = this.saved;
    this.camera.mode = s.mode;
    this.camera.orthoLeft = null;
    this.camera.orthoRight = null;
    this.camera.orthoTop = null;
    this.camera.orthoBottom = null;
    // setTarget first — it rebuilds alpha/beta/radius (see applyPreset).
    this.camera.setTarget(s.target.clone());
    this.camera.alpha = s.alpha;
    this.camera.beta = s.beta;
    this.camera.radius = s.radius;
    this.camera.lowerAlphaLimit = s.lowerAlphaLimit;
    this.camera.upperAlphaLimit = s.upperAlphaLimit;
    this.camera.lowerBetaLimit = s.lowerBetaLimit;
    this.camera.upperBetaLimit = s.upperBetaLimit;
    this.camera.lowerRadiusLimit = s.lowerRadiusLimit;
    this.camera.upperRadiusLimit = s.upperRadiusLimit;
  }
}
