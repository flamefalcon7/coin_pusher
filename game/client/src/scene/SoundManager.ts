export class SoundManager {
  private ctx: AudioContext | null = null;
  private lastCoinLandTime = 0;
  private lastCoinDespawnTime = 0;
  private static readonly THROTTLE_MS = 200; // max 5 sounds/sec

  // Pre-decoded audio buffers for samples
  private coinInsertBuf: AudioBuffer | null = null;
  private coinLandBuf: AudioBuffer | null = null;
  private coinDespawnBuf: AudioBuffer | null = null;
  private slotSpinBuf: AudioBuffer | null = null;
  private static readonly BGM_COUNT = 3;
  private bgmBufs: AudioBuffer[] = [];
  private bgmIndex = 0;
  private bgmSource: AudioBufferSourceNode | null = null;
  private bgmGain: GainNode | null = null;
  private bgmPlaying = false;
  private loaded = false;
  private _muted = false;

  /** Lazy-init AudioContext on first user interaction (autoplay policy). */
  private ensureContext(): AudioContext {
    if (!this.ctx) {
      this.ctx = new AudioContext();
      this.loadSamples().then(() => this.startBgm());
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

    const sfxFiles = ["coin-insert.mp3", "coin-land.mp3", "coin-despawn.mp3", "slot-spin.mp3"] as const;
    const bgmFiles = Array.from({ length: SoundManager.BGM_COUNT }, (_, i) => `bgm-${i}.mp3`);

    const decode = async (f: string) => {
      const resp = await fetch(`/sounds/${f}`);
      const arrayBuf = await resp.arrayBuffer();
      return this.ctx!.decodeAudioData(arrayBuf);
    };

    const [insertBuf, landBuf, despawnBuf, slotSpinBuf, ...bgmBufs] = await Promise.all(
      [...sfxFiles, ...bgmFiles].map(decode),
    );

    this.coinInsertBuf = insertBuf;
    this.coinLandBuf = landBuf;
    this.coinDespawnBuf = despawnBuf;
    this.slotSpinBuf = slotSpinBuf;
    this.bgmBufs = bgmBufs;
  }

  get muted(): boolean { return this._muted; }

  setMuted(muted: boolean): void {
    this._muted = muted;
    if (this.bgmGain) {
      this.bgmGain.gain.value = muted ? 0 : 0.15;
    }
  }

  toggleMute(): boolean {
    this._muted = !this._muted;
    if (this.bgmGain) {
      this.bgmGain.gain.value = this._muted ? 0 : 0.15;
    }
    return this._muted;
  }

  /** Start background music, rotating through tracks. */
  startBgm(): void {
    if (this.bgmPlaying || this.bgmBufs.length === 0) return;
    this.bgmPlaying = true;
    this.playNextBgmTrack();
  }

  private playNextBgmTrack(): void {
    if (!this.bgmPlaying || this.bgmBufs.length === 0) return;
    const ctx = this.ensureContext();

    this.bgmSource = ctx.createBufferSource();
    this.bgmSource.buffer = this.bgmBufs[this.bgmIndex];
    this.bgmSource.loop = false;

    this.bgmGain = ctx.createGain();
    this.bgmGain.gain.value = this._muted ? 0 : 0.15;

    this.bgmSource.connect(this.bgmGain).connect(ctx.destination);
    this.bgmSource.onended = () => {
      if (!this.bgmPlaying) return;
      this.bgmIndex = (this.bgmIndex + 1) % this.bgmBufs.length;
      this.playNextBgmTrack();
    };
    this.bgmSource.start();
  }

  stopBgm(): void {
    this.bgmPlaying = false;
    if (this.bgmSource) {
      this.bgmSource.onended = null;
      this.bgmSource.stop();
      this.bgmSource = null;
    }
  }

  /** Play a sample with slight pitch randomization for natural variation. */
  private playSampleRandomized(
    buffer: AudioBuffer | null,
    volume: number,
    pitchRange: number = 0.08,
  ): void {
    if (!buffer || this._muted) return;
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
    if (this._muted) return;
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

  /** Heavy explosion — sub-bass thump + mid crunch + noise blast. */
  playExplosion(): void {
    if (this._muted) return;
    const ctx = this.ensureContext();
    const t = ctx.currentTime;

    // Layer 1: Sub-bass thump (40→15Hz sine, heavy)
    const sub = ctx.createOscillator();
    const subGain = ctx.createGain();
    sub.type = "sine";
    sub.frequency.setValueAtTime(40, t);
    sub.frequency.exponentialRampToValueAtTime(15, t + 0.5);
    subGain.gain.setValueAtTime(0.4, t);
    subGain.gain.setValueAtTime(0.4, t + 0.05);
    subGain.gain.exponentialRampToValueAtTime(0.001, t + 0.6);
    sub.connect(subGain).connect(ctx.destination);
    sub.start(t);
    sub.stop(t + 0.6);

    // Layer 2: Mid crunch (sawtooth 120→30Hz, distorted feel)
    const mid = ctx.createOscillator();
    const midGain = ctx.createGain();
    mid.type = "sawtooth";
    mid.frequency.setValueAtTime(120, t);
    mid.frequency.exponentialRampToValueAtTime(30, t + 0.3);
    midGain.gain.setValueAtTime(0.12, t);
    midGain.gain.exponentialRampToValueAtTime(0.001, t + 0.35);
    // Waveshaper for crunch/distortion
    const shaper = ctx.createWaveShaper();
    const curve = new Float32Array(256);
    for (let i = 0; i < 256; i++) {
      const x = (i / 128) - 1;
      curve[i] = (Math.PI + 3) * x / (Math.PI + 3 * Math.abs(x));
    }
    shaper.curve = curve;
    shaper.oversample = "2x";
    mid.connect(shaper).connect(midGain).connect(ctx.destination);
    mid.start(t);
    mid.stop(t + 0.35);

    // Layer 3: Noise blast (low-pass filtered, punchy)
    const bufferSize = ctx.sampleRate * 0.4;
    const buffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) {
      data[i] = (Math.random() * 2 - 1);
    }
    const noise = ctx.createBufferSource();
    noise.buffer = buffer;

    const lowpass = ctx.createBiquadFilter();
    lowpass.type = "lowpass";
    lowpass.frequency.setValueAtTime(1200, t);
    lowpass.frequency.exponentialRampToValueAtTime(150, t + 0.35);
    lowpass.Q.setValueAtTime(1.5, t);

    const noiseGain = ctx.createGain();
    noiseGain.gain.setValueAtTime(0.25, t);
    noiseGain.gain.setValueAtTime(0.25, t + 0.03);
    noiseGain.gain.exponentialRampToValueAtTime(0.001, t + 0.4);

    noise.connect(lowpass).connect(noiseGain).connect(ctx.destination);
    noise.start(t);
    noise.stop(t + 0.4);
  }

  /** Lightning storm — 3-second soundscape with initial crack, rolling rumble,
   *  crackle, and periodic secondary cracks throughout the storm. */
  playLightning(): void {
    if (this._muted) return;
    const ctx = this.ensureContext();
    const t = ctx.currentTime;

    // Layer 1: Sharp initial crack (sine 2500→300Hz, very fast decay, loud)
    const crack = ctx.createOscillator();
    const crackGain = ctx.createGain();
    crack.type = "sine";
    crack.frequency.setValueAtTime(2500, t);
    crack.frequency.exponentialRampToValueAtTime(300, t + 0.06);
    crackGain.gain.setValueAtTime(0.4, t);
    crackGain.gain.exponentialRampToValueAtTime(0.001, t + 0.08);
    crack.connect(crackGain).connect(ctx.destination);
    crack.start(t);
    crack.stop(t + 0.1);

    // Layer 2: Rolling thunder rumble — extended to 3s (sawtooth 70→15Hz, slow decay)
    const rumble = ctx.createOscillator();
    const rumbleGain = ctx.createGain();
    rumble.type = "sawtooth";
    rumble.frequency.setValueAtTime(70, t);
    rumble.frequency.exponentialRampToValueAtTime(15, t + 3.0);
    rumbleGain.gain.setValueAtTime(0.2, t);
    rumbleGain.gain.setValueAtTime(0.2, t + 0.1);
    rumbleGain.gain.exponentialRampToValueAtTime(0.001, t + 3.0);
    rumble.connect(rumbleGain).connect(ctx.destination);
    rumble.start(t);
    rumble.stop(t + 3.0);

    // Layer 3: Initial crackle (noise burst, bandpass 1000-3000Hz)
    const bufferSize = ctx.sampleRate * 0.2;
    const buffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) {
      data[i] = (Math.random() * 2 - 1);
    }
    const noise = ctx.createBufferSource();
    noise.buffer = buffer;

    const bandpass = ctx.createBiquadFilter();
    bandpass.type = "bandpass";
    bandpass.frequency.setValueAtTime(2000, t);
    bandpass.Q.setValueAtTime(1.0, t);

    const noiseGain = ctx.createGain();
    noiseGain.gain.setValueAtTime(0.25, t);
    noiseGain.gain.exponentialRampToValueAtTime(0.001, t + 0.2);

    noise.connect(bandpass).connect(noiseGain).connect(ctx.destination);
    noise.start(t);
    noise.stop(t + 0.2);

    // Layer 4: Periodic secondary cracks throughout the storm
    const secondaryCracks = [0.5, 1.2, 2.0, 2.5];
    secondaryCracks.forEach((offset, i) => {
      const vol = 0.25 - i * 0.04; // Each slightly quieter
      const freq = 1800 + (Math.random() - 0.5) * 400; // Slight frequency variation
      const sc = ctx.createOscillator();
      const scGain = ctx.createGain();
      sc.type = "sine";
      sc.frequency.setValueAtTime(freq, t + offset);
      sc.frequency.exponentialRampToValueAtTime(300, t + offset + 0.06);
      scGain.gain.setValueAtTime(0, t);
      scGain.gain.setValueAtTime(vol, t + offset);
      scGain.gain.exponentialRampToValueAtTime(0.001, t + offset + 0.08);
      sc.connect(scGain).connect(ctx.destination);
      sc.start(t + offset);
      sc.stop(t + offset + 0.1);
    });
  }

  /** Super push — charge-up rising tone + explosive thrust impact. */
  playSuperPush(): void {
    if (this._muted) return;
    const ctx = this.ensureContext();
    const t = ctx.currentTime;

    // Layer 1: Charge-up rising oscillator (0-0.4s)
    const chargeOsc = ctx.createOscillator();
    const chargeGain = ctx.createGain();
    chargeOsc.type = "sine";
    chargeOsc.frequency.setValueAtTime(100, t);
    chargeOsc.frequency.exponentialRampToValueAtTime(400, t + 0.4);
    chargeGain.gain.setValueAtTime(0.08, t);
    chargeGain.gain.linearRampToValueAtTime(0.2, t + 0.35);
    chargeGain.gain.exponentialRampToValueAtTime(0.001, t + 0.42);
    chargeOsc.connect(chargeGain).connect(ctx.destination);
    chargeOsc.start(t);
    chargeOsc.stop(t + 0.45);

    // Layer 2: Charge-up filtered noise with rising cutoff (0-0.4s)
    const chargeNoiseSize = ctx.sampleRate * 0.45;
    const chargeNoiseBuf = ctx.createBuffer(1, chargeNoiseSize, ctx.sampleRate);
    const chargeNoiseData = chargeNoiseBuf.getChannelData(0);
    for (let i = 0; i < chargeNoiseSize; i++) {
      chargeNoiseData[i] = (Math.random() * 2 - 1);
    }
    const chargeNoise = ctx.createBufferSource();
    chargeNoise.buffer = chargeNoiseBuf;

    const chargeLp = ctx.createBiquadFilter();
    chargeLp.type = "lowpass";
    chargeLp.frequency.setValueAtTime(200, t);
    chargeLp.frequency.exponentialRampToValueAtTime(2000, t + 0.4);
    chargeLp.Q.setValueAtTime(2, t);

    const chargeNoiseGain = ctx.createGain();
    chargeNoiseGain.gain.setValueAtTime(0.04, t);
    chargeNoiseGain.gain.linearRampToValueAtTime(0.12, t + 0.35);
    chargeNoiseGain.gain.exponentialRampToValueAtTime(0.001, t + 0.42);

    chargeNoise.connect(chargeLp).connect(chargeNoiseGain).connect(ctx.destination);
    chargeNoise.start(t);
    chargeNoise.stop(t + 0.45);

    // Layer 3: Thrust impact — sub-bass thump at 0.4s (deeper, louder, longer)
    const thumpOsc = ctx.createOscillator();
    const thumpGain = ctx.createGain();
    thumpOsc.type = "sine";
    thumpOsc.frequency.setValueAtTime(35, t + 0.4);
    thumpOsc.frequency.exponentialRampToValueAtTime(12, t + 1.0);
    thumpGain.gain.setValueAtTime(0, t);
    thumpGain.gain.setValueAtTime(0.5, t + 0.4);
    thumpGain.gain.exponentialRampToValueAtTime(0.001, t + 1.05);
    thumpOsc.connect(thumpGain).connect(ctx.destination);
    thumpOsc.start(t + 0.4);
    thumpOsc.stop(t + 1.1);

    // Layer 4: Whoosh — bandpass noise burst at 0.4s (louder)
    const whooshSize = ctx.sampleRate * 0.4;
    const whooshBuf = ctx.createBuffer(1, whooshSize, ctx.sampleRate);
    const whooshData = whooshBuf.getChannelData(0);
    for (let i = 0; i < whooshSize; i++) {
      whooshData[i] = (Math.random() * 2 - 1);
    }
    const whoosh = ctx.createBufferSource();
    whoosh.buffer = whooshBuf;

    const whooshBp = ctx.createBiquadFilter();
    whooshBp.type = "bandpass";
    whooshBp.frequency.setValueAtTime(800, t + 0.4);
    whooshBp.frequency.exponentialRampToValueAtTime(200, t + 0.7);
    whooshBp.Q.setValueAtTime(1.0, t + 0.4);

    const whooshGain = ctx.createGain();
    whooshGain.gain.setValueAtTime(0, t);
    whooshGain.gain.setValueAtTime(0.28, t + 0.4);
    whooshGain.gain.exponentialRampToValueAtTime(0.001, t + 0.75);

    whoosh.connect(whooshBp).connect(whooshGain).connect(ctx.destination);
    whoosh.start(t + 0.4);
    whoosh.stop(t + 0.8);

    // Layer 5: Mid-freq metallic collision — sawtooth 150→40Hz at 0.4s
    const collisionOsc = ctx.createOscillator();
    const collisionGain = ctx.createGain();
    collisionOsc.type = "sawtooth";
    collisionOsc.frequency.setValueAtTime(150, t + 0.4);
    collisionOsc.frequency.exponentialRampToValueAtTime(40, t + 0.7);
    collisionGain.gain.setValueAtTime(0, t);
    collisionGain.gain.setValueAtTime(0.12, t + 0.4);
    collisionGain.gain.exponentialRampToValueAtTime(0.001, t + 0.72);
    collisionOsc.connect(collisionGain).connect(ctx.destination);
    collisionOsc.start(t + 0.4);
    collisionOsc.stop(t + 0.75);
  }

  /** Slot reels rolling — sample-based. */
  playSlotSpin(): void {
    this.ensureContext();
    this.playSampleRandomized(this.slotSpinBuf, 0.5, 0);
  }

  /** Ascending arpeggio — C5→E5→G5→C6 triangle waves. */
  playJackpot(): void {
    if (this._muted) return;
    const ctx = this.ensureContext();
    const t = ctx.currentTime;

    const notes = [523.25, 659.25, 783.99, 1046.50]; // C5, E5, G5, C6
    notes.forEach((freq, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "triangle";
      osc.frequency.setValueAtTime(freq, t + i * 0.15);
      gain.gain.setValueAtTime(0, t);
      gain.gain.setValueAtTime(0.2, t + i * 0.15);
      gain.gain.exponentialRampToValueAtTime(0.001, t + i * 0.15 + 0.4);
      osc.connect(gain).connect(ctx.destination);
      osc.start(t + i * 0.15);
      osc.stop(t + i * 0.15 + 0.4);
    });
  }

  /** Wind whoosh — filtered noise with pitch oscillation for 4 seconds. */
  playTornado(): void {
    if (this._muted) return;
    const ctx = this.ensureContext();
    const t = ctx.currentTime;
    const duration = 4.0;

    // White noise buffer
    const bufferSize = ctx.sampleRate * duration;
    const buffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) {
      data[i] = Math.random() * 2 - 1;
    }

    const noise = ctx.createBufferSource();
    noise.buffer = buffer;

    // Bandpass filter (200-800Hz) for wind-like sound
    const bandpass = ctx.createBiquadFilter();
    bandpass.type = "bandpass";
    bandpass.frequency.setValueAtTime(500, t);
    bandpass.Q.setValueAtTime(0.8, t);

    // Slow pitch oscillation via playbackRate LFO
    const lfo = ctx.createOscillator();
    const lfoGain = ctx.createGain();
    lfo.frequency.setValueAtTime(0.8, t); // Slow whoosh
    lfoGain.gain.setValueAtTime(200, t); // Modulate filter freq
    lfo.connect(lfoGain);
    lfoGain.connect(bandpass.frequency);
    lfo.start(t);
    lfo.stop(t + duration);

    // Volume envelope: fade in 0.5s → sustain → fade out 0.5s
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0, t);
    gain.gain.linearRampToValueAtTime(0.15, t + 0.5);
    gain.gain.setValueAtTime(0.15, t + duration - 0.5);
    gain.gain.linearRampToValueAtTime(0, t + duration);

    noise.connect(bandpass).connect(gain).connect(ctx.destination);
    noise.start(t);
    noise.stop(t + duration);
  }

  dispose(): void {
    if (this.ctx) {
      this.ctx.close();
      this.ctx = null;
    }
  }
}
