import { connect, type NatsConnection, type Subscription, StringCodec } from "nats";
import * as metrics from "../metrics.js";
import { create, toBinary } from "@bufbuild/protobuf";
import type { StateDeltaMessage, DespawnMessage, WorldSnapshotMessage, SlotMachineSpinMessage, SlotMachineCounterMessage, AbilityEventMessage, CoinSpawnMessage, QueueUpdateMessage, SlotStatusMessage, WheelSpinMessage, WheelCounterMessage } from "@coin-pusher/shared";
import { GameMessageSchema } from "@coin-pusher/shared";

const sc = StringCodec();

export type BatchInsertCommand = {
  user_id: string;
  slot_id: number;
  count: number;
  // Optional reference_id carried from the Go backend's outbox row. Used by
  // the game server to dedup at-least-once retries from the outbox drainer.
  // Absent on legacy (pre-outbox) publishes.
  reference_id?: string;
};

export type CoinInsertCommand = {
  user_id: string;
  x: number;
  y: number;
  z: number;
};

export type SpawnStackCommand = {
  user_id: string;
  type: string;
  x: number;
  y: number;
  z: number;
};

export type ShockCommand = {
  user_id: string;
  username: string;
};

export type TornadoCommand = {
  user_id: string;
  username: string;
  x: number;
  z: number;
};

export type ExplosionCommand = {
  user_id: string;
  username: string;
  x: number;
  z: number;
};

export type LightningCommand = {
  user_id: string;
  username: string;
};

export type SuperPushCommand = {
  user_id: string;
  username: string;
};

export type ClearAllCommand = {
  user_id: string;
};

export type FillPlatformCommand = {
  user_id: string;
};

export type SponsorConfigCommand = {
  sponsors: {
    id: string;
    brand_name: string;
    token_symbol: string;
    brand_color: string;
    logo_url: string;
    ad_image_url: string;
    placement_tier?: "primary" | "secondary" | "tertiary";
  }[];
};

export type SponsorQuotaCommand = {
  quota_id: string;
  sponsor_id: string;
  coin_count: number;
};

export type BonusDropCommand = {
  sponsor_id: string;
  coin_count: number;
};

export type UpdateSceneObjectsCommand = {
  user_id: string;
  objects: {
    id: string;
    type: string;
    position: [number, number, number];
    rotation: [number, number, number];
    scale: [number, number, number];
  }[];
};

export type RewardEvent = {
  coin_count: number;
  user_id?: string;
};

export class NATSClient {
  private nc: NatsConnection | null = null;
  private subs: Subscription[] = [];
  private cmdSubs: Subscription[] = [];
  private room: string;

  constructor(room: string = "main") {
    this.room = room;
  }

  /** Publish with metrics tracking. */
  private trackedPublish(subject: string, data: Uint8Array): void {
    const shortTopic = subject.replace(`game.${this.room}.`, "");
    metrics.natsPublishTotal.labels(shortTopic).inc();
    try {
      this.nc!.publish(subject, data);
    } catch (err) {
      metrics.natsPublishErrors.labels(shortTopic).inc();
      console.error(`NATS publish error [${shortTopic}]:`, err);
    }
  }

  async connect(url: string = "nats://localhost:4222"): Promise<void> {
    this.nc = await connect({
      servers: url,
      maxReconnectAttempts: -1,
      reconnectTimeWait: 2_000,
      waitOnFirstConnect: true,
    });
    console.log(`Connected to NATS at ${url}`);
    this.monitorConnection();
  }

  /** Monitor NATS connection status for reconnect/disconnect events. */
  private async monitorConnection(): Promise<void> {
    if (!this.nc) return;
    for await (const s of this.nc.status()) {
      switch (s.type) {
        case "reconnect":
          console.log(`🔄 NATS reconnected to ${(s.data as string) || "server"}`);
          break;
        case "disconnect":
          console.warn("⚠️ NATS disconnected");
          break;
        case "reconnecting":
          console.log("🔄 NATS reconnecting...");
          break;
      }
    }
  }

