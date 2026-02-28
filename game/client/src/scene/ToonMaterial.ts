import { Effect, ShaderMaterial, Scene, Color3, Vector2, Vector3, Texture } from "@babylonjs/core";
import { deriveShadow, deriveHighlight } from "./ToonTheme";

// ── Vertex Shader ──────────────────────────────────────────────────────────
const VERTEX_SHADER = `
precision highp float;

// Attributes
attribute vec3 position;
attribute vec3 normal;
#ifdef DIFFUSE_TEX
attribute vec2 uv;
#endif

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
#ifdef DIFFUSE_TEX
varying vec2 vUV;
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

#ifdef DIFFUSE_TEX
    vUV = uv;
#endif

    gl_Position = viewProjection * worldPos;
}
`;

// ── Fragment Shader ────────────────────────────────────────────────────────
const FRAGMENT_SHADER = `
precision highp float;

varying vec3 vWorldNormal;
varying vec3 vWorldPos;

#ifdef DIFFUSE_TEX
varying vec2 vUV;
uniform sampler2D diffuseTex;
uniform vec2 diffuseTexScale;
#endif

uniform vec3 baseColor;
uniform vec3 shadowColor;
uniform vec3 highlightColor;
uniform vec3 rimColor;
uniform vec3 lightDirection;
uniform vec3 cameraPosition;
uniform vec3 emissiveColor;
uniform float rimPower;
uniform float specPower;
uniform float time;
uniform float useCelShading;

void main() {
    vec3 N = normalize(vWorldNormal);
    vec3 L = normalize(-lightDirection);
    vec3 V = normalize(cameraPosition - vWorldPos);
    vec3 H = normalize(L + V);

    float NdotL = dot(N, L);
    float NdotV = max(dot(N, V), 0.0);
    float NdotH = max(dot(N, H), 0.0);

    // Albedo — start with base color, modulate by diffuse texture if present
    vec3 albedo = baseColor;
#ifdef DIFFUSE_TEX
    albedo *= texture2D(diffuseTex, vUV * diffuseTexScale).rgb;
#endif

    vec3 litColor;

    if (useCelShading > 0.5) {
        // ── 4-band cel shading (HiFi Rush style) ─────────────────────
        float intensity;
        if (NdotL > 0.55) {
            intensity = 1.0;
        } else if (NdotL > 0.05) {
            intensity = 0.85;
        } else if (NdotL > -0.3) {
            intensity = 0.65;
        } else {
            intensity = 0.45;
        }

        // 4-band color mapping: shadow → base → highlight
        vec3 bandColor;
        if (intensity > 0.9) {
            bandColor = mix(albedo, highlightColor, 0.15);
        } else if (intensity > 0.75) {
            bandColor = albedo;
        } else if (intensity > 0.55) {
            bandColor = mix(shadowColor, albedo, 0.5);
        } else {
            bandColor = shadowColor;
        }
        litColor = bandColor;

        // Hard-edge specular
        float spec = pow(NdotH, specPower);
        float specMask = smoothstep(0.4, 0.5, spec);
        litColor += specMask * highlightColor * 0.3;
    } else {
        // ── Smooth Lambert fallback ──────────────────────────────────
        float diffuse = clamp(NdotL * 0.5 + 0.5, 0.15, 1.0);
        litColor = mix(shadowColor, albedo, diffuse);

        // Smooth specular
        float spec = pow(NdotH, specPower);
        litColor += spec * 0.15;
    }

    // ── Animated rim light ───────────────────────────────────────────
    float rim = pow(1.0 - NdotV, rimPower);
    float rimAnim = 0.7 + 0.3 * sin(time * 3.0 + vWorldPos.y * 2.0);
    litColor += rim * rimColor * rimAnim * 0.4;

    // ── Fresnel glow (subtle additive) ───────────────────────────────
    float fresnel = pow(1.0 - NdotV, 3.0) * 0.08;
    litColor += fresnel;

    // ── Emissive with spatial wave (key coins glow in traveling waves) ─
    float emLen = dot(emissiveColor, emissiveColor);
    if (emLen > 0.001) {
        float wave = sin(vWorldPos.x * 8.0 + vWorldPos.z * 6.0 + time * 3.0);
        float pulse = 0.55 + 0.45 * wave;
        litColor += emissiveColor * pulse;
    } else {
        litColor += emissiveColor;
    }

    gl_FragColor = vec4(litColor, 1.0);
}
`;

