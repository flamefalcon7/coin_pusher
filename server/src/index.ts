import { WebSocketServer } from "./ws/WebSocketServer.js";
import { PhysicsWorld } from "./physics/PhysicsWorld.js";
import { SceneBuilder } from "./physics/SceneBuilder.js";
import { Pusher } from "./physics/Pusher.js";
import { Coin } from "./physics/Coin.js";
import { GameState } from "./game/GameState.js";
import { CoinManager } from "./game/CoinManager.js";
import { GameLoop } from "./game/GameLoop.js";
import type { Connection } from "./ws/Connection.js";

const PORT = process.env.PORT ? parseInt(process.env.PORT) : 3000;

console.log("🎮 Starting Coin Pusher Server...");
console.log(`📡 Port: ${PORT}`);

// Initialize game components
const physicsWorld = new PhysicsWorld();
const gameState = new GameState();
const coinManager = new CoinManager(gameState);
const wsServer = new WebSocketServer(PORT);

let pusher: Pusher;
let gameLoop: GameLoop;

// Async initialization
async function initialize() {
  // Initialize physics world
  await physicsWorld.init();

  // Build static scene
  const sceneBuilder = new SceneBuilder(physicsWorld);
  sceneBuilder.buildStaticScene();

  // Create pusher
  pusher = new Pusher(physicsWorld);

  // Create game loop
  gameLoop = new GameLoop(physicsWorld, pusher, gameState, coinManager, wsServer);

  // Set message handlers
  wsServer.setMessageHandlers({
    onCoinInsert: (_connection: Connection, x: number) => {
      const coinId = coinManager.spawnCoin(x);
      if (coinId !== null) {
        const coin = new Coin(physicsWorld, coinId, x, 1.5, 0);
        gameLoop.addCoin(coin);
      }
    },
    onPing: (_connection: Connection, _clientTime: number) => {
      // Handled by MessageHandler
    },
  });

  // Send world snapshot to new connections
  wsServer.onNewConnection((connection: Connection) => {
    const worldState = gameState.getWorldSnapshot();
    const snapshot = {
      op: "world_snapshot" as const,
      ...worldState,
    };
    connection.send(snapshot);
    console.log(`📸 Sent world snapshot to new connection (${snapshot.bodies.length} bodies)`);
  });

  // Start game loop
  gameLoop.start();

  console.log("✅ Server ready!");
}

// Graceful shutdown
const shutdown = () => {
  console.log("\n🛑 Shutting down server...");
  if (gameLoop) {
    gameLoop.stop();
  }
  wsServer.close();
  process.exit(0);
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

// Start initialization
initialize().catch((error) => {
  console.error("❌ Failed to initialize server:", error);
  process.exit(1);
});
