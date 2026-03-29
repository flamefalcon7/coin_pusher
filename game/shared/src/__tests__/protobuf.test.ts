import { describe, it, expect } from "vitest";
import { create, toBinary, fromBinary } from "@bufbuild/protobuf";
import { GameMessageSchema } from "../gen/game_pb.js";

// Helper: roundtrip through GameMessage envelope
function roundtrip(init: Parameters<typeof create<typeof GameMessageSchema>>[1]) {
  const msg = create(GameMessageSchema, init);
  const bytes = toBinary(GameMessageSchema, msg);
  return fromBinary(GameMessageSchema, bytes);
}

describe("protobuf roundtrip", () => {
  it("state_delta with multiple coin updates", () => {
    const decoded = roundtrip({
      msg: {
        case: "stateDelta",
        value: {
          serverTime: 1708000000000,
          tick: 42,
          updates: [
            { id: 1, posX: 0.123, posY: 0.456, posZ: 0.789, rotX: 0.1, rotY: 0.2, rotZ: 0.3, rotW: 0.9 },
            { id: 2, posX: -0.5, posY: 1.0, posZ: 0.0, rotX: 0.0, rotY: 0.0, rotZ: 0.0, rotW: 1.0 },
          ],
          pusherZ: 0.15,
        },
      },
    });

    expect(decoded.msg.case).toBe("stateDelta");
    if (decoded.msg.case !== "stateDelta") throw new Error("wrong case");

    const v = decoded.msg.value;
    expect(v.serverTime).toBe(1708000000000);
    expect(v.tick).toBe(42);
    expect(v.updates).toHaveLength(2);
    expect(v.updates[0].id).toBe(1);
    expect(v.updates[0].posX).toBeCloseTo(0.123, 3);
    expect(v.updates[0].posY).toBeCloseTo(0.456, 3);
    expect(v.updates[0].rotW).toBeCloseTo(0.9, 3);
    expect(v.updates[1].posX).toBeCloseTo(-0.5, 3);
    expect(v.updates[1].rotW).toBeCloseTo(1.0, 3);
    expect(v.pusherZ).toBeCloseTo(0.15, 3);
  });

  it("state_delta with empty updates", () => {
    const decoded = roundtrip({
      msg: {
        case: "stateDelta",
        value: {
          serverTime: 0,
          tick: 0,
          updates: [],
          pusherZ: 0,
        },
      },
    });

    expect(decoded.msg.case).toBe("stateDelta");
    if (decoded.msg.case !== "stateDelta") throw new Error("wrong case");
    expect(decoded.msg.value.updates).toHaveLength(0);
    expect(decoded.msg.value.tick).toBe(0);
  });

  it("despawn with multiple ids", () => {
    const decoded = roundtrip({
      msg: {
        case: "despawn",
        value: { tick: 100, ids: [5, 10, 42, 999] },
      },
    });

    expect(decoded.msg.case).toBe("despawn");
    if (decoded.msg.case !== "despawn") throw new Error("wrong case");
    expect(decoded.msg.value.tick).toBe(100);
    expect(decoded.msg.value.ids).toEqual([5, 10, 42, 999]);
  });

  it("despawn with empty ids", () => {
    const decoded = roundtrip({
      msg: {
        case: "despawn",
        value: { tick: 0, ids: [] },
      },
    });

    expect(decoded.msg.case).toBe("despawn");
    if (decoded.msg.case !== "despawn") throw new Error("wrong case");
    expect(decoded.msg.value.ids).toEqual([]);
  });

  it("world_snapshot with mixed body types", () => {
    const decoded = roundtrip({
      msg: {
        case: "worldSnapshot",
        value: {
          protocolVersion: 1,
          serverTime: 1708000000000,
          tick: 50,
          bodies: [
            { id: 1, type: "coin", posX: 0.1, posY: 0.5, posZ: 0.3, rotX: 0, rotY: 0, rotZ: 0, rotW: 1, z: 0 },
            { id: 2, type: "pusher", posX: 0, posY: 0, posZ: 0, rotX: 0, rotY: 0, rotZ: 0, rotW: 0, z: 0.12 },
          ],
        },
      },
    });

    expect(decoded.msg.case).toBe("worldSnapshot");
    if (decoded.msg.case !== "worldSnapshot") throw new Error("wrong case");

    const v = decoded.msg.value;
    expect(v.protocolVersion).toBe(1);
    expect(v.bodies).toHaveLength(2);
    expect(v.bodies[0].type).toBe("coin");
    expect(v.bodies[0].posX).toBeCloseTo(0.1, 3);
    expect(v.bodies[1].type).toBe("pusher");
    expect(v.bodies[1].z).toBeCloseTo(0.12, 3);
  });

  it("slot_spin", () => {
    const decoded = roundtrip({
      msg: {
        case: "slotSpin",
        value: { reels: ["bitcoin", "ethereum", "solana"], jackpot: false },
      },
    });

    expect(decoded.msg.case).toBe("slotSpin");
    if (decoded.msg.case !== "slotSpin") throw new Error("wrong case");
    expect(decoded.msg.value.reels).toEqual(["bitcoin", "ethereum", "solana"]);
    expect(decoded.msg.value.jackpot).toBe(false);
  });

  it("slot_spin jackpot", () => {
    const decoded = roundtrip({
      msg: {
        case: "slotSpin",
        value: { reels: ["bitcoin", "bitcoin", "bitcoin"], jackpot: true },
      },
    });

    if (decoded.msg.case !== "slotSpin") throw new Error("wrong case");
    expect(decoded.msg.value.jackpot).toBe(true);
  });

  it("slot_counter", () => {
    const decoded = roundtrip({
      msg: {
        case: "slotCounter",
        value: { counter: 7 },
      },
    });

    expect(decoded.msg.case).toBe("slotCounter");
    if (decoded.msg.case !== "slotCounter") throw new Error("wrong case");
    expect(decoded.msg.value.counter).toBe(7);
  });

  it("slot_counter zero", () => {
    const decoded = roundtrip({
      msg: {
        case: "slotCounter",
        value: { counter: 0 },
      },
    });

    if (decoded.msg.case !== "slotCounter") throw new Error("wrong case");
    expect(decoded.msg.value.counter).toBe(0);
  });

  it("ability with position", () => {
    const decoded = roundtrip({
      msg: {
        case: "ability",
        value: { ability: "tornado", x: 0.2, z: -0.1 },
      },
    });

    expect(decoded.msg.case).toBe("ability");
    if (decoded.msg.case !== "ability") throw new Error("wrong case");
    expect(decoded.msg.value.ability).toBe("tornado");
    expect(decoded.msg.value.x).toBeCloseTo(0.2, 3);
    expect(decoded.msg.value.z).toBeCloseTo(-0.1, 3);
  });

  it("ability without position", () => {
    const decoded = roundtrip({
      msg: {
        case: "ability",
        value: { ability: "shock" },
      },
    });

    if (decoded.msg.case !== "ability") throw new Error("wrong case");
    expect(decoded.msg.value.ability).toBe("shock");
    expect(decoded.msg.value.x).toBeUndefined();
    expect(decoded.msg.value.z).toBeUndefined();
  });

  it("coin_spawn", () => {
    const decoded = roundtrip({
      msg: {
        case: "coinSpawn",
        value: {
          coins: [
            { id: 100, ownerId: "user-abc" },
            { id: 101, ownerId: "user-xyz" },
          ],
        },
      },
    });

    expect(decoded.msg.case).toBe("coinSpawn");
    if (decoded.msg.case !== "coinSpawn") throw new Error("wrong case");
    expect(decoded.msg.value.coins).toHaveLength(2);
    expect(decoded.msg.value.coins[0].id).toBe(100);
    expect(decoded.msg.value.coins[0].ownerId).toBe("user-abc");
    expect(decoded.msg.value.coins[1].ownerId).toBe("user-xyz");
  });

  it("queue_update", () => {
    const decoded = roundtrip({
      msg: {
        case: "queueUpdate",
        value: { userId: "player-1", pending: 25 },
      },
    });

    expect(decoded.msg.case).toBe("queueUpdate");
    if (decoded.msg.case !== "queueUpdate") throw new Error("wrong case");
    expect(decoded.msg.value.userId).toBe("player-1");
    expect(decoded.msg.value.pending).toBe(25);
  });
});

