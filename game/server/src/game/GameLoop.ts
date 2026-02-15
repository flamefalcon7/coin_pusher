import type { PhysicsWorld } from "../physics/PhysicsWorld.js";
import type { Pusher } from "../physics/Pusher.js";
import type { Coin } from "../physics/Coin.js";
import type { GameState } from "./GameState.js";
import type { CoinManager } from "./CoinManager.js";
import type { NATSClient } from "../nats/NATSClient.js";
import type {
  StateDeltaMessage,
  DespawnMessage,
  StateUpdate,
} from "@coin-pusher/shared";
import { PHYSICS_CONFIG, SCENE_CONFIG } from "@coin-pusher/shared";
import { PHYSICS_PARAMS } from "../physics/config.js";

export class GameLoop {
  private physicsWorld: PhysicsWorld;
  private pusher: Pusher;
  private gameState: GameState;
  private coinManager: CoinManager;
  private natsClient: NATSClient;
  private coins: Map<number, Coin> = new Map();
  private running: boolean = false;
  private intervalId?: NodeJS.Timeout;
  private statsIntervalId?: NodeJS.Timeout;
  private tickCount: number = 0;

  // Quantize factor cached (avoid Math.pow every tick per coin)
  private static readonly Q_FACTOR = 1000; // 10^3

  // Pre-allocated reusable arrays to reduce GC pressure
  private updates: StateUpdate[] = [];
  private despawnIds: number[] = [];

  // Tick timing stats
  private tickTimings: number[] = [];
  private static readonly TIMING_WINDOW = 300; // samples (~10s at 30Hz)

  // Per-phase profiling accumulators (reset every TIMING_WINDOW)
  private profilePusher: number[] = [];
  private profileCoinUpdate: number[] = [];
  private profilePhysics: number[] = [];
  private profileFreeze: number[] = [];
  private profileStateCollect: number[] = [];
  private profileDespawn: number[] = [];
  private profilePublish: number[] = [];
  private profileActiveCounts: number[] = [];
  private profileSleepingCounts: number[] = [];
  private profileFrozenCounts: number[] = [];

  constructor(
    physicsWorld: PhysicsWorld,
    pusher: Pusher,
    gameState: GameState,
    coinManager: CoinManager,
    natsClient: NATSClient
  ) {
    this.physicsWorld = physicsWorld;
    this.pusher = pusher;
    this.gameState = gameState;
    this.coinManager = coinManager;
    this.natsClient = natsClient;
  }

  start(): void {
    if (this.running) return;

    this.running = true;
    console.log(`🎮 Game loop started at ${PHYSICS_CONFIG.TICK_RATE}Hz`);

    // Use setInterval for fixed tick rate
    this.intervalId = setInterval(() => {
      this.tick();
    }, PHYSICS_CONFIG.TICK_INTERVAL);

    // Start periodic stats logging (every 10 seconds)
    this.statsIntervalId = setInterval(() => {
      this.logStats();
    }, 10000);
  }

  stop(): void {
    if (!this.running) return;

    this.running = false;
    if (this.intervalId) {
      clearInterval(this.intervalId);
    }
    if (this.statsIntervalId) {
      clearInterval(this.statsIntervalId);
    }
    console.log("🛑 Game loop stopped");
  }

