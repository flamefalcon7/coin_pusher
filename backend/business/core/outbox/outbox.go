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

// NotifyChannel is the Postgres LISTEN/NOTIFY channel name shared by the
// outbox drainer (listen side) and the accounting core (notify-after-commit
// side). Centralized here so both sides can never silently diverge on the
// channel name — any change must touch this one const.
const NotifyChannel = "outbox_new"

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

	// NotifyChannel overrides the default LISTEN channel (outbox.NotifyChannel).
	// Typically left unset — test overrides only. Production should rely on
	// the shared package-level const so the listen and notify sides cannot
	// diverge via misconfiguration.
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
		c.NotifyChannel = NotifyChannel
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
			metrics.OutboxPanics.Inc()
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
//
// Fairness: the SELECT uses ROW_NUMBER() OVER (PARTITION BY subject) to
// interleave rows across subjects. This closes the starvation class
// flagged in ce:review — a high-volume subject's backlog cannot consume
// the entire BatchSize budget and starve other subjects. Within a
// subject, rows arrive in id order, preserving per-subject ordering.
//
// Ordering note: `ORDER BY id` gives insert-order, NOT commit-order —
// BIGSERIAL allocates at INSERT (non-transactional), so two concurrent
// writers' ids may land in a different order than their tx commits.
// For this codebase's use case (batch_insert per game room, game server
// dedups on reference_id) insert-order is sufficient.
func drainOnce(ctx context.Context, db *sqlx.DB, nc Publisher, log *zap.SugaredLogger, cfg Config) error {
	// Round-robin across subjects via ROW_NUMBER(). rn=1 is the oldest
	// row in each subject; rn=2 the second-oldest; etc. ORDER BY rn, id
	// then pulls one row from each subject before taking the second row
	// of any subject. LIMIT caps the total per pass.
	const selectQ = `
		WITH ranked AS (
			SELECT id, subject, payload, reference_id, created_at, attempt_count,
			       ROW_NUMBER() OVER (PARTITION BY subject ORDER BY id) AS rn
			FROM nats_outbox
			WHERE attempt_count < $1
		)
		SELECT id, subject, payload, reference_id, created_at, attempt_count
		FROM ranked
		ORDER BY rn, id
		LIMIT $2`

	var rows []outboxRow
	if err := db.SelectContext(ctx, &rows, selectQ, cfg.MaxAttempts, cfg.BatchSize); err != nil {
		return fmt.Errorf("select outbox rows: %w", err)
	}

	// Update pending-count and oldest-age gauges. Pending count is the
	// this-batch lower-bound (capped at BatchSize); for a true queue-depth
	// signal rely on oldest_pending_seconds. Keeping both lets dashboards
	// distinguish "drainer is making progress" (low pending + low age) from
	// "backlog exists behind the batch ceiling" (pending==BatchSize + age>0).
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

	// Group rows by subject in memory so a publish failure in one subject
	// doesn't block progress on OTHER subjects in the same batch. Selecting
	// with ORDER BY id (not subject, id) ensures a high-volume subject at
	// the alphabetical head can't starve later-alphabet subjects — this
	// closes the LIMIT-100 starvation finding flagged in ce:review.
	//
	// Within a subject, rows stay in id order (subsequences of the id-sorted
	// rows), so per-subject stop-on-fail preserves per-subject ordering.
	bySubject := make(map[string][]outboxRow, 4)
	subjectOrder := make([]string, 0, 4)
	for _, r := range rows {
		if _, seen := bySubject[r.Subject]; !seen {
			subjectOrder = append(subjectOrder, r.Subject)
		}
		bySubject[r.Subject] = append(bySubject[r.Subject], r)
	}

	successIDs := make([]int64, 0, len(rows))
	for _, subj := range subjectOrder {
		// Process this subject's rows in id order. Stop at first publish
		// failure to preserve per-subject ordering.
		publishedInSubject := processSubject(ctx, db, nc, log, cfg, bySubject[subj])
		successIDs = append(successIDs, publishedInSubject...)
	}

	// Batch-delete all successfully published rows.
	if len(successIDs) > 0 {
		if _, err := db.ExecContext(ctx,
			`DELETE FROM nats_outbox WHERE id = ANY($1)`,
			pq.Array(successIDs),
		); err != nil {
			// Rows stay in outbox → next drain pass re-publishes (duplicate
			// delivery, game server dedups on reference_id). Metric surfaces
			// the sustained-DELETE-failure state so ops can act before the
			// duplicate-delivery rate overwhelms dedup cache capacity.
			metrics.OutboxDeleteErrors.Inc()
			return fmt.Errorf("delete published rows: %w", err)
		}
		metrics.OutboxPublishedTotal.Add(float64(len(successIDs)))
	}

	return nil
}

// processSubject iterates rows for a single subject in id order, publishing
// each. On the first failure, it either bumps attempt_count or exiles to
// DLQ, then returns — subsequent rows in this subject stay for the next
// pass so order is preserved. DLQ exile increments metrics inline so the
// caller does not need a second return value.
func processSubject(
	ctx context.Context,
	db *sqlx.DB,
	nc Publisher,
	log *zap.SugaredLogger,
	cfg Config,
	rows []outboxRow,
) []int64 {
	var published []int64
	for _, r := range rows {
		if err := nc.Publish(r.Subject, r.Payload); err != nil {
			// Publish failure: update attempt state or exile to DLQ.
			newAttempts := r.AttemptCount + 1
			metrics.OutboxPublishErrors.Inc()
			log.Warnw("outbox publish failed",
				"id", r.ID, "subject", r.Subject,
				"attempts", newAttempts, "error", err,
			)

			// Use a detached context for retry-state writes so a shutdown
			// mid-drain cannot rewind attempt_count via ctx.Canceled.
			// Without this, rel-003 bites: SIGTERM during a NATS outage
			// → bumpAttempt UPDATE fails with ctx.Canceled → attempt_count
			// stays stale → row looks fresh to the next pod → it never
			// exiles to DLQ → the subject wedges indefinitely.
			stateCtx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
			if newAttempts >= cfg.MaxAttempts {
				if dlqErr := moveToDLQ(stateCtx, db, r, err.Error()); dlqErr != nil {
					log.Errorw("outbox DLQ move failed — row stays and will retry",
						"id", r.ID, "error", dlqErr,
					)
				} else {
					metrics.OutboxDLQTotal.Inc()
					log.Errorw("outbox row exiled to DLQ",
						"id", r.ID, "subject", r.Subject, "attempts", newAttempts,
					)
					// Subject is unblocked now. But we still stop here for this
					// pass — next pass (immediately triggered by NOTIFY from
					// newer writes, or within FallbackTick) picks up continuations.
				}
			} else {
				if upErr := bumpAttempt(stateCtx, db, r.ID, newAttempts, err.Error()); upErr != nil {
					// attempt_count didn't advance → the row will retry with
					// the same count forever if this keeps failing, and the
					// subject stays blocked by stop-on-fail. Surface via
					// metric so ops notice before the subject fully wedges.
					metrics.OutboxBumpErrors.Inc()
					log.Warnw("outbox attempt bump failed — row will be retried in place",
						"id", r.ID, "error", upErr,
					)
				}
			}
			cancel()
			return published
		}
		published = append(published, r.ID)
	}
	return published
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
