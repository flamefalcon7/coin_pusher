import { describe, it, expect, vi } from "vitest";

vi.mock("@babylonjs/core", async () => {
  const { createBabylonCoreMock } = await import("./leakHarness");
  return createBabylonCoreMock();
});

import { IsolateMode } from "../IsolateMode";
import { MockMesh } from "./leakHarness";

function makeScene() {
  const billboard = new MockMesh("billboard");
  const child = new MockMesh("billboard_child");
  (billboard as any).getDescendants = () => [child];
  const platform = new MockMesh("platform");
  const pusher = new MockMesh("pusher");
  pusher.setEnabled(false); // pre-hidden mesh must restore to hidden

  const meshes = [billboard, child, platform, pusher];
  return {
    billboard,
    child,
    platform,
    pusher,
    scene: {
      meshes,
      clearColor: { r: 0.02, g: 0.02, b: 0.06, a: 1 },
      getMeshByName: (n: string) => meshes.find((m) => m.name === n) ?? null,
      getTransformNodeByName: () => null,
    } as any,
  };
}

describe("IsolateMode (R6)", () => {
  it("hides everything except the target and its descendants, on neutral background", () => {
    const { scene, billboard, child, platform, pusher } = makeScene();
    const iso = new IsolateMode(scene);

    iso.isolate("billboard");

    expect(iso.isActive()).toBe(true);
    expect(billboard.isEnabled()).toBe(true);
    expect(child.isEnabled()).toBe(true);
    expect(platform.isEnabled()).toBe(false);
    expect(pusher.isEnabled()).toBe(false);
    expect(scene.clearColor.r).toBeCloseTo(0.5);
  });

  it("isolate(null) restores prior enabled states and clear color with no residue (leak test)", () => {
    const { scene, platform, pusher } = makeScene();
    const iso = new IsolateMode(scene);

    iso.isolate("billboard");
    iso.isolate(null);

    expect(iso.isActive()).toBe(false);
    expect(iso.getSavedStateCount()).toBe(0);
    expect(platform.isEnabled()).toBe(true);
    expect(pusher.isEnabled()).toBe(false); // was hidden before isolate
    expect(scene.clearColor.r).toBeCloseTo(0.02);
  });

  it("switching targets restores first — saved state never stacks", () => {
    const { scene, billboard, platform } = makeScene();
    const iso = new IsolateMode(scene);

    iso.isolate("billboard");
    iso.isolate("platform");

    expect(platform.isEnabled()).toBe(true);
    expect(billboard.isEnabled()).toBe(false);
    // 3 hidden meshes for the current isolation only (no accumulation)
    expect(iso.getSavedStateCount()).toBe(3);

    iso.isolate(null);
    expect(iso.getSavedStateCount()).toBe(0);
    expect(billboard.isEnabled()).toBe(true);
  });

  it("throws for unknown targets and stays inactive", () => {
    const { scene } = makeScene();
    const iso = new IsolateMode(scene);
    expect(() => iso.isolate("ghost")).toThrow(/no mesh/);
    expect(iso.isActive()).toBe(false);
    expect(iso.getSavedStateCount()).toBe(0);
  });

  it("dispose restores state (safe on inactive too)", () => {
    const { scene, platform } = makeScene();
    const iso = new IsolateMode(scene);
    iso.isolate("billboard");
    iso.dispose();
    expect(platform.isEnabled()).toBe(true);
    expect(() => iso.dispose()).not.toThrow();
  });
});
