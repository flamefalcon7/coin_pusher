import type { Coin } from "../physics/Coin.js";
import type { Pusher } from "../physics/Pusher.js";
import { SCENE_CONFIG, RATE_LIMIT_CONFIG } from "@coin-pusher/shared";
import type { Rng } from "./Rng.js";

/** Which abilities to enable in a simulation run. */
export type AbilitySet = {
  tornado: boolean;
  explosion: boolean;
  lightning: boolean;
  shock: boolean;
  superPush: boolean;
};

export const NO_ABILITIES: AbilitySet = {
  tornado: false, explosion: false, lightning: false, shock: false, superPush: false,
};

export const ALL_ABILITIES: AbilitySet = {
  tornado: true, explosion: true, lightning: true, shock: true, superPush: true,
};

/**
 * Extracted ability mechanics from GameLoop.ts for use in simulation.
 * Operates directly on a coins Map — no NATS or GameState dependency.
 */
export class AbilitySimulator {
  // Tornado state
  private tornadoActive = false;
  private tornadoCenter = { x: 0, z: 0 };
  private tornadoTicksRemaining = 0;
  private tornadoTicksElapsed = 0;
  private readonly tornadoDurationTicks: number;
  private static readonly TORNADO_RADIUS = 0.4;

  // Lightning state
  private lightningActive = false;
  private lightningTicksRemaining = 0;
  private lightningTickCounter = 0;
  private static readonly LIGHTNING_DURATION_TICKS: number = Math.ceil(3000 / (1000 / 30)); // ~90 ticks at 30Hz

  private readonly tickRate: number;

  // Optional injected RNG (seeded determinism path). When null, Math.random.
  private readonly rng: Rng | null;

  constructor(tickRate: number, rng: Rng | null = null) {
    this.tickRate = tickRate;
    this.tornadoDurationTicks = Math.ceil(RATE_LIMIT_CONFIG.TORNADO_DURATION / 1000 * tickRate);
    this.rng = rng;
  }

  /** Float in [0,1): injected RNG when seeded, else Math.random. */
  private nextFloat(): number {
    return this.rng ? this.rng() : Math.random();
  }

  /**
   * Fire a random ability (for simulation use).
   * Returns true if an ability was fired.
   */
  fireRandom(coins: Map<number, Coin>, pusher: Pusher, abilities: AbilitySet): boolean {
    const available: string[] = [];
    if (abilities.tornado && !this.tornadoActive) available.push("tornado");
    if (abilities.explosion) available.push("explosion");
    if (abilities.lightning && !this.lightningActive) available.push("lightning");
    if (abilities.shock) available.push("shock");
    if (abilities.superPush) available.push("superPush");

    if (available.length === 0) return false;

    const choice = available[Math.floor(this.nextFloat() * available.length)];
    const { PLATFORM } = SCENE_CONFIG;
    // Random position on platform
    const rx = (this.nextFloat() - 0.5) * PLATFORM.WIDTH * 0.8;
    const rz = PLATFORM.POSITION.z + (this.nextFloat() - 0.5) * PLATFORM.DEPTH * 0.6;

    switch (choice) {
      case "tornado":
        this.startTornado(rx, rz);
        break;
      case "explosion":
        this.explode(coins, rx, rz);
        break;
      case "lightning":
        this.startLightning();
        break;
      case "shock":
        this.shockPins(coins);
        break;
      case "superPush":
        pusher.startSuperPush();
        break;
    }
    return true;
  }

  /** Must be called every tick to update ongoing abilities. */
  update(coins: Map<number, Coin>): void {
    this.updateTornado(coins);
    this.updateLightning(coins);
  }

  // ── Tornado ────────────────────────────────────────────────────

  private startTornado(x: number, z: number): void {
    this.tornadoActive = true;
    this.tornadoCenter = { x, z };
    this.tornadoTicksRemaining = this.tornadoDurationTicks;
    this.tornadoTicksElapsed = 0;
  }

  private updateTornado(coins: Map<number, Coin>): void {
    if (!this.tornadoActive) return;

    this.tornadoTicksElapsed++;
    this.tornadoTicksRemaining--;
    if (this.tornadoTicksRemaining <= 0) {
      this.tornadoActive = false;
      return;
    }

    // Ramp: up in first ~15 ticks, down in last ~15 ticks
    const rampTicks = Math.ceil(0.5 * this.tickRate); // 0.5s in ticks
    let ramp = 1.0;
    if (this.tornadoTicksElapsed < rampTicks) {
      ramp = this.tornadoTicksElapsed / rampTicks;
    } else if (this.tornadoTicksRemaining < rampTicks) {
      ramp = this.tornadoTicksRemaining / rampTicks;
    }

    const cx = this.tornadoCenter.x;
    const cz = this.tornadoCenter.z;
    const radius = AbilitySimulator.TORNADO_RADIUS;

    coins.forEach((coin) => {
      const pos = coin.getPosition();
      const dx = pos.x - cx;
      const dz = pos.z - cz;
      const dist = Math.sqrt(dx * dx + dz * dz);
      if (dist > radius) return;

      const body = coin.getRigidBody();
      body.wakeUp();

      const strength = (1 - dist / radius) * ramp;
      const invDist = dist > 0.001 ? 1 / dist : 0;
      const nx = -dx * invDist;
      const nz = -dz * invDist;

      const centripetal = 0.008 * strength;
      const tangential = 0.006 * strength;
      const maxTornadoY = 0.9;
      const lift = pos.y < maxTornadoY ? 0.01 * strength : -0.004 * strength;

      body.applyImpulse({
        x: nx * centripetal + (-nz) * tangential,
        y: lift,
        z: nz * centripetal + nx * tangential,
      }, true);
    });
  }

