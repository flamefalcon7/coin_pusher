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
