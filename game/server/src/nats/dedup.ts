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
  private readonly seen = new Map<string, number>();
  private counter = 0;

  constructor(private readonly maxEntries: number = DEFAULT_MAX_ENTRIES) {}

  // Returns true if this reference_id was already seen (= duplicate, drop it).
  // Empty / undefined reference_id always returns false.
  check(refID: string | undefined): boolean {
    if (!refID) return false;
    if (this.seen.has(refID)) return true;
    this.seen.set(refID, this.counter++);
    if (this.seen.size > this.maxEntries) {
      // Map preserves insertion order — first key is oldest.
      const oldest = this.seen.keys().next().value;
      if (oldest !== undefined) this.seen.delete(oldest);
    }
    return false;
  }

  size(): number {
    return this.seen.size;
  }
}
