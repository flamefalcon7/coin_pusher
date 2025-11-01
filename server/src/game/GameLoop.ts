import type { PhysicsWorld } from '../physics/PhysicsWorld.js';
import type { Pusher } from '../physics/Pusher.js';
import type { Coin } from '../physics/Coin.js';
import type { GameState } from './GameState.js';
import type { CoinManager } from './CoinManager.js';
import type { WebSocketServer } from '../ws/WebSocketServer.js';
import type { StateDeltaMessage, DespawnMessage, StateUpdate } from '@coin-pusher/shared';
import { PHYSICS_CONFIG } from '@coin-pusher/shared';

export class GameLoop {
  private physicsWorld: PhysicsWorld;
  private pusher: Pusher;
  private gameState: GameState;
  private coinManager: CoinManager;
  private wsServer: WebSocketServer;
  private coins: Map<number, Coin> = new Map();
  private running: boolean = false;
  private intervalId?: NodeJS.Timeout;

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
  }

  stop(): void {
    if (!this.running) return;

    this.running = false;
    if (this.intervalId) {
      clearInterval(this.intervalId);
    }
    console.log('🛑 Game loop stopped');
  }

  private tick(): void {
    // 1. Update pusher position
    this.pusher.update();

    // 2. Update coins (CCD check)
    this.coins.forEach(coin => coin.update());

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
      this.coinManager.updateCoin(id, [pos.x, pos.y, pos.z], [rot.x, rot.y, rot.z, rot.w]);

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
      despawnIds.forEach(id => {
        this.coins.delete(id);
        this.coinManager.removeCoin(id);
      });

      const despawnMessage: DespawnMessage = {
        op: 'despawn',
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
      op: 'state_delta',
      serverTime: Date.now(),
      tick: this.gameState.getTick(),
      updates,
      pusherZ,
    };

    this.wsServer.broadcast(stateDelta);

    // 8. Increment tick
    this.gameState.incrementTick();
  }

  addCoin(coin: Coin): void {
    this.coins.set(coin.getId(), coin);
  }

  private quantize(value: number, decimals: number): number {
    const factor = Math.pow(10, decimals);
    return Math.round(value * factor) / factor;
  }

  private normalizeAndQuantizeQuaternion(q: { x: number; y: number; z: number; w: number }): [number, number, number, number] {
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

