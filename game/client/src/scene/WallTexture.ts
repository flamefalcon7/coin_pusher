import { Scene, DynamicTexture, Texture } from "@babylonjs/core";
import type { ICanvasRenderingContext } from "@babylonjs/core/Engines/ICanvas";

/**
 * Procedurally generate a cartoon stone-brick wall texture.
 *
 * Bricks are large, chunky, and randomly sized for a hand-drawn look.
 * Thick dark mortar lines, bold highlights/shadows, bright warm palette.
 */

// ── Palette ──────────────────────────────────────────────────────────────────

const PALETTE = [
  { r: 0xb0, g: 0xa0, b: 0x88 }, // warm sandstone
  { r: 0xc2, g: 0xab, b: 0x8e }, // light tan
  { r: 0x9a, g: 0x8e, b: 0x7a }, // medium grey-brown
  { r: 0xa8, g: 0x96, b: 0x80 }, // dusty beige
  { r: 0x8e, g: 0x9a, b: 0x7c }, // mossy olive (accent)
  { r: 0xc8, g: 0xb4, b: 0x96 }, // pale cream stone
];

const MORTAR = { r: 0x3e, g: 0x38, b: 0x30 };
const HIGHLIGHT = { r: 0xe8, g: 0xdc, b: 0xc4 };
const SHADOW = { r: 0x58, g: 0x50, b: 0x44 };

// ── Config ───────────────────────────────────────────────────────────────────

interface StoneConfig {
  size: number;
  rows: number;
  colsMin: number;
  colsMax: number;
  mortarWidth: number;
  cornerRadius: number;
}

const DEFAULT_CONFIG: StoneConfig = {
  size: 512,
  rows: 5,          // fewer rows → bigger bricks
  colsMin: 2,       // as few as 2 per row
  colsMax: 4,
  mortarWidth: 6,    // thick cartoon mortar
  cornerRadius: 6,   // rounded cartoon corners
};

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeRng(seed: number) {
  let s = seed | 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >> 17;
    s ^= s << 5;
    return (s >>> 0) / 4294967296;
  };
}

function colorStr(r: number, g: number, b: number, a = 1): string {
  return `rgba(${r | 0},${g | 0},${b | 0},${a})`;
}

