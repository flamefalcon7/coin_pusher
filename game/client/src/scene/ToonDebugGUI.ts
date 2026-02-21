import GUI from "lil-gui";
import { Vector3 } from "@babylonjs/core";
import type { SceneManager } from "./SceneManager";

export class ToonDebugGUI {
  private gui: GUI;

  constructor(sceneManager: SceneManager) {
    const pp = sceneManager.getPostProcessing();
    const pipeline = pp.getPipeline();
    const sobel = pp.getSobelOutline();
    const mats = sceneManager.getAllToonMats();

    this.gui = new GUI({ title: "Toon Debug" });

    // ── Shader folder ───────────────────────────────────────────────────
    const shaderFolder = this.gui.addFolder("Shader");

    const shaderParams = {
      rimPower: 3.0,
      specPower: 32.0,
      celShading: true,
      lightX: 0.3,
      lightY: -0.7,
      lightZ: 0.5,
    };

    shaderFolder.add(shaderParams, "rimPower", 0.5, 8, 0.1).onChange((v: number) => {
      for (const mat of mats) mat.setFloat("rimPower", v);
    });
    shaderFolder.add(shaderParams, "specPower", 4, 128, 1).onChange((v: number) => {
      for (const mat of mats) mat.setFloat("specPower", v);
    });
    shaderFolder.add(shaderParams, "celShading").onChange((v: boolean) => {
      for (const mat of mats) mat.setFloat("useCelShading", v ? 1.0 : 0.0);
    });

    const updateLight = () => {
      sceneManager.setLightDirection(new Vector3(shaderParams.lightX, shaderParams.lightY, shaderParams.lightZ));
    };
    shaderFolder.add(shaderParams, "lightX", -1, 1, 0.01).name("light X").onChange(updateLight);
    shaderFolder.add(shaderParams, "lightY", -1, 1, 0.01).name("light Y").onChange(updateLight);
    shaderFolder.add(shaderParams, "lightZ", -1, 1, 0.01).name("light Z").onChange(updateLight);

    // ── Bloom folder ────────────────────────────────────────────────────
    const bloomFolder = this.gui.addFolder("Bloom");

    const bloomParams = {
      enabled: pipeline.bloomEnabled,
      weight: pipeline.bloomWeight,
      threshold: pipeline.bloomThreshold,
      kernel: pipeline.bloomKernel,
      scale: pipeline.bloomScale,
    };

    bloomFolder.add(bloomParams, "enabled").onChange((v: boolean) => { pipeline.bloomEnabled = v; });
    bloomFolder.add(bloomParams, "weight", 0, 1, 0.01).onChange((v: number) => { pipeline.bloomWeight = v; });
    bloomFolder.add(bloomParams, "threshold", 0, 1, 0.01).onChange((v: number) => { pipeline.bloomThreshold = v; });
    bloomFolder.add(bloomParams, "kernel", 16, 256, 16).onChange((v: number) => { pipeline.bloomKernel = v; });
    bloomFolder.add(bloomParams, "scale", 0, 1, 0.01).onChange((v: number) => { pipeline.bloomScale = v; });

    // ── Image folder ────────────────────────────────────────────────────
    const imageFolder = this.gui.addFolder("Image");

    const imageParams = {
      contrast: pipeline.imageProcessing.contrast,
      exposure: pipeline.imageProcessing.exposure,
      vignetteEnabled: pipeline.imageProcessing.vignetteEnabled,
      vignetteWeight: pipeline.imageProcessing.vignetteWeight,
      chromaticAberration: pipeline.chromaticAberration.aberrationAmount,
      fxaa: pipeline.fxaaEnabled,
    };

    imageFolder.add(imageParams, "contrast", 0.5, 3, 0.01).onChange((v: number) => { pipeline.imageProcessing.contrast = v; });
    imageFolder.add(imageParams, "exposure", 0.5, 3, 0.01).onChange((v: number) => { pipeline.imageProcessing.exposure = v; });
    imageFolder.add(imageParams, "vignetteEnabled").onChange((v: boolean) => { pipeline.imageProcessing.vignetteEnabled = v; });
    imageFolder.add(imageParams, "vignetteWeight", 0, 5, 0.1).onChange((v: number) => { pipeline.imageProcessing.vignetteWeight = v; });
    imageFolder.add(imageParams, "chromaticAberration", 0, 30, 0.5).onChange((v: number) => { pipeline.chromaticAberration.aberrationAmount = v; });
    imageFolder.add(imageParams, "fxaa").onChange((v: boolean) => { pipeline.fxaaEnabled = v; });

    // ── Outline folder ──────────────────────────────────────────────────
    const outlineFolder = this.gui.addFolder("Outline");

    const depthRange = (sobel as any)._getOutlineDepthRange?.() ?? [0.0, 1.0];
    const outlineParams = {
      enabled: true,
      strength: (sobel as any)._getOutlineStrength?.() ?? 0.85,
      nearScale: (sobel as any)._getOutlineNearScale?.() ?? 2.0,
      farScale: (sobel as any)._getOutlineFarScale?.() ?? 0.5,
      depthNear: depthRange[0] as number,
      depthFar: depthRange[1] as number,
    };

    // Cache strength so we can restore after re-enable
    let cachedStrength = outlineParams.strength;

    outlineFolder.add(outlineParams, "enabled").onChange((v: boolean) => {
      if (v) {
        (sobel as any)._setOutlineStrength?.(cachedStrength);
      } else {
        (sobel as any)._setOutlineStrength?.(0);
      }
    });
    outlineFolder.add(outlineParams, "strength", 0, 1, 0.01).onChange((v: number) => {
      cachedStrength = v;
      if (outlineParams.enabled) {
        (sobel as any)._setOutlineStrength?.(v);
      }
    });
    outlineFolder.add(outlineParams, "nearScale", 0.5, 4.0, 0.1).onChange((v: number) => {
      (sobel as any)._setOutlineNearScale?.(v);
    });
    outlineFolder.add(outlineParams, "farScale", 0.1, 2.0, 0.1).onChange((v: number) => {
      (sobel as any)._setOutlineFarScale?.(v);
    });
    outlineFolder.add(outlineParams, "depthNear", 0.0, 1.0, 0.01).onChange((v: number) => {
      const range = (sobel as any)._getOutlineDepthRange?.() ?? [0.0, 1.0];
      (sobel as any)._setOutlineDepthRange?.([v, range[1]]);
    });
    outlineFolder.add(outlineParams, "depthFar", 0.0, 1.0, 0.01).onChange((v: number) => {
      const range = (sobel as any)._getOutlineDepthRange?.() ?? [0.0, 1.0];
      (sobel as any)._setOutlineDepthRange?.([range[0], v]);
    });
  }

  dispose(): void {
    this.gui.destroy();
  }
}
