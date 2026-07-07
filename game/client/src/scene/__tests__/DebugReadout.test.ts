import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ── Module mock (shared idiom — see leakHarness.ts) ─────────────────────

vi.mock("@babylonjs/core", async () => {
  const { createBabylonCoreMock } = await import("./leakHarness");
  return createBabylonCoreMock();
});

import {
  DebugReadout,
  maybeInstallDebugReadout,
  extendDebugApi,
  type DebugReadoutSources,
} from "../DebugReadout";
import { createMockScene } from "./leakHarness";

function makeSources(overrides: Partial<DebugReadoutSources> = {}): DebugReadoutSources {
  return {
    engine: { getFps: () => 60 },
    scene: createMockScene(),
    vfx: { getActiveBurstCount: () => 3 },
    getCoinCount: () => 7,
    ...overrides,
  };
}

/** Invoke the onAfterRender callback the readout registered, to force a refresh. */
function triggerRefresh(scene: any): void {
  const cb = scene.onAfterRenderObservable.add.mock.calls[0][0];
  cb();
}

describe("DebugReadout", () => {
  beforeEach(() => {
    (globalThis as any).window = { location: { search: "?debug=1" } };
  });
  afterEach(() => {
    delete (globalThis as any).window;
  });

  it("exposes all required fields with plausible types after a refresh", () => {
    const sources = makeSources();
    (sources.scene as any).meshes = [{}, {}, {}, {}, {}]; // 5 meshes
    const readout = new DebugReadout(sources);
    triggerRefresh(sources.scene);

    const snap = (globalThis as any).window.__coinpusher_debug;
    expect(snap).toBeDefined();
    for (const key of ["fps", "drawCalls", "meshes", "activeCoins", "activeBursts"]) {
      expect(typeof snap[key]).toBe("number");
    }
    expect(snap.fps).toBe(60);
    expect(snap.meshes).toBe(5);
    expect(snap.activeCoins).toBe(7);
    expect(snap.activeBursts).toBe(3);

    readout.dispose();
  });

  it("reflects changes on subsequent refreshes (live snapshot)", () => {
    let coins = 0;
    const sources = makeSources({ getCoinCount: () => coins });
    const readout = new DebugReadout(sources);

    triggerRefresh(sources.scene);
    expect((globalThis as any).window.__coinpusher_debug.activeCoins).toBe(0);

    coins = 42;
    triggerRefresh(sources.scene);
    expect((globalThis as any).window.__coinpusher_debug.activeCoins).toBe(42);

    readout.dispose();
  });

  it("dispose removes the window surface and the render observer", () => {
    const sources = makeSources();
    const readout = new DebugReadout(sources);
    expect((globalThis as any).window.__coinpusher_debug).toBeDefined();

    readout.dispose();
    expect((globalThis as any).window.__coinpusher_debug).toBeUndefined();
    expect((sources.scene as any).onAfterRenderObservable.remove).toHaveBeenCalled();
  });

  it("maybeInstallDebugReadout installs when ?debug=1", () => {
    const readout = maybeInstallDebugReadout(makeSources());
    expect(readout).not.toBeNull();
    readout?.dispose();
  });

  it("maybeInstallDebugReadout is a no-op (undefined surface) when debug is off", () => {
    (globalThis as any).window = { location: { search: "" } };
    const readout = maybeInstallDebugReadout(makeSources());
    expect(readout).toBeNull();
    expect((globalThis as any).window.__coinpusher_debug).toBeUndefined();
  });
});

describe("extendDebugApi", () => {
  beforeEach(() => {
    (globalThis as any).window = { location: { search: "?debug=1" } };
  });
  afterEach(() => {
    delete (globalThis as any).window;
  });

  it("attaches capabilities onto the live surface (same object identity)", () => {
    const sources = makeSources();
    const readout = new DebugReadout(sources);

    const dump = () => ({ meshes: [] }) as any;
    extendDebugApi({ dump });

    const surface = (globalThis as any).window.__coinpusher_debug;
    expect(surface.dump).toBe(dump);
    // Counters still refresh in place on the extended object
    triggerRefresh(sources.scene);
    expect(surface.fps).toBe(60);

    readout.dispose();
  });

  it("is a no-op when the surface is absent (debug off)", () => {
    delete (globalThis as any).window.__coinpusher_debug;
    expect(() => extendDebugApi({ dump: (() => null) as any })).not.toThrow();
    expect((globalThis as any).window.__coinpusher_debug).toBeUndefined();
  });

  it("extensions disappear with the surface on dispose", () => {
    const readout = new DebugReadout(makeSources());
    extendDebugApi({ wireframe: () => {} });
    readout.dispose();
    expect((globalThis as any).window.__coinpusher_debug).toBeUndefined();
  });
});
