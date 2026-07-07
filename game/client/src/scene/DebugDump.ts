import type { Scene } from "@babylonjs/core";
import { SCENE_CONFIG } from "@coin-pusher/shared";

/**
 * Structured scene dump for the AI agent (R1, agent-perception plan).
 * "Numbers first, pixels last": one `evaluate_script` call on
 * `window.__coinpusher_debug.dump()` replaces a screenshot-and-squint loop.
 */

export interface DumpVec3 {
  x: number;
  y: number;
  z: number;
}

export interface DumpQuat {
  x: number;
  y: number;
  z: number;
  w: number;
}

export interface MeshDump {
  name: string;
  /** World-space position (getAbsolutePosition). */
  position: DumpVec3;
  /** Quaternion rotation if set, otherwise null (euler-driven node). */
  rotationQuaternion: DumpQuat | null;
  scaling: DumpVec3;
  /** World-space AABB; null if the mesh exposes no bounding info. */
  boundingBox: { min: DumpVec3; max: DumpVec3 } | null;
}

/** Last authoritative pose received from the server for a networked body. */
export interface AuthoritativePose {
  id: number;
  pos: [number, number, number];
  rot: [number, number, number, number];
  authoritative: true;
}

export interface SceneDump {
  /** All non-thin-instance meshes in the scene graph. */
  meshes: MeshDump[];
  /** Thin-instance host meshes (coin prototypes) with their instance counts. */
  thinInstanceHosts: { name: string; count: number }[];
  /** Active coin thin-instances (CoinMeshManager.getCoinCount). */
  coinThinInstances: number;
  /** Latest raw server state (pre-interpolation) — the physics ground truth. */
  network: {
    poses: AuthoritativePose[];
    pusherZ: number | null;
    serverTime: number | null;
  };
  /** Raw shared config so a dump is self-describing against config drift (R1.2). */
  sceneConfig: typeof SCENE_CONFIG;
}

export interface SceneDumpSources {
  scene: Pick<Scene, "meshes">;
  getCoinCount: () => number;
  /** Newest buffered server state; null before the first snapshot. */
  getLatestAuthoritativeState?: () =>
    | {
        serverTime: number;
        pusherZ: number;
        coins: { id: number; pos: [number, number, number]; rot: [number, number, number, number] }[];
      }
    | null;
}

function toVec3(v: { x?: number; y?: number; z?: number } | null | undefined): DumpVec3 {
  return { x: v?.x ?? 0, y: v?.y ?? 0, z: v?.z ?? 0 };
}

function dumpMesh(mesh: any): MeshDump {
  // World-space position; fall back to local position for partial mocks.
  let position = mesh.position;
  if (typeof mesh.computeWorldMatrix === "function" && typeof mesh.getAbsolutePosition === "function") {
    mesh.computeWorldMatrix(true);
    position = mesh.getAbsolutePosition();
  }

  const rq = mesh.rotationQuaternion;
  const rotationQuaternion: DumpQuat | null = rq
    ? { x: rq.x, y: rq.y, z: rq.z, w: rq.w }
    : null;

  let boundingBox: MeshDump["boundingBox"] = null;
  if (typeof mesh.getBoundingInfo === "function") {
    try {
      const bb = mesh.getBoundingInfo()?.boundingBox;
      if (bb) {
        boundingBox = {
          min: toVec3(bb.minimumWorld ?? bb.minimum),
          max: toVec3(bb.maximumWorld ?? bb.maximum),
        };
      }
    } catch {
      // Meshes without geometry (some mocks / freshly-disposed) — leave null.
    }
  }

  return {
    name: mesh.name ?? "",
    position: toVec3(position),
    rotationQuaternion,
    scaling: toVec3(mesh.scaling),
    boundingBox,
  };
}

export function buildSceneDump(sources: SceneDumpSources): SceneDump {
  const meshes: MeshDump[] = [];
  const thinInstanceHosts: { name: string; count: number }[] = [];

  for (const mesh of (sources.scene.meshes ?? []) as any[]) {
    const thinCount = mesh?.thinInstanceCount ?? 0;
    if (thinCount > 0) {
      thinInstanceHosts.push({ name: mesh.name ?? "", count: thinCount });
    } else {
      meshes.push(dumpMesh(mesh));
    }
  }

  const latest = sources.getLatestAuthoritativeState?.() ?? null;
  const poses: AuthoritativePose[] = latest
    ? latest.coins.map((c) => ({
        id: c.id,
        pos: [c.pos[0], c.pos[1], c.pos[2]],
        rot: [c.rot[0], c.rot[1], c.rot[2], c.rot[3]],
        authoritative: true as const,
      }))
    : [];

  return {
    meshes,
    thinInstanceHosts,
    coinThinInstances: sources.getCoinCount(),
    network: {
      poses,
      pusherZ: latest?.pusherZ ?? null,
      serverTime: latest?.serverTime ?? null,
    },
    sceneConfig: SCENE_CONFIG,
  };
}
