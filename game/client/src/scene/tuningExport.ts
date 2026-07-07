/**
 * Pure helpers for the tuning HUD (R4, agent-perception plan).
 * Kept free of Babylon/lil-gui imports so they test under plain node vitest.
 */

export interface NumericLeaf {
  /** Dot path relative to the walked root, e.g. "POSITION.y". */
  path: string;
  value: number;
}

export interface TuningChange {
  /** Full config path, e.g. "PLATFORM.POSITION.y". */
  path: string;
  oldValue: number;
  newValue: number;
}

/** Recursively collect numeric leaves of a plain config object. */
export function collectNumericLeaves(obj: Record<string, unknown>, prefix = ""): NumericLeaf[] {
  const leaves: NumericLeaf[] = [];
  for (const [key, value] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (typeof value === "number") {
      leaves.push({ path, value });
    } else if (value && typeof value === "object" && !Array.isArray(value)) {
      leaves.push(...collectNumericLeaves(value as Record<string, unknown>, path));
    }
  }
  return leaves;
}

/**
 * Build the ready-to-paste TS snippet for changed constants only, with
 * old → new values in comments (R4.3). The workflow: human drags sliders →
 * export → agent applies the listed paths to `game/shared/src/types.ts` →
 * server restart picks it up.
 */
export function buildTuningExport(changes: TuningChange[]): string {
  if (changes.length === 0) {
    return "// SCENE_CONFIG tuning export: no changes";
  }
  const lines = [
    "// SCENE_CONFIG tuning export (?debug=1 HUD) — apply to game/shared/src/types.ts",
  ];
  for (const c of changes) {
    lines.push(`SCENE_CONFIG.${c.path} = ${c.newValue}; // was ${c.oldValue}`);
  }
  return lines.join("\n");
}

/** Diff current slider values against their originals. */
export function diffTuningParams(
  original: ReadonlyMap<string, number>,
  current: ReadonlyMap<string, number>,
): TuningChange[] {
  const changes: TuningChange[] = [];
  for (const [path, oldValue] of original) {
    const newValue = current.get(path);
    if (newValue !== undefined && newValue !== oldValue) {
      changes.push({ path, oldValue, newValue });
    }
  }
  return changes;
}
