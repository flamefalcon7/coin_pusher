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
import * as msgpack from "@msgpack/msgpack";

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
  private totalMessageBytes: number = 0;

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

    this.coins.forEach((coin, id) => {
      if (coin.shouldDespawn()) {
        despawnIds.push(id);
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

      // Add to updates
      updates.push({
        id,
        pos: [
          this.quantize(pos.x, 3),
          this.quantize(pos.y, 3),
          this.quantize(pos.z, 3),
        ],
        rot: this.normalizeAndQuantizeQuaternion(rot),
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
    const pusherZ = this.quantize(this.pusher.getCurrentZ(), 3);
    this.gameState.updatePusherZ(pusherZ);

    // 7. Broadcast state delta
    const stateDelta: StateDeltaMessage = {
      op: "state_delta",
      serverTime: Date.now(),
      tick: this.gameState.getTick(),
      updates,
      pusherZ,
    };

    // Track message size for stats
    const messageBytes = msgpack.encode(stateDelta).length;
    this.totalMessageBytes += messageBytes;
    this.tickCount++;

    this.wsServer.broadcast(stateDelta);

    // 8. Increment tick
    this.gameState.incrementTick();
  }

  private logStats(): void {
    const connections = this.wsServer.getConnections().size;
    const coinCount = this.coins.size;
    const avgMessageBytes =
      this.tickCount > 0
        ? Math.round(this.totalMessageBytes / this.tickCount)
        : 0;
    const estimatedBandwidthPerUser = (
      (avgMessageBytes * PHYSICS_CONFIG.TICK_RATE) /
      1024
    ).toFixed(2);
    const estimatedTotalOutbound = (
      (avgMessageBytes * PHYSICS_CONFIG.TICK_RATE * connections) /
      1024
    ).toFixed(2);

    console.log(
      `📊 Stats: ${coinCount} coins, ${connections} connections, ` +
        `avg msg: ${avgMessageBytes}B, ` +
        `bandwidth/user: ${estimatedBandwidthPerUser} KB/s, ` +
        `total outbound: ~${estimatedTotalOutbound} KB/s`
    );

    // Reset counters
    this.tickCount = 0;
    this.totalMessageBytes = 0;
  }

  addCoin(coin: Coin): void {
    this.coins.set(coin.getId(), coin);
  }

  private quantize(value: number, decimals: number): number {
    const factor = Math.pow(10, decimals);
    return Math.round(value * factor) / factor;
  }

  private normalizeAndQuantizeQuaternion(q: {
    x: number;
    y: number;
    z: number;
    w: number;
  }): [number, number, number, number] {
    // Normalize
    const len = Math.sqrt(q.x ** 2 + q.y ** 2 + q.z ** 2 + q.w ** 2);
    const qx = q.x / len;
    const qy = q.y / len;
    const qz = q.z / len;
    const qw = q.w / len;

    // Quantize
    return [
      this.quantize(qx, 3),
      this.quantize(qy, 3),
      this.quantize(qz, 3),
      this.quantize(qw, 3),
    ];
  }
}
