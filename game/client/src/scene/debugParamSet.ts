/**
 * Agent-writable visual params (R7, agent-perception plan).
 *
 * `__coinpusher_debug.set(path, value)` lets the agent binary-search a value
 * via change → dump → screenshot loops. CLIENT-VISUAL ONLY: paths resolve to
 * meshes, transform nodes, or materials in the live scene — physics and
 * SCENE_CONFIG stay read-only (permanent values land via the R4 export
 * workflow instead).
 *
 * Path format: "<meshOrNodeOrMaterialName>.<prop>[.<prop>...]"
 *   e.g. set("backWallGroup.position.z", -0.35)
 *        set("pusher.scaling.x", 1.1)
 */

interface SceneLookup {
  getMeshByName?: (name: string) => unknown;
  getTransformNodeByName?: (name: string) => unknown;
  getMaterialByName?: (name: string) => unknown;
}

export function debugSetParam(scene: SceneLookup, path: string, value: unknown): unknown {
  const parts = path.split(".");
  if (parts.length < 2) {
    throw new Error(
      `debug.set: path "${path}" must be "<meshOrNodeOrMaterialName>.<prop>[...]"`,
    );
  }

  const [name, ...props] = parts;
  const target =
    scene.getMeshByName?.(name) ??
    scene.getTransformNodeByName?.(name) ??
    scene.getMaterialByName?.(name);
  if (!target) {
    throw new Error(`debug.set: no mesh, transform node, or material named "${name}"`);
  }

  let obj = target as Record<string, unknown>;
  for (let i = 0; i < props.length - 1; i++) {
    const next = obj[props[i]];
    if (next === null || typeof next !== "object") {
      throw new Error(
        `debug.set: "${name}.${props.slice(0, i + 1).join(".")}" is not an object`,
      );
    }
    obj = next as Record<string, unknown>;
  }

  const leaf = props[props.length - 1];
  if (typeof obj[leaf] === "function") {
    throw new Error(`debug.set: refusing to overwrite method "${path}"`);
  }

  const previous = obj[leaf];
  obj[leaf] = value;
  return previous;
}