  private tick(): void {
    const tickStart = performance.now();

    // 1. Update pusher position
    this.pusher.update();
    const tAfterPusher = performance.now();

    // 2. Pre-sleep check for coins (CCD management) BEFORE physics step
    this.coins.forEach((coin) => coin.update());
    const tAfterCoinUpdate = performance.now();

    // 3. Step physics simulation
    this.physicsWorld.step();
    const tAfterPhysics = performance.now();

    // 3b. Process freeze/unfreeze
    //     Unfreeze coins that were hit by dynamic bodies (collision-event driven)
    const toUnfreeze = this.physicsWorld.drainUnfreezeQueue();
    for (let i = 0; i < toUnfreeze.length; i++) {
      const coin = this.coins.get(toUnfreeze[i]);
      if (coin && coin.isFrozen()) {
        coin.unfreeze(this.physicsWorld);
      }
    }

    //     Freeze coins that have been slow long enough
    let frozenCount = 0;
    this.coins.forEach((coin) => {
      if (coin.isFrozen()) {
        frozenCount++;
      } else if (coin.shouldFreeze()) {
        coin.freeze(this.physicsWorld);
        frozenCount++;
      }
    });
    const tAfterFreeze = performance.now();

    // 4. Single pass: collect body states and check for despawns
    //    Reuse arrays — clear length instead of allocating new arrays each tick
    const updates = this.updates;
    const despawnIds = this.despawnIds;
    updates.length = 0;
    despawnIds.length = 0;
    const f = GameLoop.Q_FACTOR;
    let sleepingCount = 0;

    this.coins.forEach((coin, id) => {
      if (coin.shouldDespawn()) {
        despawnIds.push(id);
        return;
      }

      // Skip frozen and sleeping coins — their position hasn't changed
      if (coin.isFrozen() || coin.isSleeping()) {
        sleepingCount++;
        return;
      }

      const pos = coin.getPosition();
      const rot = coin.getRotation();

      // Update game state
      this.coinManager.updateCoin(
        id,
        [pos.x, pos.y, pos.z],
        [rot.x, rot.y, rot.z, rot.w]
      );

      // Add to updates — skip normalization, Rapier quaternions are already normalized
      updates.push({
        id,
        pos: [
          Math.round(pos.x * f) / f,
          Math.round(pos.y * f) / f,
          Math.round(pos.z * f) / f,
        ],
        rot: [
          Math.round(rot.x * f) / f,
          Math.round(rot.y * f) / f,
          Math.round(rot.z * f) / f,
          Math.round(rot.w * f) / f,
        ],
      });
    });
    const tAfterStateCollect = performance.now();

    // 5. Handle despawns
    if (despawnIds.length > 0) {
      for (let i = 0; i < despawnIds.length; i++) {
        const id = despawnIds[i];
        const coin = this.coins.get(id);
        if (coin) {
          coin.destroy(this.physicsWorld);
          this.coins.delete(id);
          this.coinManager.removeCoin(id);
        }
      }

      const despawnMessage: DespawnMessage = {
        op: "despawn",
        tick: this.gameState.getTick(),
        ids: despawnIds,
      };

      this.natsClient.publishDespawn(despawnMessage);
    }
    const tAfterDespawn = performance.now();

    // 6. Update pusher z in game state
    const pusherZ = Math.round(this.pusher.getCurrentZ() * f) / f;
    this.gameState.updatePusherZ(pusherZ);

    // 7. Broadcast state delta (always send so client stays in sync with pusherZ)
    const stateDelta: StateDeltaMessage = {
      op: "state_delta",
      serverTime: Date.now(),
      tick: this.gameState.getTick(),
      updates,
      pusherZ,
    };

    this.tickCount++;

    this.natsClient.publishStateDelta(stateDelta);
    const tAfterPublish = performance.now();

    // 8. Record per-phase timings
    const pusherMs = tAfterPusher - tickStart;
    const coinUpdateMs = tAfterCoinUpdate - tAfterPusher;
    const physicsMs = tAfterPhysics - tAfterCoinUpdate;
    const freezeMs = tAfterFreeze - tAfterPhysics;
    const stateCollectMs = tAfterStateCollect - tAfterFreeze;
    const despawnMs = tAfterDespawn - tAfterStateCollect;
    const publishMs = tAfterPublish - tAfterDespawn;
    const tickMs = tAfterPublish - tickStart;

    this.tickTimings.push(tickMs);
    this.profilePusher.push(pusherMs);
    this.profileCoinUpdate.push(coinUpdateMs);
    this.profilePhysics.push(physicsMs);
    this.profileFreeze.push(freezeMs);
    this.profileStateCollect.push(stateCollectMs);
    this.profileDespawn.push(despawnMs);
    this.profilePublish.push(publishMs);
    this.profileActiveCounts.push(updates.length);
    this.profileSleepingCounts.push(sleepingCount);
    this.profileFrozenCounts.push(frozenCount);

    if (this.tickTimings.length > GameLoop.TIMING_WINDOW) {
      this.tickTimings.shift();
      this.profilePusher.shift();
      this.profileCoinUpdate.shift();
      this.profilePhysics.shift();
      this.profileFreeze.shift();
      this.profileStateCollect.shift();
      this.profileDespawn.shift();
      this.profilePublish.shift();
      this.profileActiveCounts.shift();
      this.profileSleepingCounts.shift();
      this.profileFrozenCounts.shift();
    }

    // Warn if tick exceeds budget (33.3ms at 30Hz)
    if (tickMs > PHYSICS_CONFIG.TICK_INTERVAL) {
      console.warn(
        `⚠️  Tick ${this.tickCount} overran: ${tickMs.toFixed(1)}ms ` +
          `(budget: ${PHYSICS_CONFIG.TICK_INTERVAL.toFixed(1)}ms) ` +
          `[physics: ${physicsMs.toFixed(1)}ms, coinUpdate: ${coinUpdateMs.toFixed(1)}ms, ` +
          `stateCollect: ${stateCollectMs.toFixed(1)}ms, publish: ${publishMs.toFixed(1)}ms, ` +
          `coins: ${this.coins.size}, active: ${updates.length}, sleeping: ${sleepingCount}, frozen: ${frozenCount}]`
      );
    }

    // 9. Increment tick
    this.gameState.incrementTick();
  }

