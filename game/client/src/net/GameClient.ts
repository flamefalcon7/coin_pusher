import type {
  ServerMessage,
  ClientMessage,
  StackType,
  EditorObjectNet,
  SlotSymbol,
  AbilityType,
  SponsorConfigMessage,
  BonusDropMessage,
  SponsorRewardMessage,
  StateUpdate,
} from "@coin-pusher/shared";
import { WebSocketClient } from "./WebSocketClient";
import { ClockSync } from "./ClockSync";
import { StateBuffer } from "./StateBuffer";
import { Interpolator, type InterpolatedState } from "./Interpolator";
import { maybeCreateDebugPanel, type DebugPanel } from "./DebugPanel";

/**
 * Latest raw server state (newest buffered state_delta, pre-interpolation) —
 * the shared shape for debug consumers (dump(), collider wireframes).
 */
export interface AuthoritativeState {
  serverTime: number;
  pusherZ: number;
  coins: StateUpdate[];
}

export type ConnectionStatusCallback = (
  status: "connecting" | "connected" | "disconnected",
) => void;
export type PingCallback = (ping: number) => void;
export type SlotSpinCallback = (
  reels: [SlotSymbol, SlotSymbol, SlotSymbol],
  jackpot: boolean,
) => void;
export type SlotCounterCallback = (counter: number) => void;
export type AbilityEventCallback = (
  ability: AbilityType,
  x?: number,
  z?: number,
  username?: string,
) => void;
export type CoinSpawnCallback = (
  coins: { id: number; owner_id: string; is_key_coin?: boolean; sponsor_id?: string }[],
) => void;
export type HeatUpdateCallback = (
  players: {
    user_id: string;
    username: string;
    share: number;
    raw_heat: number;
  }[],
) => void;
export type QueueUpdateCallback = (userId: string, pending: number) => void;
export type SlotStatusCallback = (counts: number[]) => void;
export type WheelSpinCallback = (segment: number, reward: number) => void;
export type WheelCounterCallback = (counter: number) => void;
export type BatchInsertAckCallback = (
  queued: number,
  error?: string,
  balancePlay?: string,
  balanceCash?: string,
  playDebited?: string,
  cashDebited?: string,
) => void;
export type RewardCallback = (
  userId: string,
  amount: number,
  balance: string,
) => void;
export type KeyCoinDrawCallback = (
  winnerId: string,
  winnerName: string,
  count: number,
) => void;
export type InventoryUpdateCallback = (inventory: {
  key_coins: number;
  scroll_shock: number;
  scroll_tornado: number;
  scroll_explosion: number;
  scroll_lightning: number;
  scroll_super_push: number;
  megaspeaker: number;
}) => void;
export type MegaspeakerCallback = (
  speakerName: string,
  message: string,
  timestamp: number,
) => void;
export type MegaspeakerErrorCallback = (error: string) => void;
export type IdleWarningCallback = () => void;
export type IdleTimeoutCallback = () => void;
export type SponsorConfigCallback = (sponsors: SponsorConfigMessage["sponsors"]) => void;
export type BonusDropCallback = (msg: BonusDropMessage) => void;
export type SponsorRewardCallback = (msg: SponsorRewardMessage) => void;

export class GameClient {
  private url: string;
  private wsClient: WebSocketClient;
  private clockSync: ClockSync;
  private stateBuffer: StateBuffer;
  private interpolator: Interpolator;

  private connectionStatusCallback?: ConnectionStatusCallback;
  private pingCallback?: PingCallback;
  private slotSpinCallback?: SlotSpinCallback;
  private slotCounterCallback?: SlotCounterCallback;
  private abilityEventCallback?: AbilityEventCallback;
  private coinSpawnCallback?: CoinSpawnCallback;
  private heatUpdateCallback?: HeatUpdateCallback;
  private queueUpdateCallback?: QueueUpdateCallback;
  private wheelSpinCallback?: WheelSpinCallback;
  private wheelCounterCallback?: WheelCounterCallback;
  private slotStatusCallback?: SlotStatusCallback;
  private batchInsertAckCallback?: BatchInsertAckCallback;
  private rewardCallback?: RewardCallback;
  private keyCoinDrawCallback?: KeyCoinDrawCallback;
  private inventoryUpdateCallback?: InventoryUpdateCallback;
  private megaspeakerCallback?: MegaspeakerCallback;
  private megaspeakerErrorCallback?: MegaspeakerErrorCallback;
  private idleWarningCallback?: IdleWarningCallback;
  private idleTimeoutCallback?: IdleTimeoutCallback;
  private sponsorConfigCallback?: SponsorConfigCallback;
  private bonusDropCallback?: BonusDropCallback;
  private sponsorRewardCallback?: SponsorRewardCallback;
  private authFailureCallback?: () => void;
  private pendingPingTime: number = 0;
  private userId: string = "";
  private _isSpectator: boolean = false;
  private _snapshotJustLoaded: boolean = false;
  private _snapshotKeyCoinIds: Set<number> | null = null;
  private _snapshotSponsorCoinIds: Map<number, string> | null = null;
  private visibilityHandler: (() => void) | null = null;
  private debugPanel: DebugPanel | null = null;

