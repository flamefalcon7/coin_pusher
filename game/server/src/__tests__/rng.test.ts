import { describe, it, expect } from "vitest";
import { xoshiro128ss, generateSeed, formatSeed } from "../rng.js";

/**
 * Properties the seeded generator must hold for it to be worth replacing
 * Math.random() with. Reproducibility is the point; the distribution checks
 * exist so a generator that is reproducible but badly broken (always returns
 * 0.5, never leaves the low half of the range) cannot pass.
 */
describe("xoshiro128ss", () => {
  it("reproduces the same sequence from the same seed", () => {
    const a = xoshiro128ss(12345);
    const b = xoshiro128ss(12345);

    const seqA = Array.from({ length: 1000 }, () => a());
    const seqB = Array.from({ length: 1000 }, () => b());

    expect(seqA).toEqual(seqB);
  });

  it("produces a different sequence from a different seed", () => {
    const a = xoshiro128ss(12345);
    const b = xoshiro128ss(12346);

    const seqA = Array.from({ length: 100 }, () => a());
    const seqB = Array.from({ length: 100 }, () => b());

    expect(seqA).not.toEqual(seqB);
  });

  it("stays within [0, 1)", () => {
    const rng = xoshiro128ss(7);
    for (let i = 0; i < 100_000; i++) {
      const v = rng();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it("is roughly uniform across the range", () => {
    const rng = xoshiro128ss(99);
    const BUCKETS = 10;
    const N = 200_000;
    const counts = new Array(BUCKETS).fill(0);

    for (let i = 0; i < N; i++) {
      counts[Math.min(BUCKETS - 1, Math.floor(rng() * BUCKETS))]++;
    }

    const expected = N / BUCKETS;
    for (const c of counts) {
      // Generous band — this catches a broken generator, not a subtly biased
      // one. Statistical quality is xoshiro's job, not this suite's.
      expect(Math.abs(c - expected) / expected).toBeLessThan(0.05);
    }
  });

  it("does not get stuck when seeded with zero", () => {
    const rng = xoshiro128ss(0);
    const values = new Set(Array.from({ length: 100 }, () => rng()));
    expect(values.size).toBeGreaterThan(90);
  });

  it("mints distinct seeds", () => {
    const seeds = new Set(Array.from({ length: 200 }, () => generateSeed()));
    // Birthday collisions in 32 bits over 200 draws are vanishingly unlikely.
    expect(seeds.size).toBeGreaterThan(195);
  });

  it("formats seeds as fixed-width hex for logs and snapshots", () => {
    expect(formatSeed(0)).toBe("00000000");
    expect(formatSeed(0xdeadbeef)).toBe("deadbeef");
    expect(formatSeed(255)).toBe("000000ff");
  });
});
