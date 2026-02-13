import type { Connection } from "./Connection.js";
import type {
  ClientMessage,
  CoinInsertMessage,
  PingMessage,
  StackSpawnMessage,
  StackType,
} from "@coin-pusher/shared";
import {
  COIN_CONFIG,
  RATE_LIMIT_CONFIG,
  SCENE_CONFIG,
} from "@coin-pusher/shared";

export type MessageHandlers = {
  onCoinInsert: (
    connection: Connection,
    x: number,
    y: number,
    z: number
  ) => void;
  onStackSpawn: (
    connection: Connection,
    type: StackType,
    x: number,
    y: number,
    z: number
  ) => void;
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
      const message =
        typeof data === "string" ? (JSON.parse(data) as ClientMessage) : data;

      switch (message.op) {
        case "coin_insert":
          this.handleCoinInsert(connection, message);
          break;
        case "spawn_stack":
          this.handleStackSpawn(connection, message);
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
    // if (!connection.canInsertCoin()) {
    //   console.warn("Coin insert rate limited");
    //   return;
    // }

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

    const y = COIN_CONFIG.SPAWN_HEIGHT;
    // const z = SLOT_CONFIG.SPAWN_Z;
    const z = SCENE_CONFIG.BACK_WALL.POSITION.z;

    // Forward to game logic
    this.handlers.onCoinInsert(connection, x, y, z);
  }

  private handleStackSpawn(
    connection: Connection,
    message: StackSpawnMessage
  ): void {
    const x = message.x;
    const type = message.type;

    if (
      typeof x !== "number" ||
      x < -RATE_LIMIT_CONFIG.MAX_X_POSITION ||
      x > RATE_LIMIT_CONFIG.MAX_X_POSITION
    ) {
      console.warn(`Invalid stack x position: ${x}`);
      return;
    }

    const y = 0.3; // Spawn just above the platform (0.25 + 0.025 = 0.275)
    const z = 0.3; // Closer to the frontend (platform extends to 0.5)

    this.handlers.onStackSpawn(connection, type, x, y, z);
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
