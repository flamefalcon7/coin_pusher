import { NATSClient, type CoinInsertCommand, type SpawnStackCommand, type ShockCommand, type TornadoCommand, type ExplosionCommand, type LightningCommand, type ClearAllCommand, type FillPlatformCommand, type UpdateSceneObjectsCommand } from "./nats/NATSClient.js";
import { PhysicsWorld } from "./physics/PhysicsWorld.js";
import { SceneBuilder } from "./physics/SceneBuilder.js";
import { Pusher } from "./physics/Pusher.js";
import { Coin } from "./physics/Coin.js";
import { StackSpawner } from "./game/StackSpawner.js";
import { GameState } from "./game/GameState.js";
import { CoinManager } from "./game/CoinManager.js";
import { GameLoop } from "./game/GameLoop.js";
import { EditorPhysics } from "./physics/EditorPhysics.js";
import type { StackType, WorldSnapshotMessage } from "@coin-pusher/shared";

const NATS_URL = process.env.NATS_URL || "nats://localhost:4222";

console.log("Starting Coin Pusher Game Server (NATS worker)...");
console.log(`NATS URL: ${NATS_URL}`);

// Initialize game components
const physicsWorld = new PhysicsWorld();
const gameState = new GameState();
const coinManager = new CoinManager(gameState);
const natsClient = new NATSClient("main");

let pusher: Pusher;
let gameLoop: GameLoop;
let snapshotInterval: NodeJS.Timeout;

async function initialize() {
  // Initialize physics
  await physicsWorld.init();

  const sceneBuilder = new SceneBuilder(physicsWorld);
  sceneBuilder.buildStaticScene();

  const editorPhysics = new EditorPhysics(physicsWorld);

  pusher = new Pusher(physicsWorld);

  // Connect to NATS
  await natsClient.connect(NATS_URL);

  // Create game loop (now uses NATSClient instead of WebSocketServer)
  gameLoop = new GameLoop(
    physicsWorld,
    pusher,
    gameState,
    coinManager,
    natsClient
  );

  // Subscribe to coin_insert commands from Go backend
  natsClient.subscribeCoinInsert((cmd: CoinInsertCommand) => {
    const coinId = coinManager.spawnCoin(cmd.x, cmd.y, cmd.z);
    if (coinId !== null) {
      const coin = new Coin(physicsWorld, coinId, cmd.x, cmd.y, cmd.z);
      gameLoop.addCoin(coin);
    }
  });

  // Subscribe to spawn_stack commands from Go backend
  natsClient.subscribeSpawnStack((cmd: SpawnStackCommand) => {
    const coins = StackSpawner.getStackCoins(cmd.type as StackType, cmd.x, cmd.y, cmd.z);
    coins.forEach((coinData) => {
      const rot: [number, number, number, number] = [
        coinData.rotation.x,
        coinData.rotation.y,
        coinData.rotation.z,
        coinData.rotation.w,
      ];

      const coinId = coinManager.spawnCoin(
        coinData.x,
        coinData.y,
        coinData.z,
        rot
      );

      if (coinId !== null) {
        const coin = new Coin(
          physicsWorld,
          coinId,
          coinData.x,
          coinData.y,
          coinData.z,
          coinData.rotation
        );
        gameLoop.addCoin(coin);
      }
    });
    console.log(`Spawned ${cmd.type} stack with ${coins.length} coins`);
  });

  // Subscribe to shock commands from Go backend
  natsClient.subscribeShock((_cmd: ShockCommand) => {
    gameLoop.shockPins();
  });

  // Subscribe to tornado commands from Go backend
  natsClient.subscribeTornado((cmd: TornadoCommand) => {
    gameLoop.startTornado(cmd.x, cmd.z);
  });

  // Subscribe to explosion commands from Go backend
  natsClient.subscribeExplosion((cmd: ExplosionCommand) => {
    gameLoop.explode(cmd.x, cmd.z);
  });

  // Subscribe to lightning commands from Go backend
  natsClient.subscribeLightning((_cmd: LightningCommand) => {
    gameLoop.lightning();
  });

  // Subscribe to clear_all commands from Go backend
  natsClient.subscribeClearAll((_cmd: ClearAllCommand) => {
    gameLoop.clearAll();
  });

  // Subscribe to fill_platform commands from Go backend
  natsClient.subscribeFillPlatform((_cmd: FillPlatformCommand) => {
    gameLoop.fillPlatform();
  });

  // Subscribe to update_scene_objects commands from Go backend
  natsClient.subscribeUpdateSceneObjects((cmd: UpdateSceneObjectsCommand) => {
    editorPhysics.syncObjects(cmd.objects);
  });

  // Subscribe to snapshot requests (request/reply for new clients)
  natsClient.subscribeSnapshotRequest(() => {
    const worldState = gameState.getWorldSnapshot();
    return {
      op: "world_snapshot" as const,
      ...worldState,
    };
  });

  // Publish snapshot periodically for hub caching (every 10s)
  snapshotInterval = setInterval(() => {
    const worldState = gameState.getWorldSnapshot();
    const snapshot: WorldSnapshotMessage = {
      op: "world_snapshot",
      ...worldState,
    };
    natsClient.publishSnapshot(snapshot);
  }, 10000);

  // Start game loop
  gameLoop.start();

  console.log("Server ready! (NATS worker mode)");
}

// Graceful shutdown
const shutdown = async () => {
  console.log("\nShutting down server...");
  if (snapshotInterval) {
    clearInterval(snapshotInterval);
  }
  if (gameLoop) {
    gameLoop.stop();
  }
  await natsClient.close();
  process.exit(0);
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

// Start initialization
initialize().catch((error) => {
  console.error("Failed to initialize server:", error);
  process.exit(1);
});
