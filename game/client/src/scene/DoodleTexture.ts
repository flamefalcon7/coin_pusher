import { Scene, DynamicTexture, Texture } from "@babylonjs/core";

/**
 * Procedurally generate a sticker-bomb / doodle-art wall texture.
 *
 * Dense, hand-drawn casino doodles with thick black outlines and
 * warm muted colors — inspired by maximalist pop-art illustration.
 *
 * We cast BabylonJS ICanvasRenderingContext to CanvasRenderingContext2D
 * since DynamicTexture always uses a real 2D canvas under the hood.
 */

// ── Color Palette (warm muted pastels + accent pops) ─────────────────────────

const DOODLE_COLORS = [
  "#E8D5B7", // warm cream
  "#F2C6A0", // peach
  "#E89B7B", // salmon
  "#D4726A", // dusty rose
  "#C2E0A8", // sage green
  "#8DC48E", // muted green
  "#A1CDE3", // soft blue
  "#7EB5D6", // sky blue
  "#F5D76E", // warm yellow
  "#F0A04B", // orange
  "#E06060", // muted red
  "#C49BD4", // lavender
  "#B8D8D0", // mint
  "#D4A574", // kraft brown
];

const ACCENT_COLORS = [
  "#FF4444", // bright red
  "#FFD700", // gold
  "#00C853", // bright green
  "#FF6B35", // vivid orange
];

const BG_COLOR = "#F5ECD7"; // warm paper
const OUTLINE_COLOR = "#1A1A1A"; // near-black

// ── RNG ──────────────────────────────────────────────────────────────────────

function makeRng(seed: number) {
  let s = seed | 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >> 17;
    s ^= s << 5;
    return (s >>> 0) / 4294967296;
  };
}

// ── Doodle Drawing Primitives ────────────────────────────────────────────────

type Ctx = CanvasRenderingContext2D;

function setStroke(ctx: Ctx, width: number) {
  ctx.strokeStyle = OUTLINE_COLOR;
  ctx.lineWidth = width;
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
}

function pickColor(rng: () => number, useAccent = false): string {
  if (useAccent && rng() < 0.25) {
    return ACCENT_COLORS[Math.floor(rng() * ACCENT_COLORS.length)];
  }
  return DOODLE_COLORS[Math.floor(rng() * DOODLE_COLORS.length)];
}

// ── Individual Doodle Elements ───────────────────────────────────────────────

