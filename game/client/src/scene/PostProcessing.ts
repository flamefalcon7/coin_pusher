import { Scene, DefaultRenderingPipeline, PostProcess, Effect, Color4 } from "@babylonjs/core";

// ── Sobel Outline Fragment Shader ─────────────────────────────────────────────
const SOBEL_OUTLINE_FRAGMENT = `
precision highp float;

varying vec2 vUV;
uniform sampler2D textureSampler;
uniform sampler2D depthSampler;
uniform vec2 screenSize;
uniform float outlineStrength;
uniform float outlineNearScale;
uniform float outlineFarScale;
uniform vec2 outlineDepthRange;

float luminance(vec3 c) {
    return dot(c, vec3(0.299, 0.587, 0.114));
}

void main() {
    float centerDepth = texture2D(depthSampler, vUV).r;
    float depthFactor = smoothstep(outlineDepthRange.x, outlineDepthRange.y, centerDepth);
    float scale = mix(outlineNearScale, outlineFarScale, depthFactor);
    vec2 texel = scale / screenSize;
    vec4 center = texture2D(textureSampler, vUV);

    // Depth-based Sobel
    float d00 = texture2D(depthSampler, vUV + vec2(-texel.x, -texel.y)).r;
    float d10 = texture2D(depthSampler, vUV + vec2( 0.0,    -texel.y)).r;
    float d20 = texture2D(depthSampler, vUV + vec2( texel.x, -texel.y)).r;
    float d01 = texture2D(depthSampler, vUV + vec2(-texel.x,  0.0)).r;
    float d21 = texture2D(depthSampler, vUV + vec2( texel.x,  0.0)).r;
    float d02 = texture2D(depthSampler, vUV + vec2(-texel.x,  texel.y)).r;
    float d12 = texture2D(depthSampler, vUV + vec2( 0.0,     texel.y)).r;
    float d22 = texture2D(depthSampler, vUV + vec2( texel.x,  texel.y)).r;

    float sobelX_depth = -d00 - 2.0*d01 - d02 + d20 + 2.0*d21 + d22;
    float sobelY_depth = -d00 - 2.0*d10 - d20 + d02 + 2.0*d12 + d22;
    float edgeDepth = sqrt(sobelX_depth * sobelX_depth + sobelY_depth * sobelY_depth);

    // Luminance-based Sobel
    float l00 = luminance(texture2D(textureSampler, vUV + vec2(-texel.x, -texel.y)).rgb);
    float l10 = luminance(texture2D(textureSampler, vUV + vec2( 0.0,    -texel.y)).rgb);
    float l20 = luminance(texture2D(textureSampler, vUV + vec2( texel.x, -texel.y)).rgb);
    float l01 = luminance(texture2D(textureSampler, vUV + vec2(-texel.x,  0.0)).rgb);
    float l21 = luminance(texture2D(textureSampler, vUV + vec2( texel.x,  0.0)).rgb);
    float l02 = luminance(texture2D(textureSampler, vUV + vec2(-texel.x,  texel.y)).rgb);
    float l12 = luminance(texture2D(textureSampler, vUV + vec2( 0.0,     texel.y)).rgb);
    float l22 = luminance(texture2D(textureSampler, vUV + vec2( texel.x,  texel.y)).rgb);

    float sobelX_lum = -l00 - 2.0*l01 - l02 + l20 + 2.0*l21 + l22;
    float sobelY_lum = -l00 - 2.0*l10 - l20 + l02 + 2.0*l12 + l22;
    float edgeLum = sqrt(sobelX_lum * sobelX_lum + sobelY_lum * sobelY_lum);

    // Combine edges
    float edge = smoothstep(0.01, 0.14, edgeDepth * 40.0 + edgeLum * 1.5);

    // Dark outline color (near-black with slight purple tint)
    vec3 outlineColor = vec3(0.05, 0.03, 0.08);
    vec3 result = mix(center.rgb, outlineColor, edge * outlineStrength);

    gl_FragColor = vec4(result, center.a);
}
`;

// Register in Effect store
Effect.ShadersStore["sobelOutlineFragmentShader"] = SOBEL_OUTLINE_FRAGMENT;

