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
import { PHYSICS_CONFIG } from "@coin-pusher/shared";
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

    // 2. Pre-sleep check for coins (CCD management) BEFORE physics step
    const t1 = performance.now();
    this.coins.forEach((coin) => coin.update());
    const coinUpdateMs = performance.now() - t1;

    // 3. Step physics simulation
    const t2 = performance.now();
    this.physicsWorld.step();
    const physicsMs = performance.now() - t2;

    // 4. Single pass: collect body states and check for despawns
    //    Reuse arrays — clear length instead of allocating new arrays each tick
    const updates = this.updates;
    const despawnIds = this.despawnIds;
    updates.length = 0;
    despawnIds.length = 0;
    const f = GameLoop.Q_FACTOR;

    this.coins.forEach((coin, id) => {
      if (coin.shouldDespawn()) {
        despawnIds.push(id);
        return;
      }

      // Skip sleeping coins — their position hasn't changed
      if (coin.isSleeping()) {
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

    // 8. Record tick timing
    const tickMs = performance.now() - tickStart;
    this.tickTimings.push(tickMs);
    if (this.tickTimings.length > GameLoop.TIMING_WINDOW) {
      this.tickTimings.shift();
    }

    // Warn if tick exceeds budget (33.3ms at 30Hz)
    if (tickMs > PHYSICS_CONFIG.TICK_INTERVAL) {
      console.warn(
        `⚠️  Tick ${this.tickCount} overran: ${tickMs.toFixed(1)}ms ` +
          `(budget: ${PHYSICS_CONFIG.TICK_INTERVAL.toFixed(1)}ms) ` +
          `[physics: ${physicsMs.toFixed(1)}ms, coinUpdate: ${coinUpdateMs.toFixed(1)}ms, ` +
          `coins: ${this.coins.size}, active: ${updates.length}]`
      );
    }

    // 9. Increment tick
    this.gameState.incrementTick();
  }

  private logStats(): void {
    const coinCount = this.coins.size;

    // Tick timing stats (always log)
    const timings = this.tickTimings;
    if (timings.length > 0) {
      const sorted = timings.slice().sort((a, b) => a - b);
      const avg = timings.reduce((s, v) => s + v, 0) / timings.length;
      const p50 = sorted[Math.floor(sorted.length * 0.5)];
      const p95 = sorted[Math.floor(sorted.length * 0.95)];
      const p99 = sorted[Math.floor(sorted.length * 0.99)];
      const max = sorted[sorted.length - 1];
      const overruns = timings.filter((t) => t > PHYSICS_CONFIG.TICK_INTERVAL).length;

      console.log(
        `📊 Tick timing (${timings.length} samples): ` +
          `avg=${avg.toFixed(1)}ms, p50=${p50.toFixed(1)}ms, p95=${p95.toFixed(1)}ms, ` +
          `p99=${p99.toFixed(1)}ms, max=${max.toFixed(1)}ms, ` +
          `overruns=${overruns}/${timings.length}`
      );
    }

    console.log(
      `   Coins: ${coinCount} total`
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
}