  // Subscribe to coin_insert commands (JSON encoded)
  subscribeCoinInsert(handler: (cmd: CoinInsertCommand) => void): void {
    const sub = this.nc!.subscribe(`game.${this.room}.cmd.coin_insert`);
    this.subs.push(sub);
    this.cmdSubs.push(sub);
    (async () => {
      for await (const msg of sub) {
        const cmd = JSON.parse(sc.decode(msg.data)) as CoinInsertCommand;
        handler(cmd);
      }
    })();
  }

  // Subscribe to spawn_stack commands (JSON encoded)
  subscribeSpawnStack(handler: (cmd: SpawnStackCommand) => void): void {
    const sub = this.nc!.subscribe(`game.${this.room}.cmd.spawn_stack`);
    this.subs.push(sub);
    this.cmdSubs.push(sub);
    (async () => {
      for await (const msg of sub) {
        const cmd = JSON.parse(sc.decode(msg.data)) as SpawnStackCommand;
        handler(cmd);
      }
    })();
  }

  // Subscribe to shock commands (JSON encoded)
  subscribeShock(handler: (cmd: ShockCommand) => void): void {
    const sub = this.nc!.subscribe(`game.${this.room}.cmd.shock`);
    this.subs.push(sub);
    this.cmdSubs.push(sub);
    (async () => {
      for await (const msg of sub) {
        const cmd = JSON.parse(sc.decode(msg.data)) as ShockCommand;
        handler(cmd);
      }
    })();
  }

  // Subscribe to tornado commands (JSON encoded)
  subscribeTornado(handler: (cmd: TornadoCommand) => void): void {
    const sub = this.nc!.subscribe(`game.${this.room}.cmd.tornado`);
    this.subs.push(sub);
    this.cmdSubs.push(sub);
    (async () => {
      for await (const msg of sub) {
        const cmd = JSON.parse(sc.decode(msg.data)) as TornadoCommand;
        handler(cmd);
      }
    })();
  }

  // Subscribe to explosion commands (JSON encoded)
  subscribeExplosion(handler: (cmd: ExplosionCommand) => void): void {
    const sub = this.nc!.subscribe(`game.${this.room}.cmd.explosion`);
    this.subs.push(sub);
    this.cmdSubs.push(sub);
    (async () => {
      for await (const msg of sub) {
        const cmd = JSON.parse(sc.decode(msg.data)) as ExplosionCommand;
        handler(cmd);
      }
    })();
  }

  // Subscribe to lightning commands (JSON encoded)
  subscribeLightning(handler: (cmd: LightningCommand) => void): void {
    const sub = this.nc!.subscribe(`game.${this.room}.cmd.lightning`);
    this.subs.push(sub);
    this.cmdSubs.push(sub);
    (async () => {
      for await (const msg of sub) {
        const cmd = JSON.parse(sc.decode(msg.data)) as LightningCommand;
        handler(cmd);
      }
    })();
  }

  // Subscribe to super_push commands (JSON encoded)
  subscribeSuperPush(handler: (cmd: SuperPushCommand) => void): void {
    const sub = this.nc!.subscribe(`game.${this.room}.cmd.super_push`);
    this.subs.push(sub);
    this.cmdSubs.push(sub);
    (async () => {
      for await (const msg of sub) {
        const cmd = JSON.parse(sc.decode(msg.data)) as SuperPushCommand;
        handler(cmd);
      }
    })();
  }

  // Subscribe to clear_all commands (JSON encoded)
  subscribeClearAll(handler: (cmd: ClearAllCommand) => void): void {
    const sub = this.nc!.subscribe(`game.${this.room}.cmd.clear_all`);
    this.subs.push(sub);
    this.cmdSubs.push(sub);
    (async () => {
      for await (const msg of sub) {
        const cmd = JSON.parse(sc.decode(msg.data)) as ClearAllCommand;
        handler(cmd);
      }
    })();
  }

