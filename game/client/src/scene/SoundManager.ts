export class SoundManager {
  private ctx: AudioContext | null = null;
  private lastCoinLandTime = 0;
  private lastCoinDespawnTime = 0;
  private static readonly THROTTLE_MS = 200; // max 5 sounds/sec

  // Pre-decoded audio buffers for coin samples
  private coinInsertBuf: AudioBuffer | null = null;
  private coinLandBuf: AudioBuffer | null = null;
  private coinDespawnBuf: AudioBuffer | null = null;
  private loaded = false;

  /** Lazy-init AudioContext on first user interaction (autoplay policy). */
  private ensureContext(): AudioContext {
    if (!this.ctx) {
      this.ctx = new AudioContext();
      this.loadSamples();
    }
    if (this.ctx.state === "suspended") {
      this.ctx.resume();
    }
    return this.ctx;
  }

  /** Load and decode all coin WAV samples. */
  private async loadSamples(): Promise<void> {
    if (this.loaded || !this.ctx) return;
    this.loaded = true;

    const files = ["coin-insert.mp3", "coin-land.mp3", "coin-despawn.mp3"] as const;
    const [insertBuf, landBuf, despawnBuf] = await Promise.all(
      files.map(async (f) => {
        const resp = await fetch(`/sounds/${f}`);
        const arrayBuf = await resp.arrayBuffer();
        return this.ctx!.decodeAudioData(arrayBuf);
      }),
    );

    this.coinInsertBuf = insertBuf;
    this.coinLandBuf = landBuf;
    this.coinDespawnBuf = despawnBuf;
  }

  /** Play a sample with slight pitch randomization for natural variation. */
  private playSampleRandomized(
    buffer: AudioBuffer | null,
    volume: number,
    pitchRange: number = 0.08,
  ): void {
    if (!buffer) return;
    const ctx = this.ensureContext();
    const src = ctx.createBufferSource();
    const gain = ctx.createGain();
    src.buffer = buffer;
    src.playbackRate.value = 1 + (Math.random() * 2 - 1) * pitchRange;
    gain.gain.value = volume;
    src.connect(gain).connect(ctx.destination);
    src.start();
  }

  /** Bright metallic clink — coin dropping into slot. */
  playCoinInsert(): void {
    this.ensureContext();
    this.playSampleRandomized(this.coinInsertBuf, 0.7, 0.1);
  }

  /** Softer metallic tap — coin landing on platform surface. */
  playCoinLand(): void {
    const now = performance.now();
    if (now - this.lastCoinLandTime < SoundManager.THROTTLE_MS) return;
    this.lastCoinLandTime = now;

    this.ensureContext();
    this.playSampleRandomized(this.coinLandBuf, 0.5, 0.12);
  }

  /** Cascading clinks — coins tumbling off the edge. Volume scales with count. */
  playCoinDespawn(count: number): void {
    const now = performance.now();
    if (now - this.lastCoinDespawnTime < SoundManager.THROTTLE_MS) return;
    this.lastCoinDespawnTime = now;

    this.ensureContext();
    const vol = Math.min(0.8, 0.3 * count);
    this.playSampleRandomized(this.coinDespawnBuf, vol, 0.1);
  }

  /** Low rumble — noise burst + low oscillator (procedural, kept as-is). */
  playShock(): void {
    const ctx = this.ensureContext();
    const t = ctx.currentTime;

    // Low oscillator rumble
    const osc = ctx.createOscillator();
    const oscGain = ctx.createGain();

    osc.type = "sawtooth";
    osc.frequency.setValueAtTime(80, t);
    osc.frequency.exponentialRampToValueAtTime(40, t + 0.4);

    oscGain.gain.setValueAtTime(0.15, t);
    oscGain.gain.exponentialRampToValueAtTime(0.001, t + 0.4);

    osc.connect(oscGain).connect(ctx.destination);
    osc.start(t);
    osc.stop(t + 0.4);

    // White noise burst
    const bufferSize = ctx.sampleRate * 0.3;
    const buffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) {
      data[i] = (Math.random() * 2 - 1) * 0.5;
    }

    const noise = ctx.createBufferSource();
    const noiseGain = ctx.createGain();
    noise.buffer = buffer;

    noiseGain.gain.setValueAtTime(0.12, t);
    noiseGain.gain.exponentialRampToValueAtTime(0.001, t + 0.3);

    noise.connect(noiseGain).connect(ctx.destination);
    noise.start(t);
    noise.stop(t + 0.3);
  }

  dispose(): void {
    if (this.ctx) {
      this.ctx.close();
      this.ctx = null;
    }
  }
}
