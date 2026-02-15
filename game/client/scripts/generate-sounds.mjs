/**
 * Generates realistic coin sound effect WAV files using procedural synthesis.
 * Run: node scripts/generate-sounds.mjs
 * Output: public/sounds/coin-insert.wav, coin-land.wav, coin-despawn.wav
 */
import { writeFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SAMPLE_RATE = 44100;

// Inharmonic partial ratios — gives metal its characteristic ring
const METAL_RATIOS = [1.0, 1.47, 2.09, 2.56, 3.53, 4.15, 5.19, 6.87];

function generateSamples(durationSec, fn) {
  const len = Math.ceil(SAMPLE_RATE * durationSec);
  const samples = new Float32Array(len);
  for (let i = 0; i < len; i++) {
    const t = i / SAMPLE_RATE;
    samples[i] = fn(t, i, len);
  }
  return samples;
}

function mix(buffers) {
  const maxLen = Math.max(...buffers.map((b) => b.length));
  const out = new Float32Array(maxLen);
  for (const buf of buffers) {
    for (let i = 0; i < buf.length; i++) {
      out[i] += buf[i];
    }
  }
  return out;
}

function clamp(samples) {
  const out = new Float32Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    out[i] = Math.max(-1, Math.min(1, samples[i]));
  }
  return out;
}

/**
 * Generate a metallic hit: layered inharmonic sine partials + noise transient.
 */
function metalHit({
  fundamental,
  volume,
  decaySec,
  numPartials = 6,
  noiseAmount = 0.3,
  noiseDuration = 0.008,
  partialAmps = null,
  partialDecays = null,
  brightness = 1.0, // >1 = higher partials louder/longer = crisper
}) {
  const duration = decaySec + 0.05;
  const layers = [];

  // Sine partials at inharmonic ratios
  for (let p = 0; p < numPartials && p < METAL_RATIOS.length; p++) {
    const freq = fundamental * METAL_RATIOS[p];
    // Higher brightness = higher partials stay louder
    const amp = partialAmps ? partialAmps[p] : 1.0 / (1 + p * (0.6 / brightness));
    // Higher brightness = higher partials decay slower (ring longer)
    const decay = partialDecays ? partialDecays[p] : decaySec / (1 + p * (0.45 / brightness));

    layers.push(
      generateSamples(duration, (t) => {
        if (t > decay) return 0;
        const env = Math.exp(-t / (decay * 0.22));
        return amp * env * Math.sin(2 * Math.PI * freq * t);
      }),
    );
  }

  // Sharp noise transient (initial impact click) — crisp attack
  if (noiseAmount > 0) {
    layers.push(
      generateSamples(noiseDuration, (t) => {
        const env = Math.pow(1 - t / noiseDuration, 2); // sharper falloff
        const noise = (Math.random() * 2 - 1) * noiseAmount;
        return noise * env;
      }),
    );
  }

  const mixed = mix(layers);
  for (let i = 0; i < mixed.length; i++) {
    mixed[i] *= volume;
  }
  return clamp(mixed);
}

/**
 * Coin insert: bright, resonant clink — coin dropping through metal slot.
 */
function generateCoinInsert() {
  // Primary metallic ring — high bright clink
  const hit1 = metalHit({
    fundamental: 3800,
    volume: 0.65,
    decaySec: 0.22,
    numPartials: 8,
    noiseAmount: 0.7,
    noiseDuration: 0.003,
    brightness: 1.8,
  });

  // Secondary slightly delayed ring (coin bouncing once in the slot)
  const hit2Delay = 0.02; // 20ms later
  const hit2 = metalHit({
    fundamental: 4400,
    volume: 0.35,
    decaySec: 0.14,
    numPartials: 6,
    noiseAmount: 0.5,
    noiseDuration: 0.002,
    brightness: 1.6,
  });

  // Offset hit2
  const totalLen = Math.max(hit1.length, hit2.length + Math.ceil(hit2Delay * SAMPLE_RATE));
  const out = new Float32Array(totalLen);
  for (let i = 0; i < hit1.length; i++) out[i] += hit1[i];
  const offset = Math.ceil(hit2Delay * SAMPLE_RATE);
  for (let i = 0; i < hit2.length; i++) {
    if (i + offset < totalLen) out[i + offset] += hit2[i];
  }

  return clamp(out);
}

/**
 * Coin land: dampened tap — coin hitting a flat surface.
 */
function generateCoinLand() {
  return metalHit({
    fundamental: 2400,
    volume: 0.5,
    decaySec: 0.09,
    numPartials: 6,
    noiseAmount: 0.8,
    noiseDuration: 0.003,
    brightness: 1.5,
  });
}

/**
 * Coin despawn: cascading metallic clinks — coins tumbling off edge.
 */
function generateCoinDespawn() {
  const hits = [];
  const numHits = 3;
  const totalDuration = 0.35;

  for (let i = 0; i < numHits; i++) {
    const delay = i * 0.035; // 35ms apart — tighter cascade
    const fund = 2000 + i * 600; // higher ascending pitch
    const vol = 0.45 / (1 + i * 0.3);

    const hit = metalHit({
      fundamental: fund,
      volume: vol,
      decaySec: 0.1 - i * 0.015,
      numPartials: 6,
      noiseAmount: 0.6,
      noiseDuration: 0.003,
      brightness: 1.5,
    });

    const totalLen = Math.ceil(totalDuration * SAMPLE_RATE);
    const padded = new Float32Array(totalLen);
    const offset = Math.ceil(delay * SAMPLE_RATE);
    for (let j = 0; j < hit.length && j + offset < totalLen; j++) {
      padded[j + offset] = hit[j];
    }
    hits.push(padded);
  }

  return clamp(mix(hits));
}

/**
 * Write Float32 samples to a WAV file (16-bit PCM, mono).
 */
function writeWav(filepath, samples) {
  const numSamples = samples.length;
  const bytesPerSample = 2;
  const dataSize = numSamples * bytesPerSample;
  const bufferSize = 44 + dataSize;
  const buf = Buffer.alloc(bufferSize);

  // RIFF header
  buf.write("RIFF", 0);
  buf.writeUInt32LE(bufferSize - 8, 4);
  buf.write("WAVE", 8);

  // fmt chunk
  buf.write("fmt ", 12);
  buf.writeUInt32LE(16, 16); // chunk size
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(SAMPLE_RATE, 24);
  buf.writeUInt32LE(SAMPLE_RATE * bytesPerSample, 28); // byte rate
  buf.writeUInt16LE(bytesPerSample, 32); // block align
  buf.writeUInt16LE(16, 34); // bits per sample

  // data chunk
  buf.write("data", 36);
  buf.writeUInt32LE(dataSize, 40);

  for (let i = 0; i < numSamples; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    const val = s < 0 ? s * 0x8000 : s * 0x7fff;
    buf.writeInt16LE(Math.round(val), 44 + i * bytesPerSample);
  }

  writeFileSync(filepath, buf);
  const sizeKB = (bufferSize / 1024).toFixed(1);
  console.log(`  ${filepath} (${sizeKB} KB, ${(numSamples / SAMPLE_RATE * 1000).toFixed(0)}ms)`);
}

// Generate all sounds
const outDir = join(__dirname, "..", "public", "sounds");

console.log("Generating coin sound effects...\n");

writeWav(join(outDir, "coin-insert.wav"), generateCoinInsert());
writeWav(join(outDir, "coin-land.wav"), generateCoinLand());
writeWav(join(outDir, "coin-despawn.wav"), generateCoinDespawn());

console.log("\nDone!");
