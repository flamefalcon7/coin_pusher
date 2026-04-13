// Package outbox implements the transactional-outbox drainer for NATS
// publishes. Rows are written to nats_outbox inside the same tx as the
// originating balance change (see accounting.OutboxWriter); this worker
// drains them with at-least-once semantics, publishes to NATS, and deletes
// on success. Failed rows stay for retry; rows past maxAttempts move to
// nats_outbox_dlq to prevent a single poison pill from blocking its subject.
//
// Trigger sources, in priority order:
//  1. Postgres LISTEN on channel "outbox_new" (fired by accounting after tx commit)
//  2. Fallback ticker (default 5s) — catches missed notifications, writer
//     crashes between commit and notify, listener reconnection gaps.
//
// Per-subject ordering: rows are fetched `ORDER BY subject, id` and processed
// per-subject; a publish failure in subject A does not block subjects B, C.
// Within a single subject, stop-on-fail preserves commit-order delivery.
//
// See docs/plans/2026-04-13-001-fix-batch-insert-outbox-plan.md.
package outbox

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"time"

	"github.com/jmoiron/sqlx"
	"github.com/lib/pq"
	"go.uber.org/zap"

	"github.com/flamefalcon/coin-pusher/backend/foundation/metrics"
)

// Publisher is the minimal NATS publish surface the drainer needs.
// *nats.Conn satisfies it natively. Split out so unit tests can inject a
// mock that controls success/failure without spinning up a real NATS server.
type Publisher interface {
	Publish(subject string, data []byte) error
}

// Config tunes the drainer. Zero values get sensible defaults via
// applyDefaults.
type Config struct {
	// FallbackTick is how often the drainer runs a safety-net drain pass
	// in the absence of LISTEN notifications. Default: 5 seconds.
	FallbackTick time.Duration

	// BatchSize caps how many rows a single drain pass reads. Default: 100.
	BatchSize int

	// MaxAttempts is the attempt_count threshold for DLQ exile. Default: 10.
	MaxAttempts int

	// ListenDSN is the Postgres connection string used for the long-lived
	// LISTEN connection (pq.NewListener needs its own conn, separate from
	// the sqlx pool). Required.
	ListenDSN string

	// NotifyChannel is the Postgres NOTIFY channel name. Default:
	// "outbox_new". Must match what accounting.Core fires after commit.
	NotifyChannel string

	// TableSizeRefresh is how often the outbox table size gauge is sampled
	// (pg_total_relation_size query). Default: 60 seconds.
	TableSizeRefresh time.Duration
}

func (c *Config) applyDefaults() {
	if c.FallbackTick <= 0 {
		c.FallbackTick = 5 * time.Second
	}
	if c.BatchSize <= 0 {
		c.BatchSize = 100
	}
	if c.MaxAttempts <= 0 {
		c.MaxAttempts = 10
	}
	if c.NotifyChannel == "" {
		c.NotifyChannel = "outbox_new"
	}
	if c.TableSizeRefresh <= 0 {
		c.TableSizeRefresh = 60 * time.Second
	}
}

// outboxRow is the internal shape read from nats_outbox during a drain pass.
type outboxRow struct {
	ID            int64     `db:"id"`
	Subject       string    `db:"subject"`
	Payload       []byte    `db:"payload"`
	ReferenceID   string    `db:"reference_id"`
	CreatedAt     time.Time `db:"created_at"`
	AttemptCount  int       `db:"attempt_count"`
}

