import { Color3, Color4 } from "@babylonjs/core";

export interface ToonTheme {
  name: string;
  label: string;
  clearColor: Color4;
  shadowTint: Color3;
  highlight: Color3;
  rim: Color3;
  coin: Color3;
  platform: Color3;
  wall: Color3;
  pin: Color3;
  pusher: Color3;
}

/** Derive a shadow color from a base color blended with a tint. */
export function deriveShadow(base: Color3, tint: Color3): Color3 {
  return new Color3(
    base.r * 0.55 + tint.r * 0.45,
    base.g * 0.55 + tint.g * 0.45,
    base.b * 0.55 + tint.b * 0.45,
  );
}

/** Derive a highlight color from a base color (brightened toward white). */
export function deriveHighlight(base: Color3): Color3 {
  return new Color3(
    Math.min(1, base.r * 0.7 + 0.3),
    Math.min(1, base.g * 0.7 + 0.3),
    Math.min(1, base.b * 0.7 + 0.3),
  );
}

// ── Theme 0: Psychedelic Pop ──────────────────────────────────────────────
// Amber Orange coins, Dark Plum platform, Mint Turquoise walls
const PSYCHEDELIC_POP: ToonTheme = {
  name: "psychedelic_pop",
  label: "Psychedelic Pop",
  clearColor: new Color4(0.102, 0.055, 0.180, 1.0), // #1A0E2E Deep psychedelic purple
  shadowTint: new Color3(0.10, 0.05, 0.18),           // Purple shadow
  highlight: new Color3(1.0, 0.85, 0.95),             // Warm pink-white
  rim: new Color3(0.8, 0.4, 0.9),                     // Purple rim
  coin: new Color3(0.910, 0.588, 0.125),               // #E89620 Amber Orange
  platform: new Color3(0.169, 0.082, 0.282),           // #2B1548 Dark Plum
  wall: new Color3(1.0, 1.0, 1.0),                       // White — doodle texture carries color
  pin: new Color3(0.910, 0.224, 0.420),                 // #E8396B Hot Pink
  pusher: new Color3(0.478, 0.188, 0.412),              // #7A3069 Deep Plum
};

// ── Theme 1: Neon ──────────────────────────────────────────────────────────
// Neon Green coins, Electric Blue walls, Neon Pink pusher, deep black BG
const NEON: ToonTheme = {
  name: "neon",
  label: "Neon",
  clearColor: new Color4(0.02, 0.02, 0.06, 1.0),
  shadowTint: new Color3(0.05, 0.05, 0.15),
  highlight: new Color3(0.9, 1.0, 0.95),    // Cool white-green
  rim: new Color3(0.3, 0.8, 1.0),           // Electric cyan rim
  coin: new Color3(0.22, 1.0, 0.08),       // #39FF14 Neon Green
  platform: new Color3(0.12, 0.12, 0.18),   // Dark surface
  wall: new Color3(0.85, 0.85, 0.9),          // Slightly tinted white for neon
  pin: new Color3(0.7, 0.7, 0.85),          // Cool white
  pusher: new Color3(1.0, 0.0, 0.5),        // #FF007F Neon Pink
};

// ── Theme 2: Retro ─────────────────────────────────────────────────────────
// Mustard Yellow coins, Burnt Orange pusher, Teal walls, Cream platform
const RETRO: ToonTheme = {
  name: "retro",
  label: "Retro",
  clearColor: new Color4(0.24, 0.15, 0.14, 1.0),  // Deep Brown bg
  shadowTint: new Color3(0.22, 0.14, 0.1),
  highlight: new Color3(1.0, 0.95, 0.85),   // Warm cream
  rim: new Color3(0.9, 0.6, 0.2),           // Warm orange rim
  coin: new Color3(0.88, 0.68, 0.0),        // #E1AD01 Mustard Yellow
  platform: new Color3(0.92, 0.9, 0.72),    // #FFFDD0 Cream (toned)
  wall: new Color3(1.0, 0.97, 0.93),          // Warm white for retro
  pin: new Color3(0.85, 0.8, 0.7),          // Warm white
  pusher: new Color3(0.8, 0.33, 0.0),       // #CC5500 Burnt Orange
};

// ── Theme 3: Industrial ────────────────────────────────────────────────────
// Caution Yellow coins, Vibrant Red pusher, Charcoal walls
const INDUSTRIAL: ToonTheme = {
  name: "industrial",
  label: "Industrial",
  clearColor: new Color4(0.08, 0.08, 0.08, 1.0),  // Near black
  shadowTint: new Color3(0.12, 0.12, 0.12),
  highlight: new Color3(0.95, 0.95, 1.0),   // Cool white
  rim: new Color3(0.7, 0.7, 0.8),           // Steel blue rim
  coin: new Color3(1.0, 0.83, 0.0),         // #FFD300 Caution Yellow
  platform: new Color3(0.35, 0.35, 0.35),   // Medium gray
  wall: new Color3(0.95, 0.95, 0.95),         // Near-white for industrial
  pin: new Color3(0.96, 0.96, 0.96),        // #F5F5F5 Bright White
  pusher: new Color3(1.0, 0.0, 0.0),        // #FF0000 Vibrant Red
};

export const THEMES: ToonTheme[] = [PSYCHEDELIC_POP, NEON, RETRO, INDUSTRIAL];
