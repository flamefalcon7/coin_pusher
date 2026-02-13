import { WebSocketServer as WSServer } from "ws";
import type { WebSocket } from "ws";
import { Connection } from "./Connection.js";
import { MessageHandler, type MessageHandlers } from "./MessageHandler.js";
import type { ServerMessage, ClientMessage } from "@coin-pusher/shared";
import { NETWORK_CONFIG } from "@coin-pusher/shared";
import * as msgpack from "@msgpack/msgpack";

export class WebSocketServer {
  private wss: WSServer;
  private connections: Set<Connection> = new Set();
  private messageHandler: MessageHandler;
  private newConnectionCallback?: (connection: Connection) => void;
  private idleCheckInterval?: NodeJS.Timeout;

  constructor(port: number) {
    this.wss = new WSServer({ port });

    // Temporary handlers (will be replaced when game state is ready)
    const handlers: MessageHandlers = {
      onCoinInsert: (_connection, x, y, z) => {
        console.log(
          `Coin insert at x=${x.toFixed(3)}, y=${y.toFixed(3)}, z=${z.toFixed(
            3
          )}`
        );
      },
      onStackSpawn: (_connection, type, x, y, z) => {
        console.log(
          `Stack spawn: ${type} at x=${x.toFixed(3)}, y=${y.toFixed(
            3
          )}, z=${z.toFixed(3)}`
        );
      },
      onPing: (_connection, _clientTime) => {
        // Handled by MessageHandler
      },
    };

    this.messageHandler = new MessageHandler(handlers);

    this.wss.on("connection", (ws: WebSocket) => {
      this.handleConnection(ws);
    });

    // Start idle connection cleanup
    this.startIdleConnectionCleanup();

    console.log(`📡 WebSocket server listening on port ${port}`);
  }

  private handleConnection(ws: WebSocket): void {
    const connection = new Connection(ws);
    this.connections.add(connection);

    console.log(`✅ New connection (total: ${this.connections.size})`);

    // Call new connection callback (for world snapshot)
    if (this.newConnectionCallback) {
      this.newConnectionCallback(connection);
    }

    ws.on("message", (data: Buffer) => {
      // Update connection activity timestamp on any message
      connection.updateActivity();

      // Decode MessagePack binary data from client
      try {
        const message = msgpack.decode(data) as ClientMessage;
        this.messageHandler.handleMessage(connection, message);
      } catch (error) {
        // Fallback to JSON for backward compatibility (if client sends JSON)
        try {
          this.messageHandler.handleMessage(connection, data.toString());
        } catch (fallbackError) {
          console.error("Failed to parse message:", error);
        }
      }
    });

    ws.on("close", () => {
      this.connections.delete(connection);
      console.log(`❌ Connection closed (total: ${this.connections.size})`);
    });

    ws.on("error", (error) => {
      console.error("WebSocket error:", error);
    });
  }

  broadcast(message: ServerMessage): void {
    if (this.connections.size === 0) return;
    // Encode once, send raw buffer to all connections
    const buffer = msgpack.encode(message);
    for (const connection of this.connections) {
      if (connection.isOpen()) {
        connection.sendRaw(buffer);
      }
    }
  }

  sendToConnection(connection: Connection, message: ServerMessage): void {
    connection.send(message);
  }

  setMessageHandlers(handlers: MessageHandlers): void {
    this.messageHandler = new MessageHandler(handlers);
  }

  onNewConnection(callback: (connection: Connection) => void): void {
    this.newConnectionCallback = callback;
  }

  getConnections(): Set<Connection> {
    return this.connections;
  }

  /**
   * Start periodic cleanup of idle connections
   */
  private startIdleConnectionCleanup(): void {
    this.idleCheckInterval = setInterval(() => {
      this.cleanupIdleConnections();
    }, NETWORK_CONFIG.CONNECTION_CHECK_INTERVAL);

    console.log(
      `🔄 Idle connection cleanup started (check every ${
        NETWORK_CONFIG.CONNECTION_CHECK_INTERVAL / 1000
      }s, timeout: ${NETWORK_CONFIG.CONNECTION_IDLE_TIMEOUT / 1000}s)`
    );
  }

  /**
   * Check and disconnect idle connections
   */
  private cleanupIdleConnections(): void {
    const now = Date.now();
    const idleConnections: Connection[] = [];

    this.connections.forEach((connection) => {
      if (connection.isIdle(NETWORK_CONFIG.CONNECTION_IDLE_TIMEOUT)) {
        idleConnections.push(connection);
      }
    });

    if (idleConnections.length > 0) {
      console.log(
        `⏰ Disconnecting ${
          idleConnections.length
        } idle connection(s) (no activity for ${
          NETWORK_CONFIG.CONNECTION_IDLE_TIMEOUT / 1000
        }s)`
      );

      idleConnections.forEach((connection) => {
        const idleDuration = now - connection.getLastActivityTime();
        console.log(
          `   💤 Connection idle for ${Math.round(
            idleDuration / 1000
          )}s, closing...`
        );

        // Remove from connections set
        this.connections.delete(connection);

        // Close the WebSocket
        if (connection.isOpen()) {
          connection.close();
        }
      });

      console.log(
        `   ✅ Cleanup complete (remaining connections: ${this.connections.size})`
      );
    }
  }

  close(): void {
    console.log("Closing WebSocket server...");

    // Stop idle connection cleanup
    if (this.idleCheckInterval) {
      clearInterval(this.idleCheckInterval);
    }

    this.connections.forEach((connection) => connection.close());
    this.wss.close();
  }
}
