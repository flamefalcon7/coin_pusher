import type { ServerMessage, ClientMessage } from '@coin-pusher/shared';
import { GameMessageSchema } from '@coin-pusher/shared';
import { fromBinary } from '@bufbuild/protobuf';
import * as msgpack from '@msgpack/msgpack';

export type MessageCallback = (message: ServerMessage) => void;

export class WebSocketClient {
  private ws: WebSocket | null = null;
  private url: string;
  private token?: string;
  private messageCallback?: MessageCallback;
  private onOpenCallback?: () => void;
  private onCloseCallback?: () => void;
  private onErrorCallback?: (error: Event) => void;

  constructor(url: string, token?: string) {
    this.url = url;
    this.token = token;
  }

  connect(): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      console.warn('WebSocket already connected');
      return;
    }

    const wsUrl = this.token ? `${this.url}?token=${this.token}` : this.url;
    console.log(`📡 Connecting to ${wsUrl}...`);
    this.ws = new WebSocket(wsUrl);

    // Set binary type to arraybuffer for binary protocols
    this.ws.binaryType = 'arraybuffer';

    this.ws.onopen = () => {
      console.log('✅ WebSocket connected');
      if (this.onOpenCallback) {
        this.onOpenCallback();
      }
    };

    this.ws.onmessage = (event) => {
      try {
        const bytes = new Uint8Array(event.data as ArrayBuffer);
        if (bytes.length === 0) return;

        // Detect format by first byte:
        // msgpack fixmap: 0x80-0x8f, map16: 0xde, map32: 0xdf
        // protobuf field tags start with lower values (0x08, 0x0a, 0x10, etc.)
        const first = bytes[0];
        const isMsgpack = (first >= 0x80 && first <= 0x8f) || first === 0xde || first === 0xdf;

        if (!isMsgpack) {
          // Try protobuf decode
          const gm = fromBinary(GameMessageSchema, bytes);
          const msg = gm.msg;
          if (msg.case) {
            const converted = this.convertProtoToServerMessage(msg);
            if (converted && this.messageCallback) {
              this.messageCallback(converted);
            }
            return;
          }
        }

        // Fallback: msgpack (for pong, welcome, heat_update, reward, batch_insert_ack)
        const message = msgpack.decode(bytes) as ServerMessage;
        if (this.messageCallback) {
          this.messageCallback(message);
        }
      } catch (error) {
        console.error('Failed to decode message:', error);
      }
    };

    this.ws.onclose = () => {
      console.log('👋 WebSocket disconnected');
      if (this.onCloseCallback) {
        this.onCloseCallback();
      }
    };

    this.ws.onerror = (error) => {
      console.error('❌ WebSocket error:', error);
      if (this.onErrorCallback) {
        this.onErrorCallback(error);
      }
    };
  }

  private convertProtoToServerMessage(msg: NonNullable<import('@coin-pusher/shared').GameMessage['msg']>): ServerMessage | null {
    switch (msg.case) {
      case "stateDelta": {
        const v = msg.value;
        return {
          op: "state_delta",
          serverTime: v.serverTime,
          tick: v.tick,
          updates: v.updates.map((u) => ({
            id: u.id,
            pos: [u.posX, u.posY, u.posZ] as [number, number, number],
            rot: [u.rotX, u.rotY, u.rotZ, u.rotW] as [number, number, number, number],
          })),
          pusherZ: v.pusherZ,
        };
      }
      case "despawn": {
        const v = msg.value;
        return {
          op: "despawn",
          tick: v.tick,
          ids: v.ids.slice(),
        };
      }
      case "worldSnapshot": {
        const v = msg.value;
        return {
          op: "world_snapshot",
          protocolVersion: v.protocolVersion,
          serverTime: v.serverTime,
          tick: v.tick,
          bodies: v.bodies.map((b) => ({
            id: b.id,
            type: b.type as "coin" | "pusher",
            pos: b.type === "coin" ? [b.posX, b.posY, b.posZ] as [number, number, number] : undefined,
            rot: b.type === "coin" ? [b.rotX, b.rotY, b.rotZ, b.rotW] as [number, number, number, number] : undefined,
            z: b.type === "pusher" ? b.z : undefined,
          })),
        };
      }
      case "slotSpin": {
        const v = msg.value;
        return {
          op: "slot_spin",
          reels: v.reels as [string, string, string] as import('@coin-pusher/shared').SlotMachineSpinMessage['reels'],
          jackpot: v.jackpot,
        };
      }
      case "slotCounter":
        return {
          op: "slot_counter",
          counter: msg.value.counter,
        };
      case "ability": {
        const v = msg.value;
        return {
          op: "ability",
          ability: v.ability as import('@coin-pusher/shared').AbilityType,
          x: v.x,
          z: v.z,
        };
      }
      case "coinSpawn": {
        const v = msg.value;
        return {
          op: "coin_spawn",
          coins: v.coins.map((c) => ({
            id: c.id,
            owner_id: c.ownerId,
          })),
        };
      }
      case "queueUpdate": {
        const v = msg.value;
        return {
          op: "queue_update",
          user_id: v.userId,
          pending: v.pending,
        };
      }
      default:
        return null;
    }
  }

  disconnect(): void {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  send(message: ClientMessage): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      console.warn('WebSocket not connected, cannot send message');
      return;
    }

    // Use MessagePack for binary encoding (40% smaller than JSON)
    const binary = msgpack.encode(message);
    this.ws.send(binary);
  }

  onMessage(callback: MessageCallback): void {
    this.messageCallback = callback;
  }

  onOpen(callback: () => void): void {
    this.onOpenCallback = callback;
  }

  onClose(callback: () => void): void {
    this.onCloseCallback = callback;
  }

  onError(callback: (error: Event) => void): void {
    this.onErrorCallback = callback;
  }

  isConnected(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }
}