  constructor(url: string, token?: string) {
    this.url = url;
    this.wsClient = new WebSocketClient(url, token);
    this.clockSync = new ClockSync();
    this.stateBuffer = new StateBuffer();
    this.interpolator = new Interpolator(this.stateBuffer, this.clockSync);
    this.debugPanel = maybeCreateDebugPanel(this.clockSync, this.stateBuffer);

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

    this.wsClient.onClose((code) => {
      if ((code === 4401 || code === 4403) && this.authFailureCallback) {
        this.authFailureCallback();
        return;
      }
      if (code === 4408 || code === 4410) {
        if (this.idleTimeoutCallback) {
          this.idleTimeoutCallback();
        }
        // Still fire disconnected so UI disables buttons etc.
        if (this.connectionStatusCallback) {
          this.connectionStatusCallback("disconnected");
        }
        return;
      }
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
          "World snapshot received:",
          message.bodies.length,
          "bodies",
        );
        // Reset interpolator known coins on new snapshot
        this.interpolator.clear();
        // Initialize state buffer with snapshot
        this.stateBuffer.clear();
        // Track key coin and sponsor coin IDs from snapshot for rendering
        this._snapshotKeyCoinIds = new Set<number>();
        this._snapshotSponsorCoinIds = new Map<number, string>();
        const snapshotCoins = message.bodies
          .filter(
            (b) =>
              (b.type === "coin" || b.type === "key_coin" || b.type === "sponsor_coin") && b.pos && b.rot,
          )
          .map((b) => {
            if (b.type === "key_coin") {
              this._snapshotKeyCoinIds!.add(b.id);
            }
            if (b.type === "sponsor_coin" && b.sponsor_id) {
              this._snapshotSponsorCoinIds!.set(b.id, b.sponsor_id);
            }
            return {
              id: b.id,
              pos: b.pos!,
              rot: b.rot!,
            };
          });
        const snapshotPusherZ = message.bodies.find((b) => b.type === "pusher")?.z ?? 0;
        this.stateBuffer.addState({
          serverTime: message.serverTime,
          tick: message.tick,
          updates: snapshotCoins,
          pusherZ: snapshotPusherZ,
        });
        // Seed interpolator so sleeping coins render immediately
        this.interpolator.seedCoins(snapshotCoins, snapshotPusherZ);
        this._snapshotJustLoaded = true;
        break;

      case "state_delta":
        // Sync clock to game server's timestamps (not Go backend's pong)
        this.clockSync.recordStateDeltaTime(message.serverTime);
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

      case "slot_spin":
        if (this.slotSpinCallback) {
          this.slotSpinCallback(message.reels, message.jackpot);
        }
        break;

      case "slot_counter":
        if (this.slotCounterCallback) {
          this.slotCounterCallback(message.counter);
        }
        break;

      case "ability":
        if (this.abilityEventCallback) {
          this.abilityEventCallback(
            message.ability,
            message.x,
            message.z,
            message.username,
          );
        }
        break;

      case "coin_spawn":
        if (this.coinSpawnCallback) {
          this.coinSpawnCallback(message.coins);
        }
        break;

      case "heat_update":
        if (this.heatUpdateCallback) {
          this.heatUpdateCallback(message.players);
        }
        break;

      case "queue_update":
        if (this.queueUpdateCallback) {
          this.queueUpdateCallback(message.user_id, message.pending);
        }
        break;

      case "wheel_spin":
        if (this.wheelSpinCallback) {
          this.wheelSpinCallback(message.segment, message.reward);
        }
        break;

      case "wheel_counter":
        if (this.wheelCounterCallback) {
          this.wheelCounterCallback(message.counter);
        }
        break;

      case "slot_status":
        if (this.slotStatusCallback) {
          this.slotStatusCallback(message.counts);
        }
        break;

      case "batch_insert_ack":
        if (this.batchInsertAckCallback) {
          this.batchInsertAckCallback(
            message.queued,
            message.error,
            message.balance_play,
            message.balance_cash,
            message.play_debited,
            message.cash_debited,
          );
        }
        break;

      case "reward":
        if (this.rewardCallback) {
          this.rewardCallback(message.user_id, message.amount, message.balance);
        }
        break;

      case "key_coin_draw":
        if (this.keyCoinDrawCallback) {
          this.keyCoinDrawCallback(
            message.winner_id,
            message.winner_name,
            message.count,
          );
        }
        break;

      case "inventory_update":
        if (this.inventoryUpdateCallback) {
          this.inventoryUpdateCallback({
            key_coins: message.key_coins,
            scroll_shock: message.scroll_shock,
            scroll_tornado: message.scroll_tornado,
            scroll_explosion: message.scroll_explosion,
            scroll_lightning: message.scroll_lightning,
            scroll_super_push: message.scroll_super_push,
            megaspeaker: message.megaspeaker,
          });
        }
        break;

      case "megaspeaker":
        if (this.megaspeakerCallback) {
          this.megaspeakerCallback(
            message.speaker_name,
            message.message,
            message.timestamp,
          );
        }
        break;

      case "megaspeaker_error":
        if (this.megaspeakerErrorCallback) {
          this.megaspeakerErrorCallback(message.error);
        }
        break;

      case "idle_warning":
        if (this.idleWarningCallback) {
          this.idleWarningCallback();
        }
        break;

      case "sponsor_config":
        if (this.sponsorConfigCallback) {
          this.sponsorConfigCallback(message.sponsors);
        }
        break;

      case "bonus_drop":
        if (this.bonusDropCallback) {
          this.bonusDropCallback(message);
        }
        break;

      case "sponsor_reward":
        if (this.sponsorRewardCallback) {
          this.sponsorRewardCallback(message);
        }
        break;

      case "welcome":
        this.userId = message.user_id;
        this._isSpectator = message.user_id === "";
        console.log(
          this._isSpectator
            ? "Connected as spectator"
            : `Assigned user ID: ${this.userId}`,
        );
        break;
    }
  }

