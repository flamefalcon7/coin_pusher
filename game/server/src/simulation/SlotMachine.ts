import { SLOT_MACHINE_CONFIG, COIN_CONFIG, SCENE_CONFIG } from "@coin-pusher/shared";
import { randomInt } from "node:crypto";
import type { SlotSymbol } from "@coin-pusher/shared";
import type { Rng } from "./Rng.js";

/** Pending bonus coin spawn (scheduled by tick). */
export type BonusCoinSpawn = {
  x: number;
  y: number;
  z: number;
  rotation: { x: number; y: number; z: number; w: number };
};

/**
 * Standalone slot machine state machine for simulation.
 * Tick-based timing — no setTimeout/NATS dependencies.
 */
export class SlotMachine {
  private counter: number = 0;
  private spinning: boolean = false;
  private spinEndTick: number = 0;
  private bonusSpawnQueue: { tick: number }[] = [];

  // Statistics
  totalSpins: number = 0;
  totalJackpots: number = 0;

  // Timing config (converted from ms to ticks)
  private readonly spinDurationTicks: number;
  private readonly bonusDelayTicks: number;
  private readonly bonusIntervalTicks: number;

  // Optional injected RNG (seeded determinism path). When null, production
  // behavior is preserved: crypto randomInt for reels, Math.random for spawns.
  private readonly rng: Rng | null;

  constructor(tickRate: number, rng: Rng | null = null) {
    this.spinDurationTicks = Math.ceil(SLOT_MACHINE_CONFIG.SPIN_DURATION / 1000 * tickRate);
    this.bonusDelayTicks = Math.ceil(SLOT_MACHINE_CONFIG.BONUS_SPAWN_DELAY / 1000 * tickRate);
    this.bonusIntervalTicks = Math.max(1, Math.ceil(SLOT_MACHINE_CONFIG.BONUS_SPAWN_INTERVAL / 1000 * tickRate));
    this.rng = rng;
  }

  /** Float in [0,1): injected RNG when seeded, else Math.random. */
  private nextFloat(): number {
    return this.rng ? this.rng() : Math.random();
  }

  /** Integer in [0,n): injected RNG when seeded, else crypto randomInt. */
  private reelIndex(n: number): number {
    return this.rng ? Math.floor(this.rng() * n) : randomInt(n);
  }

  /**
   * Notify that a coin fell through the left wall.
   * Returns bonus coins to spawn (empty if no jackpot this tick).
   */
  onLeftWallCoin(currentTick: number): BonusCoinSpawn[] {
    if (this.spinning) return [];

    this.counter++;

    if (this.counter >= SLOT_MACHINE_CONFIG.TRIGGER_COUNT) {
      return this.triggerSpin(currentTick);
    }
    return [];
  }

  /**
   * Called every tick — returns bonus coins that should spawn this tick.
   */
  tick(currentTick: number): BonusCoinSpawn[] {
    if (!this.spinning) return [];

    // Check if spin animation is done (non-jackpot case)
    if (this.bonusSpawnQueue.length === 0 && currentTick >= this.spinEndTick) {
      this.spinning = false;
      return [];
    }

    // Drain bonus coins scheduled for this tick
    const spawns: BonusCoinSpawn[] = [];
    while (this.bonusSpawnQueue.length > 0 && this.bonusSpawnQueue[0].tick <= currentTick) {
      this.bonusSpawnQueue.shift();
      spawns.push(this.randomBonusCoinSpawn());
    }

    // All bonus coins spawned — done spinning
    if (this.bonusSpawnQueue.length === 0 && currentTick >= this.spinEndTick) {
      this.spinning = false;
    }

    return spawns;
  }

  private triggerSpin(currentTick: number): BonusCoinSpawn[] {
    this.spinning = true;
    this.counter = 0;
    this.totalSpins++;

    // Roll 3 random symbols
    const symbols = SLOT_MACHINE_CONFIG.SYMBOLS;
    const reels: [SlotSymbol, SlotSymbol, SlotSymbol] = [
      symbols[this.reelIndex(symbols.length)],
      symbols[this.reelIndex(symbols.length)],
      symbols[this.reelIndex(symbols.length)],
    ];
    const jackpot = reels[0] === reels[1] && reels[1] === reels[2];

    if (jackpot) {
      this.totalJackpots++;
      // Schedule bonus coin spawns
      const startTick = currentTick + this.bonusDelayTicks;
      for (let i = 0; i < SLOT_MACHINE_CONFIG.BONUS_AMOUNT; i++) {
        this.bonusSpawnQueue.push({ tick: startTick + i * this.bonusIntervalTicks });
      }
      // Spin ends after all bonuses are spawned
      const lastBonusTick = startTick + (SLOT_MACHINE_CONFIG.BONUS_AMOUNT - 1) * this.bonusIntervalTicks;
      this.spinEndTick = lastBonusTick + 1;
    } else {
      this.spinEndTick = currentTick + this.spinDurationTicks;
    }

    return [];
  }

  private randomBonusCoinSpawn(): BonusCoinSpawn {
    const x = (this.nextFloat() - 0.5) * SCENE_CONFIG.PLATFORM.WIDTH;
    const y = COIN_CONFIG.SPAWN_HEIGHT + 0.5 + this.nextFloat() * 0.5;
    const z = SCENE_CONFIG.PLATFORM.POSITION.z + (this.nextFloat() - 0.5) * 0.4;
    const angle = (this.nextFloat() - 0.5) * Math.PI;
    return {
      x, y, z,
      rotation: { x: 0, y: Math.sin(angle / 2), z: 0, w: Math.cos(angle / 2) },
    };
  }

  isSpinning(): boolean {
    return this.spinning;
  }
}