  private static percentiles(arr: number[]): { avg: number; p50: number; p95: number; p99: number; max: number } {
    if (arr.length === 0) return { avg: 0, p50: 0, p95: 0, p99: 0, max: 0 };
    const sorted = arr.slice().sort((a, b) => a - b);
    const avg = arr.reduce((s, v) => s + v, 0) / arr.length;
    return {
      avg,
      p50: sorted[Math.floor(sorted.length * 0.5)],
      p95: sorted[Math.floor(sorted.length * 0.95)],
      p99: sorted[Math.floor(sorted.length * 0.99)],
      max: sorted[sorted.length - 1],
    };
  }

  private static fmtMs(v: number): string {
    return v.toFixed(2);
  }

  private logStats(): void {
    const coinCount = this.coins.size;
    const n = this.tickTimings.length;
    if (n === 0) {
      this.tickCount = 0;
      return;
    }

    const fmt = GameLoop.fmtMs;
    const total = GameLoop.percentiles(this.tickTimings);
    const physics = GameLoop.percentiles(this.profilePhysics);
    const coinUpd = GameLoop.percentiles(this.profileCoinUpdate);
    const frz = GameLoop.percentiles(this.profileFreeze);
    const stateCol = GameLoop.percentiles(this.profileStateCollect);
    const desp = GameLoop.percentiles(this.profileDespawn);
    const pub = GameLoop.percentiles(this.profilePublish);
    const push = GameLoop.percentiles(this.profilePusher);

    const avgActive = this.profileActiveCounts.length > 0
      ? Math.round(this.profileActiveCounts.reduce((s, v) => s + v, 0) / this.profileActiveCounts.length)
      : 0;
    const avgSleeping = this.profileSleepingCounts.length > 0
      ? Math.round(this.profileSleepingCounts.reduce((s, v) => s + v, 0) / this.profileSleepingCounts.length)
      : 0;
    const avgFrozen = this.profileFrozenCounts.length > 0
      ? Math.round(this.profileFrozenCounts.reduce((s, v) => s + v, 0) / this.profileFrozenCounts.length)
      : 0;
    const overruns = this.tickTimings.filter((t) => t > PHYSICS_CONFIG.TICK_INTERVAL).length;

    // Calculate what % of total tick each phase takes (based on avg)
    const pctOf = (phase: number) => total.avg > 0 ? ((phase / total.avg) * 100).toFixed(0) : "0";

    console.log(
      `\n📊 PROFILING REPORT (${n} ticks, ${coinCount} coins: ${avgActive} active, ${avgSleeping} sleeping, ${avgFrozen} frozen)\n` +
      `   Budget: ${fmt(PHYSICS_CONFIG.TICK_INTERVAL)}ms | Overruns: ${overruns}/${n}\n` +
      `   ─────────────────────────────────────────────────────────────\n` +
      `   Phase            │  avg      p50      p95      p99      max   │ % of tick\n` +
      `   ─────────────────┼──────────────────────────────────────────────┼──────────\n` +
      `   Total            │ ${fmt(total.avg).padStart(6)}  ${fmt(total.p50).padStart(6)}  ${fmt(total.p95).padStart(6)}  ${fmt(total.p99).padStart(6)}  ${fmt(total.max).padStart(6)}  │   100%\n` +
      `   Physics (Rapier) │ ${fmt(physics.avg).padStart(6)}  ${fmt(physics.p50).padStart(6)}  ${fmt(physics.p95).padStart(6)}  ${fmt(physics.p99).padStart(6)}  ${fmt(physics.max).padStart(6)}  │  ${pctOf(physics.avg).padStart(4)}%\n` +
      `   Freeze/unfreeze  │ ${fmt(frz.avg).padStart(6)}  ${fmt(frz.p50).padStart(6)}  ${fmt(frz.p95).padStart(6)}  ${fmt(frz.p99).padStart(6)}  ${fmt(frz.max).padStart(6)}  │  ${pctOf(frz.avg).padStart(4)}%\n` +
      `   Coin update      │ ${fmt(coinUpd.avg).padStart(6)}  ${fmt(coinUpd.p50).padStart(6)}  ${fmt(coinUpd.p95).padStart(6)}  ${fmt(coinUpd.p99).padStart(6)}  ${fmt(coinUpd.max).padStart(6)}  │  ${pctOf(coinUpd.avg).padStart(4)}%\n` +
      `   State collect    │ ${fmt(stateCol.avg).padStart(6)}  ${fmt(stateCol.p50).padStart(6)}  ${fmt(stateCol.p95).padStart(6)}  ${fmt(stateCol.p99).padStart(6)}  ${fmt(stateCol.max).padStart(6)}  │  ${pctOf(stateCol.avg).padStart(4)}%\n` +
      `   Despawn          │ ${fmt(desp.avg).padStart(6)}  ${fmt(desp.p50).padStart(6)}  ${fmt(desp.p95).padStart(6)}  ${fmt(desp.p99).padStart(6)}  ${fmt(desp.max).padStart(6)}  │  ${pctOf(desp.avg).padStart(4)}%\n` +
      `   NATS publish     │ ${fmt(pub.avg).padStart(6)}  ${fmt(pub.p50).padStart(6)}  ${fmt(pub.p95).padStart(6)}  ${fmt(pub.p99).padStart(6)}  ${fmt(pub.max).padStart(6)}  │  ${pctOf(pub.avg).padStart(4)}%\n` +
      `   Pusher           │ ${fmt(push.avg).padStart(6)}  ${fmt(push.p50).padStart(6)}  ${fmt(push.p95).padStart(6)}  ${fmt(push.p99).padStart(6)}  ${fmt(push.max).padStart(6)}  │  ${pctOf(push.avg).padStart(4)}%\n` +
      `   ─────────────────────────────────────────────────────────────`
    );

    // Detailed sleep stats (when DEBUG_SLEEP enabled)
    if (PHYSICS_PARAMS.DEBUG_SLEEP) {
      let activeCoins = 0;
      let sleepingCoins = 0;
      let lowVelActiveCoins = 0;
      let totalLinVel = 0;
      let totalAngVel = 0;

      const linThresholdSq = PHYSICS_PARAMS.SLEEP_LINEAR_THRESHOLD ** 2;
      const angThresholdSq = PHYSICS_PARAMS.SLEEP_ANGULAR_THRESHOLD ** 2;

      this.coins.forEach((coin) => {
        const body = coin.getRigidBody();
        if (body.isSleeping()) {
          sleepingCoins++;
        } else {
          activeCoins++;
          const linvel = body.linvel();
          const angvel = body.angvel();

          const vSq = linvel.x ** 2 + linvel.y ** 2 + linvel.z ** 2;
          const wSq = angvel.x ** 2 + angvel.y ** 2 + angvel.z ** 2;

          totalLinVel += Math.sqrt(vSq);
          totalAngVel += Math.sqrt(wSq);

          if (vSq < linThresholdSq && wSq < angThresholdSq) {
            lowVelActiveCoins++;
          }
        }
      });

      const avgLinVel =
        activeCoins > 0 ? (totalLinVel / activeCoins).toFixed(3) : "0.000";
      const avgAngVel =
        activeCoins > 0 ? (totalAngVel / activeCoins).toFixed(3) : "0.000";

      console.log(
        `   Sleep: ${activeCoins} active (${lowVelActiveCoins} low-vel), ${sleepingCoins} sleeping\n` +
          `   Velocities (active): Lin: ${avgLinVel}, Ang: ${avgAngVel}`
      );
    }

    this.tickCount = 0;
  }