  // Subscribe to fill_platform commands (JSON encoded)
  subscribeFillPlatform(handler: (cmd: FillPlatformCommand) => void): void {
    const sub = this.nc!.subscribe(`game.${this.room}.cmd.fill_platform`);
    this.subs.push(sub);
    this.cmdSubs.push(sub);
    (async () => {
      for await (const msg of sub) {
        const cmd = JSON.parse(sc.decode(msg.data)) as FillPlatformCommand;
        handler(cmd);
      }
    })();
  }

  // Subscribe to update_scene_objects commands (JSON encoded)
  subscribeUpdateSceneObjects(handler: (cmd: UpdateSceneObjectsCommand) => void): void {
    const sub = this.nc!.subscribe(`game.${this.room}.cmd.update_scene_objects`);
    this.subs.push(sub);
    this.cmdSubs.push(sub);
    (async () => {
      for await (const msg of sub) {
        const cmd = JSON.parse(sc.decode(msg.data)) as UpdateSceneObjectsCommand;
        handler(cmd);
      }
    })();
  }

  // Subscribe to snapshot requests (request/reply, protobuf encoded)
  subscribeSnapshotRequest(handler: () => WorldSnapshotMessage): void {
    const sub = this.nc!.subscribe(`game.${this.room}.snapshot.request`);
    this.subs.push(sub);
    (async () => {
      for await (const msg of sub) {
        const snapshot = handler();
        const gm = create(GameMessageSchema, {
          msg: {
            case: "worldSnapshot",
            value: {
              protocolVersion: snapshot.protocolVersion,
              serverTime: snapshot.serverTime,
              tick: snapshot.tick,
              bodies: snapshot.bodies.map((b) => ({
                id: b.id,
                type: b.type,
                posX: b.pos?.[0] ?? 0,
                posY: b.pos?.[1] ?? 0,
                posZ: b.pos?.[2] ?? 0,
                rotX: b.rot?.[0] ?? 0,
                rotY: b.rot?.[1] ?? 0,
                rotZ: b.rot?.[2] ?? 0,
                rotW: b.rot?.[3] ?? 0,
                z: b.z ?? 0,
                sponsorId: b.sponsor_id ?? "",
              })),
            },
          },
        });
        msg.respond(toBinary(GameMessageSchema, gm));
      }
    })();
  }

  // Publish state delta (protobuf encoded, 15Hz)
  publishStateDelta(delta: StateDeltaMessage): void {
    const msg = create(GameMessageSchema, {
      msg: {
        case: "stateDelta",
        value: {
          serverTime: delta.serverTime,
          tick: delta.tick,
          updates: delta.updates.map((u) => ({
            id: u.id,
            posX: u.pos[0],
            posY: u.pos[1],
            posZ: u.pos[2],
            rotX: u.rot[0],
            rotY: u.rot[1],
            rotZ: u.rot[2],
            rotW: u.rot[3],
          })),
          pusherZ: delta.pusherZ,
        },
      },
    });
    this.trackedPublish(`game.${this.room}.state_delta`, toBinary(GameMessageSchema, msg));
  }

  // Publish despawn event (protobuf encoded)
  publishDespawn(despawn: DespawnMessage): void {
    const msg = create(GameMessageSchema, {
      msg: {
        case: "despawn",
        value: {
          tick: despawn.tick,
          ids: despawn.ids,
        },
      },
    });
    this.trackedPublish(`game.${this.room}.despawn`, toBinary(GameMessageSchema, msg));
  }

  // Publish reward event (JSON encoded)
  publishReward(reward: RewardEvent): void {
    this.trackedPublish(`game.${this.room}.reward`, sc.encode(JSON.stringify(reward)));
  }