function drawStar(ctx: Ctx, x: number, y: number, r: number, color: string) {
  const points = 5;
  ctx.beginPath();
  for (let i = 0; i < points * 2; i++) {
    const angle = (i * Math.PI) / points - Math.PI / 2;
    const rad = i % 2 === 0 ? r : r * 0.4;
    const px = x + Math.cos(angle) * rad;
    const py = y + Math.sin(angle) * rad;
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.fill();
  setStroke(ctx, 2.5);
  ctx.stroke();
}

function drawCoin(ctx: Ctx, x: number, y: number, r: number, color: string) {
  // Outer circle
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.fill();
  setStroke(ctx, 2.5);
  ctx.stroke();
  // Inner circle
  ctx.beginPath();
  ctx.arc(x, y, r * 0.65, 0, Math.PI * 2);
  setStroke(ctx, 2);
  ctx.stroke();
  // Dollar sign
  ctx.fillStyle = OUTLINE_COLOR;
  ctx.font = `bold ${Math.floor(r * 0.9)}px sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText("$", x, y + 1);
}

function drawDice(ctx: Ctx, x: number, y: number, s: number, color: string) {
  const hs = s / 2;
  const r = s * 0.12;
  // Rounded rect
  ctx.beginPath();
  ctx.moveTo(x - hs + r, y - hs);
  ctx.lineTo(x + hs - r, y - hs);
  ctx.quadraticCurveTo(x + hs, y - hs, x + hs, y - hs + r);
  ctx.lineTo(x + hs, y + hs - r);
  ctx.quadraticCurveTo(x + hs, y + hs, x + hs - r, y + hs);
  ctx.lineTo(x - hs + r, y + hs);
  ctx.quadraticCurveTo(x - hs, y + hs, x - hs, y + hs - r);
  ctx.lineTo(x - hs, y - hs + r);
  ctx.quadraticCurveTo(x - hs, y - hs, x - hs + r, y - hs);
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.fill();
  setStroke(ctx, 2.5);
  ctx.stroke();
  // Dots (showing 5)
  const dotR = s * 0.07;
  ctx.fillStyle = OUTLINE_COLOR;
  const dotPositions = [
    [0, 0],
    [-0.28, -0.28], [0.28, -0.28],
    [-0.28, 0.28], [0.28, 0.28],
  ];
  for (const [dx, dy] of dotPositions) {
    ctx.beginPath();
    ctx.arc(x + dx * s, y + dy * s, dotR, 0, Math.PI * 2);
    ctx.fill();
  }
}

function drawHeart(ctx: Ctx, x: number, y: number, s: number, color: string) {
  ctx.beginPath();
  ctx.moveTo(x, y + s * 0.35);
  ctx.bezierCurveTo(x - s * 0.5, y - s * 0.1, x - s * 0.5, y - s * 0.45, x, y - s * 0.2);
  ctx.bezierCurveTo(x + s * 0.5, y - s * 0.45, x + s * 0.5, y - s * 0.1, x, y + s * 0.35);
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.fill();
  setStroke(ctx, 2.5);
  ctx.stroke();
}

function drawSmiley(ctx: Ctx, x: number, y: number, r: number, color: string) {
  // Face
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.fill();
  setStroke(ctx, 2.5);
  ctx.stroke();
  // Eyes
  ctx.fillStyle = OUTLINE_COLOR;
  ctx.beginPath();
  ctx.arc(x - r * 0.3, y - r * 0.2, r * 0.12, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.arc(x + r * 0.3, y - r * 0.2, r * 0.12, 0, Math.PI * 2);
  ctx.fill();
  // Smile
  ctx.beginPath();
  ctx.arc(x, y + r * 0.05, r * 0.4, 0.15, Math.PI - 0.15);
  setStroke(ctx, 2);
  ctx.stroke();
}

function drawLightning(ctx: Ctx, x: number, y: number, s: number, color: string) {
  const pts = [
    [0, -0.5], [0.15, -0.1], [0.4, -0.1],
    [0.0, 0.15], [0.25, 0.15], [-0.1, 0.5],
    [0.1, 0.05], [-0.15, 0.05], [0.05, -0.2],
    [-0.2, -0.2],
  ];
  ctx.beginPath();
  ctx.moveTo(x + pts[0][0] * s, y + pts[0][1] * s);
  for (let i = 1; i < pts.length; i++) {
    ctx.lineTo(x + pts[i][0] * s, y + pts[i][1] * s);
  }
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.fill();
  setStroke(ctx, 2.5);
  ctx.stroke();
}

function drawDiamond(ctx: Ctx, x: number, y: number, s: number, color: string) {
  const hs = s / 2;
  ctx.beginPath();
  ctx.moveTo(x, y - hs);
  ctx.lineTo(x + hs * 0.7, y);
  ctx.lineTo(x, y + hs);
  ctx.lineTo(x - hs * 0.7, y);
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.fill();
  setStroke(ctx, 2.5);
  ctx.stroke();
  // Inner shine line
  ctx.beginPath();
  ctx.moveTo(x - hs * 0.35, y - hs * 0.15);
  ctx.lineTo(x, y - hs * 0.55);
  ctx.lineTo(x + hs * 0.35, y - hs * 0.15);
  setStroke(ctx, 1.5);
  ctx.stroke();
}

function drawCrown(ctx: Ctx, x: number, y: number, s: number, color: string) {
  const hw = s * 0.45;
  const hh = s * 0.35;
  ctx.beginPath();
  ctx.moveTo(x - hw, y + hh);
  ctx.lineTo(x - hw, y - hh * 0.2);
  ctx.lineTo(x - hw * 0.5, y + hh * 0.3);
  ctx.lineTo(x, y - hh);
  ctx.lineTo(x + hw * 0.5, y + hh * 0.3);
  ctx.lineTo(x + hw, y - hh * 0.2);
  ctx.lineTo(x + hw, y + hh);
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.fill();
  setStroke(ctx, 2.5);
  ctx.stroke();
  // Gems
  const gemR = s * 0.05;
  ctx.fillStyle = ACCENT_COLORS[0];
  for (const gx of [-0.2, 0, 0.2]) {
    ctx.beginPath();
    ctx.arc(x + gx * s, y + hh * 0.5, gemR, 0, Math.PI * 2);
    ctx.fill();
  }
}

function drawSpeechBubble(ctx: Ctx, x: number, y: number, s: number, color: string, text: string) {
  const w = s * 0.8;
  const h = s * 0.5;
  const r = s * 0.12;
  // Bubble body
  ctx.beginPath();
  ctx.moveTo(x - w / 2 + r, y - h / 2);
  ctx.lineTo(x + w / 2 - r, y - h / 2);
  ctx.quadraticCurveTo(x + w / 2, y - h / 2, x + w / 2, y - h / 2 + r);
  ctx.lineTo(x + w / 2, y + h / 2 - r);
  ctx.quadraticCurveTo(x + w / 2, y + h / 2, x + w / 2 - r, y + h / 2);
  // Tail
  ctx.lineTo(x - w * 0.1, y + h / 2);
  ctx.lineTo(x - w * 0.2, y + h / 2 + s * 0.15);
  ctx.lineTo(x - w * 0.3, y + h / 2);
  ctx.lineTo(x - w / 2 + r, y + h / 2);
  ctx.quadraticCurveTo(x - w / 2, y + h / 2, x - w / 2, y + h / 2 - r);
  ctx.lineTo(x - w / 2, y - h / 2 + r);
  ctx.quadraticCurveTo(x - w / 2, y - h / 2, x - w / 2 + r, y - h / 2);
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.fill();
  setStroke(ctx, 2.5);
  ctx.stroke();
  // Text
  ctx.fillStyle = OUTLINE_COLOR;
  ctx.font = `bold ${Math.floor(s * 0.18)}px sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(text, x, y);
}

function drawSwirl(ctx: Ctx, x: number, y: number, r: number, color: string) {
  ctx.beginPath();
  const turns = 2.5;
  const steps = 60;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const angle = t * turns * Math.PI * 2;
    const rad = r * 0.15 + t * r * 0.75;
    const px = x + Math.cos(angle) * rad;
    const py = y + Math.sin(angle) * rad;
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }
  ctx.strokeStyle = color;
  ctx.lineWidth = 3;
  ctx.lineCap = "round";
  ctx.stroke();
  // Outline
  setStroke(ctx, 1.5);
  ctx.stroke();
}

