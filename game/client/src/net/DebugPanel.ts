import { debugConfig } from "./debugConfig";
import type { ClockSync } from "./ClockSync";
import type { StateBuffer } from "./StateBuffer";

/**
 * Real-time debug panel for tuning interpolation parameters.
 * Activated by ?debug=1 URL param. Renders a floating panel with sliders.
 */
export class DebugPanel {
  private container: HTMLDivElement;
  private statsEl: HTMLDivElement;
  private clockSync: ClockSync;
  private stateBuffer: StateBuffer;
  private rafId: number = 0;

  constructor(clockSync: ClockSync, stateBuffer: StateBuffer) {
    this.clockSync = clockSync;
    this.stateBuffer = stateBuffer;
    this.container = document.createElement("div");
    this.container.id = "debug-panel";
    Object.assign(this.container.style, {
      position: "fixed",
      top: "10px",
      right: "10px",
      width: "300px",
      background: "rgba(0,0,0,0.85)",
      color: "#0f0",
      fontFamily: "monospace",
      fontSize: "11px",
      padding: "10px",
      borderRadius: "6px",
      zIndex: "99999",
      userSelect: "none",
      maxHeight: "90vh",
      overflowY: "auto",
    });

    this.statsEl = document.createElement("div");
    this.statsEl.style.marginBottom = "8px";
    this.statsEl.style.borderBottom = "1px solid #333";
    this.statsEl.style.paddingBottom = "6px";
    this.container.appendChild(this.statsEl);

    this.addSlider("Delay Base", "interpolationDelayBase", 0, 300, 1, "ms");
    this.addSlider("Delay Multiplier", "interpolationDelayMultiplier", 0.5, 4, 0.1, "x");
    this.addSlider("Delay Min", "interpolationDelayMin", 0, 300, 1, "ms");
    this.addSlider("Delay Max", "interpolationDelayMax", 100, 1000, 10, "ms");
    this.addSlider("Extrap Max", "extrapolationMaxTime", 0, 500, 5, "ms");
    this.addToggle("Hermite", "useHermite");
    this.addToggle("Hermite Clamp", "hermiteClamp");

    // Reset button
    const resetBtn = document.createElement("button");
    resetBtn.textContent = "Reset Defaults";
    Object.assign(resetBtn.style, {
      marginTop: "8px",
      padding: "4px 8px",
      background: "#333",
      color: "#fff",
      border: "1px solid #555",
      borderRadius: "3px",
      cursor: "pointer",
      fontSize: "11px",
      width: "100%",
    });
    resetBtn.onclick = () => {
      debugConfig.interpolationDelayBase = 110;
      debugConfig.interpolationDelayMultiplier = 1.5;
      debugConfig.interpolationDelayMin = 100;
      debugConfig.interpolationDelayMax = 500;
      debugConfig.extrapolationMaxTime = 150;
      debugConfig.useHermite = true;
      debugConfig.hermiteClamp = true;
      // Refresh all inputs
      this.container.querySelectorAll<HTMLInputElement>("input[data-key]").forEach((input) => {
        const key = input.dataset.key as keyof typeof debugConfig;
        if (input.type === "checkbox") {
          input.checked = debugConfig[key] as boolean;
        } else {
          input.value = String(debugConfig[key]);
          const valSpan = input.parentElement?.querySelector(".val") as HTMLSpanElement;
          if (valSpan) valSpan.textContent = String(debugConfig[key]);
        }
      });
    };
    this.container.appendChild(resetBtn);

    // Copy button
    const copyBtn = document.createElement("button");
    copyBtn.textContent = "Copy Values";
    Object.assign(copyBtn.style, {
      marginTop: "4px",
      padding: "4px 8px",
      background: "#333",
      color: "#fff",
      border: "1px solid #555",
      borderRadius: "3px",
      cursor: "pointer",
      fontSize: "11px",
      width: "100%",
    });
    copyBtn.onclick = () => {
      const values = JSON.stringify(debugConfig, null, 2);
      navigator.clipboard.writeText(values);
      copyBtn.textContent = "Copied!";
      setTimeout(() => { copyBtn.textContent = "Copy Values"; }, 1000);
    };
    this.container.appendChild(copyBtn);

    document.body.appendChild(this.container);
    this.startStatsLoop();
  }

  private addSlider(
    label: string,
    key: keyof typeof debugConfig,
    min: number,
    max: number,
    step: number,
    unit: string,
  ): void {
    const row = document.createElement("div");
    row.style.marginBottom = "6px";

    const labelEl = document.createElement("div");
    labelEl.style.display = "flex";
    labelEl.style.justifyContent = "space-between";
    labelEl.innerHTML = `<span>${label}</span><span class="val">${debugConfig[key]}</span>`;
    row.appendChild(labelEl);

    const input = document.createElement("input");
    input.type = "range";
    input.min = String(min);
    input.max = String(max);
    input.step = String(step);
    input.value = String(debugConfig[key]);
    input.dataset.key = key;
    Object.assign(input.style, { width: "100%", accentColor: "#0f0" });

    const valSpan = labelEl.querySelector(".val") as HTMLSpanElement;
    input.oninput = () => {
      const v = parseFloat(input.value);
      (debugConfig as any)[key] = v;
      valSpan.textContent = `${v}${unit}`;
    };

    row.appendChild(input);
    this.container.appendChild(row);
  }

  private addToggle(label: string, key: keyof typeof debugConfig): void {
    const row = document.createElement("div");
    Object.assign(row.style, {
      marginBottom: "6px",
      display: "flex",
      justifyContent: "space-between",
      alignItems: "center",
    });

    const labelEl = document.createElement("span");
    labelEl.textContent = label;
    row.appendChild(labelEl);

    const input = document.createElement("input");
    input.type = "checkbox";
    input.checked = debugConfig[key] as boolean;
    input.dataset.key = key;
    input.onchange = () => {
      (debugConfig as any)[key] = input.checked;
    };

    row.appendChild(input);
    this.container.appendChild(row);
  }

  private startStatsLoop(): void {
    const update = () => {
      const rtt = this.clockSync.getRTT();
      const offset = this.clockSync.getOffset();
      const bufSize = this.stateBuffer.getBufferSize();
      const delay = Math.max(
        debugConfig.interpolationDelayMin,
        Math.min(debugConfig.interpolationDelayMax,
          Math.max(debugConfig.interpolationDelayBase, rtt * debugConfig.interpolationDelayMultiplier))
      );
      this.statsEl.innerHTML = [
        `RTT: ${rtt}ms | Offset: ${offset.toFixed(0)}ms`,
        `Buffer: ${bufSize} | Delay: ${delay.toFixed(0)}ms`,
        `Mode: ${debugConfig.useHermite ? "Hermite" : "LERP"}${debugConfig.hermiteClamp ? "+clamp" : ""}`,
      ].join("<br>");
      this.rafId = requestAnimationFrame(update);
    };
    this.rafId = requestAnimationFrame(update);
  }

  destroy(): void {
    cancelAnimationFrame(this.rafId);
    this.container.remove();
  }
}

/** Create debug panel if ?debug=1 is in the URL */
export function maybeCreateDebugPanel(clockSync: ClockSync, stateBuffer: StateBuffer): DebugPanel | null {
  const params = new URLSearchParams(window.location.search);
  if (params.get("debug") === "1") {
    return new DebugPanel(clockSync, stateBuffer);
  }
  return null;
}
