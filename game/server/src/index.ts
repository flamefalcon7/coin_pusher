import { NATSClient, type CoinInsertCommand, type SpawnStackCommand, type ShockCommand, type TornadoCommand, type ExplosionCommand, type LightningCommand, type SuperPushCommand, type ClearAllCommand, type FillPlatformCommand, type UpdateSceneObjectsCommand } from "./nats/NATSClient.js";
import { RefIDDedup } from "./nats/dedup.js";
import { startMetricsServer } from "./metrics.js";
import * as metrics from "./metrics.js";
import { PhysicsWorld } from "./physics/PhysicsWorld.js";
import { SceneBuilder } from "./physics/SceneBuilder.js";
import { Pusher } from "./physics/Pusher.js";
import { Coin } from "./physics/Coin.js";
import { StackSpawner } from "./game/StackSpawner.js";
import { GameState } from "./game/GameState.js";
import { CoinManager } from "./game/CoinManager.js";
import { GameLoop } from "./game/GameLoop.js";
import { DropScheduler } from "./game/DropScheduler.js";
import { SponsorManager } from "./game/SponsorManager.js";
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
let sponsorManager: SponsorManager;
let snapshotInterval: NodeJS.Timeout;

async function initialize() {
  startMetricsServer(9100);

  // Initialize physics
  await physicsWorld.init();

  const sceneBuilder = new SceneBuilder(physicsWorld);
  sceneBuilder.buildStaticScene();

  const editorPhysics = new EditorPhysics(physicsWorld);

  pusher = new Pusher(physicsWorld);

  // Connect to NATS
  await natsClient.connect(NATS_URL);

  // Create drop scheduler, sponsor manager, and game loop
  const dropScheduler = new DropScheduler();
  sponsorManager = new SponsorManager(natsClient);

  gameLoop = new GameLoop(
    physicsWorld,
    pusher,
    gameState,
    coinManager,
    natsClient,
    dropScheduler,
    sponsorManager
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
  natsClient.subscribeShock((cmd: ShockCommand) => {
    gameLoop.shockPins();
    natsClient.publishAbilityEvent({ op: "ability", ability: "shock", username: cmd.username });
  });

  // Subscribe to tornado commands from Go backend
  natsClient.subscribeTornado((cmd: TornadoCommand) => {
    gameLoop.startTornado(cmd.x, cmd.z);
    natsClient.publishAbilityEvent({ op: "ability", ability: "tornado", x: cmd.x, z: cmd.z, username: cmd.username });
  });

  // Subscribe to explosion commands from Go backend
  natsClient.subscribeExplosion((cmd: ExplosionCommand) => {
    gameLoop.explode(cmd.x, cmd.z);
    natsClient.publishAbilityEvent({ op: "ability", ability: "explosion", x: cmd.x, z: cmd.z, username: cmd.username });
  });

  // Subscribe to lightning commands from Go backend
  natsClient.subscribeLightning((cmd: LightningCommand) => {
    gameLoop.lightning();
    natsClient.publishAbilityEvent({ op: "ability", ability: "lightning", username: cmd.username });
  });

  // Subscribe to super_push commands from Go backend
  natsClient.subscribeSuperPush((cmd: SuperPushCommand) => {
    pusher.startSuperPush();
    natsClient.publishAbilityEvent({ op: "ability", ability: "superPush", username: cmd.username });
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

  // Subscribe to batch_insert commands from Go backend.
  // Dedup on reference_id: outbox drainer uses at-least-once delivery, so a
  // retry after transient NATS failure can deliver the same event twice.
  // Dropping duplicates here prevents double-enqueuing coins that the player
  // was debited for exactly once.
  const batchInsertDedup = new RefIDDedup();
  natsClient.subscribeBatchInsert((cmd) => {
    if (batchInsertDedup.check(cmd.reference_id)) {
      metrics.batchInsertDuplicatesSuppressed.inc();
      return;
    }
    const accepted = dropScheduler.enqueue(cmd.user_id, cmd.slot_id, cmd.count);
    console.log(`📥 Batch insert: ${cmd.user_id} queued ${accepted}/${cmd.count} coins at slot=${cmd.slot_id}`);
    // Publish queue update
    natsClient.publishQueueUpdate({
      op: "queue_update",
      user_id: cmd.user_id,
      pending: dropScheduler.getPending(cmd.user_id),
    });
  });

  // Subscribe to sponsor config updates from backend
  natsClient.subscribeSponsorConfig((cmd) => {
    sponsorManager.onSponsorConfig(cmd.sponsors);
  });

  // Subscribe to sponsor quota commands from backend
  natsClient.subscribeSponsorQuota((cmd) => {
    sponsorManager.onSponsorQuota(cmd);
  });

  // Subscribe to bonus drop commands from backend
  natsClient.subscribeBonusDrop((cmd) => {
    sponsorManager.onBonusDrop(cmd);
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

// Graceful shutdown with drain
let shuttingDown = false;
const shutdown = async (exitCode: number = 0) => {
  if (shuttingDown) return;
  shuttingDown = true;

  console.log("\n⏳ Graceful shutdown initiated...");

  // 1. Stop accepting new commands (coin inserts, abilities, etc.)
  natsClient.unsubscribeCommands();

  // 2. Stop periodic snapshots
  if (snapshotInterval) {
    clearInterval(snapshotInterval);
  }

  // 3. Drain: let DropScheduler empty + wait for coins to settle (max 60s)
  //    Game loop keeps ticking during drain so physics continues
  if (gameLoop) {
    await gameLoop.drain(60_000);
    gameLoop.stop();
  }

  // 3b. Clean up sponsor manager timers
  if (sponsorManager) {
    sponsorManager.dispose();
  }

  // 4. Close NATS (flush remaining publishes)
  await natsClient.close();

  console.log("✅ Shutdown complete");
  process.exit(exitCode);
};

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

// Last-resort guards. The game loop contains its own tick failures, so anything
// reaching here came from a NATS callback, a timer, or an await we do not own.
// Log it loudly with the full stack — an unattributed silent exit is the worst
// possible outcome for a server that holds player balances — then drain and
// leave with a non-zero code so the supervisor restarts us.
const fatal = (kind: string) => (error: unknown) => {
  console.error(`💀 ${kind}:`, error);
  if (shuttingDown) return;
  shutdown(1).catch((err) => {
    console.error("Shutdown after fatal error failed:", err);
    process.exit(1);
  });
};

process.on("uncaughtException", fatal("Uncaught exception"));
process.on("unhandledRejection", fatal("Unhandled promise rejection"));

// Start initialization
initialize().catch((error) => {
  console.error("Failed to initialize server:", error);
  process.exit(1);
});
