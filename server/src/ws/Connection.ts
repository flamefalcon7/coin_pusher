import type { WebSocket } from "ws";
import type { ServerMessage } from "@coin-pusher/shared";
import { RATE_LIMIT_CONFIG } from "@coin-pusher/shared";

export class Connection {
  private ws: WebSocket;
  private lastCoinInsertTime: number = 0;

  constructor(ws: WebSocket) {
    this.ws = ws;
  }

  send(message: ServerMessage): void {
    if (this.ws.readyState === 1) {
      // WebSocket.OPEN
      this.ws.send(JSON.stringify(message));
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