function drawChip(ctx: Ctx, x: number, y: number, r: number, color: string) {
  // Outer circle
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.fill();
  setStroke(ctx, 2.5);
  ctx.stroke();
  // Edge notches
  for (let i = 0; i < 8; i++) {
    const angle = (i / 8) * Math.PI * 2;
    const nx = x + Math.cos(angle) * r * 0.85;
    const ny = y + Math.sin(angle) * r * 0.85;
    ctx.beginPath();
    ctx.arc(nx, ny, r * 0.1, 0, Math.PI * 2);
    ctx.fillStyle = "#FFFFFF";
    ctx.fill();
  }
  // Inner circle
  ctx.beginPath();
  ctx.arc(x, y, r * 0.55, 0, Math.PI * 2);
  ctx.fillStyle = "#FFFFFF";
  ctx.fill();
  setStroke(ctx, 1.5);
  ctx.stroke();
  // Value
  ctx.fillStyle = color;
  ctx.font = `bold ${Math.floor(r * 0.6)}px sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText("★", x, y + 1);
}

function drawExclamation(ctx: Ctx, x: number, y: number, s: number, color: string) {
  // Body
  ctx.beginPath();
  ctx.moveTo(x - s * 0.08, y - s * 0.35);
  ctx.lineTo(x + s * 0.08, y - s * 0.35);
  ctx.lineTo(x + s * 0.05, y + s * 0.1);
  ctx.lineTo(x - s * 0.05, y + s * 0.1);
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.fill();
  setStroke(ctx, 2);
  ctx.stroke();
  // Dot
  ctx.beginPath();
  ctx.arc(x, y + s * 0.25, s * 0.06, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.fill();
  setStroke(ctx, 2);
  ctx.stroke();
}

function drawArrow(ctx: Ctx, x: number, y: number, s: number, color: string) {
  ctx.beginPath();
  ctx.moveTo(x + s * 0.4, y);
  ctx.lineTo(x + s * 0.1, y - s * 0.2);
  ctx.lineTo(x + s * 0.1, y - s * 0.08);
  ctx.lineTo(x - s * 0.4, y - s * 0.08);
  ctx.lineTo(x - s * 0.4, y + s * 0.08);
  ctx.lineTo(x + s * 0.1, y + s * 0.08);
  ctx.lineTo(x + s * 0.1, y + s * 0.2);
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.fill();
  setStroke(ctx, 2.5);
  ctx.stroke();
}

function drawMoneyBag(ctx: Ctx, x: number, y: number, s: number, color: string) {
  // Bag body (pear shape)
  ctx.beginPath();
  ctx.moveTo(x, y - s * 0.35);
  ctx.bezierCurveTo(x + s * 0.15, y - s * 0.4, x + s * 0.1, y - s * 0.45, x, y - s * 0.42);
  ctx.bezierCurveTo(x - s * 0.1, y - s * 0.45, x - s * 0.15, y - s * 0.4, x, y - s * 0.35);
  ctx.moveTo(x, y - s * 0.35);
  ctx.bezierCurveTo(x + s * 0.4, y - s * 0.15, x + s * 0.4, y + s * 0.35, x, y + s * 0.4);
  ctx.bezierCurveTo(x - s * 0.4, y + s * 0.35, x - s * 0.4, y - s * 0.15, x, y - s * 0.35);
  ctx.fillStyle = color;
  ctx.fill();
  setStroke(ctx, 2.5);
  ctx.stroke();
  // Dollar sign
  ctx.fillStyle = OUTLINE_COLOR;
  ctx.font = `bold ${Math.floor(s * 0.35)}px sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText("$", x, y + s * 0.05);
}