  // Publish slot machine spin result (protobuf encoded)
  publishSlotSpin(msg: SlotMachineSpinMessage): void {
    const gm = create(GameMessageSchema, {
      msg: {
        case: "slotSpin",
        value: {
          reels: msg.reels,
          jackpot: msg.jackpot,
        },
      },
    });
    this.trackedPublish(`game.${this.room}.slot_spin`, toBinary(GameMessageSchema, gm));
  }

  // Publish slot machine counter update (protobuf encoded)
  publishSlotCounter(msg: SlotMachineCounterMessage): void {
    const gm = create(GameMessageSchema, {
      msg: {
        case: "slotCounter",
        value: {
          counter: msg.counter,
        },
      },
    });
    this.trackedPublish(`game.${this.room}.slot_counter`, toBinary(GameMessageSchema, gm));
  }

  // Publish ability event (protobuf encoded, broadcast to all clients)
  publishAbilityEvent(msg: AbilityEventMessage): void {
    const gm = create(GameMessageSchema, {
      msg: {
        case: "ability",
        value: {
          ability: msg.ability,
          x: msg.x,
          z: msg.z,
          username: msg.username,
        },
      },
    });
    this.trackedPublish(`game.${this.room}.ability`, toBinary(GameMessageSchema, gm));
  }

  // Publish full world snapshot for caching (protobuf encoded)
  publishSnapshot(snapshot: WorldSnapshotMessage): void {
    const gm = create(GameMessageSchema, {
      msg: {
        case: "worldSnapshot",
        value: {
          protocolVersion: snapshot.protocolVersion,
          serverTime: snapshot.serverTime,
          tick: snapshot.tick,
          bodies: snapshot.bodies.map((b) => ({
            id: b.id,
            type: b.type,
            posX: b.pos?.[0] ?? 0,
            posY: b.pos?.[1] ?? 0,
            posZ: b.pos?.[2] ?? 0,
            rotX: b.rot?.[0] ?? 0,
            rotY: b.rot?.[1] ?? 0,
            rotZ: b.rot?.[2] ?? 0,
            rotW: b.rot?.[3] ?? 0,
            z: b.z ?? 0,
            sponsorId: b.sponsor_id ?? "",
          })),
        },
      },
    });
    this.trackedPublish(`game.${this.room}.snapshot`, toBinary(GameMessageSchema, gm));
  }

  // Publish classified coin despawn events (JSON encoded, for backend processing)
  publishCoinDespawn(data: { coins: { id: number; zone: string; owner_id: string; sponsor_id?: string }[]; tick: number }): void {
    this.trackedPublish(`game.${this.room}.evt.coin_despawn`, sc.encode(JSON.stringify(data)));
  }

  // Publish coin spawn notification (protobuf encoded, for client broadcast)
  publishCoinSpawn(msg: CoinSpawnMessage): void {
    const gm = create(GameMessageSchema, {
      msg: {
        case: "coinSpawn",
        value: {
          coins: msg.coins.map((c) => ({
            id: c.id,
            ownerId: c.owner_id,
            isKeyCoin: c.is_key_coin ?? false,
            sponsorId: c.sponsor_id ?? "",
          })),
        },
      },
    });
    this.trackedPublish(`game.${this.room}.coin_spawn`, toBinary(GameMessageSchema, gm));
  }

  // Publish key coin front despawn event (JSON encoded, for backend processing)
  publishKeyCoinFrontDespawn(data: { count: number; tick: number }): void {
    this.trackedPublish(`game.${this.room}.evt.key_coin_front_despawn`, sc.encode(JSON.stringify(data)));
  }

  // Publish queue update notification (protobuf encoded, for client broadcast)
  publishQueueUpdate(msg: QueueUpdateMessage): void {
    const gm = create(GameMessageSchema, {
      msg: {
        case: "queueUpdate",
        value: {
          userId: msg.user_id,
          pending: msg.pending,
        },
      },
    });
    this.trackedPublish(`game.${this.room}.queue_update`, toBinary(GameMessageSchema, gm));
  }

