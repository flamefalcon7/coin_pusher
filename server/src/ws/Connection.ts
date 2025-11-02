import type { WebSocket } from "ws";
import type { ServerMessage } from "@coin-pusher/shared";
import { RATE_LIMIT_CONFIG } from "@coin-pusher/shared";
import * as msgpack from "@msgpack/msgpack";

export class Connection {
  private ws: WebSocket;
  private lastCoinInsertTime: number = 0;
  private lastActivityTime: number;

  constructor(ws: WebSocket) {
    this.ws = ws;
    this.lastActivityTime = Date.now();
  }

  /**
   * Update the last activity timestamp
   * Called when receiving any message from client (ping, coin_insert, etc.)
   */
  updateActivity(): void {
    this.lastActivityTime = Date.now();
  }

  /**
   * Get the last activity timestamp
   */
  getLastActivityTime(): number {
    return this.lastActivityTime;
  }

  /**
   * Check if connection is idle (no activity for specified timeout)
   */
  isIdle(timeoutMs: number): boolean {
    return Date.now() - this.lastActivityTime >= timeoutMs;
  }

  send(message: ServerMessage): void {
    if (this.ws.readyState === 1) {
      // WebSocket.OPEN
      // Use MessagePack for binary encoding (40% smaller than JSON)
      const binary = msgpack.encode(message);
      this.ws.send(binary);
    }
  }

  isOpen(): boolean {
    return this.ws.readyState === 1;
  }

  close(): void {
    this.ws.close();
  }

  canInsertCoin(): boolean {
    const now = Date.now();
    if (
      now - this.lastCoinInsertTime <
      RATE_LIMIT_CONFIG.COIN_INSERT_COOLDOWN
    ) {
      return false;
    }
    this.lastCoinInsertTime = now;
    return true;
  }

  getWebSocket(): WebSocket {
    return this.ws;
  }
}
