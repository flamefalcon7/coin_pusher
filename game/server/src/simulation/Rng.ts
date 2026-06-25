/**
 * Seedable pseudo-random number generator for the simulation harness.
 *
 * mulberry32 — a tiny, fast, dependency-free PRNG with a 32-bit state. Good
 * enough for reproducible Monte-Carlo / replay-determinism testing; NOT for
 * cryptographic use (the live SlotMachine keeps node:crypto `randomInt` for
 * anti-cheat — RNG injection here is opt-in and only for the seeded test path).
 *
 * Same seed → identical `() => number` sequence in [0, 1), which is what the
 * determinism test (U7) relies on. See KTD-3 in the feedback-loop plan.
 */
export type Rng = () => number;

export function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
