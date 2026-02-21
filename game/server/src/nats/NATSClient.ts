import { connect, type NatsConnection, type Subscription, StringCodec } from "nats";
import * as msgpack from "@msgpack/msgpack";
import type { StateDeltaMessage, DespawnMessage, WorldSnapshotMessage, SlotMachineSpinMessage, SlotMachineCounterMessage, AbilityEventMessage } from "@coin-pusher/shared";

const sc = StringCodec();

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
};

export type TornadoCommand = {
  user_id: string;
  x: number;
  z: number;
};

export type ExplosionCommand = {
  user_id: string;
  x: number;
  z: number;
};

export type LightningCommand = {
  user_id: string;
};

export type SuperPushCommand = {
  user_id: string;
};

export type ClearAllCommand = {
  user_id: string;
};

export type FillPlatformCommand = {
  user_id: string;
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
  private room: string;

  constructor(room: string = "main") {
    this.room = room;
  }

  async connect(url: string = "nats://localhost:4222"): Promise<void> {
    this.nc = await connect({ servers: url });
    console.log(`Connected to NATS at ${url}`);
  }

  // Subscribe to coin_insert commands (JSON encoded)
  subscribeCoinInsert(handler: (cmd: CoinInsertCommand) => void): void {
    const sub = this.nc!.subscribe(`game.${this.room}.cmd.coin_insert`);
    this.subs.push(sub);
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
    (async () => {
      for await (const msg of sub) {
        const cmd = JSON.parse(sc.decode(msg.data)) as UpdateSceneObjectsCommand;
        handler(cmd);
      }
    })();
  }

  // Subscribe to snapshot requests (request/reply)
  subscribeSnapshotRequest(handler: () => WorldSnapshotMessage): void {
    const sub = this.nc!.subscribe(`game.${this.room}.snapshot.request`);
    this.subs.push(sub);
    (async () => {
      for await (const msg of sub) {
        const snapshot = handler();
        const encoded = msgpack.encode(snapshot);
        msg.respond(encoded);
      }
    })();
  }

  // Publish state delta (msgpack encoded, 30Hz)
  publishStateDelta(delta: StateDeltaMessage): void {
    const encoded = msgpack.encode(delta);
    this.nc!.publish(`game.${this.room}.state_delta`, encoded);
  }

  // Publish despawn event (msgpack encoded)
  publishDespawn(despawn: DespawnMessage): void {
    const encoded = msgpack.encode(despawn);
    this.nc!.publish(`game.${this.room}.despawn`, encoded);
  }

  // Publish reward event (JSON encoded)
  publishReward(reward: RewardEvent): void {
    this.nc!.publish(`game.${this.room}.reward`, sc.encode(JSON.stringify(reward)));
  }

  // Publish slot machine spin result (msgpack encoded)
  publishSlotSpin(msg: SlotMachineSpinMessage): void {
    const encoded = msgpack.encode(msg);
    this.nc!.publish(`game.${this.room}.slot_spin`, encoded);
  }

  // Publish slot machine counter update (msgpack encoded)
  publishSlotCounter(msg: SlotMachineCounterMessage): void {
    const encoded = msgpack.encode(msg);
    this.nc!.publish(`game.${this.room}.slot_counter`, encoded);
  }

  // Publish ability event (msgpack encoded, broadcast to all clients)
  publishAbilityEvent(msg: AbilityEventMessage): void {
    const encoded = msgpack.encode(msg);
    this.nc!.publish(`game.${this.room}.ability`, encoded);
  }

  // Publish full world snapshot for caching (msgpack encoded)
  publishSnapshot(snapshot: WorldSnapshotMessage): void {
    const encoded = msgpack.encode(snapshot);
    this.nc!.publish(`game.${this.room}.snapshot`, encoded);
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