export class PostProcessing {
  private pipeline: DefaultRenderingPipeline;
  private sobelOutline: PostProcess;

  constructor(scene: Scene) {
    const camera = scene.activeCamera;
    if (!camera) {
      throw new Error("PostProcessing requires an active camera");
    }

    // ── Sobel Outline (created BEFORE pipeline so FXAA smooths it) ──────
    const depthRenderer = scene.enableDepthRenderer(camera, false, false);
    this.sobelOutline = new PostProcess(
      "sobelOutline",
      "sobelOutline",
      ["screenSize", "outlineStrength", "outlineNearScale", "outlineFarScale", "outlineDepthRange"],
      ["depthSampler"],
      1.0,
      camera,
    );
    let _outlineStrength = 0.85;
    let _outlineNearScale = 1.2;
    let _outlineFarScale = 0.5;
    let _outlineDepthRange: [number, number] = [0.0, 1.0];
    this.sobelOutline.onApply = (effect) => {
      effect.setFloat2("screenSize", this.sobelOutline.width, this.sobelOutline.height);
      effect.setTexture("depthSampler", depthRenderer.getDepthMap());
      effect.setFloat("outlineStrength", _outlineStrength);
      effect.setFloat("outlineNearScale", _outlineNearScale);
      effect.setFloat("outlineFarScale", _outlineFarScale);
      effect.setFloat2("outlineDepthRange", _outlineDepthRange[0], _outlineDepthRange[1]);
    };
    // Expose setter via closure (used by debug GUI)
    (this.sobelOutline as any)._setOutlineStrength = (v: number) => { _outlineStrength = v; };
    (this.sobelOutline as any)._getOutlineStrength = () => _outlineStrength;
    (this.sobelOutline as any)._setOutlineNearScale = (v: number) => { _outlineNearScale = v; };
    (this.sobelOutline as any)._getOutlineNearScale = () => _outlineNearScale;
    (this.sobelOutline as any)._setOutlineFarScale = (v: number) => { _outlineFarScale = v; };
    (this.sobelOutline as any)._getOutlineFarScale = () => _outlineFarScale;
    (this.sobelOutline as any)._setOutlineDepthRange = (v: [number, number]) => { _outlineDepthRange = v; };
    (this.sobelOutline as any)._getOutlineDepthRange = () => _outlineDepthRange;

    // ── Default Rendering Pipeline ──────────────────────────────────────
    this.pipeline = new DefaultRenderingPipeline(
      "toonPipeline",
      true, // HDR
      scene,
      [camera]
    );

    // Image processing: contrast + exposure
    this.pipeline.imageProcessingEnabled = true;
    this.pipeline.imageProcessing.contrast = 1.3;
    this.pipeline.imageProcessing.exposure = 1.1;
    this.pipeline.imageProcessing.colorCurvesEnabled = true;

    // Bloom — amplifies rim light and glow effects
    this.pipeline.bloomEnabled = true;
    this.pipeline.bloomThreshold = 0.7;
    this.pipeline.bloomWeight = 0.4;
    this.pipeline.bloomKernel = 64;
    this.pipeline.bloomScale = 0.5;

    // Chromatic aberration
    this.pipeline.chromaticAberrationEnabled = true;
    this.pipeline.chromaticAberration.aberrationAmount = 1;

    // Vignette
    this.pipeline.imageProcessing.vignetteEnabled = true;
    this.pipeline.imageProcessing.vignetteWeight = 2.5;
    this.pipeline.imageProcessing.vignetteColor = new Color4(0.05, 0.03, 0.1, 1);

    // FXAA for smoother outlines
    this.pipeline.fxaaEnabled = true;

    console.log("✨ Post-processing initialized (Sobel outline, bloom, vignette, chromatic aberration, FXAA)");
  }

  getPipeline(): DefaultRenderingPipeline {
    return this.pipeline;
  }

  getSobelOutline(): PostProcess {
    return this.sobelOutline;
  }

  dispose(): void {
    this.sobelOutline.dispose();
    this.pipeline.dispose();
  }
}
