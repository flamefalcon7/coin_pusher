import client from "prom-client";

// Collect default Node.js metrics (memory, CPU, event loop, GC)
client.collectDefaultMetrics({ prefix: "coinpusher_" });

// ── Tick timing ──────────────────────────────────────────────────────

export const tickDuration = new client.Histogram({
  name: "coinpusher_game_tick_duration_seconds",
  help: "Total game tick duration in seconds.",
  buckets: [0.001, 0.005, 0.01, 0.015, 0.02, 0.025, 0.03, 0.033, 0.04, 0.05, 0.1],
});

export const tickPhaseDuration = new client.Histogram({
  name: "coinpusher_game_tick_phase_seconds",
  help: "Per-phase tick duration in seconds.",
  labelNames: ["phase"] as const,
  buckets: [0.0001, 0.0005, 0.001, 0.002, 0.005, 0.01, 0.02, 0.033],
});

// Ticks that threw and were contained by the game loop's guard. Any non-zero
// value means the simulation lost a frame of work; a sustained rate means the
// loop is limping and the cause needs finding, not just absorbing.
export const tickErrorsTotal = new client.Counter({
  name: "coinpusher_game_tick_errors_total",
  help: "Total game ticks that threw and were contained by the tick guard.",
});

// Coins evicted by the post-error sweep because their rigid body no longer
// answers. These are the stale references that would otherwise re-throw on
// every subsequent tick.
export const coinsEvictedOnError = new client.Counter({
  name: "coinpusher_coins_evicted_on_error_total",
  help: "Total coins removed by the tick-error recovery sweep.",
});

// Spawn requests refused because the table is at MAX_ACTIVE_COINS (or the
// position was out of range). Rising values mean the room is saturated and
// players are being told "no" — a capacity signal, not an error.
export const coinSpawnsRejected = new client.Counter({
  name: "coinpusher_coin_spawns_rejected_total",
  help: "Total coin spawn requests rejected, by source.",
  labelNames: ["source"] as const,
});

// ── Coin gauges ──────────────────────────────────────────────────────

export const coinsActive = new client.Gauge({
  name: "coinpusher_coins_active",
  help: "Number of active (non-sleeping) coins on the platform.",
});

export const coinsSleeping = new client.Gauge({
  name: "coinpusher_coins_sleeping",
  help: "Number of sleeping coins on the platform.",
});

export const coinsDespawned = new client.Counter({
  name: "coinpusher_coins_despawned_total",
  help: "Total coins despawned by zone.",
  labelNames: ["zone"] as const,
});

// ── Game mechanics ───────────────────────────────────────────────────

export const slotCounter = new client.Gauge({
  name: "coinpusher_slot_counter",
  help: "Current slot machine coin counter.",
});

export const wheelCounter = new client.Gauge({
  name: "coinpusher_wheel_counter",
  help: "Current jackpot wheel coin counter.",
});

export const slotSpinsTotal = new client.Counter({
  name: "coinpusher_slot_spins_total",
  help: "Total slot machine spins triggered.",
});

export const wheelSpinsTotal = new client.Counter({
  name: "coinpusher_wheel_spins_total",
  help: "Total jackpot wheel spins triggered.",
});

// ── NATS publish metrics ─────────────────────────────────────────────

export const natsPublishTotal = new client.Counter({
  name: "coinpusher_nats_publish_total",
  help: "Total NATS publishes by topic.",
  labelNames: ["topic"] as const,
});

export const natsPublishErrors = new client.Counter({
  name: "coinpusher_nats_publish_errors_total",
  help: "Total NATS publish errors by topic.",
  labelNames: ["topic"] as const,
});

// Batch-insert commands dropped because reference_id was recently seen in the
// game-server dedup cache. Non-zero is expected (outbox drainer retries); a
// sustained spike signals the drainer is aggressively retrying a subject that
// isn't ack-visible, which may indicate NATS-level issues.
export const batchInsertDuplicatesSuppressed = new client.Counter({
  name: "coinpusher_batch_insert_duplicates_suppressed_total",
  help: "Total batch_insert commands dropped due to reference_id dedup (outbox retry protection).",
});

// ── Abilities ────────────────────────────────────────────────────────

export const tornadoActive = new client.Gauge({
  name: "coinpusher_tornado_active",
  help: "Whether a tornado is currently active (0 or 1).",
});

export const lightningActive = new client.Gauge({
  name: "coinpusher_lightning_active",
  help: "Whether a lightning storm is currently active (0 or 1).",
});

// ── Metrics HTTP server ──────────────────────────────────────────────

import http from "node:http";

export function startMetricsServer(port: number = 9100): void {
  const server = http.createServer(async (req, res) => {
    if (req.url === "/metrics") {
      try {
        res.setHeader("Content-Type", client.register.contentType);
        res.end(await client.register.metrics());
      } catch (err) {
        res.statusCode = 500;
        res.end("Error collecting metrics");
        console.error("Metrics collection error:", err);
      }
    } else {
      res.statusCode = 404;
      res.end("Not Found");
    }
  });

  server.listen(port, () => {
    console.log(`Metrics server listening on :${port}`);
  });
}
