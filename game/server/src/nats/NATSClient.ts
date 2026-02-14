import { connect, type NatsConnection, type Subscription, StringCodec } from "nats";
import * as msgpack from "@msgpack/msgpack";
import type { StateDeltaMessage, DespawnMessage, WorldSnapshotMessage } from "@coin-pusher/shared";

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
