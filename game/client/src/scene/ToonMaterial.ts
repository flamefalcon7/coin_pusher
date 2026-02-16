import { Effect, ShaderMaterial, Scene, Color3, Vector3 } from "@babylonjs/core";

// ── Vertex Shader ──────────────────────────────────────────────────────────
const VERTEX_SHADER = `
precision highp float;

// Attributes
attribute vec3 position;
attribute vec3 normal;

#ifdef THIN_INSTANCES
attribute vec4 world0;
attribute vec4 world1;
attribute vec4 world2;
attribute vec4 world3;
#endif

// Uniforms
uniform mat4 viewProjection;
#ifndef THIN_INSTANCES
uniform mat4 world;
#endif

// Varyings
varying vec3 vWorldNormal;
varying vec3 vWorldPos;

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

    gl_Position = viewProjection * worldPos;
}
`;

// ── Fragment Shader ────────────────────────────────────────────────────────
const FRAGMENT_SHADER = `
precision highp float;

varying vec3 vWorldNormal;
varying vec3 vWorldPos;

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

  const mat = new ShaderMaterial(name, scene, "toon", {
    attributes: thinInstances
      ? ["position", "normal", "world0", "world1", "world2", "world3"]
      : ["position", "normal"],
    uniforms: [
      "world",
      "viewProjection",
      "baseColor",
      "shadowTint",
      "lightDirection",
      "cameraPosition",
      "emissiveColor",
    ],
    defines,
  });

  mat.setColor3("baseColor", baseColor);
  mat.setColor3("shadowTint", shadowTint);
  mat.setColor3("emissiveColor", Color3.Black());
  mat.setVector3("lightDirection", new Vector3(0.3, -0.7, 0.5));

  // Backface culling on by default
  mat.backFaceCulling = true;

  return mat;
}