  // ── Explosion ──────────────────────────────────────────────────

  private explode(coins: Map<number, Coin>, x: number, z: number): void {
    const radius = 0.6;
    coins.forEach((coin) => {
      const pos = coin.getPosition();
      const dx = pos.x - x;
      const dz = pos.z - z;
      const dist = Math.sqrt(dx * dx + dz * dz);
      if (dist > radius) return;

      const body = coin.getRigidBody();
      body.wakeUp();
      const t = 1 - dist / radius;
      const strength = t * t;
      const invDist = dist > 0.001 ? 1 / dist : 0;
      const nx = dx * invDist;
      const nz = dz * invDist;

      body.applyImpulse({
        x: nx * 0.08 * strength + (this.nextFloat() - 0.5) * 0.01,
        y: 0.06 * strength,
        z: nz * 0.08 * strength + (this.nextFloat() - 0.5) * 0.01,
      }, true);
      body.applyTorqueImpulse({
        x: (this.nextFloat() - 0.5) * 0.002 * strength,
        y: (this.nextFloat() - 0.5) * 0.002 * strength,
        z: (this.nextFloat() - 0.5) * 0.002 * strength,
      }, true);
    });
  }

  // ── Lightning ──────────────────────────────────────────────────

  private startLightning(): void {
    this.lightningActive = true;
    this.lightningTicksRemaining = AbilitySimulator.LIGHTNING_DURATION_TICKS;
    this.lightningTickCounter = 0;
  }

  private updateLightning(coins: Map<number, Coin>): void {
    if (!this.lightningActive) return;

    this.lightningTicksRemaining--;
    if (this.lightningTicksRemaining <= 0) {
      this.lightningActive = false;
      return;
    }

    this.lightningTickCounter++;
    if (this.lightningTickCounter % 4 !== 0) return;

    const { POSITION: PLAT_POS, DEPTH: PLAT_DEPTH, WIDTH, FLARE_Z, FLARE_ANGLE } = SCENE_CONFIG.PLATFORM;
    const { POSITION: PUSH_POS, DEPTH: PUSH_DEPTH } = SCENE_CONFIG.PUSHER;
    const hw = WIDTH / 2;
    const flareRad = FLARE_ANGLE * Math.PI / 180;

    const backZ = PUSH_POS.z - PUSH_DEPTH / 2;
    const frontZ = PLAT_POS.z + PLAT_DEPTH / 2;

    const sz = backZ + this.nextFloat() * (frontZ - backZ);
    let halfW = sz < FLARE_Z ? hw : hw + Math.tan(flareRad) * (sz - FLARE_Z);
    halfW -= 0.05;
    const sx = (this.nextFloat() * 2 - 1) * halfW;

    const radius = 0.35;
    coins.forEach((coin) => {
      const pos = coin.getPosition();
      const dx = pos.x - sx;
      const dz = pos.z - sz;
      const dist = Math.sqrt(dx * dx + dz * dz);
      if (dist > radius) return;

      const body = coin.getRigidBody();
      body.wakeUp();
      const t = 1 - dist / radius;
      const strength = t * t;
      const invDist = dist > 0.001 ? 1 / dist : 0;
      const nx = dx * invDist;
      const nz = dz * invDist;

      body.applyImpulse({
        x: nx * 0.06 * strength + (this.nextFloat() - 0.5) * 0.008,
        y: 0.055 * strength,
        z: nz * 0.06 * strength + (this.nextFloat() - 0.5) * 0.008,
      }, true);
      body.applyTorqueImpulse({
        x: (this.nextFloat() - 0.5) * 0.002 * strength,
        y: (this.nextFloat() - 0.5) * 0.002 * strength,
        z: (this.nextFloat() - 0.5) * 0.002 * strength,
      }, true);
    });
  }

  // ── Shock Pins ─────────────────────────────────────────────────

  private shockPins(coins: Map<number, Coin>): void {
    const pinYMin = SCENE_CONFIG.PLATFORM.POSITION.y + SCENE_CONFIG.PINS.START_Y;
    const pinYMax = pinYMin + (SCENE_CONFIG.PINS.ROWS - 1) * SCENE_CONFIG.PINS.VERTICAL_SPACING + SCENE_CONFIG.PINS.Y_OFFSET;
    const backWallZ = SCENE_CONFIG.BACK_WALL.POSITION.z;
    const zThreshold = 0.25;

    coins.forEach((coin) => {
      const pos = coin.getPosition();
      if (pos.y >= pinYMin && pos.y <= pinYMax && pos.z < backWallZ + zThreshold) {
        const body = coin.getRigidBody();
        body.wakeUp();
        body.applyImpulse({
          x: (this.nextFloat() - 0.5) * 0.005,
          y: -0.002,
          z: 0.005 + this.nextFloat() * 0.005,
        }, true);
      }
    });
  }
}