// ── Doodle element dispatcher ────────────────────────────────────────────────

type DoodleFn = (ctx: Ctx, x: number, y: number, size: number, color: string) => void;

const DOODLE_ELEMENTS: { fn: DoodleFn; weight: number; extra?: string }[] = [
  { fn: drawStar, weight: 3 },
  { fn: drawCoin, weight: 4 },
  { fn: drawDice, weight: 3 },
  { fn: drawHeart, weight: 2 },
  { fn: drawSmiley, weight: 3 },
  { fn: drawLightning, weight: 2 },
  { fn: drawDiamond, weight: 2 },
  { fn: drawCrown, weight: 1 },
  { fn: drawChip, weight: 3 },
  { fn: drawExclamation, weight: 1 },
  { fn: drawArrow, weight: 2 },
  { fn: drawSwirl, weight: 1 },
  { fn: drawMoneyBag, weight: 2 },
  { fn: (ctx, x, y, s, c) => drawSpeechBubble(ctx, x, y, s, c, "WIN!"), weight: 1, extra: "WIN!" },
  { fn: (ctx, x, y, s, c) => drawSpeechBubble(ctx, x, y, s, c, "POW!"), weight: 1, extra: "POW!" },
  { fn: (ctx, x, y, s, c) => drawSpeechBubble(ctx, x, y, s, c, "JACKPOT!"), weight: 1, extra: "JACKPOT!" },
  { fn: (ctx, x, y, s, c) => drawSpeechBubble(ctx, x, y, s, c, "ZAP!"), weight: 1, extra: "ZAP!" },
];

