import { Effect, ShaderMaterial, Scene, Color3, Vector3 } from "@babylonjs/core";
import { deriveShadow, deriveHighlight } from "./ToonTheme";

// ── Vertex Shader (simplified toon — no thin instances, no diffuse tex) ─────
const VERTEX_SHADER = `
precision highp float;

attribute vec3 position;
attribute vec3 normal;

uniform mat4 world;
uniform mat4 viewProjection;

varying vec3 vWorldNormal;
varying vec3 vWorldPos;

void main() {
    vec4 worldPos = world * vec4(position, 1.0);
    vWorldPos = worldPos.xyz;

    mat3 normalMat = mat3(world);
    vWorldNormal = normalize(normalMat * normal);

    gl_Position = viewProjection * worldPos;
}
`;

// ── Fragment Shader (toon base + honeycomb + wave glow) ─────────────────────
const FRAGMENT_SHADER = `
precision highp float;

varying vec3 vWorldNormal;
varying vec3 vWorldPos;

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

// Honeycomb uniforms
uniform float honeycombScale;
uniform float honeycombEdgeWidth;
uniform vec3 honeycombGlowColor;
uniform float waveSpeed;
uniform float waveFrequency;
uniform float waveIntensity;

// ── Hex grid: returns distance to nearest hex edge ──────────────────────
float hexDist(vec2 p) {
    p = abs(p);
    // Hex distance: max of two half-plane distances
    return max(dot(p, normalize(vec2(1.0, 1.732))), p.x);
}

vec4 hexCoords(vec2 uv) {
    // Two offset grids
    vec2 r = vec2(1.0, 1.732);
    vec2 h = r * 0.5;

    vec2 a = mod(uv, r) - h;
    vec2 b = mod(uv - h, r) - h;

    // Pick the cell center closest to the point
    vec2 gv;
    if (dot(a, a) < dot(b, b)) {
        gv = a;
    } else {
        gv = b;
    }

    // Distance to edge of hexagon
    float edgeDist = 0.5 - hexDist(gv);

    return vec4(gv, edgeDist, 0.0);
}

void main() {
    vec3 N = normalize(vWorldNormal);
    vec3 L = normalize(-lightDirection);
    vec3 V = normalize(cameraPosition - vWorldPos);
    vec3 H = normalize(L + V);

    float NdotL = dot(N, L);
    float NdotV = max(dot(N, V), 0.0);
    float NdotH = max(dot(N, H), 0.0);

    vec3 albedo = baseColor;
    vec3 litColor;

    if (useCelShading > 0.5) {
        // 4-band cel shading
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
        // Smooth Lambert fallback
        float diffuse = clamp(NdotL * 0.5 + 0.5, 0.15, 1.0);
        litColor = mix(shadowColor, albedo, diffuse);

        float spec = pow(NdotH, specPower);
        litColor += spec * 0.15;
    }

    // Animated rim light
    float rim = pow(1.0 - NdotV, rimPower);
    float rimAnim = 0.7 + 0.3 * sin(time * 3.0 + vWorldPos.y * 2.0);
    litColor += rim * rimColor * rimAnim * 0.4;

    // Fresnel glow
    float fresnel = pow(1.0 - NdotV, 3.0) * 0.08;
    litColor += fresnel;

    // Emissive
    litColor += emissiveColor;

    // ── Honeycomb pattern ────────────────────────────────────────────
    vec2 hexUV = vWorldPos.yz * honeycombScale;
    vec4 hex = hexCoords(hexUV);
    float edgeDist = hex.z;

    // Anti-aliased edge mask using fwidth
    float fw = fwidth(edgeDist);
    float edgeMask = 1.0 - smoothstep(honeycombEdgeWidth - fw, honeycombEdgeWidth + fw, edgeDist);

    // Darken cell interiors slightly for contrast
    litColor *= mix(0.96, 1.0, edgeMask);

    // ── Wave glow on edges ───────────────────────────────────────────
    float wave = sin(time * waveSpeed - vWorldPos.y * waveFrequency);
    wave = wave * 0.5 + 0.5; // remap to 0..1
    wave = pow(wave, 2.0);   // sharpen the wave peaks

    // Additive glow on hex edges — pushed above bloom threshold
    vec3 glow = honeycombGlowColor * edgeMask * wave * waveIntensity;
    litColor += glow;

    gl_FragColor = vec4(litColor, 1.0);
}
`;

// Register shaders
Effect.ShadersStore["honeycombWallVertexShader"] = VERTEX_SHADER;
Effect.ShadersStore["honeycombWallFragmentShader"] = FRAGMENT_SHADER;

/** Create a honeycomb wall ShaderMaterial with wave glow effect. */
export function createHoneycombWallMaterial(
  name: string,
  baseColor: Color3,
  scene: Scene,
): ShaderMaterial {
  const shadowColor = deriveShadow(baseColor, new Color3(0.25, 0.22, 0.32));
  const highlightColor = deriveHighlight(baseColor);
  const rimColor = new Color3(0.8, 0.8, 0.9);

  const mat = new ShaderMaterial(name, scene, "honeycombWall", {
    attributes: ["position", "normal"],
    uniforms: [
      "world", "viewProjection",
      "baseColor", "shadowColor", "highlightColor", "rimColor",
      "lightDirection", "cameraPosition", "emissiveColor",
      "rimPower", "specPower", "time", "useCelShading",
      // Honeycomb-specific
      "honeycombScale", "honeycombEdgeWidth", "honeycombGlowColor",
      "waveSpeed", "waveFrequency", "waveIntensity",
    ],
  });

  // Toon base uniforms
  mat.setColor3("baseColor", baseColor);
  mat.setColor3("shadowColor", shadowColor);
  mat.setColor3("highlightColor", highlightColor);
  mat.setColor3("rimColor", rimColor);
  mat.setColor3("emissiveColor", Color3.Black());
  mat.setVector3("lightDirection", new Vector3(0.3, -0.7, 0.5));
  mat.setFloat("rimPower", 3.0);
  mat.setFloat("specPower", 32.0);
  mat.setFloat("time", 0);
  mat.setFloat("useCelShading", 1.0);

  // Honeycomb uniforms
  mat.setFloat("honeycombScale", 12.0);
  mat.setFloat("honeycombEdgeWidth", 0.04);
  mat.setColor3("honeycombGlowColor", new Color3(0.8, 0.4, 0.9)); // default purple
  mat.setFloat("waveSpeed", 1.5);
  mat.setFloat("waveFrequency", 4.0);
  mat.setFloat("waveIntensity", 0.8);

  mat.backFaceCulling = true;

  return mat;
}
