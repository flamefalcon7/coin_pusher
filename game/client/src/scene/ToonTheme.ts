import { Color3, Color4 } from "@babylonjs/core";

export interface ToonTheme {
  name: string;
  label: string;
  clearColor: Color4;
  shadowTint: Color3;
  coin: Color3;
  platform: Color3;
  wall: Color3;
  pin: Color3;
  pusher: Color3;
}

// ── Theme 1: Neon ──────────────────────────────────────────────────────────
// Neon Green coins, Electric Blue walls, Neon Pink pusher, deep black BG
const NEON: ToonTheme = {
  name: "neon",
  label: "Neon",
  clearColor: new Color4(0.02, 0.02, 0.06, 1.0),
  shadowTint: new Color3(0.05, 0.05, 0.15),
  coin: new Color3(0.22, 1.0, 0.08),       // #39FF14 Neon Green
  platform: new Color3(0.12, 0.12, 0.18),   // Dark surface
  wall: new Color3(0.12, 0.32, 1.0),        // #1F51FF Electric Blue
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
  coin: new Color3(0.88, 0.68, 0.0),        // #E1AD01 Mustard Yellow
  platform: new Color3(0.92, 0.9, 0.72),    // #FFFDD0 Cream (toned)
  wall: new Color3(0.0, 0.5, 0.5),          // #008080 Teal
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
  coin: new Color3(1.0, 0.83, 0.0),         // #FFD300 Caution Yellow
  platform: new Color3(0.35, 0.35, 0.35),   // Medium gray
  wall: new Color3(0.2, 0.2, 0.2),          // #333333 Charcoal
  pin: new Color3(0.96, 0.96, 0.96),        // #F5F5F5 Bright White
  pusher: new Color3(1.0, 0.0, 0.0),        // #FF0000 Vibrant Red
};

export const THEMES: ToonTheme[] = [NEON, RETRO, INDUSTRIAL];
