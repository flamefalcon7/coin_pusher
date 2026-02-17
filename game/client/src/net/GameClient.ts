import type {
  ServerMessage,
  ClientMessage,
  StackType,
  EditorObjectNet,
} from "@coin-pusher/shared";
import { WebSocketClient } from "./WebSocketClient";
import { ClockSync } from "./ClockSync";
import { StateBuffer } from "./StateBuffer";
import { Interpolator, type InterpolatedState } from "./Interpolator";

export type ConnectionStatusCallback = (
  status: "connecting" | "connected" | "disconnected"
) => void;
export type PingCallback = (ping: number) => void;

export class GameClient {
  private wsClient: WebSocketClient;
  private clockSync: ClockSync;
  private stateBuffer: StateBuffer;
  private interpolator: Interpolator;

  private connectionStatusCallback?: ConnectionStatusCallback;
  private pingCallback?: PingCallback;
  private pendingPingTime: number = 0;

  constructor(url: string, token?: string) {
    this.wsClient = new WebSocketClient(url, token);
    this.clockSync = new ClockSync();
    this.stateBuffer = new StateBuffer();
    this.interpolator = new Interpolator(this.stateBuffer, this.clockSync);

    this.setupHandlers();
  }

  private setupHandlers(): void {
    this.wsClient.onMessage((message) => {
      this.handleMessage(message);
    });

    this.wsClient.onOpen(() => {
      if (this.connectionStatusCallback) {
        this.connectionStatusCallback("connected");
      }
    });

    this.wsClient.onClose(() => {
      if (this.connectionStatusCallback) {
        this.connectionStatusCallback("disconnected");
      }
    });

    this.wsClient.onError(() => {
      if (this.connectionStatusCallback) {
        this.connectionStatusCallback("disconnected");
      }
    });
  }

  private handleMessage(message: ServerMessage): void {
    switch (message.op) {
      case "world_snapshot":
        console.log(
          "📸 World snapshot received:",
          message.bodies.length,
          "bodies"
        );
        // Reset interpolator known coins on new snapshot
        this.interpolator.clear();
        // Initialize state buffer with snapshot
        this.stateBuffer.clear();
        this.stateBuffer.addState({
          serverTime: message.serverTime,
          tick: message.tick,
          updates: message.bodies
            .filter((b) => b.type === "coin" && b.pos && b.rot)
            .map((b) => ({
              id: b.id,
              pos: b.pos!,
              rot: b.rot!,
            })),
          pusherZ: message.bodies.find((b) => b.type === "pusher")?.z ?? 0,
        });
        break;

      case "state_delta":
        // Add to state buffer
        this.stateBuffer.addState({
          serverTime: message.serverTime,
          tick: message.tick,
          updates: message.updates,
          pusherZ: message.pusherZ,
        });
        break;

      case "despawn":
        // Remove despawned coins from interpolator's known coins
        for (const id of message.ids) {
          this.interpolator.removeCoin(id);
        }
        break;

      case "pong":
        if (this.pendingPingTime > 0) {
          this.clockSync.recordPong(this.pendingPingTime, message.serverTime);
          this.pendingPingTime = 0;

          // Update ping display
          if (this.pingCallback) {
            this.pingCallback(this.clockSync.getRTT());
          }
        }
        break;
    }
  }

  connect(): void {
    if (this.connectionStatusCallback) {
      this.connectionStatusCallback("connecting");
    }
    this.wsClient.connect();
  }

  disconnect(): void {
    this.wsClient.disconnect();
  }

  update(): void {
    // Check if we should send ping
    if (this.wsClient.isConnected() && this.clockSync.shouldSendPing()) {
      const clientTime = Date.now();
      this.pendingPingTime = clientTime;
      this.wsClient.send({
        op: "ping",
        clientTime,
      });
    }
  }

  insertCoin(x: number): void {
    // Send MessagePack encoded message
    const message: ClientMessage = {
      op: "coin_insert",
      x,
    };
    this.wsClient.send(message);
  }

  spawnStack(type: StackType, x: number): void {
    // Send MessagePack encoded message
    const message: ClientMessage = {
      op: "spawn_stack",
      type,
      x,
    };
    this.wsClient.send(message);
  }

  shock(): void {
    const message: ClientMessage = {
      op: "shock",
    };
    this.wsClient.send(message);
  }

  clearAll(): void {
    this.wsClient.send({ op: "clear_all" } as ClientMessage);
  }

  fillPlatform(): void {
    this.wsClient.send({ op: "fill_platform" } as ClientMessage);
  }

  updateSceneObjects(objects: EditorObjectNet[]): void {
    this.wsClient.send({ op: "update_scene_objects", objects } as ClientMessage);
  }

  getInterpolatedState(): InterpolatedState | null {
    return this.interpolator.getInterpolatedState();
  }

  onConnectionStatus(callback: ConnectionStatusCallback): void {
    this.connectionStatusCallback = callback;
  }

  onPing(callback: PingCallback): void {
    this.pingCallback = callback;
  }

  isConnected(): boolean {
    return this.wsClient.isConnected();
  }

  getClockOffset(): number {
    return this.clockSync.getOffset();
  }

  getBufferSize(): number {
    return this.stateBuffer.getBufferSize();
  }
}
