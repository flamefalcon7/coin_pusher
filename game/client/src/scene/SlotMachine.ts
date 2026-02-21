import {
  Scene,
  Mesh,
  MeshBuilder,
  Vector3,
  Color3,
  TransformNode,
  DynamicTexture,
  StandardMaterial,
} from "@babylonjs/core";
import { SCENE_CONFIG, SLOT_MACHINE_CONFIG } from "@coin-pusher/shared";
import type { SlotSymbol } from "@coin-pusher/shared";
import { createToonMat } from "./ToonMaterial";

// ── Colors ───────────────────────────────────────────────────────────────────
const WINDOW_BG_COLOR = new Color3(0.06, 0.06, 0.10); // dark screen background
const PANEL_COLOR = new Color3(0.12, 0.12, 0.16);      // dark bottom panel
const OUTLINE_COLOR = new Color3(0.08, 0.08, 0.08);    // near-black outlines

// Symbol display config
const SYMBOL_MAP: Record<SlotSymbol, { char: string; color: string }> = {
  bitcoin:  { char: "\u20BF", color: "#F7931A" },  // ₿
  ethereum: { char: "\u039E", color: "#627EEA" },   // Ξ
  solana:   { char: "\u25CE", color: "#9945FF" },   // ◎
};

const ALL_SYMBOLS = SLOT_MACHINE_CONFIG.SYMBOLS;

export class SlotMachine {
  private group: TransformNode;
  private symbolPlanes: Mesh[] = [];
  private symbolTextures: DynamicTexture[] = [];
  private counterTexture: DynamicTexture | null = null;
  private spinning: boolean = false;
  private spinTimers: ReturnType<typeof setInterval>[] = [];
  private spinTimeouts: ReturnType<typeof setTimeout>[] = [];
  private currentSymbols: SlotSymbol[] = ["bitcoin", "bitcoin", "bitcoin"];
  private winY: number = 0;
  private winH: number = 0;

  constructor(scene: Scene, position: Vector3, parent?: TransformNode) {
    this.group = new TransformNode("slotMachine", scene);
    this.group.position = position;
    if (parent) {
      this.group.parent = parent;
    }

    const cfg = SCENE_CONFIG.SLOT_MACHINE;
    const W = cfg.WIDTH;   // 0.28
    const H = cfg.HEIGHT;  // 0.45

    // Wider display (1.6× original width)
    const dispW = W * 1.6;

    // ── Materials ─────────────────────────────────────────────────────
    const windowMat = createToonMat("slotWindowMat", WINDOW_BG_COLOR, scene);
    const panelMat = createToonMat("slotPanelMat", PANEL_COLOR, scene);
    const outlineMat = createToonMat("slotOutlineMat", OUTLINE_COLOR, scene);

    // ── Reel window ─────────────────────────────────────────────────
    this.winH = H * 0.40;
    const winD = 0.015;
    this.winY = H * 0.55;
    const winH = this.winH;
    const winY = this.winY;

    const windowBg = MeshBuilder.CreateBox("slotWindow", {
      width: dispW, height: winH, depth: winD,
    }, scene);
    windowBg.position = new Vector3(0, winY, 0.001);
    windowBg.material = windowMat;
    windowBg.parent = this.group;

    // ── 3 Symbol planes (no cylinders) ──────────────────────────────
    const reelSpacing = dispW / 3;
    const symbolSize = Math.min(winH, reelSpacing) * 0.85 * 0.85;

    for (let i = 0; i < 3; i++) {
      const rx = -reelSpacing + reelSpacing * i;

      const symbolPlane = MeshBuilder.CreatePlane(`slotSymbol${i}`, {
        width: symbolSize,
        height: symbolSize,
      }, scene);
      symbolPlane.position = new Vector3(rx, winY, winD / 2 + 0.008);
      symbolPlane.parent = this.group;

      // DynamicTexture for symbol rendering
      const texSize = 128;
      const dynTex = new DynamicTexture(`slotSymbolTex${i}`, texSize, scene, false);
      dynTex.hasAlpha = true;
      const symMat = new StandardMaterial(`slotSymbolMat${i}`, scene);
      symMat.diffuseTexture = dynTex;
      symMat.emissiveColor = new Color3(0.8, 0.8, 0.8);
      symMat.useAlphaFromDiffuseTexture = true;
      symMat.backFaceCulling = false;
      symbolPlane.material = symMat;

      this.symbolPlanes.push(symbolPlane);
      this.symbolTextures.push(dynTex);
    }

    // Draw initial symbols
    this.drawSymbol(0, "bitcoin");
    this.drawSymbol(1, "bitcoin");
    this.drawSymbol(2, "bitcoin");

    // ── Divider lines between reels ───────────────────────────────────
    for (let i = 0; i < 2; i++) {
      const divX = -reelSpacing / 2 + reelSpacing * i;
      const div = MeshBuilder.CreateBox(`slotDiv${i}`, {
        width: 0.005, height: winH * 0.9, depth: winD + 0.01,
      }, scene);
      div.position = new Vector3(divX, winY, 0.005);
      div.material = outlineMat;
      div.parent = this.group;
    }

    // ── Bottom counter panel ─────────────────────────────────────────
    const panelW = dispW * 0.85;
    const panelH = H * 0.12;
    const panelD = 0.012;
    const panelY = winY - winH / 2 - panelH / 2 - 0.008;

    const panel = MeshBuilder.CreateBox("slotPanel", {
      width: panelW, height: panelH, depth: panelD,
    }, scene);
    panel.position = new Vector3(0, panelY, 0.002);
    panel.material = panelMat;
    panel.parent = this.group;

    // Counter display plane
    const counterPlane = MeshBuilder.CreatePlane("slotCounter", {
      width: panelW * 0.9,
      height: panelH * 0.8,
    }, scene);
    counterPlane.position = new Vector3(0, panelY, panelD / 2 + 0.003);
    counterPlane.parent = this.group;

    const counterTex = new DynamicTexture("slotCounterTex", { width: 256, height: 64 }, scene, false);
    counterTex.hasAlpha = true;
    const counterMat = new StandardMaterial("slotCounterMat", scene);
    counterMat.diffuseTexture = counterTex;
    counterMat.emissiveColor = new Color3(0.9, 0.9, 0.9);
    counterMat.useAlphaFromDiffuseTexture = true;
    counterMat.backFaceCulling = false;
    counterPlane.material = counterMat;
    this.counterTexture = counterTex;

    // Draw initial counter
    this.drawCounter(0);

    console.log("  \u2713 Slot machine created");
  }

