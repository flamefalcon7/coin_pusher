import { Scene, DefaultRenderingPipeline } from "@babylonjs/core";

export class PostProcessing {
  private pipeline: DefaultRenderingPipeline;

  constructor(scene: Scene) {
    const camera = scene.activeCamera;
    if (!camera) {
      throw new Error("PostProcessing requires an active camera");
    }

    this.pipeline = new DefaultRenderingPipeline(
      "toonPipeline",
      true, // HDR
      scene,
      [camera]
    );

    // Image processing: contrast + exposure + saturation
    this.pipeline.imageProcessingEnabled = true;
    this.pipeline.imageProcessing.contrast = 1.5;
    this.pipeline.imageProcessing.exposure = 1.05;
    this.pipeline.imageProcessing.colorCurvesEnabled = true;

    // Subtle bloom — amplifies shock effect glow
    this.pipeline.bloomEnabled = true;
    this.pipeline.bloomThreshold = 0.7;
    this.pipeline.bloomWeight = 0.25;
    this.pipeline.bloomKernel = 64;

    // FXAA for smoother outlines
    this.pipeline.fxaaEnabled = true;

    console.log("✨ Post-processing initialized (contrast, bloom, FXAA)");
  }

  getPipeline(): DefaultRenderingPipeline {
    return this.pipeline;
  }
}
