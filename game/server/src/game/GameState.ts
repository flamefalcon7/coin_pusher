import type { BodyState, BodyType, WorldState } from "@coin-pusher/shared";
import { PROTOCOL_VERSION } from "@coin-pusher/shared";

// Extended BodyState with sponsor tracking (for serialization to protobuf)
export type BodyStateWithSponsor = BodyState & { sponsor_id?: string };

export class GameState {
  private nextBodyId: number = 1; // ID 0 reserved for pusher
  private bodies: Map<number, BodyStateWithSponsor> = new Map();
  private tick: number = 0;
  private pusherZ: number = 0;

  /**
   * Seed of this session's simulation RNG. Held here because it belongs to the
   * world, and read by whatever records or arbitrates a session.
   *
   * Deliberately NOT in getWorldSnapshot(): anyone holding the seed can
   * reproduce every draw the simulation will make, and lightning strike
   * positions come off that stream while the player chooses when to spend the
   * scroll. It used to ship in the snapshot; that is the hole this removes.
   * See docs/decisions.md D-005.
   */
  private readonly rngSeed: string;

  constructor(rngSeed: string = "") {
    this.rngSeed = rngSeed;
    // Initialize pusher at ID 0
    this.bodies.set(0, {
      id: 0,
      type: "pusher",
      z: 0,
    });
  }

  getNextBodyId(): number {
    return this.nextBodyId++;
  }

  addCoin(
    id: number,
    x: number,
    y: number,
    z: number,
    rotation?: [number, number, number, number],
    bodyType: BodyType = "coin",
    sponsorId?: string
  ): void {
    // Default rotation: 90 degrees around X-axis (coin standing up)
    const rot: [number, number, number, number] = rotation || [
      Math.SQRT1_2,
      0,
      0,
      Math.SQRT1_2,
    ];
    const body: BodyStateWithSponsor = {
      id,
      type: bodyType,
      pos: [x, y, z],
      rot,
    };
    if (sponsorId) {
      body.sponsor_id = sponsorId;
    }
    this.bodies.set(id, body);
  }

  updateCoinState(
    id: number,
    pos: [number, number, number],
    rot: [number, number, number, number]
  ): void {
    const body = this.bodies.get(id);
    if (body && (body.type === "coin" || body.type === "key_coin" || body.type === "sponsor_coin")) {
      body.pos = pos;
      body.rot = rot;
    }
  }

  removeCoin(id: number): void {
    this.bodies.delete(id);
  }

  updatePusherZ(z: number): void {
    this.pusherZ = z;
    const pusher = this.bodies.get(0);
    if (pusher) {
      pusher.z = z;
    }
  }

  getPusherZ(): number {
    return this.pusherZ;
  }

  getTick(): number {
    return this.tick;
  }

  incrementTick(): void {
    this.tick++;
  }

  getRngSeed(): string {
    return this.rngSeed;
  }

  getWorldSnapshot(): WorldState {
    return {
      protocolVersion: PROTOCOL_VERSION,
      tick: this.tick,
      serverTime: Date.now(),
      bodies: Array.from(this.bodies.values()),
    };
  }

  getAllCoins(): Map<number, BodyState> {
    const coins = new Map<number, BodyState>();
    this.bodies.forEach((body, id) => {
      if (body.type === "coin") {
        coins.set(id, body);
      }
    });
    return coins;
  }

  hasBody(id: number): boolean {
    return this.bodies.has(id);
  }

  getBody(id: number): BodyState | undefined {
    return this.bodies.get(id);
  }
}