  // ── Symbol Drawing ────────────────────────────────────────────────────

  private drawSymbol(reelIndex: number, symbol: SlotSymbol): void {
    const tex = this.symbolTextures[reelIndex];
    if (!tex) return;

    const ctx = tex.getContext() as unknown as CanvasRenderingContext2D;
    const size = tex.getSize().width;
    ctx.clearRect(0, 0, size, size);

    const info = SYMBOL_MAP[symbol];
    ctx.fillStyle = info.color;
    ctx.font = `bold ${Math.floor(size * 0.6)}px Arial, sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(info.char, size / 2, size / 2);

    tex.update();
    this.currentSymbols[reelIndex] = symbol;
  }

  // ── Counter Drawing ───────────────────────────────────────────────────

  private drawCounter(count: number): void {
    const tex = this.counterTexture;
    if (!tex) return;

    const ctx = tex.getContext() as unknown as CanvasRenderingContext2D;
    const w = tex.getSize().width;
    const h = tex.getSize().height;
    ctx.clearRect(0, 0, w, h);

    ctx.fillStyle = "#FFD700";
    ctx.font = `bold ${Math.floor(h * 0.6)}px monospace`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(`${count}/${SLOT_MACHINE_CONFIG.TRIGGER_COUNT}`, w / 2, h / 2);

    tex.update();
  }

  // ── Public API ────────────────────────────────────────────────────────

  updateCounter(counter: number): void {
    this.drawCounter(counter);
  }

  spinReels(results: [SlotSymbol, SlotSymbol, SlotSymbol], jackpot: boolean, onComplete?: () => void): void {
    if (this.spinning) return;
    this.spinning = true;

    // Clear any existing timers
    this.clearSpinTimers();

    const topEdge = this.winY + this.winH / 2;
    const bottomEdge = this.winY - this.winH / 2;
    const step = this.winH * 0.08; // scroll step per tick

    // Stop times for each reel (staggered)
    const stopTimes = [1500, 2500, 3500];

    for (let i = 0; i < 3; i++) {
      const plane = this.symbolPlanes[i];
      let symbolIndex = 0;

      // Fast spin: scroll symbol plane downward
      const timer = setInterval(() => {
        plane.position.y -= step;

        // When plane drops below bottom edge, wrap to top with new symbol
        if (plane.position.y < bottomEdge) {
          symbolIndex = (symbolIndex + 1) % ALL_SYMBOLS.length;
          this.drawSymbol(i, ALL_SYMBOLS[symbolIndex]);
          plane.position.y = topEdge;
        }
      }, 80);
      this.spinTimers.push(timer);

      // Schedule stop for this reel
      const stopTimeout = setTimeout(() => {
        clearInterval(timer);

        // Slow-down phase: show 2 lead-in symbols then the result
        const slowSymbols = [
          ALL_SYMBOLS[(ALL_SYMBOLS.indexOf(results[i]) + 2) % ALL_SYMBOLS.length],
          ALL_SYMBOLS[(ALL_SYMBOLS.indexOf(results[i]) + 1) % ALL_SYMBOLS.length],
          results[i],
        ];
        let slowIdx = 0;
        let slowInterval = 150;
        const slowStep = step * 0.6;

        const slowDown = () => {
          if (slowIdx >= slowSymbols.length) {
            // Snap final symbol to center
            this.drawSymbol(i, results[i]);
            plane.position.y = this.winY;

            if (i === 2) {
              this.spinning = false;
              onComplete?.();
            }
            return;
          }

          // Start new symbol from top, scroll to center
          this.drawSymbol(i, slowSymbols[slowIdx]);
          plane.position.y = topEdge;

          const scrollToCenter = () => {
            plane.position.y -= slowStep;
            if (plane.position.y <= this.winY) {
              plane.position.y = this.winY;
              slowIdx++;
              slowInterval += 50;
              const t = setTimeout(slowDown, slowInterval);
              this.spinTimeouts.push(t);
            } else {
              const t = setTimeout(scrollToCenter, 30);
              this.spinTimeouts.push(t);
            }
          };
          scrollToCenter();
        };

        // Start from top for first slow symbol
        plane.position.y = topEdge;
        slowDown();
      }, stopTimes[i]);
      this.spinTimeouts.push(stopTimeout);
    }
  }

  private clearSpinTimers(): void {
    for (const t of this.spinTimers) clearInterval(t);
    for (const t of this.spinTimeouts) clearTimeout(t);
    this.spinTimers = [];
    this.spinTimeouts = [];
  }

  getGroup(): TransformNode {
    return this.group;
  }

  getReels(): Mesh[] {
    return this.symbolPlanes;
  }

  dispose(): void {
    this.clearSpinTimers();
    for (const tex of this.symbolTextures) tex.dispose();
    this.counterTexture?.dispose();
    this.group.dispose(false, true);
  }
}
