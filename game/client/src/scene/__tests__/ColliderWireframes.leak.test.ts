import { describe, it, expect, vi } from "vitest";

vi.mock("@babylonjs/core", async () => {
  const { createBabylonCoreMock } = await import("./leakHarness");
  return createBabylonCoreMock();
});

import { ColliderWireframes, MAX_COIN_WIREFRAMES } from "../ColliderWireframes";
import { createMockScene } from "./leakHarness";
import { SCENE_CONFIG, PUSHER_CONFIG } from "@coin-pusher/shared";

/** Sum local positions up the parent chain (rotation-agnostic → OK for centers). */
function worldPos(mesh: any): { x: number; y: number; z: number } {
  let x = 0, y = 0, z = 0;
  for (let node: any = mesh; node; node = node.parent) {
    if (node.position) {
      x += node.position.x ?? 0;
      y += node.position.y ?? 0;
      z += node.position.z ?? 0;
    }
  }
  return { x, y, z };
}

function findStatic(wf: ColliderWireframes, name: string): any {
  return (wf as any).staticMeshes.find((m: any) => m.name === name);
}

function makeCoins(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    id: i,
    pos: [0, 0.3, 0] as [number, number, number],
    rot: [0, 0, 0, 1] as [number, number, number, number],
  }));
}

/** Fire the onBeforeRender callback the overlay registered. */
function tick(scene: any): void {
  const cb = scene.onBeforeRenderObservable.add.mock.calls[0][0];
  cb();
}

