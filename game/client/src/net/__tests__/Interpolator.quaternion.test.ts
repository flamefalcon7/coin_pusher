import { describe, it, expect } from "vitest";
import { Interpolator } from "../Interpolator";
import { StateBuffer } from "../StateBuffer";
import { ClockSync } from "../ClockSync";

/**
 * The server quantizes every broadcast quaternion to 3 decimal places (1mm-
 * equivalent precision) AFTER normalizing it. Quantization is the last step, so
 * what arrives on the wire is no longer a unit quaternion — its norm can sit
 * ~1e-3 either side of 1.
 *
 * SLERP does not repair that: with non-unit inputs the weights are computed
 * from a dot product that is not cos(theta), and the blended output inherits
 * the error. A non-unit quaternion fed to a renderer is not a pure rotation —
 * it scales the mesh — so the client has to re-normalize.
 *
 * Fixing it here rather than on the server is deliberate: the server cannot
 * both quantize for bandwidth and guarantee unit length, and the client is the
 * only place the value is actually used as a rotation.
 */

type Quat = [number, number, number, number];

const QUANTIZE = 1000; // server's Q_FACTOR — 3 decimal places

/** Reproduce the server's normalize-then-quantize pipeline. */
function normalizeAndQuantize(q: Quat): Quat {
  const n = Math.hypot(q[0], q[1], q[2], q[3]);
  return q.map((v) => Math.round((v / n) * QUANTIZE) / QUANTIZE) as Quat;
}

const norm = (q: Quat) => Math.hypot(q[0], q[1], q[2], q[3]);

/** Reach the private slerp, which is what the rest of the class delegates to. */
function slerp(a: Quat, b: Quat, t: number): Quat {
  // slerpInto is pure — it reads neither collaborator — so real instances are
  // fine here and avoid a mock that could drift from the real signatures.
  const interp = new Interpolator(new StateBuffer(), new ClockSync());
  const out: Quat = [0, 0, 0, 0];
  (
    interp as unknown as {
      slerpInto(o: Quat, q1: Quat, q2: Quat, t: number): void;
    }
  ).slerpInto(out, a, b, t);
  return out;
}

/**
 * Public-surface coverage. The slerp assertions below reach a private method;
 * these drive getInterpolatedState() the way GameClient does, so the raw-copy
 * paths (snapshot seeding, first frame, no-previous-update, extrapolation) are
 * covered too. Those four paths originally passed the wire value straight
 * through — the private-method tests could not see it.
 */
describe("Interpolator quaternion handling (public surface)", () => {
  const QUANTIZED: Quat = normalizeAndQuantize([0.3117, 0.5231, 0.1873, 0.7742]);

  function buildInterpolator() {
    const buffer = new StateBuffer();
    const clock = new ClockSync();
    return { interp: new Interpolator(buffer, clock), buffer };
  }

  /** Fill the buffer densely around now so any interpolation delay lands inside. */
  function fillBuffer(buffer: StateBuffer, coinId: number) {
    const now = Date.now();
    for (let i = 0; i < 60; i++) {
      buffer.addState({
        serverTime: now - 3000 + i * 50,
        tick: i,
        updates: [{ id: coinId, pos: [i * 0.01, 0.3, 0], rot: QUANTIZED }],
        pusherZ: 0,
      });
    }
  }

  const assertAllUnit = (state: { coins: { rot: Quat }[] } | null) => {
    expect(state).not.toBeNull();
    expect(state!.coins.length).toBeGreaterThan(0);
    for (const c of state!.coins) {
      expect(Math.abs(norm(c.rot) - 1)).toBeLessThan(1e-6);
    }
  };

  it("returns unit rotations from seeded snapshot coins", () => {
    const { interp } = buildInterpolator();
    interp.seedCoins([{ id: 1, pos: [0, 0.3, 0], rot: QUANTIZED }], 0);

    const coins = (
      interp as unknown as { knownCoins: Map<number, { rot: Quat }> }
    ).knownCoins;
    expect(Math.abs(norm(coins.get(1)!.rot) - 1)).toBeLessThan(1e-6);
  });

  it("returns unit rotations while interpolating", () => {
    const { interp, buffer } = buildInterpolator();
    fillBuffer(buffer, 1);
    assertAllUnit(interp.getInterpolatedState() as never);
  });

  it("returns unit rotations while extrapolating past the newest state", () => {
    const { interp, buffer } = buildInterpolator();
    const now = Date.now();
    // Two states well in the past: the target time is beyond both, so the
    // extrapolation path runs — the path that is active precisely when the
    // client is starved of updates.
    buffer.addState({
      serverTime: now - 6000,
      tick: 1,
      updates: [{ id: 1, pos: [0, 0.3, 0], rot: QUANTIZED }],
      pusherZ: 0,
    });
    buffer.addState({
      serverTime: now - 5900,
      tick: 2,
      updates: [{ id: 1, pos: [0.01, 0.3, 0], rot: QUANTIZED }],
      pusherZ: 0,
    });

    assertAllUnit(interp.getInterpolatedState() as never);
  });
});