// Register shaders in BabylonJS Effect store
Effect.ShadersStore["toonVertexShader"] = VERTEX_SHADER;
Effect.ShadersStore["toonFragmentShader"] = FRAGMENT_SHADER;

export interface ToonMaterialOptions {
  name?: string;
  baseColor?: Color3;
  shadowColor?: Color3;
  highlightColor?: Color3;
  rimColor?: Color3;
  rimPower?: number;
  specPower?: number;
  thinInstances?: boolean;
  diffuseTexture?: Texture;
  useCelShading?: boolean;
}

export function createToonMaterial(
  scene: Scene,
  options: ToonMaterialOptions = {}
): ShaderMaterial {
  const {
    name = "toonMat",
    baseColor = new Color3(0.7, 0.7, 0.7),
    thinInstances = false,
    rimPower = 3.0,
    specPower = 32.0,
    useCelShading = true,
  } = options;

  const shadowColor = options.shadowColor ?? deriveShadow(baseColor, new Color3(0.25, 0.22, 0.32));
  const highlightColor = options.highlightColor ?? deriveHighlight(baseColor);
  const rimColor = options.rimColor ?? new Color3(0.8, 0.8, 0.9);

  const defines: string[] = [];
  if (thinInstances) {
    defines.push("#define THIN_INSTANCES");
  }

  const attribs = ["position", "normal"];
  const samplers: string[] = [];

  if (options.diffuseTexture) {
    defines.push("#define DIFFUSE_TEX");
    attribs.push("uv");
    samplers.push("diffuseTex");
  }

  if (thinInstances) {
    attribs.push("world0", "world1", "world2", "world3");
  }

  const uniforms = [
    "world",
    "viewProjection",
    "baseColor",
    "shadowColor",
    "highlightColor",
    "rimColor",
    "lightDirection",
    "cameraPosition",
    "emissiveColor",
    "rimPower",
    "specPower",
    "time",
    "useCelShading",
  ];

  if (options.diffuseTexture) {
    uniforms.push("diffuseTexScale");
  }

  const mat = new ShaderMaterial(name, scene, "toon", {
    attributes: attribs,
    uniforms,
    samplers,
    defines,
  });

  mat.setColor3("baseColor", baseColor);
  mat.setColor3("shadowColor", shadowColor);
  mat.setColor3("highlightColor", highlightColor);
  mat.setColor3("rimColor", rimColor);
  mat.setColor3("emissiveColor", Color3.Black());
  mat.setVector3("lightDirection", new Vector3(0.3, -0.7, 0.5));
  mat.setFloat("rimPower", rimPower);
  mat.setFloat("specPower", specPower);
  mat.setFloat("time", 0);
  mat.setFloat("useCelShading", useCelShading ? 1.0 : 0.0);

  if (options.diffuseTexture) {
    mat.setTexture("diffuseTex", options.diffuseTexture);
    mat.setVector2("diffuseTexScale", new Vector2(
      options.diffuseTexture.uScale ?? 1,
      options.diffuseTexture.vScale ?? 1,
    ));
  }

  // Backface culling on by default
  mat.backFaceCulling = true;

  return mat;
}

/** Convenience wrapper: create a toon material with common defaults. */
export function createToonMat(
  name: string,
  color: Color3,
  scene: Scene,
  opts?: Partial<ToonMaterialOptions>,
): ShaderMaterial {
  return createToonMaterial(scene, {
    name,
    baseColor: color,
    ...opts,
  });
}
