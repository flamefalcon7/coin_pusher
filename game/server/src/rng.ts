import { randomBytes } from "node:crypto";

/**
 * Seeded pseudo-random number generator for the live simulation.
 *
 * Why this exists: the game server's randomness decides where coins land, and
 * where coins land decides RTP. With `Math.random()` a session cannot be
 * replayed, so a disputed round cannot be arbitrated, and a physics parameter
 * change cannot be regression-tested against a known input — you can only
 * observe that the payout moved and guess why.
 *
 * Why xoshiro128** specifically:
 * - 128-bit state, period 2^128-1. A 32-bit-state generator such as mulberry32
 *   is fine for a bounded test run but is a poor fit for a process that draws
 *   continuously for weeks.
 * - Pure 32-bit integer ops. A BigInt-based generator (xorshift128+ over 64-bit
 *   words) would allocate on every draw, in a function called several times per
 *   tick inside the frame budget.
 * - No dependency.
 *
 * NOT cryptographically secure, and deliberately not used for outcomes where
 * unpredictability is a security property — slot reels and wheel segments keep
 * `node:crypto.randomInt`, because a seeded stream that a player can observe or
 * guess is a jackpot-prediction exploit. See docs/decisions.md D-005.
 */
export type Rng = () => number;

/**
 * splitmix32 — used only to expand a single seed word into the four state
 * words. Seeding a xoshiro state with correlated values (e.g. [seed,0,0,0])
 * gives a poor initial stream; running it through a different mixer first is
 * the standard remedy.
 */
function splitmix32(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x9e3779b9) | 0;
    let t = a ^ (a >>> 16);
    t = Math.imul(t, 0x21f0aaad);
    t = t ^ (t >>> 15);
    t = Math.imul(t, 0x735a2d97);
    return (t ^ (t >>> 15)) >>> 0;
  };
}

/**
 * xoshiro128** — returns a float in [0, 1).
 *
 * Same seed always yields the same sequence, which is the whole point: a
 * recorded seed plus the same build reproduces the run.
 */
/**
 * Expand a seed word into the four xoshiro state words. Exported so a test can
 * run a reference implementation from the same starting state as production.
 */
export function splitmix32State(seed: number): [number, number, number, number] {
  const mix = splitmix32(seed);
  const s: [number, number, number, number] = [mix(), mix(), mix(), mix()];
  // An all-zero state is a fixed point that only ever produces zero. splitmix32
  // never actually yields one for a 32-bit seed (verified across the whole
  // range), so this is belt-and-braces against a future change to the seeding.
  if ((s[0] | s[1] | s[2] | s[3]) === 0) s[0] = 1;
  return s;
}

/**
 * The generator's full state: four 32-bit words, 128 bits of entropy.
 *
 * Seeding from a single 32-bit word (the previous shape) left the *effective*
 * seed space at 2^32 no matter how wide the state was — 4.3 billion candidates,
 * which is an offline search, not a wall. Sessions now seed the state directly.
 */
export type RngState = [number, number, number, number];

export function xoshiro128ss(seed: number | RngState): Rng {
  let [a, b, c, d] = typeof seed === "number" ? splitmix32State(seed) : seed;

  return function (): number {
    // Reference (Blackman & Vigna, prng.di.unimi.it/xoshiro128starstar.c):
    //   const uint32_t result = rotl(s[1] * 5, 7) * 9;
    //   const uint32_t t = s[1] << 9;
    // Both the scrambler and t read s[1]. A widely-copied JavaScript
    // transcription applies the scrambler to s[0] instead; that variant has a
    // correct state transition (so the period still holds) but its output is
    // not the function the published test batteries were run against.
    const t = (b << 9) >>> 0;
    let r = Math.imul(b, 5);
    r = (Math.imul((r << 7) | (r >>> 25), 9)) >>> 0;

    c ^= a;
    d ^= b;
    b ^= c;
    a ^= d;
    c ^= t;
    d = ((d << 11) | (d >>> 21)) >>> 0;

    return r / 4294967296;
  };
}

/**
 * A fresh unpredictable seed for a new session: the generator's whole state,
 * straight from the CSPRNG. Unpredictable so a leaked or brute-forced seed
 * cannot let a player anticipate coin scatter or lightning strike positions;
 * recorded (server-side only) so the session stays replayable afterwards.
 */
export function generateSeed(): RngState {
  const b = randomBytes(16);
  const s: RngState = [
    b.readUInt32BE(0),
    b.readUInt32BE(4),
    b.readUInt32BE(8),
    b.readUInt32BE(12),
  ];
  // An all-zero state is a fixed point that only ever yields zero. The odds are
  // 2^-128, but the failure is total and silent, so it is worth two words.
  if ((s[0] | s[1] | s[2] | s[3]) === 0) s[0] = 1;
  return s;
}

/**
 * Format a seed for logs and for SESSION_RNG_SEED. 32 hex characters, one
 * 8-character group per state word, no separators.
 */
export function formatSeed(seed: RngState): string {
  return seed.map((w) => (w >>> 0).toString(16).padStart(8, "0")).join("");
}

/**
 * Parse a seed produced by formatSeed. Returns null on anything that is not
 * exactly 32 hex characters — callers must decide what to do rather than
 * silently running on a seed nobody chose. A malformed SESSION_RNG_SEED used
 * to fall through `parseInt` to NaN and then to state word 0.
 */
export function parseSeed(hex: string): RngState | null {
  const trimmed = hex.trim().toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(trimmed)) return null;

  const s: RngState = [0, 0, 0, 0];
  for (let i = 0; i < 4; i++) {
    s[i] = parseInt(trimmed.slice(i * 8, i * 8 + 8), 16) >>> 0;
  }
  if ((s[0] | s[1] | s[2] | s[3]) === 0) return null;
  return s;
}