describe("protobuf byte size", () => {
  it("state_delta is compact", () => {
    const msg = create(GameMessageSchema, {
      msg: {
        case: "stateDelta",
        value: {
          serverTime: Date.now(),
          tick: 1000,
          updates: Array.from({ length: 100 }, (_, i) => ({
            id: i + 1,
            posX: Math.random(),
            posY: Math.random(),
            posZ: Math.random(),
            rotX: Math.random() * 0.5,
            rotY: Math.random() * 0.5,
            rotZ: Math.random() * 0.5,
            rotW: 0.866,
          })),
          pusherZ: 0.1,
        },
      },
    });

    const bytes = toBinary(GameMessageSchema, msg);

    // Measure envelope cost: same message with 0 updates
    const emptyMsg = create(GameMessageSchema, {
      msg: {
        case: "stateDelta",
        value: { serverTime: Date.now(), tick: 1000, updates: [], pusherZ: 0.1 },
      },
    });
    const emptyBytes = toBinary(GameMessageSchema, emptyMsg);
    const envelopeSize = emptyBytes.length;
    const perCoinBytes = (bytes.length - envelopeSize) / 100;

    // Per-coin: 1 varint id + 7 floats (5 bytes each) + length prefix ≈ 39 bytes
    // (pos×3 + rot×4 = 7 floats)
    expect(perCoinBytes).toBeLessThan(42);
    // Total must be reasonable for 100 coins
    expect(bytes.length).toBeLessThan(4200);
  });
});

