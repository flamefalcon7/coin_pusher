import type { Connection } from "./Connection.js";
import type {
  ClientMessage,
  CoinInsertMessage,
  PingMessage,
} from "@coin-pusher/shared";
import { RATE_LIMIT_CONFIG } from "@coin-pusher/shared";

export type MessageHandlers = {
  onCoinInsert: (connection: Connection, x: number) => void;
  onPing: (connection: Connection, clientTime: number) => void;
};

export class MessageHandler {
  private handlers: MessageHandlers;

  constructor(handlers: MessageHandlers) {
    this.handlers = handlers;
  }

  handleMessage(connection: Connection, data: string | ClientMessage): void {
    try {
      // Handle both string (JSON) and object (MessagePack decoded)
      const message = typeof data === 'string' 
        ? (JSON.parse(data) as ClientMessage)
        : data;

      switch (message.op) {
        case "coin_insert":
          this.handleCoinInsert(connection, message);
          break;
        case "ping":
          this.handlePing(connection, message);
          break;
        default:
          console.warn("Unknown message operation:", (message as any).op);
      }
    } catch (error) {
      console.error("Failed to parse message:", error);
    }
  }

  private handleCoinInsert(
    connection: Connection,
    message: CoinInsertMessage
  ): void {
    // Rate limiting check
    if (!connection.canInsertCoin()) {
      console.warn("Coin insert rate limited");
      return;
    }

    // Validate x coordinate
    const x = message.x;
    if (
      typeof x !== "number" ||
      x < -RATE_LIMIT_CONFIG.MAX_X_POSITION ||
      x > RATE_LIMIT_CONFIG.MAX_X_POSITION
    ) {
      console.warn(`Invalid coin x position: ${x}`);
      return;
    }

    // Forward to game logic
    this.handlers.onCoinInsert(connection, x);
  }

  private handlePing(connection: Connection, _message: PingMessage): void {
    // Ping is considered activity, but updateActivity is already called
    // in WebSocketServer.onmessage before handleMessage
    const serverTime = Date.now();
    connection.send({
      op: "pong",
      serverTime,
    });
  }
}