// Run blocks until ctx is canceled. It establishes the LISTEN connection,
// spins up the fallback ticker, and loops forever draining the outbox. All
// errors are logged and recovered from — the only exit path is ctx
// cancellation.
func Run(ctx context.Context, db *sqlx.DB, nc Publisher, log *zap.SugaredLogger, cfg Config) error {
	cfg.applyDefaults()
	if cfg.ListenDSN == "" {
		return errors.New("outbox.Run: Config.ListenDSN is required")
	}

	// pq.NewListener ping interval (best-practice: 90s). Errors surface via
	// the eventCb; we log but don't stop the worker.
	listener := pq.NewListener(cfg.ListenDSN, 10*time.Second, 90*time.Second, func(ev pq.ListenerEventType, err error) {
		if err != nil {
			log.Warnw("outbox listener event", "event", ev, "error", err)
		}
	})
	defer listener.Close()

	if err := listener.Listen(cfg.NotifyChannel); err != nil {
		return fmt.Errorf("outbox.Run: LISTEN %s: %w", cfg.NotifyChannel, err)
	}
	log.Infow("outbox drainer started",
		"channel", cfg.NotifyChannel,
		"fallback_tick", cfg.FallbackTick,
		"batch_size", cfg.BatchSize,
		"max_attempts", cfg.MaxAttempts,
	)

	fallback := time.NewTicker(cfg.FallbackTick)
	defer fallback.Stop()
	sizeTicker := time.NewTicker(cfg.TableSizeRefresh)
	defer sizeTicker.Stop()

	// One eager drain on start — catches anything backlogged while the
	// worker was down.
	runDrainPass(ctx, db, nc, log, cfg)

	for {
		select {
		case <-ctx.Done():
			log.Infow("outbox drainer stopping", "reason", ctx.Err())
			return nil

		case <-listener.Notify:
			// nil notify can arrive on listener reconnect — treat as a nudge
			// to force-drain (we may have missed notifies during the gap).
			runDrainPass(ctx, db, nc, log, cfg)

		case <-fallback.C:
			runDrainPass(ctx, db, nc, log, cfg)

		case <-sizeTicker.C:
			refreshTableSizeGauge(ctx, db, log)
		}
	}
}

// runDrainPass wraps drainOnce with panic recovery. A single bad row or
// transient glitch must not kill the drainer goroutine.
func runDrainPass(ctx context.Context, db *sqlx.DB, nc Publisher, log *zap.SugaredLogger, cfg Config) {
	defer func() {
		if r := recover(); r != nil {
			log.Errorw("outbox drainer panic recovered", "panic", r)
		}
		metrics.OutboxLastTickTimestamp.SetToCurrentTime()
	}()

	if err := drainOnce(ctx, db, nc, log, cfg); err != nil {
		log.Warnw("outbox drain pass error", "error", err)
	}
}

// drainOnce runs a single drain pass. Returns error only for unexpected
// infra failures (SELECT can't run, etc.). Per-row publish failures are
// handled inline and do not abort the pass.
func drainOnce(ctx context.Context, db *sqlx.DB, nc Publisher, log *zap.SugaredLogger, cfg Config) error {
	const selectQ = `
		SELECT id, subject, payload, reference_id, created_at, attempt_count
		FROM nats_outbox
		WHERE attempt_count < $1
		ORDER BY subject, id
		LIMIT $2`

	var rows []outboxRow
	if err := db.SelectContext(ctx, &rows, selectQ, cfg.MaxAttempts, cfg.BatchSize); err != nil {
		return fmt.Errorf("select outbox rows: %w", err)
	}

	// Update pending-count and oldest-age gauges. Pending count shown is
	// this-batch lower-bound; for a real total we'd need a separate COUNT —
	// fine for now since alerts care about "is this growing" more than
	// exact value at an instant.
	metrics.OutboxPendingRows.Set(float64(len(rows)))
	if len(rows) > 0 {
		oldest := rows[0].CreatedAt
		for _, r := range rows {
			if r.CreatedAt.Before(oldest) {
				oldest = r.CreatedAt
			}
		}
		metrics.OutboxOldestPendingSeconds.Set(time.Since(oldest).Seconds())
	} else {
		metrics.OutboxOldestPendingSeconds.Set(0)
	}

	if len(rows) == 0 {
		return nil
	}

	// Group rows by subject. Rows are already ORDER BY subject,id so runs of
	// same subject are contiguous.
	successIDs := make([]int64, 0, len(rows))
	i := 0
	for i < len(rows) {
		subj := rows[i].Subject
		j := i
		for j < len(rows) && rows[j].Subject == subj {
			j++
		}
		subjRows := rows[i:j]
		i = j

		// Process this subject's rows in id order. Stop at first publish
		// failure to preserve per-subject ordering.
		publishedInSubject, dlqInSubject := processSubject(ctx, db, nc, log, cfg, subjRows)
		successIDs = append(successIDs, publishedInSubject...)
		_ = dlqInSubject // already logged + metered inline
	}

	// Batch-delete all successfully published rows.
	if len(successIDs) > 0 {
		if _, err := db.ExecContext(ctx,
			`DELETE FROM nats_outbox WHERE id = ANY($1)`,
			pq.Array(successIDs),
		); err != nil {
			// Rows stay in outbox → next drain pass re-publishes (duplicate
			// delivery, game server dedups on reference_id).
			return fmt.Errorf("delete published rows: %w", err)
		}
		metrics.OutboxPublishedTotal.Add(float64(len(successIDs)))
	}

	return nil
}

