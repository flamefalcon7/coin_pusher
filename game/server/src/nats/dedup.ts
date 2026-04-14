// Reference-ID based dedup cache for batch_insert.
//
// The Go backend writes batch_insert events to a Postgres outbox inside the
// same tx as the balance debit, then a worker publishes to NATS with
// at-least-once semantics. A retry after a transient publish failure can
// therefore deliver the same reference_id twice to this game server.
// Without dedup, the second delivery would apply the batch a second time —
// spawning phantom coins for which the player was debited once.
//
// Dedup is keyed on reference_id. Empty / missing reference_id bypasses the
// cache (no dedup possible) so legacy publishes during a rolling deploy still
// work. Cache is a fixed-size FIFO; retry windows are seconds, so 10k entries
// covers any realistic burst + retry horizon for this workload.

const DEFAULT_MAX_ENTRIES = 10_000;

export class RefIDDedup {
  // Set preserves insertion order per ES2015+, so the first value yielded by
  // .values() / .keys() is always the oldest insertion. We rely on that for
  // FIFO eviction. No counter needed — the Set itself is the queue.
  private readonly seen = new Set<string>();

  constructor(private readonly maxEntries: number = DEFAULT_MAX_ENTRIES) {}

  // Returns true if this reference_id was already seen (= duplicate, drop it).
  // Empty / undefined reference_id always returns false.
  //
  // Defensive runtime type check: the NATS payload is unvalidated JSON, so a
  // non-string value (e.g., null from a backend bug) would bypass dedup via
  // falsy-check and silently admit a duplicate. Treat anything non-string as
  // "no reference_id" rather than throwing — unknown shape is a bypass, not
  // a crash.
  check(refID: string | undefined): boolean {
    if (typeof refID !== "string" || refID.length === 0) return false;
    if (this.seen.has(refID)) return true;
    this.seen.add(refID);
    if (this.seen.size > this.maxEntries) {
      const oldest = this.seen.values().next().value;
      if (oldest !== undefined) this.seen.delete(oldest);
    }
    return false;
  }

  size(): number {
    return this.seen.size;
  }
}
