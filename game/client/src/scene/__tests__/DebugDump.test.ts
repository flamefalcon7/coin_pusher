import { describe, it, expect } from "vitest";
import { buildSceneDump, type SceneDumpSources } from "../DebugDump";
import { SCENE_CONFIG } from "@coin-pusher/shared";

/** Minimal mesh double matching what buildSceneDump reads (mock idiom). */
function makeMesh(
  name: string,
  opts: {
    position?: { x: number; y: number; z: number };
    rotationQuaternion?: { x: number; y: number; z: number; w: number } | null;
    thinInstanceCount?: number;
    bounds?: { min: [number, number, number]; max: [number, number, number] };
  } = {},
) {
  const position = opts.position ?? { x: 0, y: 0, z: 0 };
  return {
    name,
    position,
    rotationQuaternion: opts.rotationQuaternion ?? null,
    scaling: { x: 1, y: 1, z: 1 },
    thinInstanceCount: opts.thinInstanceCount ?? 0,
    computeWorldMatrix: () => {},
    getAbsolutePosition: () => position,
    getBoundingInfo: () => ({
      boundingBox: {
        minimumWorld: opts.bounds
          ? { x: opts.bounds.min[0], y: opts.bounds.min[1], z: opts.bounds.min[2] }
          : { x: position.x - 0.5, y: position.y - 0.5, z: position.z - 0.5 },
        maximumWorld: opts.bounds
          ? { x: opts.bounds.max[0], y: opts.bounds.max[1], z: opts.bounds.max[2] }
          : { x: position.x + 0.5, y: position.y + 0.5, z: position.z + 0.5 },
      },
    }),
  };
}

function makeSources(meshes: unknown[], overrides: Partial<SceneDumpSources> = {}): SceneDumpSources {
  return {
    scene: { meshes } as SceneDumpSources["scene"],
    getCoinCount: () => 0,
    ...overrides,
  };
}

describe("buildSceneDump", () => {
  it("returns entries for known meshes with world positions", () => {
    const dump = buildSceneDump(
      makeSources([
        makeMesh("platform", { position: { x: 0, y: 0.25, z: 0.05 } }),
        makeMesh("backWall", { position: { x: 0, y: 0.5, z: -0.4 } }),
      ]),
    );

    expect(dump.meshes.map((m) => m.name)).toEqual(["platform", "backWall"]);
    expect(dump.meshes[0].position).toEqual({ x: 0, y: 0.25, z: 0.05 });
    expect(dump.meshes[1].position.z).toBeCloseTo(-0.4);
  });

  it("bounding boxes are finite for every dumped mesh", () => {
    const dump = buildSceneDump(
      makeSources([
        makeMesh("a", { bounds: { min: [-0.6, 0, -0.65], max: [0.6, 0.275, 0.7] } }),
        makeMesh("b"),
      ]),
    );

    for (const mesh of dump.meshes) {
      expect(mesh.boundingBox).not.toBeNull();
      for (const v of [mesh.boundingBox!.min, mesh.boundingBox!.max]) {
        for (const n of [v.x, v.y, v.z]) {
          expect(Number.isFinite(n)).toBe(true);
        }
      }
    }
  });

  it("does not throw on an empty scene", () => {
    const dump = buildSceneDump(makeSources([]));
    expect(dump.meshes).toEqual([]);
    expect(dump.thinInstanceHosts).toEqual([]);
    expect(dump.coinThinInstances).toBe(0);
    expect(dump.network.poses).toEqual([]);
    expect(dump.network.pusherZ).toBeNull();
  });

  it("separates thin-instance hosts from regular meshes and reports coin count", () => {
    const dump = buildSceneDump(
      makeSources(
        [makeMesh("coinProto", { thinInstanceCount: 42 }), makeMesh("pusher")],
        { getCoinCount: () => 42 },
      ),
    );

    expect(dump.meshes.map((m) => m.name)).toEqual(["pusher"]);
    expect(dump.thinInstanceHosts).toEqual([{ name: "coinProto", count: 42 }]);
    expect(dump.coinThinInstances).toBe(42);
  });

  it("flags latest network poses as authoritative and carries pusherZ/serverTime", () => {
    const dump = buildSceneDump(
      makeSources([], {
        getLatestAuthoritativeState: () => ({
          serverTime: 12345,
          pusherZ: -0.02,
          coins: [{ id: 7, pos: [0.1, 0.3, 0.0], rot: [0, 0, 0, 1] }],
        }),
      }),
    );

    expect(dump.network.poses).toEqual([
      { id: 7, pos: [0.1, 0.3, 0.0], rot: [0, 0, 0, 1], authoritative: true },
    ]);
    expect(dump.network.pusherZ).toBeCloseTo(-0.02);
    expect(dump.network.serverTime).toBe(12345);
  });

  it("embeds the raw SCENE_CONFIG so dumps are self-describing (R1.2)", () => {
    const dump = buildSceneDump(makeSources([]));
    expect(dump.sceneConfig).toBe(SCENE_CONFIG);
    expect(dump.sceneConfig.PLATFORM.POSITION.y).toBeCloseTo(0.25);
  });

  it("survives partial mock meshes missing optional getters", () => {
    const bare = { name: "bare", position: { x: 1, y: 2, z: 3 } };
    const dump = buildSceneDump(makeSources([bare]));
    expect(dump.meshes[0]).toEqual({
      name: "bare",
      position: { x: 1, y: 2, z: 3 },
      rotationQuaternion: null,
      scaling: { x: 0, y: 0, z: 0 },
      boundingBox: null,
    });
  });
});
