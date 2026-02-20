import { Effect, ShaderMaterial, Scene, Color3, Vector3, BaseTexture } from "@babylonjs/core";

// ── Vertex Shader ──────────────────────────────────────────────────────────
const VERTEX_SHADER = `
precision highp float;

// Attributes
attribute vec3 position;
attribute vec3 normal;
#ifdef USE_TEXTURE
attribute vec2 uv;
#endif

#ifdef THIN_INSTANCES
attribute vec4 world0;
attribute vec4 world1;
attribute vec4 world2;
attribute vec4 world3;
#endif

#if defined(USE_TEXTURE) && defined(THIN_INSTANCES)
attribute vec2 coinData;
#endif

// Uniforms
uniform mat4 viewProjection;
#ifndef THIN_INSTANCES
uniform mat4 world;
#endif

// Varyings
varying vec3 vWorldNormal;
varying vec3 vWorldPos;
#ifdef USE_TEXTURE
varying vec2 vUV;
#endif

#if defined(USE_TEXTURE) && defined(THIN_INSTANCES)
varying vec2 vCoinData;
#endif

void main() {
#ifdef THIN_INSTANCES
    mat4 worldMat = mat4(world0, world1, world2, world3);
#else
    mat4 worldMat = world;
#endif

    vec4 worldPos = worldMat * vec4(position, 1.0);
    vWorldPos = worldPos.xyz;

    // Transform normal (use inverse transpose for non-uniform scale)
    mat3 normalMat = mat3(worldMat);
    vWorldNormal = normalize(normalMat * normal);

#ifdef USE_TEXTURE
    vUV = uv;
#endif

#if defined(USE_TEXTURE) && defined(THIN_INSTANCES)
    vCoinData = coinData;
#endif

    gl_Position = viewProjection * worldPos;
}
`;

// ── Fragment Shader ────────────────────────────────────────────────────────
const FRAGMENT_SHADER = `
precision highp float;

varying vec3 vWorldNormal;
varying vec3 vWorldPos;
#ifdef USE_TEXTURE
varying vec2 vUV;
uniform sampler2D coinTexture;
uniform float time;
#endif

#if defined(USE_TEXTURE) && defined(THIN_INSTANCES)
varying vec2 vCoinData;
#endif

uniform vec3 baseColor;
uniform vec3 shadowTint;
uniform vec3 lightDirection;
uniform vec3 cameraPosition;
uniform vec3 emissiveColor;

void main() {
    vec3 N = normalize(vWorldNormal);
    vec3 L = normalize(-lightDirection);

    // 3-band stepped cel shading — keep colors bold, shadows subtle
    float NdotL = dot(N, L);
    float intensity;
    if (NdotL > 0.3) {
        intensity = 1.0;
    } else if (NdotL > -0.1) {
        intensity = 0.85;
    } else {
        intensity = 0.65;
    }

    // Shadows = darkened base color blended with subtle tint
    vec3 shadowColor = baseColor * 0.55 + shadowTint * 0.45;
    vec3 litColor = mix(shadowColor, baseColor, intensity);

    // Fresnel rim light
    vec3 V = normalize(cameraPosition - vWorldPos);
    float rim = 1.0 - max(dot(N, V), 0.0);
    rim = smoothstep(0.55, 0.75, rim);
    litColor += rim * 0.25;

    // Emissive (for shock effect glow)
    litColor += emissiveColor;

#ifdef USE_TEXTURE
    vec2 atlasUV = vUV;
#ifdef THIN_INSTANCES
    float col = mod(vCoinData.x, 4.0);
    float row = floor(vCoinData.x / 4.0);
    atlasUV = (vUV + vec2(col, row)) / 4.0;
#endif
    float symbol = texture2D(coinTexture, atlasUV).r;
    litColor += symbol * 0.2;
#ifdef THIN_INSTANCES
    if (vCoinData.y > 0.5) {
        litColor += baseColor * 0.4 * (0.7 + 0.3 * sin(time * 4.0));
    }
#endif
#endif

    gl_FragColor = vec4(litColor, 1.0);
}
`;

// Register shaders in BabylonJS Effect store
Effect.ShadersStore["toonVertexShader"] = VERTEX_SHADER;
Effect.ShadersStore["toonFragmentShader"] = FRAGMENT_SHADER;

export interface ToonMaterialOptions {
  name?: string;
  baseColor?: Color3;
  shadowTint?: Color3;
  thinInstances?: boolean;
  texture?: BaseTexture;
}

export function createToonMaterial(
  scene: Scene,
  options: ToonMaterialOptions = {}
): ShaderMaterial {
  const {
    name = "toonMat",
    baseColor = new Color3(0.7, 0.7, 0.7),
    shadowTint = new Color3(0.25, 0.22, 0.32),
    thinInstances = false,
  } = options;

  const defines: string[] = [];
  if (thinInstances) {
    defines.push("#define THIN_INSTANCES");
  }

  const attribs = ["position", "normal"];
  const samplers: string[] = [];

  if (options.texture) {
    defines.push("#define USE_TEXTURE");
    attribs.push("uv");
    samplers.push("coinTexture");
  }

  if (thinInstances) {
    attribs.push("world0", "world1", "world2", "world3");
  }

  if (options.texture && thinInstances) {
    attribs.push("coinData");
  }

  const uniforms = [
    "world",
    "viewProjection",
    "baseColor",
    "shadowTint",
    "lightDirection",
    "cameraPosition",
    "emissiveColor",
  ];

  if (options.texture) {
    uniforms.push("time");
  }

  const mat = new ShaderMaterial(name, scene, "toon", {
    attributes: attribs,
    uniforms,
    samplers,
    defines,
  });

  mat.setColor3("baseColor", baseColor);
  mat.setColor3("shadowTint", shadowTint);
  mat.setColor3("emissiveColor", Color3.Black());
  mat.setVector3("lightDirection", new Vector3(0.3, -0.7, 0.5));

  if (options.texture) {
    mat.setTexture("coinTexture", options.texture);
  }

  // Backface culling on by default
  mat.backFaceCulling = true;

  return mat;
}
