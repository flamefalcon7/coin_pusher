import { PhysicsWorld } from "../physics/PhysicsWorld.js";
import { SceneBuilder } from "../physics/SceneBuilder.js";
import { Pusher } from "../physics/Pusher.js";
import { Coin } from "../physics/Coin.js";
import { SimClock } from "./SimClock.js";
import { SlotMachine } from "./SlotMachine.js";
import { AbilitySimulator, type AbilitySet, NO_ABILITIES } from "./AbilitySimulator.js";
import { classifyCoin } from "./CoinOutcome.js";
import type { TrialResult } from "./Statistics.js";
import type { Rng } from "./Rng.js";
import {
  PHYSICS_CONFIG,
  SCENE_CONFIG,
  COIN_CONFIG,
  PUSHER_CONFIG,
} from "@coin-pusher/shared";

/** Per-tick observation hook for the main loop (used by determinism tests). */
export type SimTickHook = (tick: number, coins: Map<number, Coin>) => void;

/** Optional injection for the simulation path. */
export type SimLoopOptions = {
  /** Seeded RNG — threads into warmup/insert, SlotMachine, AbilitySimulator.
   *  When omitted, the trial uses Math.random / crypto (production shape). */
  rng?: Rng | null;
  /** Called once per main-loop tick after despawns, for state snapshots. */
  onTick?: SimTickHook;
};

export type SimLoopConfig = {
  coinsPerTrial: number;          // player coins to insert per trial
  coinInsertIntervalTicks: number; // ticks between coin inserts (default 60 = 2s)
  warmupCoins: number;            // coins to pre-fill before trial
  warmupSettleTicks: number;      // ticks to let warmup coins settle
  abilities: AbilitySet;          // which abilities to enable
  abilityIntervalTicks: number;   // ticks between random ability fires
  maxBonusDepth: number;          // max recursion depth for bonus coins triggering slots
  maxSimTimeSec: number;          // safety timeout per trial (simulated seconds)
  drainTimeoutTicks: number;      // max ticks to wait after last insert for coins to clear
};

export const DEFAULT_CONFIG: SimLoopConfig = {
  coinsPerTrial: 200,
  coinInsertIntervalTicks: 60,    // ~2 seconds at 30Hz
  warmupCoins: 80,
  warmupSettleTicks: 300,         // 10 seconds settle time
  abilities: NO_ABILITIES,
  abilityIntervalTicks: 150,      // ~5 seconds
  maxBonusDepth: 5,
  maxSimTimeSec: 7200,
  drainTimeoutTicks: 3000,         // ~100 seconds at 30Hz to wait for remaining coins
};

/**
 * Core simulation loop — synchronous for loop, no setInterval.
 * Persistent world: coins accumulate on the platform across the trial.
 */
export class SimLoop {
  private config: SimLoopConfig;
  private readonly rng: Rng | null;
  private readonly onTick?: SimTickHook;

  constructor(config: Partial<SimLoopConfig> = {}, opts: SimLoopOptions = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.rng = opts.rng ?? null;
    this.onTick = opts.onTick;
  }

  /** Float in [0,1): injected seeded RNG when present, else Math.random. */
  private nextFloat(): number {
    return this.rng ? this.rng() : Math.random();
  }

