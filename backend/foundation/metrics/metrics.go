package metrics

import (
	"database/sql"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"
)

// HTTP metrics
var (
	HTTPRequestsTotal = promauto.NewCounterVec(prometheus.CounterOpts{
		Name: "coinpusher_http_requests_total",
		Help: "Total HTTP requests by method, path pattern, and status code.",
	}, []string{"method", "path", "status"})

	HTTPRequestDuration = promauto.NewHistogramVec(prometheus.HistogramOpts{
		Name:    "coinpusher_http_request_duration_seconds",
		Help:    "HTTP request duration in seconds.",
		Buckets: prometheus.DefBuckets,
	}, []string{"method", "path"})
)

// WebSocket metrics
var (
	WSConnectionsActive = promauto.NewGauge(prometheus.GaugeOpts{
		Name: "coinpusher_ws_connections_active",
		Help: "Number of active WebSocket connections.",
	})

	WSSendBufferOverflow = promauto.NewCounter(prometheus.CounterOpts{
		Name: "coinpusher_ws_send_buffer_overflow_total",
		Help: "Number of dropped messages due to full send buffer.",
	})

	WSMessagesReceived = promauto.NewCounterVec(prometheus.CounterOpts{
		Name: "coinpusher_ws_messages_received_total",
		Help: "Total WebSocket messages received by operation.",
	}, []string{"op"})

	WSRateLimit = promauto.NewCounterVec(prometheus.CounterOpts{
		Name: "coinpusher_ws_rate_limit_total",
		Help: "Rate-limited WebSocket messages by ability type.",
	}, []string{"ability"})

	AbilityUsageTotal = promauto.NewCounterVec(prometheus.CounterOpts{
		Name: "coinpusher_ability_usage_total",
		Help: "Successful ability uses by type.",
	}, []string{"ability"})

	MegaspeakerTotal = promauto.NewCounter(prometheus.CounterOpts{
		Name: "coinpusher_megaspeaker_total",
		Help: "Total megaspeaker messages sent.",
	})

	BatchInsertCoins = promauto.NewCounter(prometheus.CounterOpts{
		Name: "coinpusher_batch_insert_coins_total",
		Help: "Total coins accepted via batch insert.",
	})
)

// NATS metrics
var (
	NATSDisconnects = promauto.NewCounter(prometheus.CounterOpts{
		Name: "coinpusher_nats_disconnects_total",
		Help: "Number of NATS disconnections.",
	})

	NATSReconnects = promauto.NewCounter(prometheus.CounterOpts{
		Name: "coinpusher_nats_reconnects_total",
		Help: "Number of NATS reconnections.",
	})
)

// Database pool metrics
var (
	DBPoolInUse = promauto.NewGauge(prometheus.GaugeOpts{
		Name: "coinpusher_db_pool_in_use",
		Help: "Number of database connections in use.",
	})

	DBPoolIdle = promauto.NewGauge(prometheus.GaugeOpts{
		Name: "coinpusher_db_pool_idle",
		Help: "Number of idle database connections.",
	})

	DBPoolMaxOpen = promauto.NewGauge(prometheus.GaugeOpts{
		Name: "coinpusher_db_pool_max_open",
		Help: "Maximum number of open database connections.",
	})

	DBPoolWaitCount = promauto.NewGauge(prometheus.GaugeOpts{
		Name: "coinpusher_db_pool_wait_count",
		Help: "Total number of waits for a database connection.",
	})
)

// Worker metrics
var (
	WorkerRuns = promauto.NewCounterVec(prometheus.CounterOpts{
		Name: "coinpusher_worker_runs_total",
		Help: "Total worker tick runs by worker name.",
	}, []string{"worker"})

	WorkerDuration = promauto.NewHistogramVec(prometheus.HistogramOpts{
		Name:    "coinpusher_worker_duration_seconds",
		Help:    "Worker tick duration by worker name.",
		Buckets: prometheus.DefBuckets,
	}, []string{"worker"})

	WorkerErrors = promauto.NewCounterVec(prometheus.CounterOpts{
		Name: "coinpusher_worker_errors_total",
		Help: "Total worker errors by worker name.",
	}, []string{"worker"})
)

// Reward metrics
var (
	RewardFlushTotal = promauto.NewCounter(prometheus.CounterOpts{
		Name: "coinpusher_reward_flush_total",
		Help: "Total reward flush operations.",
	})

	RewardFlushErrors = promauto.NewCounter(prometheus.CounterOpts{
		Name: "coinpusher_reward_flush_errors_total",
		Help: "Total reward flush errors.",
	})

	KeyCoinDrawTotal = promauto.NewCounter(prometheus.CounterOpts{
		Name: "coinpusher_key_coin_draw_total",
		Help: "Total key coin lucky draws.",
	})
)