  addCoin(coin: Coin): void {
    this.coins.set(coin.getId(), coin);
  }

  shockPins(): void {
    // Pin zone bounds: coins stuck around the pins near the back wall
    const pinYMin = SCENE_CONFIG.PLATFORM.POSITION.y + SCENE_CONFIG.PINS.START_Y;
    const pinYMax = pinYMin + (SCENE_CONFIG.PINS.ROWS - 1) * SCENE_CONFIG.PINS.VERTICAL_SPACING + SCENE_CONFIG.PINS.Y_OFFSET;
    const backWallZ = SCENE_CONFIG.BACK_WALL.POSITION.z;
    const zThreshold = 0.25; // coins within 25cm of back wall

    let shocked = 0;
    this.coins.forEach((coin) => {
      const pos = coin.getPosition();

      // Check if coin is in the pin zone (near back wall, in pin Y range)
      if (pos.y >= pinYMin && pos.y <= pinYMax && pos.z < backWallZ + zThreshold) {
        // Unfreeze frozen coins before applying impulse
        if (coin.isFrozen()) {
          coin.unfreeze(this.physicsWorld);
        }
        const body = coin.getRigidBody();
        // Wake up sleeping coins
        body.wakeUp();
        // Apply random impulse: forward (positive Z), slight downward, random lateral
        const impulse = {
          x: (Math.random() - 0.5) * 0.005,
          y: -0.002,
          z: 0.005 + Math.random() * 0.005,
        };
        body.applyImpulse(impulse, true);
        shocked++;
      }
    });

    if (shocked > 0) {
      console.log(`Shocked ${shocked} coins in pin zone`);
    }
  }
}