// processSubject iterates rows for a single subject in id order, publishing
// each. On the first failure, it either bumps attempt_count or exiles to
// DLQ, then returns — subsequent rows in this subject stay for the next
// pass so order is preserved.
//
// Returns (publishedIDs, dlqedIDs) for caller's bookkeeping.
func processSubject(
	ctx context.Context,
	db *sqlx.DB,
	nc Publisher,
	log *zap.SugaredLogger,
	cfg Config,
	rows []outboxRow,
) ([]int64, []int64) {
	var published, dlqed []int64
	for _, r := range rows {
		if err := nc.Publish(r.Subject, r.Payload); err != nil {
			// Publish failure: update attempt state or exile to DLQ.
			newAttempts := r.AttemptCount + 1
			metrics.OutboxPublishErrors.Inc()
			log.Warnw("outbox publish failed",
				"id", r.ID, "subject", r.Subject,
				"attempts", newAttempts, "error", err,
			)

			if newAttempts >= cfg.MaxAttempts {
				if dlqErr := moveToDLQ(ctx, db, r, err.Error()); dlqErr != nil {
					log.Errorw("outbox DLQ move failed — row stays and will retry",
						"id", r.ID, "error", dlqErr,
					)
				} else {
					metrics.OutboxDLQTotal.Inc()
					dlqed = append(dlqed, r.ID)
					log.Errorw("outbox row exiled to DLQ",
						"id", r.ID, "subject", r.Subject, "attempts", newAttempts,
					)
					// Subject is unblocked now. But we still stop here for this
					// pass — next pass (immediately triggered by NOTIFY from
					// newer writes, or within FallbackTick) picks up continuations.
				}
			} else {
				if upErr := bumpAttempt(ctx, db, r.ID, newAttempts, err.Error()); upErr != nil {
					log.Warnw("outbox attempt bump failed — row will be retried in place",
						"id", r.ID, "error", upErr,
					)
				}
			}
			return published, dlqed
		}
		published = append(published, r.ID)
	}
	return published, dlqed
}

func bumpAttempt(ctx context.Context, db *sqlx.DB, id int64, newCount int, lastErr string) error {
	const q = `
		UPDATE nats_outbox
		SET attempt_count = $1, last_error = $2, last_attempted_at = NOW()
		WHERE id = $3`
	_, err := db.ExecContext(ctx, q, newCount, lastErr, id)
	return err
}

func moveToDLQ(ctx context.Context, db *sqlx.DB, r outboxRow, lastErr string) error {
	// Single tx: copy into DLQ + delete from outbox. If either fails the
	// whole move is rolled back and the row stays for next-pass retry.
	tx, err := db.BeginTxx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin dlq tx: %w", err)
	}
	defer tx.Rollback() //nolint:errcheck // rollback is no-op after commit

	const insQ = `
		INSERT INTO nats_outbox_dlq (
			original_id, subject, payload, reference_id,
			created_at, attempt_count, last_error, last_attempted_at,
			payload_version, dlq_reason
		) VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), 1, $8)`
	newAttempts := r.AttemptCount + 1
	if _, err := tx.ExecContext(ctx, insQ,
		r.ID, r.Subject, r.Payload, r.ReferenceID,
		r.CreatedAt, newAttempts, lastErr,
		fmt.Sprintf("attempt_count=%d >= max", newAttempts),
	); err != nil {
		return fmt.Errorf("insert dlq: %w", err)
	}

	if _, err := tx.ExecContext(ctx, `DELETE FROM nats_outbox WHERE id = $1`, r.ID); err != nil {
		return fmt.Errorf("delete from outbox: %w", err)
	}

	return tx.Commit()
}

// refreshTableSizeGauge samples the total size of nats_outbox via
// pg_total_relation_size. Cheap query but there's no need to run it every
// drain pass.
func refreshTableSizeGauge(ctx context.Context, db *sqlx.DB, log *zap.SugaredLogger) {
	const q = `SELECT pg_total_relation_size('nats_outbox')`
	var sz int64
	if err := db.GetContext(ctx, &sz, q); err != nil {
		// Not fatal — table may not exist in tests, or permissions could be
		// off. Log once-in-a-while and move on.
		if !errors.Is(err, sql.ErrNoRows) {
			log.Debugw("outbox table size query failed", "error", err)
		}
		return
	}
	metrics.OutboxTableBytes.Set(float64(sz))
}
