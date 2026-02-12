import type { PhysicsWorld } from "../physics/PhysicsWorld.js";
import type { Pusher } from "../physics/Pusher.js";
import type { Coin } from "../physics/Coin.js";
import type { GameState } from "./GameState.js";
import type { CoinManager } from "./CoinManager.js";
import type { WebSocketServer } from "../ws/WebSocketServer.js";
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
  private wsServer: WebSocketServer;
  private coins: Map<number, Coin> = new Map();
  private running: boolean = false;
  private intervalId?: NodeJS.Timeout;
  private statsIntervalId?: NodeJS.Timeout;
  private tickCount: number = 0;

  // Quantize factor cached (avoid Math.pow every tick per coin)
  private static readonly Q_FACTOR = 1000; // 10^3

  constructor(
    physicsWorld: PhysicsWorld,
    pusher: Pusher,
    gameState: GameState,
    coinManager: CoinManager,
    wsServer: WebSocketServer
  ) {
    this.physicsWorld = physicsWorld;
    this.pusher = pusher;
    this.gameState = gameState;
    this.coinManager = coinManager;
    this.wsServer = wsServer;
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
    // 1. Update pusher position
    this.pusher.update();

    // 2. Update coins (CCD check)
    this.coins.forEach((coin) => coin.update());

    // 3. Step physics simulation
    this.physicsWorld.step();

    // 4. Collect body states and check for despawns
    const updates: StateUpdate[] = [];
    const despawnIds: number[] = [];
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
      despawnIds.forEach((id) => {
        const coin = this.coins.get(id);
        if (coin) {
          // Properly remove RigidBody and Collider from physics world
          coin.destroy(this.physicsWorld);
          this.coins.delete(id);
          this.coinManager.removeCoin(id);
        }
      });

      const despawnMessage: DespawnMessage = {
        op: "despawn",
        tick: this.gameState.getTick(),
        ids: despawnIds,
      };

      this.wsServer.broadcast(despawnMessage);
    }

    // 6. Update pusher z in game state
    const pusherZ = Math.round(this.pusher.getCurrentZ() * f) / f;
    this.gameState.updatePusherZ(pusherZ);

    // 7. Broadcast state delta
    const stateDelta: StateDeltaMessage = {
      op: "state_delta",
      serverTime: Date.now(),
      tick: this.gameState.getTick(),
      updates,
      pusherZ,
    };

    this.tickCount++;

    this.wsServer.broadcast(stateDelta);

    // 8. Increment tick
    this.gameState.incrementTick();
  }

  private logStats(): void {
    const connections = this.wsServer.getConnections().size;
    const coinCount = this.coins.size;

    let activeCoins = 0;
    let sleepingCoins = 0;
    let lowVelActiveCoins = 0;
    let totalLinVel = 0;
    let totalAngVel = 0;

    const linThresholdSq = PHYSICS_PARAMS.SLEEP_LINEAR_THRESHOLD ** 2;
    const angThresholdSq = PHYSICS_PARAMS.SLEEP_ANGULAR_THRESHOLD ** 2;

    if (PHYSICS_PARAMS.DEBUG_SLEEP) {
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

          // Check if coin is candidate for sleep (low velocity)
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
        `📊 Stats: ${activeCoins} active (${lowVelActiveCoins} low-vel), ${sleepingCoins} sleeping, ${coinCount} total\n` +
          `   Velocities (active): Lin: ${avgLinVel}, Ang: ${avgAngVel}\n` +
          `   Net: ${connections} conns`
      );

      // Reset counters
      this.tickCount = 0;
    }
  }

  addCoin(coin: Coin): void {
    this.coins.set(coin.getId(), coin);
  }
}
