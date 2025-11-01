import { WebSocketServer as WSServer } from "ws";
import type { WebSocket } from "ws";
import { Connection } from "./Connection.js";
import { MessageHandler, type MessageHandlers } from "./MessageHandler.js";
import type { ServerMessage, ClientMessage } from "@coin-pusher/shared";
import * as msgpack from "@msgpack/msgpack";

export class WebSocketServer {
  private wss: WSServer;
  private connections: Set<Connection> = new Set();
  private messageHandler: MessageHandler;
  private newConnectionCallback?: (connection: Connection) => void;

  constructor(port: number) {
    this.wss = new WSServer({ port });

    // Temporary handlers (will be replaced when game state is ready)
    const handlers: MessageHandlers = {
      onCoinInsert: (_connection, x) => {
        console.log(`Coin insert at x=${x.toFixed(3)}`);
      },
      onPing: (_connection, _clientTime) => {
        // Handled by MessageHandler
      },
    };

    this.messageHandler = new MessageHandler(handlers);

    this.wss.on("connection", (ws: WebSocket) => {
      this.handleConnection(ws);
    });

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
    this.connections.forEach((connection) => {
      if (connection.isOpen()) {
        connection.send(message);
      }
    });
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

  close(): void {
    console.log("Closing WebSocket server...");
    this.connections.forEach((connection) => connection.close());
    this.wss.close();
  }
}