describe("ColliderWireframes", () => {
  it("builds static wireframes for every server collider group", () => {
    const scene = createMockScene();
    const wf = new ColliderWireframes(scene);

    // platform (1 box + 6 flare prisms + lip) + back wall slab + 27 pins
    // + 2 side-wall back segments + 2×4 opening-frame strips + pusher envelope
    expect(wf.getStaticMeshCount()).toBe(47);
    expect(wf.getCoinPoolSize()).toBe(0);

    wf.dispose();
  });

  it("places key collider landmarks at their SCENE_CONFIG positions (drift guard)", () => {
    // Count-only assertions can't catch a sign flip or offset in the
    // SceneBuilder-mirroring math — which would defeat the overlay's whole
    // purpose (showing rendered-vs-physical drift). Pin the landmarks.
    const scene = createMockScene();
    const wf = new ColliderWireframes(scene);

    const platform = worldPos(findStatic(wf, "wf_platform_center"));
    expect(platform.x).toBeCloseTo(SCENE_CONFIG.PLATFORM.POSITION.x);
    expect(platform.y).toBeCloseTo(SCENE_CONFIG.PLATFORM.POSITION.y);
    expect(platform.z).toBeCloseTo(SCENE_CONFIG.PLATFORM.POSITION.z);

    const backWall = worldPos(findStatic(wf, "wf_backWall_slab"));
    expect(backWall.x).toBeCloseTo(SCENE_CONFIG.BACK_WALL.POSITION.x);
    expect(backWall.y).toBeCloseTo(SCENE_CONFIG.BACK_WALL.POSITION.y);
    expect(backWall.z).toBeCloseTo(SCENE_CONFIG.BACK_WALL.POSITION.z);

    // Side-wall back segments sit at x = ±0.6 (catches an x-sign flip).
    expect(worldPos(findStatic(wf, "wf_sideWall_L_back")).x).toBeCloseTo(
      SCENE_CONFIG.SIDE_WALLS.LEFT_POSITION.x,
    );
    expect(worldPos(findStatic(wf, "wf_sideWall_R_back")).x).toBeCloseTo(
      SCENE_CONFIG.SIDE_WALLS.RIGHT_POSITION.x,
    );

    // Pusher envelope is centered on the config pos shifted by Z_OFFSET.
    const envelope = worldPos(findStatic(wf, "wf_pusherEnvelope"));
    expect(envelope.x).toBeCloseTo(SCENE_CONFIG.PUSHER.POSITION.x);
    expect(envelope.z).toBeCloseTo(SCENE_CONFIG.PUSHER.POSITION.z + PUSHER_CONFIG.Z_OFFSET);

    wf.dispose();
  });

  it("is hidden by default and toggles via setVisible", () => {
    const scene = createMockScene();
    const wf = new ColliderWireframes(scene);
    expect(wf.isVisible()).toBe(false);

    wf.setVisible(true);
    expect(wf.isVisible()).toBe(true);
    wf.setVisible(false);
    expect(wf.isVisible()).toBe(false);

    wf.dispose();
  });

  it(`caps the dynamic coin pool at ${MAX_COIN_WIREFRAMES} (perf guard)`, () => {
    const scene = createMockScene();
    const wf = new ColliderWireframes(scene);
    let serverTime = 0;
    wf.setPoseProvider(() => ({ serverTime: ++serverTime, pusherZ: -0.5, coins: makeCoins(50) }));
    wf.setVisible(true);

    for (let i = 0; i < 10; i++) tick(scene);

    expect(wf.getCoinPoolSize()).toBe(MAX_COIN_WIREFRAMES);
    wf.dispose();
  });

  it("disables surplus pool coins when the network count drops", () => {
    const scene = createMockScene();
    const wf = new ColliderWireframes(scene);
    let serverTime = 0;
    let coins = makeCoins(10);
    wf.setPoseProvider(() => ({ serverTime: ++serverTime, pusherZ: -0.5, coins }));
    wf.setVisible(true);

    tick(scene);
    expect(wf.getCoinPoolSize()).toBe(10);

    coins = makeCoins(3);
    tick(scene);

    const pool = (wf as any).coinPool;
    expect(pool.filter((m: any) => m.isEnabled()).length).toBe(3);
    expect(wf.getCoinPoolSize()).toBe(10); // pool retained, not leaked-grown

    wf.dispose();
  });

  it("skips dynamic rewrites while the server tick hasn't advanced (no-op guard)", () => {
    const scene = createMockScene();
    const wf = new ColliderWireframes(scene);
    let coins = makeCoins(1);
    wf.setPoseProvider(() => ({ serverTime: 1000, pusherZ: -0.5, coins }));
    wf.setVisible(true);

    tick(scene);
    coins = makeCoins(5); // same serverTime → stale state must be ignored
    tick(scene);
    expect(wf.getCoinPoolSize()).toBe(1);

    wf.setVisible(true); // toggling visibility re-syncs even without a new tick
    tick(scene);
    expect(wf.getCoinPoolSize()).toBe(5);

    wf.dispose();
  });

  it("does not update dynamic bodies while hidden", () => {
    const scene = createMockScene();
    const wf = new ColliderWireframes(scene);
    wf.setPoseProvider(() => ({ serverTime: 1, pusherZ: -0.5, coins: makeCoins(5) }));

    tick(scene); // visible=false → no pool growth
    expect(wf.getCoinPoolSize()).toBe(0);

    wf.dispose();
  });

  it("dispose leaves no residue: counters at zero, observer removed, double-dispose safe (leak test)", () => {
    const scene = createMockScene();
    const wf = new ColliderWireframes(scene);
    wf.setPoseProvider(() => ({ serverTime: 1, pusherZ: -0.5, coins: makeCoins(30) }));
    wf.setVisible(true);
    tick(scene);

    const staticSpies = (wf as any).staticMeshes.map((m: any) => vi.spyOn(m, "dispose"));
    const coinSpies = (wf as any).coinPool.map((m: any) => vi.spyOn(m, "dispose"));

    wf.dispose();

    expect(wf.getStaticMeshCount()).toBe(0);
    expect(wf.getCoinPoolSize()).toBe(0);
    expect(scene.onBeforeRenderObservable.remove).toHaveBeenCalled();
    for (const spy of [...staticSpies, ...coinSpies]) expect(spy).toHaveBeenCalledTimes(1);

    expect(() => wf.dispose()).not.toThrow();
  });
});