describe("Interpolator quaternion handling", () => {
  it("the premise holds: quantized input really is off the unit sphere", () => {
    // A rotation whose components do not land on 3-decimal boundaries.
    const q = normalizeAndQuantize([0.3117, 0.5231, 0.1873, 0.7742]);
    expect(Math.abs(norm(q) - 1)).toBeGreaterThan(1e-5);
  });

  it("returns a unit quaternion from quantized inputs (slerp path)", () => {
    const a = normalizeAndQuantize([0.3117, 0.5231, 0.1873, 0.7742]);
    const b = normalizeAndQuantize([-0.6412, 0.2277, 0.5519, 0.4834]);

    for (const t of [0, 0.13, 0.25, 0.5, 0.75, 0.99, 1]) {
      const out = slerp(a, b, t);
      expect(Math.abs(norm(out) - 1)).toBeLessThan(1e-6);
    }
  });

  it("returns a unit quaternion on the near-parallel lerp shortcut", () => {
    // dot > 0.9995 takes the linear branch, which shortens the quaternion the
    // most — a straight chord across the sphere rather than an arc along it.
    const a = normalizeAndQuantize([0.0, 0.0, 0.0, 1.0]);
    const b = normalizeAndQuantize([0.001, 0.002, 0.001, 0.9999]);

    for (const t of [0.25, 0.5, 0.75]) {
      const out = slerp(a, b, t);
      expect(Math.abs(norm(out) - 1)).toBeLessThan(1e-6);
    }
  });

  it("still takes the shortest path when the inputs are opposed in sign", () => {
    const a = normalizeAndQuantize([0.3117, 0.5231, 0.1873, 0.7742]);
    const negB = normalizeAndQuantize([-0.3117, -0.5231, -0.1873, -0.7742]);

    // q and -q are the same rotation; interpolating between them must not
    // travel the long way round, and must stay unit length.
    const out = slerp(a, negB, 0.5);
    expect(Math.abs(norm(out) - 1)).toBeLessThan(1e-6);

    // Halfway between a rotation and itself is that rotation (up to sign).
    const dot = Math.abs(
      out[0] * a[0] + out[1] * a[1] + out[2] * a[2] + out[3] * a[3],
    );
    expect(dot).toBeGreaterThan(0.999);
  });

  it("preserves the rotation it is given at the endpoints", () => {
    const a = normalizeAndQuantize([0.3117, 0.5231, 0.1873, 0.7742]);
    const b = normalizeAndQuantize([-0.6412, 0.2277, 0.5519, 0.4834]);

    const at0 = slerp(a, b, 0);
    const at1 = slerp(a, b, 1);

    // Same rotation as the (normalized) input, not merely unit length.
    const na = norm(a);
    for (let i = 0; i < 4; i++) {
      expect(at0[i]).toBeCloseTo(a[i] / na, 5);
    }
    const nb = norm(b);
    for (let i = 0; i < 4; i++) {
      expect(Math.abs(at1[i])).toBeCloseTo(Math.abs(b[i] / nb), 5);
    }
  });
});