function vary(base: number, range: number, rng: () => number): number {
  return Math.max(0, Math.min(255, base + (rng() - 0.5) * 2 * range));
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

// ── Generator ────────────────────────────────────────────────────────────────

function drawStoneWall(ctx: ICanvasRenderingContext, cfg: StoneConfig, seed: number): void {
  const rng = makeRng(seed);
  const { size, rows, colsMin, colsMax, mortarWidth, cornerRadius } = cfg;
  const mw = mortarWidth;
  const cr = cornerRadius;

  // Fill background with mortar color
  ctx.fillStyle = colorStr(MORTAR.r, MORTAR.g, MORTAR.b);
  ctx.fillRect(0, 0, size, size);

  // Generate random row heights
  const rowWeights: number[] = [];
  let totalWeight = 0;
  for (let r = 0; r < rows; r++) {
    const w = 0.6 + rng() * 0.8; // 0.6–1.4 relative height
    rowWeights.push(w);
    totalWeight += w;
  }
  const rowScale = size / totalWeight;

  let y = 0;
  for (let row = 0; row < rows; row++) {
    const rowH = rowWeights[row] * rowScale;
    const cols = colsMin + Math.floor(rng() * (colsMax - colsMin + 1));

    // Random offset per row (not just 0 or half)
    const offset = rng() * (size / cols) * 0.8;

    // Generate wildly varying column widths
    const widths: number[] = [];
    let totalW = 0;
    for (let c = 0; c < cols; c++) {
      const w = 0.4 + rng() * 1.2; // 0.4–1.6 (big variance!)
      widths.push(w);
      totalW += w;
    }
    const colScale = size / totalW;

    let x = offset;
    for (let c = 0; c < cols; c++) {
      const brickW = widths[c] * colScale;
      const sx = x + mw;
      const sy = y + mw;
      const sw = brickW - mw * 2;
      const sh = rowH - mw * 2;

      if (sw <= cr * 2 || sh <= cr * 2) { x += brickW; continue; }

      // Pick a random palette color with per-brick variation
      const pal = PALETTE[Math.floor(rng() * PALETTE.length)];
      const sr = vary(pal.r, 25, rng);
      const sg = vary(pal.g, 22, rng);
      const sb = vary(pal.b, 18, rng);

      // Draw stone face (with seamless wrap)
      const drawBrick = (bx: number) => {
        const clampW = Math.min(sw, size - bx);
        if (clampW <= 0) return;

        // Main fill
        ctx.fillStyle = colorStr(sr, sg, sb);
        roundRect(ctx, bx, sy, clampW, sh, cr);
        ctx.fill();

        // Bold top-left highlight (cartoon depth)
        const hlW = Math.max(3, mw);
        ctx.fillStyle = colorStr(HIGHLIGHT.r, HIGHLIGHT.g, HIGHLIGHT.b, 0.35);
        ctx.fillRect(bx + cr, sy, clampW - cr * 2, hlW);
        ctx.fillRect(bx, sy + cr, hlW, sh - cr * 2);

        // Bold bottom-right shadow
        ctx.fillStyle = colorStr(SHADOW.r, SHADOW.g, SHADOW.b, 0.4);
        ctx.fillRect(bx + cr, sy + sh - hlW, clampW - cr * 2, hlW);
        ctx.fillRect(bx + clampW - hlW, sy + cr, hlW, sh - cr * 2);

        // Occasional cartoon crack/scratch (thin dark line)
        if (rng() < 0.15) {
          const cx1 = bx + cr + rng() * (clampW - cr * 2);
          const cy1 = sy + cr + rng() * (sh * 0.3);
          const cx2 = cx1 + (rng() - 0.5) * clampW * 0.4;
          const cy2 = cy1 + rng() * sh * 0.5;
          ctx.strokeStyle = colorStr(MORTAR.r, MORTAR.g, MORTAR.b, 0.3);
          ctx.lineWidth = 1.5;
          ctx.beginPath();
          ctx.moveTo(cx1, cy1);
          ctx.lineTo(cx2, cy2);
          ctx.stroke();
        }

        // Small noise spots (cartoon texture)
        const spots = Math.floor(rng() * 4);
        for (let d = 0; d < spots; d++) {
          const dx = bx + cr + rng() * (clampW - cr * 2);
          const dy = sy + cr + rng() * (sh - cr * 2);
          const ds = 2 + rng() * 4;
          const da = 0.08 + rng() * 0.12;
          ctx.fillStyle = rng() > 0.5
            ? colorStr(HIGHLIGHT.r, HIGHLIGHT.g, HIGHLIGHT.b, da)
            : colorStr(SHADOW.r, SHADOW.g, SHADOW.b, da);
          ctx.fillRect(dx, dy, ds, ds);
        }
      };

      // Draw primary brick
      drawBrick(sx % size);

      // Wrap around for seamless tiling
      if ((sx + sw) > size) {
        drawBrick(0);
      }

      x += brickW;
    }
    y += rowH;
  }
}

function roundRect(
  ctx: ICanvasRenderingContext,
  x: number, y: number, w: number, h: number, r: number,
) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

// ── Public API ───────────────────────────────────────────────────────────────

export function createStoneWallTexture(
  scene: Scene,
  name: string,
  seed = 12345,
  config?: Partial<StoneConfig>,
): Texture {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  const dt = new DynamicTexture(name, cfg.size, scene, true);
  const ctx = dt.getContext();

  drawStoneWall(ctx, cfg, seed);

  dt.update();
  dt.uScale = 2;
  dt.vScale = 2;

  return dt;
}
