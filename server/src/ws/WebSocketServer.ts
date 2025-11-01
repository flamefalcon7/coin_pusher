import { WebSocketServer as WSServer } from "ws";
import type { WebSocket } from "ws";
import { Connection } from "./Connection.js";
import { MessageHandler, type MessageHandlers } from "./MessageHandler.js";
import type { ServerMessage } from "@coin-pusher/shared";

export class WebSocketServer {
  private wss: WSServer;
  private connections: Set<Connection> = new Set();
  private messageHandler: MessageHandler;

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

    ws.on("message", (data: Buffer) => {
      this.messageHandler.handleMessage(connection, data.toString());
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

  getConnections(): Set<Connection> {
    return this.connections;
  }

  close(): void {
    console.log("Closing WebSocket server...");
    this.connections.forEach((connection) => connection.close());
    this.wss.close();
  }
}
