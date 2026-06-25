import { SceneInstrumentation } from "@babylonjs/core";
import type { Scene, Engine } from "@babylonjs/core";
import type { VFXManager } from "./VFXManager";
import { isDebugEnabled } from "../net/debugConfig";

/**
 * Read-only runtime counters exposed on `window.__coinpusher_debug` so the AI
 * agent (via Chrome DevTools MCP) can read ground-truth numbers instead of
 * asking a human to eyeball the frame. See WS5 / self-verification skill.
 *
 * Only installed when `?debug=1` — never present in a normal session.
 */
export interface DebugSnapshot {
  /** Smoothed frames per second (engine.getFps). */
  fps: number;
  /** Draw calls this frame (SceneInstrumentation.drawCallsCounter). */
  drawCalls: number;
  /** Total meshes in the scene graph. */
  meshes: number;
  /** Active coin thin-instances (CoinMeshManager.getCoinCount). */
  activeCoins: number;
  /** Active VFX burst particle systems (VFXManager.getActiveBurstCount). */
  activeBursts: number;
}

declare global {
  interface Window {
    __coinpusher_debug?: DebugSnapshot;
  }
}

/** The minimal surface DebugReadout needs — keeps it decoupled + testable. */
export interface DebugReadoutSources {
  engine: Pick<Engine, "getFps">;
  scene: Scene;
  vfx: Pick<VFXManager, "getActiveBurstCount">;
  getCoinCount: () => number;
}

export class DebugReadout {
  private readonly instrumentation: SceneInstrumentation;
  private observer: ReturnType<Scene["onAfterRenderObservable"]["add"]> | null;
  // A single mutable object refreshed in place — window.__coinpusher_debug
  // always points at the latest values.
  private readonly snapshot: DebugSnapshot = {
    fps: 0,
    drawCalls: 0,
    meshes: 0,
    activeCoins: 0,
    activeBursts: 0,
  };

  constructor(private readonly sources: DebugReadoutSources) {
    this.instrumentation = new SceneInstrumentation(sources.scene);
    window.__coinpusher_debug = this.snapshot;
    this.observer = sources.scene.onAfterRenderObservable.add(() => this.refresh());
  }

  private refresh(): void {
    const { engine, scene, vfx, getCoinCount } = this.sources;
    this.snapshot.fps = Math.round(engine.getFps());
    this.snapshot.drawCalls = this.instrumentation.drawCallsCounter.current;
    this.snapshot.meshes = scene.meshes.length;
    this.snapshot.activeCoins = getCoinCount();
    this.snapshot.activeBursts = vfx.getActiveBurstCount();
  }

  dispose(): void {
    if (this.observer) {
      this.sources.scene.onAfterRenderObservable.remove(this.observer);
      this.observer = null;
    }
    this.instrumentation.dispose();
    if (typeof window !== "undefined") {
      delete window.__coinpusher_debug;
    }
  }
}

/** Install the HUD only when `?debug=1`. Returns null otherwise (no surface). */
export function maybeInstallDebugReadout(
  sources: DebugReadoutSources,
): DebugReadout | null {
  if (!isDebugEnabled()) return null;
  return new DebugReadout(sources);
}