  // Publish jackpot wheel spin result (protobuf encoded)
  publishWheelSpin(msg: WheelSpinMessage): void {
    const gm = create(GameMessageSchema, {
      msg: {
        case: "wheelSpin",
        value: {
          segment: msg.segment,
          reward: msg.reward,
        },
      },
    });
    this.trackedPublish(`game.${this.room}.wheel_spin`, toBinary(GameMessageSchema, gm));
  }

  // Publish jackpot wheel counter update (protobuf encoded)
  publishWheelCounter(msg: WheelCounterMessage): void {
    const gm = create(GameMessageSchema, {
      msg: {
        case: "wheelCounter",
        value: {
          counter: msg.counter,
        },
      },
    });
    this.trackedPublish(`game.${this.room}.wheel_counter`, toBinary(GameMessageSchema, gm));
  }

  // Publish slot status for backend sync (JSON encoded, 1Hz)
  publishSlotStatus(msg: SlotStatusMessage): void {
    this.trackedPublish(`game.${this.room}.slot_status`, sc.encode(JSON.stringify(msg)));
  }

  // Subscribe to batch_insert commands (JSON encoded)
  subscribeBatchInsert(handler: (cmd: BatchInsertCommand) => void): void {
    const sub = this.nc!.subscribe(`game.${this.room}.cmd.batch_insert`);
    this.subs.push(sub);
    this.cmdSubs.push(sub);
    (async () => {
      for await (const msg of sub) {
        const cmd = JSON.parse(sc.decode(msg.data)) as BatchInsertCommand;
        handler(cmd);
      }
    })();
  }

  // Subscribe to sponsor_config updates (JSON encoded)
  subscribeSponsorConfig(handler: (cmd: SponsorConfigCommand) => void): void {
    const sub = this.nc!.subscribe(`game.${this.room}.sponsor_config`);
    this.subs.push(sub);
    this.cmdSubs.push(sub);
    (async () => {
      for await (const msg of sub) {
        const cmd = JSON.parse(sc.decode(msg.data)) as SponsorConfigCommand;
        handler(cmd);
      }
    })();
  }

  // Subscribe to sponsor_quota commands (JSON encoded)
  subscribeSponsorQuota(handler: (cmd: SponsorQuotaCommand) => void): void {
    const sub = this.nc!.subscribe(`game.${this.room}.cmd.sponsor_quota`);
    this.subs.push(sub);
    this.cmdSubs.push(sub);
    (async () => {
      for await (const msg of sub) {
        const cmd = JSON.parse(sc.decode(msg.data)) as SponsorQuotaCommand;
        handler(cmd);
      }
    })();
  }

  // Subscribe to bonus_drop commands (JSON encoded)
  subscribeBonusDrop(handler: (cmd: BonusDropCommand) => void): void {
    const sub = this.nc!.subscribe(`game.${this.room}.cmd.sponsor_bonus`);
    this.subs.push(sub);
    this.cmdSubs.push(sub);
    (async () => {
      for await (const msg of sub) {
        const cmd = JSON.parse(sc.decode(msg.data)) as BonusDropCommand;
        handler(cmd);
      }
    })();
  }

  // Publish sponsor quota consumed event (JSON encoded, for backend processing)
  publishSponsorQuotaConsumed(data: { quota_id: string; coins_spawned: number }): void {
    this.trackedPublish(`game.${this.room}.evt.sponsor_quota_consumed`, sc.encode(JSON.stringify(data)));
  }

  /** Unsubscribe from all command subscriptions (stop accepting new game commands). */
  unsubscribeCommands(): void {
    for (const sub of this.cmdSubs) {
      sub.unsubscribe();
    }
    this.cmdSubs = [];
    console.log("NATS command subscriptions closed");
  }

  // Graceful close
  async close(): Promise<void> {
    for (const sub of this.subs) {
      sub.unsubscribe();
    }
    if (this.nc) {
      await this.nc.drain();
      await this.nc.close();
    }
    console.log("NATS connection closed");
  }
}
