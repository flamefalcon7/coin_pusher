// Unit tests for RefIDDedup — the idempotency contract underlying the
// outbox drainer's at-least-once retry semantics. Runs under vitest
// (see game/server/vitest.config.ts):
//
//   pnpm --filter @coin-pusher/game test

import { test, expect } from "vitest";
import { RefIDDedup } from "./dedup.js";

test("empty string bypasses dedup (legacy rolling-deploy safe)", () => {
  const d = new RefIDDedup();
  expect(d.check("")).toBe(false);
  expect(d.check("")).toBe(false); // still false, not cached
  expect(d.size()).toBe(0);
});

test("undefined bypasses dedup", () => {
  const d = new RefIDDedup();
  expect(d.check(undefined)).toBe(false);
  expect(d.size()).toBe(0);
});

test("first occurrence returns false, second returns true", () => {
  const d = new RefIDDedup();
  expect(d.check("ref-a")).toBe(false);
  expect(d.check("ref-a")).toBe(true);
});

test("distinct refs tracked independently", () => {
  const d = new RefIDDedup();
  expect(d.check("ref-a")).toBe(false);
  expect(d.check("ref-b")).toBe(false);
  expect(d.check("ref-a")).toBe(true);
  expect(d.check("ref-b")).toBe(true);
});

test("FIFO eviction at maxEntries", () => {
  const d = new RefIDDedup(3);
  d.check("a");
  d.check("b");
  d.check("c");
  expect(d.size()).toBe(3);
  // Inserting a 4th evicts the oldest ("a").
  d.check("d");
  expect(d.size()).toBe(3);
  // "a" was evicted, so re-checking it returns false (treated as new).
  expect(d.check("a")).toBe(false);
  // "b", "c", "d" should still be present — but "b" is now oldest after
  // "a"'s re-insertion. The critical property: evicted entries don't
  // dedup; unevicted ones do.
  expect(d.check("c")).toBe(true);
  expect(d.check("d")).toBe(true);
});

test("repeat of existing entry does not count as new insertion", () => {
  const d = new RefIDDedup(3);
  d.check("a");
  d.check("b");
  d.check("a"); // dup — must NOT push out anything
  d.check("c");
  expect(d.size()).toBe(3);
  // All three still present; no premature eviction from the duplicate.
  expect(d.check("a")).toBe(true);
  expect(d.check("b")).toBe(true);
  expect(d.check("c")).toBe(true);
});

test("size() reflects current cache occupancy", () => {
  const d = new RefIDDedup(10);
  expect(d.size()).toBe(0);
  d.check("a");
  expect(d.size()).toBe(1);
  d.check("a"); // dup, no growth
  expect(d.size()).toBe(1);
  d.check("b");
  expect(d.size()).toBe(2);
});

test("custom maxEntries is respected", () => {
  const d = new RefIDDedup(2);
  d.check("a");
  d.check("b");
  expect(d.size()).toBe(2);
  d.check("c"); // evicts "a"
  expect(d.size()).toBe(2);
  // Careful: checking an evicted ref re-inserts it and evicts another.
  // Assert only on entries known to still be present.
  expect(d.check("b")).toBe(true);
  expect(d.check("c")).toBe(true);
});

test("1000 distinct entries stay bounded by default cap", () => {
  const d = new RefIDDedup(100);
  for (let i = 0; i < 1000; i++) {
    d.check(`ref-${i}`);
  }
  expect(d.size()).toBe(100);
  // Last 100 inserted (ref-900..ref-999) should still be present.
  // Don't probe evicted refs here — the probe itself re-inserts them and
  // perturbs the eviction window. Eviction-then-reappear is tested in the
  // FIFO test above.
  expect(d.check("ref-900")).toBe(true);
  expect(d.check("ref-999")).toBe(true);
});

test("default constructor caps at 10,000", () => {
  // Boundary test for the production default. Without this, a regression
  // changing DEFAULT_MAX_ENTRIES would pass every other test.
  const d = new RefIDDedup();
  for (let i = 0; i < 10_001; i++) {
    d.check(`ref-${i}`);
  }
  expect(d.size()).toBe(10_000);
  // ref-0 (first inserted) must have been evicted at the 10,001st insert.
  // Don't probe with check() (re-inserts), use the other path: the last
  // 10k inserted are present.
  expect(d.check("ref-10000")).toBe(true);
  expect(d.check("ref-5000")).toBe(true);
});

test("non-string reference_id bypasses dedup (defensive — wire payload is unvalidated)", () => {
  const d = new RefIDDedup();
  // JSON null, number, object — anything non-string from a malformed/buggy
  // producer must fall through to the no-dedup path, not admit a duplicate
  // via accidental equality. The as-unknown-as-string cast reflects how
  // the field arrives after JSON.parse.
  expect(d.check(null as unknown as string | undefined)).toBe(false);
  expect(d.check(null as unknown as string | undefined)).toBe(false);
  expect(d.check(123 as unknown as string | undefined)).toBe(false);
  expect(d.size()).toBe(0);
});