function pickDoodle(rng: () => number): DoodleFn {
  let total = 0;
  for (const e of DOODLE_ELEMENTS) total += e.weight;
  let r = rng() * total;
  for (const e of DOODLE_ELEMENTS) {
    r -= e.weight;
    if (r <= 0) return e.fn;
  }
  return DOODLE_ELEMENTS[0].fn;
}

// ── Main Generator ───────────────────────────────────────────────────────────

interface DoodleConfig {
  size: number;
  /** Number of doodle elements to place */
  count: number;
  /** Min element size */
  minSize: number;
  /** Max element size */
  maxSize: number;
  /** Outline thickness multiplier */
  outlineScale: number;
}

const DEFAULT_CONFIG: DoodleConfig = {
  size: 1024,
  count: 65,
  minSize: 40,
  maxSize: 85,
  outlineScale: 1.0,
};

function drawDoodleWall(ctx: Ctx, cfg: DoodleConfig, seed: number): void {
  const rng = makeRng(seed);
  const { size, count, minSize, maxSize } = cfg;

  // Fill background with warm paper color
  ctx.fillStyle = BG_COLOR;
  ctx.fillRect(0, 0, size, size);

  // Add subtle paper grain dots
  for (let i = 0; i < 800; i++) {
    const gx = rng() * size;
    const gy = rng() * size;
    const ga = 0.03 + rng() * 0.05;
    ctx.fillStyle = `rgba(180, 160, 130, ${ga})`;
    ctx.fillRect(gx, gy, 1 + rng() * 2, 1 + rng() * 2);
  }

  // Place doodle elements with slight overlap for sticker bomb density
  for (let i = 0; i < count; i++) {
    const x = rng() * size;
    const y = rng() * size;
    const s = minSize + rng() * (maxSize - minSize);
    const color = pickColor(rng, true);
    const doodle = pickDoodle(rng);

    ctx.save();
    ctx.translate(x, y);
    ctx.rotate((rng() - 0.5) * 0.6); // slight random rotation
    ctx.translate(-x, -y);

    doodle(ctx, x, y, s, color);

    ctx.restore();

    // Wrap around edges for seamless tiling
    if (x + s / 2 > size) {
      ctx.save();
      ctx.translate(x - size, y);
      ctx.rotate((rng() - 0.5) * 0.3);
      ctx.translate(-(x - size), -y);
      doodle(ctx, x - size, y, s, color);
      ctx.restore();
    }
    if (y + s / 2 > size) {
      ctx.save();
      ctx.translate(x, y - size);
      ctx.rotate((rng() - 0.5) * 0.3);
      ctx.translate(-x, -(y - size));
      doodle(ctx, x, y - size, s, color);
      ctx.restore();
    }
  }

  // Add scattered tiny stars/dots to fill remaining gaps
  for (let i = 0; i < 40; i++) {
    const sx = rng() * size;
    const sy = rng() * size;
    const sr = 3 + rng() * 6;
    ctx.fillStyle = pickColor(rng);
    ctx.beginPath();
    // Tiny 4-point star
    for (let j = 0; j < 8; j++) {
      const angle = (j / 8) * Math.PI * 2;
      const rad = j % 2 === 0 ? sr : sr * 0.3;
      const px = sx + Math.cos(angle) * rad;
      const py = sy + Math.sin(angle) * rad;
      if (j === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.closePath();
    ctx.fill();
  }
}

// ── Public API ───────────────────────────────────────────────────────────────

export function createDoodleTexture(
  scene: Scene,
  name: string,
  seed = 42424,
  config?: Partial<DoodleConfig>,
): Texture {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  const dt = new DynamicTexture(name, cfg.size, scene, true);
  const ctx = dt.getContext() as unknown as CanvasRenderingContext2D;

  drawDoodleWall(ctx, cfg, seed);

  dt.update();
  dt.uScale = 2;
  dt.vScale = 2;

  return dt;
}