// Alerting metrics — financial integrity and business logic breakpoints.
var (
	BatchInsertRefundFailures = promauto.NewCounter(prometheus.CounterOpts{
		Name: "coinpusher_batch_insert_refund_failures_total",
		Help: "Batch insert NATS publish failed AND refund also failed — coins lost.",
	})

	WithdrawalRefundErrors = promauto.NewCounter(prometheus.CounterOpts{
		Name: "coinpusher_withdrawal_refund_errors_total",
		Help: "Failed attempts to refund a failed on-chain withdrawal.",
	})

	AuthFailures = promauto.NewCounterVec(prometheus.CounterOpts{
		Name: "coinpusher_auth_failures_total",
		Help: "Authentication failures by reason.",
	}, []string{"reason"})

	WSSnapshotTimeout = promauto.NewCounter(prometheus.CounterOpts{
		Name: "coinpusher_ws_snapshot_timeout_total",
		Help: "Snapshot requests that timed out (new client sees empty game).",
	})

	HeatActivePlayers = promauto.NewGauge(prometheus.GaugeOpts{
		Name: "coinpusher_heat_active_players",
		Help: "Number of active players in heat engine (heat > threshold).",
	})

	ProgressMetricErrors = promauto.NewCounter(prometheus.CounterOpts{
		Name: "coinpusher_progress_metric_errors_total",
		Help: "Failed progress metric recordings (achievement tracking broken).",
	})
)

// Outbox drainer metrics — transactional-outbox publish path observability.
// See docs/plans/2026-04-13-001-fix-batch-insert-outbox-plan.md.
var (
	OutboxPublishedTotal = promauto.NewCounter(prometheus.CounterOpts{
		Name: "coinpusher_outbox_published_total",
		Help: "Total nats_outbox rows successfully published to NATS and deleted.",
	})

	OutboxPublishErrors = promauto.NewCounter(prometheus.CounterOpts{
		Name: "coinpusher_outbox_publish_errors_total",
		Help: "Total nats_outbox rows that failed to publish on a given drain pass (row is retained for retry).",
	})

	OutboxDLQTotal = promauto.NewCounter(prometheus.CounterOpts{
		Name: "coinpusher_outbox_dlq_total",
		Help: "Total rows exiled to nats_outbox_dlq after exceeding attempt_count threshold.",
	})

	OutboxPendingRows = promauto.NewGauge(prometheus.GaugeOpts{
		Name: "coinpusher_outbox_pending_rows",
		Help: "Current count of rows in nats_outbox with attempt_count < 10 (drainable backlog).",
	})

	OutboxOldestPendingSeconds = promauto.NewGauge(prometheus.GaugeOpts{
		Name: "coinpusher_outbox_oldest_pending_seconds",
		Help: "Age of the oldest drainable row in nats_outbox, in seconds.",
	})

	OutboxLastTickTimestamp = promauto.NewGauge(prometheus.GaugeOpts{
		Name: "coinpusher_outbox_last_tick_timestamp",
		Help: "Unix timestamp of the last drainer loop iteration (liveness signal).",
	})

	OutboxTableBytes = promauto.NewGauge(prometheus.GaugeOpts{
		Name: "coinpusher_outbox_table_bytes",
		Help: "Size of nats_outbox table in bytes (via pg_total_relation_size).",
	})

	// OutboxNotifyErrors counts best-effort `NOTIFY outbox_new` failures
	// fired from accounting.ProcessGameInsert after commit. Not load-bearing
	// (drainer fallback tick catches missed notifies), but a sustained
	// non-zero rate signals pool saturation or a slow-NOTIFY Postgres state
	// that would otherwise go silent.
	OutboxNotifyErrors = promauto.NewCounter(prometheus.CounterOpts{
		Name: "coinpusher_outbox_notify_errors_total",
		Help: "Post-commit NOTIFY outbox_new calls that failed; drainer fallback tick handles recovery.",
	})

	// OutboxPanics counts drainer-goroutine panics recovered by the loop's
	// defer. Should stay at 0. Any increment is a code bug to investigate.
	OutboxPanics = promauto.NewCounter(prometheus.CounterOpts{
		Name: "coinpusher_outbox_panics_total",
		Help: "Drainer goroutine panics recovered by defer; normally 0.",
	})

	// OutboxDeleteErrors counts failures of the batched DELETE-after-publish
	// statement. Rows stay in nats_outbox → next drain pass re-publishes;
	// game server dedups on reference_id. Non-zero means we are actively
	// relying on consumer dedup — worth an investigation.
	OutboxDeleteErrors = promauto.NewCounter(prometheus.CounterOpts{
		Name: "coinpusher_outbox_delete_errors_total",
		Help: "Batched DELETE of successfully-published rows failed; at-least-once duplicates expected on next pass.",
	})

	// OutboxBumpErrors counts failures of the attempt_count UPDATE after a
	// publish failure. Critical: if bumpAttempt fails persistently, a poison
	// row's attempt_count never advances, it never reaches MaxAttempts, never
	// exiles to DLQ, and its subject stays blocked indefinitely. This
	// counter is how that failure mode surfaces.
	OutboxBumpErrors = promauto.NewCounter(prometheus.CounterOpts{
		Name: "coinpusher_outbox_bump_errors_total",
		Help: "attempt_count UPDATE failures after publish failure; row retry state may be stuck.",
	})
)