  connect(): void {
    if (this.connectionStatusCallback) {
      this.connectionStatusCallback("connecting");
    }
    this.wsClient.connect();

    // Pause/resume broadcasts on tab visibility change.
    if (!this.visibilityHandler) {
      this.visibilityHandler = () => {
        if (!this.wsClient.isConnected()) return;
        if (document.hidden) {
          this.wsClient.send({ op: "pause_updates" });
          this.pendingPingTime = 0;
        } else {
          this.wsClient.send({ op: "resume_updates" });
        }
      };
      document.addEventListener("visibilitychange", this.visibilityHandler);
    }
  }

  disconnect(): void {
    this.wsClient.disconnect();
  }

  dispose(): void {
    this.disconnect();
    if (this.visibilityHandler) {
      document.removeEventListener("visibilitychange", this.visibilityHandler);
      this.visibilityHandler = null;
    }
    this.debugPanel?.destroy();
    this.debugPanel = null;
  }

  /** Returns true if connected as an unauthenticated spectator. */
  isSpectator(): boolean {
    return this._isSpectator;
  }

  /**
   * Disconnect the current (spectator) WS and reconnect with an auth token.
   * Re-wires all message handlers on the new WebSocketClient.
   */
  /**
   * Disconnect the current (authenticated) WS and reconnect as a spectator.
   */
  reconnectAsSpectator(): void {
    this.wsClient.disconnect();
    this._isSpectator = true;
    this.userId = "";
    this.clockSync = new ClockSync();
    this.stateBuffer = new StateBuffer();
    this.interpolator = new Interpolator(this.stateBuffer, this.clockSync);
    this.wsClient = new WebSocketClient(this.url);
    this.setupHandlers();
    this.connect();
  }

