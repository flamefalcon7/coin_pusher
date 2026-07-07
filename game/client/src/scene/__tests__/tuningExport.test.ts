import { describe, it, expect } from "vitest";
import {
  collectNumericLeaves,
  buildTuningExport,
  diffTuningParams,
} from "../tuningExport";
import { debugSetParam } from "../debugParamSet";
import { SCENE_CONFIG } from "@coin-pusher/shared";

describe("collectNumericLeaves", () => {
  it("flattens nested numeric leaves with dot paths, skipping non-numbers", () => {
    const leaves = collectNumericLeaves({
      WIDTH: 1.2,
      POSITION: { x: 0, y: 0.25, z: 0.05 },
      LABEL: "not-a-number",
      FLAGS: [1, 2],
    });
    expect(leaves).toEqual([
      { path: "WIDTH", value: 1.2 },
      { path: "POSITION.x", value: 0 },
      { path: "POSITION.y", value: 0.25 },
      { path: "POSITION.z", value: 0.05 },
    ]);
  });

  it("covers the real SCENE_CONFIG.PLATFORM section", () => {
    const leaves = collectNumericLeaves(
      SCENE_CONFIG.PLATFORM as unknown as Record<string, unknown>,
    );
    const paths = leaves.map((l) => l.path);
    expect(paths).toContain("POSITION.y");
    expect(paths).toContain("THICKNESS");
    expect(leaves.find((l) => l.path === "POSITION.y")?.value).toBeCloseTo(0.25);
  });
});

describe("diffTuningParams + buildTuningExport", () => {
  it("exports only changed constants with old → new comments", () => {
    const original = new Map([
      ["PLATFORM.POSITION.y", 0.25],
      ["SIDE_WALLS.THICKNESS", 0.1],
      ["PUSHER.HEIGHT", 0.2],
    ]);
    const current = new Map([
      ["PLATFORM.POSITION.y", 0.3],
      ["SIDE_WALLS.THICKNESS", 0.1],
      ["PUSHER.HEIGHT", 0.25],
    ]);

    const changes = diffTuningParams(original, current);
    expect(changes).toHaveLength(2);

    const snippet = buildTuningExport(changes);
    expect(snippet).toContain("SCENE_CONFIG.PLATFORM.POSITION.y = 0.3; // was 0.25");
    expect(snippet).toContain("SCENE_CONFIG.PUSHER.HEIGHT = 0.25; // was 0.2");
    expect(snippet).not.toContain("SIDE_WALLS.THICKNESS");
    expect(snippet).toContain("game/shared/src/types.ts");
  });

  it("reports no-changes cleanly", () => {
    expect(buildTuningExport([])).toBe("// SCENE_CONFIG tuning export: no changes");
  });
});

describe("debugSetParam (R7)", () => {
  function makeScene() {
    const wall = {
      position: { x: 0, y: 0.5, z: -0.4 },
      rotation: { x: 0, y: 0, z: 0 },
      dispose: () => {},
    };
    const mat = { alpha: 1 };
    return {
      wall,
      mat,
      scene: {
        getMeshByName: (n: string) => (n === "backWall" ? wall : null),
        getTransformNodeByName: () => null,
        getMaterialByName: (n: string) => (n === "wallMat" ? mat : null),
      },
    };
  }

  it("sets a nested transform value and returns the previous one", () => {
    const { scene, wall } = makeScene();
    const old = debugSetParam(scene, "backWall.position.z", -0.35);
    expect(old).toBeCloseTo(-0.4);
    expect(wall.position.z).toBeCloseTo(-0.35);
  });

  it("falls back to material lookup", () => {
    const { scene, mat } = makeScene();
    const old = debugSetParam(scene, "wallMat.alpha", 0.5);
    expect(old).toBe(1);
    expect(mat.alpha).toBe(0.5);
  });

  it("throws a clear error for unknown targets, bad paths, and methods", () => {
    const { scene } = makeScene();
    expect(() => debugSetParam(scene, "nope.position.x", 1)).toThrow(/no mesh/);
    expect(() => debugSetParam(scene, "backWall", 1)).toThrow(/must be/);
    expect(() => debugSetParam(scene, "backWall.position.z.w", 1)).toThrow(/not an object/);
    expect(() => debugSetParam(scene, "backWall.dispose", 1)).toThrow(/method/);
  });
});
