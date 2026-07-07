import { describe, it, expect, vi } from "vitest";

vi.mock("@babylonjs/core", async () => {
  const { createBabylonCoreMock, MockVector3 } = await import("./leakHarness");
  return {
    ...createBabylonCoreMock(),
    Camera: class {
      static ORTHOGRAPHIC_CAMERA = 1;
      static PERSPECTIVE_CAMERA = 0;
    },
    Vector3: MockVector3,
  };
});

import { DebugCameraController } from "../DebugCamera";
import { DebugSceneAids } from "../DebugSceneAids";
import { createMockScene, MockVector3 } from "./leakHarness";

function makeCamera() {
  return {
    alpha: Math.PI / 2,
    beta: Math.PI / 3,
    radius: 3,
    target: new MockVector3(0, 1, 0),
    mode: 0, // PERSPECTIVE_CAMERA
    orthoLeft: null as number | null,
    orthoRight: null as number | null,
    orthoTop: null as number | null,
    orthoBottom: null as number | null,
    lowerAlphaLimit: Math.PI / 2 as number | null,
    upperAlphaLimit: Math.PI / 2 as number | null,
    lowerBetaLimit: Math.PI / 3 as number | null,
    upperBetaLimit: Math.PI / 3 as number | null,
    lowerRadiusLimit: 3 as number | null,
    upperRadiusLimit: 3 as number | null,
    setTarget(v: MockVector3) {
      this.target = v;
    },
  };
}

const engine = { getAspectRatio: () => 1.5 };

describe("DebugCameraController", () => {
  it("top preset is orthographic, looking straight down, limits cleared", () => {
    const cam = makeCamera();
    const ctl = new DebugCameraController(engine, cam as any);

    ctl.applyPreset("top");

    expect(cam.mode).toBe(1); // ORTHOGRAPHIC_CAMERA
    expect(cam.beta).toBeLessThan(0.1);
    expect(cam.lowerAlphaLimit).toBeNull();
    expect(cam.upperBetaLimit).toBeNull();
    expect(cam.orthoLeft).toBeCloseTo(-1.5);
    expect(cam.orthoRight).toBeCloseTo(1.5);
    // aspect 1.5 → vertical half-extent 1.0 (undistorted pixels)
    expect(cam.orthoTop).toBeCloseTo(1.0);
    // Targets the platform top (spatial contract: y = 0.275)
    expect(cam.target.y).toBeCloseTo(0.275);
  });

  it("front and side presets differ only in azimuth (alpha)", () => {
    const cam = makeCamera();
    const ctl = new DebugCameraController(engine, cam as any);

    ctl.applyPreset("front");
    expect(cam.alpha).toBeCloseTo(Math.PI / 2); // camera on +Z (player side)
    expect(cam.beta).toBeCloseTo(Math.PI / 2);

    ctl.applyPreset("side");
    expect(cam.alpha).toBeCloseTo(0); // camera on +X (player's right)
    expect(cam.beta).toBeCloseTo(Math.PI / 2);
    expect(cam.mode).toBe(1);
  });

  it("default preset restores the exact saved player-camera state", () => {
    const cam = makeCamera();
    const ctl = new DebugCameraController(engine, cam as any);

    ctl.applyPreset("top");
    ctl.applyPreset("default");

    expect(cam.mode).toBe(0);
    expect(cam.alpha).toBeCloseTo(Math.PI / 2);
    expect(cam.beta).toBeCloseTo(Math.PI / 3);
    expect(cam.radius).toBe(3);
    expect(cam.target.y).toBeCloseTo(1);
    expect(cam.orthoLeft).toBeNull();
    expect(cam.lowerAlphaLimit).toBeCloseTo(Math.PI / 2);
    expect(cam.upperRadiusLimit).toBe(3);
  });
});

describe("DebugSceneAids", () => {
  it("creates the axis gizmo and grid, and dispose leaves no residue (leak test)", () => {
    const scene = createMockScene();
    const aids = new DebugSceneAids(scene);

    // 3 axis lines + 1 grid line-system
    expect(aids.getMeshCount()).toBe(4);

    const disposeSpies = (aids as any).meshes.map((m: any) => vi.spyOn(m, "dispose"));
    aids.dispose();

    expect(aids.getMeshCount()).toBe(0);
    for (const spy of disposeSpies) expect(spy).toHaveBeenCalledTimes(1);

    // Double-dispose is safe
    expect(() => aids.dispose()).not.toThrow();
  });
});
