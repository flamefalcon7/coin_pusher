import { SceneInstrumentation } from "@babylonjs/core";
import type { Scene, Engine } from "@babylonjs/core";
import type { StackType } from "@coin-pusher/shared";
import type { VFXManager } from "./VFXManager";
import type { SceneDump } from "./DebugDump";
import { isDebugEnabled } from "../net/debugConfig";

/**
 * Runtime debug API exposed on `window.__coinpusher_debug` so the AI agent
 * (via Chrome DevTools MCP) can read ground-truth numbers and inject actions
 * instead of asking a human to eyeball the frame. See WS5 / self-verification
 * skill and the agent-perception plan (docs/archive/plans/2026-07-07-001).
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

/** Ability names accepted by action injection (both wire and camel casing). */
export type DebugAbilityName =
  | "shock"
  | "tornado"
  | "explosion"
  | "lightning"
  | "superPush"
  | "super_push";

/**
 * Result of an injected action so an agent can detect a no-op (disconnected,
 * on cooldown, unknown name) without a follow-up dump()/screenshot round-trip.
 */
export interface DebugActionResult {
  ok: boolean;
  reason?: string;
}

/** Agent action injection (R5) — same client code paths as the real UI. */
export interface DebugActions {
  /** Insert `count` coins at slot 0-4 (default: center slot, 1 coin). */
  insertCoin(slot?: number, count?: number): DebugActionResult;
  /** Trigger an ability; x/z used by targeted abilities (tornado/explosion). */
  triggerAbility(name: DebugAbilityName, x?: number, z?: number): DebugActionResult;
  /** Spawn a shaped coin stack (admin, server-enforced) for scene setup. */
  spawnStack(type: StackType, x?: number): DebugActionResult;
  /** Clear the board (admin, server-enforced) — resets between test loops. */
  clearAll(): DebugActionResult;
  /** Saturate the platform (admin, server-enforced) for stress screenshots. */
  fillPlatform(): DebugActionResult;
}

export type DebugCameraPreset = "top" | "front" | "side" | "default";

/**
 * The full debug surface: live counters (refreshed in place per frame by
 * DebugReadout) plus capabilities installed later via `extendDebugApi` by the
 * modules that own them (dump/actions from App, camera/wireframe/isolate/set
 * from the scene layer).
 */
export interface CoinPusherDebugApi extends DebugSnapshot {
  /** Structured scene state (R1). */
  dump?: () => SceneDump;
  /** Deterministic debug camera presets (R2). */
  camera?: (preset: DebugCameraPreset) => void;
  /** Rapier collider wireframe overlay toggle (R3). */
  wireframe?: (on: boolean) => void;
  /** Action injection (R5). */
  actions?: DebugActions;
  /** Isolated render mode; pass null to restore (R6). */
  isolate?: (meshName: string | null) => void;
  /** Set a client-visual parameter by path; returns the previous value (R7). */
  set?: (path: string, value: unknown) => unknown;
}

declare global {
  interface Window {
    __coinpusher_debug?: CoinPusherDebugApi;
  }
}

/**
 * Attach capabilities to the debug surface. No-op when the surface is absent
 * (i.e. not `?debug=1`), so callers never need their own debug gate.
 */
export function extendDebugApi(ext: Partial<CoinPusherDebugApi>): void {
  if (typeof window === "undefined" || !window.__coinpusher_debug) return;
  Object.assign(window.__coinpusher_debug, ext);
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
