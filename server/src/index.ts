import { WebSocketServer } from "./ws/WebSocketServer.js";

const PORT = process.env.PORT ? parseInt(process.env.PORT) : 3000;

console.log("🎮 Starting Coin Pusher Server...");
console.log(`📡 Port: ${PORT}`);

const wsServer = new WebSocketServer(PORT);

// Graceful shutdown
const shutdown = () => {
  console.log("\n🛑 Shutting down server...");
  wsServer.close();
  process.exit(0);
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

console.log("✅ Server ready!");
