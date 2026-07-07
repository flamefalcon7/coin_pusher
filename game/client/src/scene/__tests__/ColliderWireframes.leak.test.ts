import { describe, it, expect, vi } from "vitest";

vi.mock("@babylonjs/core", async () => {
  const { createBabylonCoreMock } = await import("./leakHarness");
  return createBabylonCoreMock();
});

import { ColliderWireframes, MAX_COIN_WIREFRAMES } from "../ColliderWireframes";
import { createMockScene } from "./leakHarness";

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
    wf.setPoseProvider(() => ({ pusherZ: -0.5, coins: makeCoins(50) }));
    wf.setVisible(true);

    for (let i = 0; i < 10; i++) tick(scene);

    expect(wf.getCoinPoolSize()).toBe(MAX_COIN_WIREFRAMES);
    wf.dispose();
  });

  it("disables surplus pool coins when the network count drops", () => {
    const scene = createMockScene();
    const wf = new ColliderWireframes(scene);
    let coins = makeCoins(10);
    wf.setPoseProvider(() => ({ pusherZ: -0.5, coins }));
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

  it("does not update dynamic bodies while hidden", () => {
    const scene = createMockScene();
    const wf = new ColliderWireframes(scene);
    wf.setPoseProvider(() => ({ pusherZ: -0.5, coins: makeCoins(5) }));

    tick(scene); // visible=false → no pool growth
    expect(wf.getCoinPoolSize()).toBe(0);

    wf.dispose();
  });

  it("dispose leaves no residue: counters at zero, observer removed, double-dispose safe (leak test)", () => {
    const scene = createMockScene();
    const wf = new ColliderWireframes(scene);
    wf.setPoseProvider(() => ({ pusherZ: -0.5, coins: makeCoins(30) }));
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