  /** Run a single trial. Returns the trial result. */
  async runTrial(): Promise<TrialResult> {
    // --- Setup ---
    const clock = new SimClock();
    const physicsWorld = new PhysicsWorld();
    await physicsWorld.init();

    const sceneBuilder = new SceneBuilder(physicsWorld);
    sceneBuilder.buildStaticScene();

    const pusher = new Pusher(physicsWorld);
    const slotMachine = new SlotMachine(PHYSICS_CONFIG.TICK_RATE, this.rng);
    const abilitySimulator = new AbilitySimulator(PHYSICS_CONFIG.TICK_RATE, this.rng);

    const coins = new Map<number, Coin>();
    let coinIdCounter = 0;
    const dt = 1 / PHYSICS_CONFIG.TICK_RATE;
    const dtMs = dt * 1000;
    // The pusher is a position-based kinematic body and must be advanced once
    // per solver substep, exactly as GameLoop.runTick() does. Advancing it once
    // per tick would move it a whole tick's travel during the first substep and
    // leave it frozen for the rest — a different contact velocity against the
    // coins, which would make this harness's RTP numbers describe a pusher the
    // live server does not have.
    const substepMs = dtMs / physicsWorld.getSubsteps();
    /** Advance one tick of physics with production's pusher cadence. */
    const stepWithPusher = () => {
      // clock.advance(dtMs) has already run, so clock.now() is the tick's END.
      const tickStartMs = clock.now() - dtMs;
      physicsWorld.step((substep) => {
        pusher.update(tickStartMs + (substep + 1) * substepMs);
      });
    };

    // Track which coin IDs are bonus coins
    const bonusCoinIds = new Set<number>();
    // Track player-inserted coin IDs (to know when trial is "done")
    const playerCoinIds = new Set<number>();
    // Track bonus depth per coin (for recursion safety)
    let currentBonusDepth = 0;

    // Tracking
    let coinsInserted = 0;
    let frontEdgePlayer = 0;
    let leftWallPlayer = 0;
    let lostPlayer = 0;
    let bonusCoinsSpawned = 0;
    let bonusFrontEdge = 0;

    // --- Helper: spawn a coin ---
    // tag: 'warmup' | 'player' | 'bonus'
    const spawnCoin = (x: number, y: number, z: number, tag: 'warmup' | 'player' | 'bonus', rotation?: { x: number; y: number; z: number; w: number }): Coin => {
      const id = ++coinIdCounter;
      const coin = new Coin(physicsWorld, id, x, y, z, rotation);
      coins.set(id, coin);
      if (tag === 'bonus') {
        bonusCoinIds.add(id);
      } else if (tag === 'player') {
        playerCoinIds.add(id);
      }
      return coin;
    };

    // --- Helper: process despawns ---
    const processDespawns = (currentTick: number): void => {
      const toRemove: number[] = [];

      coins.forEach((coin, id) => {
        if (!coin.shouldDespawn()) return;

        const pos = coin.getPosition();
        const outcome = classifyCoin(pos);
        const isBonus = bonusCoinIds.has(id);

        if (outcome === "front_edge") {
          if (isBonus) {
            bonusFrontEdge++;
          } else {
            frontEdgePlayer++;
          }
        } else if (outcome === "left_wall") {
          if (!isBonus) {
            leftWallPlayer++;
          }
          // Left wall coins trigger slot machine (bonus coins too, with depth limit)
          if (!isBonus || currentBonusDepth < this.config.maxBonusDepth) {
            const prevDepth = currentBonusDepth;
            if (isBonus) currentBonusDepth++;
            const bonusSpawns = slotMachine.onLeftWallCoin(currentTick);
            for (const spawn of bonusSpawns) {
              spawnCoin(spawn.x, spawn.y, spawn.z, 'bonus', spawn.rotation);
              bonusCoinsSpawned++;
            }
            if (isBonus) currentBonusDepth = prevDepth;
          }
        } else {
          if (!isBonus) {
            lostPlayer++;
          }
        }

        toRemove.push(id);
      });

      for (const id of toRemove) {
        const coin = coins.get(id);
        if (coin) {
          coin.destroy(physicsWorld);
          coins.delete(id);
          bonusCoinIds.delete(id);
          playerCoinIds.delete(id);
        }
      }
    };

    // --- Warmup: pre-fill platform ---
    // Use hex packing similar to GameLoop.fillPlatform
    const { POSITION, DEPTH, WIDTH, FLARE_Z, FLARE_ANGLE, THICKNESS } = SCENE_CONFIG.PLATFORM;
    const surfaceY = POSITION.y + THICKNESS / 2;
    const frontZ = POSITION.z + DEPTH / 2;
    const hw = WIDTH / 2;
    const flareRad = FLARE_ANGLE * Math.PI / 180;
    const coinD = COIN_CONFIG.RADIUS * 2;
    const colSpacing = coinD;
    const rowSpacing = coinD * Math.sqrt(3) / 2;

    const pusherMaxZ = SCENE_CONFIG.PUSHER.POSITION.z
      + SCENE_CONFIG.PUSHER.DEPTH / 2
      + PUSHER_CONFIG.Z_OFFSET + PUSHER_CONFIG.AMPLITUDE;
    const zMin = pusherMaxZ + coinD;
    const zMax = frontZ - 0.02;

    let warmupCount = 0;
    let row = 0;
    outer:
    for (let z = zMin; z <= zMax; z += rowSpacing) {
      let halfW: number;
      if (z < FLARE_Z) {
        halfW = hw;
      } else {
        halfW = hw + Math.tan(flareRad) * (z - FLARE_Z);
      }
      halfW -= 0.02;
      const xOffset = (row % 2 === 1) ? coinD / 2 : 0;

      for (let x = -halfW + xOffset; x <= halfW; x += colSpacing) {
        if (x < -halfW || x > halfW) continue;
        if (this.nextFloat() < 0.1) continue; // 10% skip for messiness
        if (warmupCount >= this.config.warmupCoins) break outer;

        const cy = surfaceY + 0.3 + this.nextFloat() * 0.1;
        const rx = x + (this.nextFloat() - 0.5) * 0.06;
        const rz = z + (this.nextFloat() - 0.5) * 0.06;
        const angle = (this.nextFloat() - 0.5) * Math.PI * 0.3;
        const rot = { x: 0, y: Math.sin(angle / 2), z: 0, w: Math.cos(angle / 2) };

        spawnCoin(rx, cy, rz, 'warmup', rot);
        warmupCount++;
      }
      row++;
    }

    // Settle warmup coins
    for (let t = 0; t < this.config.warmupSettleTicks; t++) {
      clock.advance(dtMs);
      coins.forEach((coin) => coin.update());
      stepWithPusher();
      processDespawns(t);
    }

    // Reset counters after warmup (warmup coin despawns don't count)
    frontEdgePlayer = 0;
    leftWallPlayer = 0;
    lostPlayer = 0;
    bonusFrontEdge = 0;
    bonusCoinsSpawned = 0;
    slotMachine.totalSpins = 0;
    slotMachine.totalJackpots = 0;
    // Mark remaining warmup coins as non-bonus, non-counted
    // They are already non-bonus. Their despawn will be counted — this is expected
    // (they represent the "house" coins on the platform)

    // --- Main simulation loop ---
    let currentTick = 0;
    let abilityTick = 0;
    let drainTicks = 0;
    const maxTicks = this.config.maxSimTimeSec * PHYSICS_CONFIG.TICK_RATE;

    // playerCoinIds + bonusCoinIds tracks coins we care about for termination
    const hasTrackedCoins = () => playerCoinIds.size > 0 || bonusCoinIds.size > 0;

    while (coinsInserted < this.config.coinsPerTrial || hasTrackedCoins()) {
      currentTick++;

      if (currentTick > maxTicks) break; // safety

      // Drain timeout: if all coins inserted, count drain ticks
      if (coinsInserted >= this.config.coinsPerTrial) {
        drainTicks++;
        if (drainTicks > this.config.drainTimeoutTicks) break;
      }

      clock.advance(dtMs);

      // Insert coin at interval
      if (coinsInserted < this.config.coinsPerTrial && currentTick % this.config.coinInsertIntervalTicks === 0) {
        const randomX = (this.nextFloat() - 0.5) * 0.8;
        spawnCoin(randomX, COIN_CONFIG.SPAWN_HEIGHT, 0, 'player');
        coinsInserted++;
      }

      // Ability firing
      abilityTick++;
      if (this.config.abilities !== NO_ABILITIES && abilityTick >= this.config.abilityIntervalTicks) {
        abilitySimulator.fireRandom(coins, pusher, this.config.abilities);
        abilityTick = 0;
      }

      // Update ability effects (tornado/lightning)
      abilitySimulator.update(coins);

      // Update coins (sleep/CCD)
      coins.forEach((coin) => coin.update());

      // Physics step — advances the pusher once per substep, as production does
      stepWithPusher();

      // Slot machine tick — spawn bonus coins
      const bonusSpawns = slotMachine.tick(currentTick);
      for (const spawn of bonusSpawns) {
        spawnCoin(spawn.x, spawn.y, spawn.z, 'bonus', spawn.rotation);
        bonusCoinsSpawned++;
      }

      // Process despawns
      processDespawns(currentTick);

      // Observation hook — snapshot world state at this tick (determinism test).
      this.onTick?.(currentTick, coins);

      // Early exit: all player+bonus coins resolved
      if (coinsInserted >= this.config.coinsPerTrial && !hasTrackedCoins() && !slotMachine.isSpinning()) {
        break;
      }
    }

    return {
      coinsInserted,
      frontEdgeCoins: frontEdgePlayer,
      leftWallCoins: leftWallPlayer,
      lostCoins: lostPlayer,
      bonusCoinsSpawned,
      bonusFrontEdge,
      slotSpins: slotMachine.totalSpins,
      slotJackpots: slotMachine.totalJackpots,
    };
  }
}
