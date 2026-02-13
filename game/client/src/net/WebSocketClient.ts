import type { ServerMessage, ClientMessage } from '@coin-pusher/shared';
import * as msgpack from '@msgpack/msgpack';

export type MessageCallback = (message: ServerMessage) => void;

export class WebSocketClient {
  private ws: WebSocket | null = null;
  private url: string;
  private messageCallback?: MessageCallback;
  private onOpenCallback?: () => void;
  private onCloseCallback?: () => void;
  private onErrorCallback?: (error: Event) => void;

  constructor(url: string) {
    this.url = url;
  }

  connect(): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      console.warn('WebSocket already connected');
      return;
    }

    console.log(`📡 Connecting to ${this.url}...`);
    this.ws = new WebSocket(this.url);
    
    // Set binary type to arraybuffer for MessagePack
    this.ws.binaryType = 'arraybuffer';

    this.ws.onopen = () => {
      console.log('✅ WebSocket connected');
      if (this.onOpenCallback) {
        this.onOpenCallback();
      }
    };

    this.ws.onmessage = (event) => {
      try {
        // Decode MessagePack binary data
        const buffer = event.data as ArrayBuffer;
        const message = msgpack.decode(new Uint8Array(buffer)) as ServerMessage;
        
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

