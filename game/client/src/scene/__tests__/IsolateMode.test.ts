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

  it("preserves a hidden-parent child's own enabled flag across an isolate cycle (wireframe cascade regression)", () => {
    // Reproduces the ColliderWireframes overlay: a disabled root TransformNode
    // with an enabled child. isEnabled() walks ancestors and reports false for
    // the child, but its OWN flag is still true — isolate must save/restore the
    // own flag so re-enabling the root later still shows the child.
    const root = new MockMesh("wfRoot");
    root.setEnabled(false);
    const wfChild = new MockMesh("wfChild");
    wfChild.parent = root;
    const target = new MockMesh("pusher");
    const meshes = [root, wfChild, target];
    const scene = {
      meshes,
      clearColor: { r: 0.02, g: 0.02, b: 0.06, a: 1 },
      getMeshByName: (n: string) => meshes.find((m) => m.name === n) ?? null,
      getTransformNodeByName: () => null,
    } as any;
    const iso = new IsolateMode(scene);

    expect(wfChild.isEnabled()).toBe(false); // ancestor-aware: parent disabled
    expect(wfChild.isEnabled(false)).toBe(true); // own flag still on

    iso.isolate("pusher");
    iso.isolate(null);

    // Own flag restored to true → re-enabling the root shows the overlay again.
    expect(wfChild.isEnabled(false)).toBe(true);
    root.setEnabled(true);
    expect(wfChild.isEnabled()).toBe(true);
  });

  it("resolves the target via the transform-node fallback (VFX/wireframe groups are TransformNodes)", () => {
    const groupChild = new MockMesh("vfxGroup_child");
    const group = { name: "vfxGroup", getDescendants: () => [groupChild] };
    const other = new MockMesh("platform");
    const meshes = [groupChild, other];
    const scene = {
      meshes,
      clearColor: { r: 0.02, g: 0.02, b: 0.06, a: 1 },
      getMeshByName: (n: string) => (n === "vfxGroup_child" ? groupChild : n === "platform" ? other : null),
      getTransformNodeByName: (n: string) => (n === "vfxGroup" ? group : null),
    } as any;
    const iso = new IsolateMode(scene);

    iso.isolate("vfxGroup"); // miss on mesh lookup → transform-node fallback

    expect(iso.isActive()).toBe(true);
    expect(groupChild.isEnabled()).toBe(true); // kept (descendant of target)
    expect(other.isEnabled()).toBe(false); // hidden
    iso.isolate(null);
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