  reconnectWithToken(token: string): void {
    this.wsClient.disconnect();
    this._isSpectator = false;
    this.userId = "";
    this.clockSync = new ClockSync();
    this.stateBuffer = new StateBuffer();
    this.interpolator = new Interpolator(this.stateBuffer, this.clockSync);
    this.wsClient = new WebSocketClient(this.url, token);
    this.setupHandlers();
    this.connect();
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

  tornado(x: number, z: number): void {
    const message: ClientMessage = {
      op: "tornado",
      x,
      z,
    };
    this.wsClient.send(message);
  }

  explosion(x: number, z: number): void {
    const message: ClientMessage = {
      op: "explosion",
      x,
      z,
    };
    this.wsClient.send(message);
  }

  lightning(): void {
    const message: ClientMessage = {
      op: "lightning",
    };
    this.wsClient.send(message);
  }

  superPush(): void {
    this.wsClient.send({ op: "super_push" } as ClientMessage);
  }

  clearAll(): void {
    this.wsClient.send({ op: "clear_all" } as ClientMessage);
  }

  fillPlatform(): void {
    this.wsClient.send({ op: "fill_platform" } as ClientMessage);
  }

  updateSceneObjects(objects: EditorObjectNet[]): void {
    this.wsClient.send({
      op: "update_scene_objects",
      objects,
    } as ClientMessage);
  }

  getInterpolatedState(): InterpolatedState | null {
    return this.interpolator.getInterpolatedState();
  }

  /**
   * Latest raw server state (newest buffered state_delta, pre-interpolation).
   * This is the physics ground truth the debug dump (R1) reports as
   * `authoritative` poses. Null before the first state arrives.
   */
  getLatestAuthoritativeState(): AuthoritativeState | null {
    const newest = this.stateBuffer.getNewestState();
    if (!newest) return null;
    return {
      serverTime: newest.serverTime,
      pusherZ: newest.pusherZ,
      coins: newest.updates,
    };
  }

  onConnectionStatus(callback: ConnectionStatusCallback): void {
    this.connectionStatusCallback = callback;
  }

  onAuthFailure(callback: () => void): void {
    this.authFailureCallback = callback;
  }

  onPing(callback: PingCallback): void {
    this.pingCallback = callback;
  }

  onSlotSpin(callback: SlotSpinCallback): void {
    this.slotSpinCallback = callback;
  }

  onSlotCounter(callback: SlotCounterCallback): void {
    this.slotCounterCallback = callback;
  }

  onAbilityEvent(callback: AbilityEventCallback): void {
    this.abilityEventCallback = callback;
  }

  onCoinSpawn(callback: CoinSpawnCallback): void {
    this.coinSpawnCallback = callback;
  }

  onHeatUpdate(callback: HeatUpdateCallback): void {
    this.heatUpdateCallback = callback;
  }

  onQueueUpdate(callback: QueueUpdateCallback): void {
    this.queueUpdateCallback = callback;
  }

  onWheelSpin(callback: WheelSpinCallback): void {
    this.wheelSpinCallback = callback;
  }

  onWheelCounter(callback: WheelCounterCallback): void {
    this.wheelCounterCallback = callback;
  }

  onSlotStatus(callback: SlotStatusCallback): void {
    this.slotStatusCallback = callback;
  }

  onBatchInsertAck(callback: BatchInsertAckCallback): void {
    this.batchInsertAckCallback = callback;
  }

  onReward(callback: RewardCallback): void {
    this.rewardCallback = callback;
  }

  onKeyCoinDraw(callback: KeyCoinDrawCallback): void {
    this.keyCoinDrawCallback = callback;
  }

  onInventoryUpdate(callback: InventoryUpdateCallback): void {
    this.inventoryUpdateCallback = callback;
  }

  onMegaspeaker(callback: MegaspeakerCallback): void {
    this.megaspeakerCallback = callback;
  }

  onMegaspeakerError(callback: MegaspeakerErrorCallback): void {
    this.megaspeakerErrorCallback = callback;
  }

  onIdleWarning(callback: IdleWarningCallback): void {
    this.idleWarningCallback = callback;
  }

  onIdleTimeout(callback: IdleTimeoutCallback): void {
    this.idleTimeoutCallback = callback;
  }

  onSponsorConfig(callback: SponsorConfigCallback): void {
    this.sponsorConfigCallback = callback;
  }

  onBonusDrop(callback: BonusDropCallback): void {
    this.bonusDropCallback = callback;
  }

  onSponsorReward(callback: SponsorRewardCallback): void {
    this.sponsorRewardCallback = callback;
  }

  sendMegaspeaker(message: string): void {
    this.wsClient.send({ op: "megaspeaker", message } as ClientMessage);
  }

  batchInsert(slotId: number, count: number): void {
    const message: ClientMessage = {
      op: "batch_insert",
      slot_id: slotId,
      count,
    };
    this.wsClient.send(message);
  }

  isConnected(): boolean {
    return this.wsClient.isConnected();
  }

  getUserId(): string {
    return this.userId;
  }

  getClockOffset(): number {
    return this.clockSync.getOffset();
  }

  getBufferSize(): number {
    return this.stateBuffer.getBufferSize();
  }

  /** Returns true once after a world_snapshot is loaded, then resets. */
  consumeSnapshotFlag(): boolean {
    if (this._snapshotJustLoaded) {
      this._snapshotJustLoaded = false;
      return true;
    }
    return false;
  }

  /** Returns key coin IDs from the last world_snapshot, then clears. */
  consumeSnapshotKeyCoinIds(): Set<number> | null {
    const ids = this._snapshotKeyCoinIds;
    this._snapshotKeyCoinIds = null;
    return ids;
  }

  /** Returns sponsor coin ID mappings from the last world_snapshot, then clears. */
  consumeSnapshotSponsorCoinIds(): Map<number, string> | null {
    const ids = this._snapshotSponsorCoinIds;
    this._snapshotSponsorCoinIds = null;
    return ids;
  }
}