describe("mixed-format detection", () => {
  it("protobuf first byte is not in msgpack fixmap range", () => {
    const msg = create(GameMessageSchema, {
      msg: {
        case: "stateDelta",
        value: {
          serverTime: Date.now(),
          tick: 1,
          updates: [{ id: 1, posX: 0.1, posY: 0.2, posZ: 0.3, rotX: 0, rotY: 0, rotZ: 0, rotW: 1 }],
          pusherZ: 0,
        },
      },
    });

    const bytes = toBinary(GameMessageSchema, msg);
    const first = bytes[0];

    // Protobuf field 1 LEN-type = 0x0a. Must NOT overlap with msgpack fixmap (0x80-0x8f)
    expect(first).toBeLessThan(0x80);
    // Should be a valid protobuf field tag
    expect(first).toBe(0x0a); // field 1, wire type 2 (LEN)
  });

  it("all oneof variants produce non-fixmap first bytes", () => {
    const cases: Parameters<typeof create<typeof GameMessageSchema>>[1][] = [
      { msg: { case: "stateDelta", value: { serverTime: 1, tick: 1, updates: [], pusherZ: 0 } } },
      { msg: { case: "despawn", value: { tick: 1, ids: [1] } } },
      { msg: { case: "worldSnapshot", value: { protocolVersion: 1, serverTime: 1, tick: 1, bodies: [] } } },
      { msg: { case: "slotSpin", value: { reels: ["a"], jackpot: false } } },
      { msg: { case: "slotCounter", value: { counter: 1 } } },
      { msg: { case: "ability", value: { ability: "shock" } } },
      { msg: { case: "coinSpawn", value: { coins: [{ id: 1, ownerId: "u" }] } } },
      { msg: { case: "queueUpdate", value: { userId: "u", pending: 1 } } },
    ];

    for (const init of cases) {
      const bytes = toBinary(GameMessageSchema, create(GameMessageSchema, init));
      const first = bytes[0];
      // Must not be in msgpack fixmap range (0x80-0x8f) or map16/map32 (0xde, 0xdf)
      const isMsgpackMap = (first >= 0x80 && first <= 0x8f) || first === 0xde || first === 0xdf;
      expect(isMsgpackMap).toBe(false);
    }
  });
});