// Bot scheduler metrics — observability for the play-bot Scheduler goroutine
// (see backend/business/core/bot/scheduler.go and
// docs/plans/2026-04-16-001-feat-play-bot-plan.md, Unit 5).
//
// All counters are house-flow safety signals: BotInsertFailureTotal /
// BotInsertPanicTotal sustained increments indicate the scheduler is failing
// to write inserts but not crashing — silent house drain risk. BotOutboxStalled
// at 1 means scheduler proactively skipped insert work to avoid amplifying an
// existing outbox backlog. BotRefillDailyCapRemaining alertable to surface
// runaway refill loops before they exhaust the daily cap.
var (
	BotActiveCount = promauto.NewGauge(prometheus.GaugeOpts{
		Name: "coinpusher_bot_active_count",
		Help: "Number of bots currently flagged online by the scheduler.",
	})

	BotInsertTotalPlay = promauto.NewCounter(prometheus.CounterOpts{
		Name: "coinpusher_bot_insert_total_play",
		Help: "Cumulative PLAY coins inserted by bots via scheduler ticks.",
	})

	BotRewardTotalCash = promauto.NewCounter(prometheus.CounterOpts{
		Name: "coinpusher_bot_reward_total_cash",
		Help: "Cumulative CASH coins credited to bot accounts via heat reward distribution.",
	})

	BotRefillTotalPlay = promauto.NewCounter(prometheus.CounterOpts{
		Name: "coinpusher_bot_refill_total_play",
		Help: "Cumulative PLAY coins issued via BOT_REFILL by the scheduler.",
	})

	BotRefillDailyCapRemaining = promauto.NewGauge(prometheus.GaugeOpts{
		Name: "coinpusher_bot_refill_daily_cap_remaining",
		Help: "Remaining headroom under the configured daily bot refill cap (PLAY).",
	})

	BotInsertFailureTotal = promauto.NewCounter(prometheus.CounterOpts{
		Name: "coinpusher_bot_insert_failure_total",
		Help: "Bot insert attempts that returned an error from gameCore.ProcessBatchInsert.",
	})

	BotInsertPanicTotal = promauto.NewCounter(prometheus.CounterOpts{
		Name: "coinpusher_bot_insert_panic_total",
		Help: "Bot insert attempts where the scheduler recovered from a panic.",
	})

	BotOutboxStalled = promauto.NewGauge(prometheus.GaugeOpts{
		Name: "coinpusher_bot_outbox_stalled",
		Help: "1 when scheduler is skipping inserts due to nats_outbox backlog or stale rows; 0 otherwise.",
	})
)

// RTP monitoring metrics
var (
	RTPRatio = promauto.NewGaugeVec(prometheus.GaugeOpts{
		Name: "coinpusher_rtp_ratio",
		Help: "Return-to-player ratio (cash rewarded / play inserted) by time window.",
	}, []string{"window"})

	RTPCoinsInserted = promauto.NewGaugeVec(prometheus.GaugeOpts{
		Name: "coinpusher_rtp_coins_inserted",
		Help: "Total play coins inserted in time window.",
	}, []string{"window"})

	RTPCoinsRewarded = promauto.NewGaugeVec(prometheus.GaugeOpts{
		Name: "coinpusher_rtp_coins_rewarded",
		Help: "Total cash coins rewarded in time window.",
	}, []string{"window"})

	RTPPlayerAnomalyCount = promauto.NewGauge(prometheus.GaugeOpts{
		Name: "coinpusher_rtp_player_anomaly_count",
		Help: "Number of players with abnormally high RTP in the analysis window.",
	})
)

// StartDBCollector starts a goroutine that periodically collects DB pool stats.
func StartDBCollector(db *sql.DB, interval time.Duration) {
	go func() {
		ticker := time.NewTicker(interval)
		defer ticker.Stop()
		for range ticker.C {
			stats := db.Stats()
			DBPoolInUse.Set(float64(stats.InUse))
			DBPoolIdle.Set(float64(stats.Idle))
			DBPoolMaxOpen.Set(float64(stats.MaxOpenConnections))
			DBPoolWaitCount.Set(float64(stats.WaitCount))
		}
	}()
}
