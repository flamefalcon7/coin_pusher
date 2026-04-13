// Unit tests for RefIDDedup — the idempotency contract underlying the
// outbox drainer's at-least-once retry semantics. Runs via the built-in
// Node test runner (no deps):
//
//   node --test --loader tsx --experimental-test-coverage dist/nats/dedup.test.js
//
// Or, post-build:
//   pnpm build && node --test dist/nats/dedup.test.js

import { test } from "node:test";
import assert from "node:assert/strict";
import { RefIDDedup } from "./dedup.js";

test("empty string bypasses dedup (legacy rolling-deploy safe)", () => {
  const d = new RefIDDedup();
  assert.equal(d.check(""), false);
  assert.equal(d.check(""), false); // still false, not cached
  assert.equal(d.size(), 0);
});

test("undefined bypasses dedup", () => {
  const d = new RefIDDedup();
  assert.equal(d.check(undefined), false);
  assert.equal(d.size(), 0);
});

test("first occurrence returns false, second returns true", () => {
  const d = new RefIDDedup();
  assert.equal(d.check("ref-a"), false);
  assert.equal(d.check("ref-a"), true);
});

test("distinct refs tracked independently", () => {
  const d = new RefIDDedup();
  assert.equal(d.check("ref-a"), false);
  assert.equal(d.check("ref-b"), false);
  assert.equal(d.check("ref-a"), true);
  assert.equal(d.check("ref-b"), true);
});

test("FIFO eviction at maxEntries", () => {
  const d = new RefIDDedup(3);
  d.check("a");
  d.check("b");
  d.check("c");
  assert.equal(d.size(), 3);
  // Inserting a 4th evicts the oldest ("a").
  d.check("d");
  assert.equal(d.size(), 3);
  // "a" was evicted, so re-checking it returns false (treated as new).
  assert.equal(d.check("a"), false);
  // "b", "c", "d" should still be present — but "b" is now oldest after
  // "a"'s re-insertion. The critical property: evicted entries don't
  // dedup; unevicted ones do.
  assert.equal(d.check("c"), true);
  assert.equal(d.check("d"), true);
});

test("repeat of existing entry does not count as new insertion", () => {
  const d = new RefIDDedup(3);
  d.check("a");
  d.check("b");
  d.check("a"); // dup — must NOT push out anything
  d.check("c");
  assert.equal(d.size(), 3);
  // All three still present; no premature eviction from the duplicate.
  assert.equal(d.check("a"), true);
  assert.equal(d.check("b"), true);
  assert.equal(d.check("c"), true);
});

test("size() reflects current cache occupancy", () => {
  const d = new RefIDDedup(10);
  assert.equal(d.size(), 0);
  d.check("a");
  assert.equal(d.size(), 1);
  d.check("a"); // dup, no growth
  assert.equal(d.size(), 1);
  d.check("b");
  assert.equal(d.size(), 2);
});

test("custom maxEntries is respected", () => {
  const d = new RefIDDedup(2);
  d.check("a");
  d.check("b");
  assert.equal(d.size(), 2);
  d.check("c"); // evicts "a"
  assert.equal(d.size(), 2);
  // Careful: checking an evicted ref re-inserts it and evicts another.
  // Assert only on entries known to still be present.
  assert.equal(d.check("b"), true);
  assert.equal(d.check("c"), true);
});

test("1000 distinct entries stay bounded by default cap", () => {
  const d = new RefIDDedup(100);
  for (let i = 0; i < 1000; i++) {
    d.check(`ref-${i}`);
  }
  assert.equal(d.size(), 100);
  // Last 100 inserted (ref-900..ref-999) should still be present.
  // Don't probe evicted refs here — the probe itself re-inserts them and
  // perturbs the eviction window. Eviction-then-reappear is tested in the
  // FIFO test above.
  assert.equal(d.check("ref-900"), true);
  assert.equal(d.check("ref-999"), true);
});
