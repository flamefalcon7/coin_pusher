// Admin subcommands for the transactional outbox (nats_outbox) and its
// dead-letter queue (nats_outbox_dlq). These exist so operators and agents
// can respond to outbox-related alerts (P1_OutboxDLQGrowth,
// P0_OutboxOldestPending, P1_OutboxBumpErrors) without needing raw psql
// access — every must-have operator action has a CLI surface here.
//
// See docs/plans/2026-04-13-001-fix-batch-insert-outbox-plan.md.
package main

import (
	"context"
	"database/sql"
	"fmt"
	"os"
	"strconv"
	"time"

	"github.com/jmoiron/sqlx"
)

// outboxCmd dispatches `admin outbox <sub>` subcommands.
func outboxCmd(db *sqlx.DB) error {
	if len(os.Args) < 3 {
		return fmt.Errorf("usage: admin outbox <status>")
	}
	switch os.Args[2] {
	case "status":
		return outboxStatus(db)
	default:
		return fmt.Errorf("unknown outbox subcommand: %s", os.Args[2])
	}
}

// dlqCmd dispatches `admin dlq <sub>` subcommands.
func dlqCmd(db *sqlx.DB) error {
	if len(os.Args) < 3 {
		return fmt.Errorf("usage: admin dlq <list|inspect|retry|retry-all|delete>")
	}
	switch os.Args[2] {
	case "list":
		return dlqList(db)
	case "inspect":
		return dlqInspect(db)
	case "retry":
		return dlqRetry(db)
	case "retry-all":
		return dlqRetryAll(db)
	case "delete":
		return dlqDelete(db)
	default:
		return fmt.Errorf("unknown dlq subcommand: %s", os.Args[2])
	}
}

// ---------------------------------------------------------------------------
// outbox status
// ---------------------------------------------------------------------------

// outboxStatus prints a live snapshot of nats_outbox that covers every
// question an operator would ask after an alert fires: how much is pending,
// which subjects are backed up, which rows have advanced past MaxAttempts
// (= stuck, need manual cleanup), and which rows have hit persistent errors.
func outboxStatus(db *sqlx.DB) error {
	ctx := context.Background()

	var totalPending int64
	if err := db.GetContext(ctx, &totalPending,
		`SELECT COUNT(*) FROM nats_outbox WHERE attempt_count < 10`,
	); err != nil {
		return fmt.Errorf("count pending: %w", err)
	}

	var totalStuck int64
	if err := db.GetContext(ctx, &totalStuck,
		`SELECT COUNT(*) FROM nats_outbox WHERE attempt_count >= 10`,
	); err != nil {
		return fmt.Errorf("count stuck: %w", err)
	}

	var oldest sql.NullTime
	if err := db.GetContext(ctx, &oldest,
		`SELECT MIN(created_at) FROM nats_outbox WHERE attempt_count < 10`,
	); err != nil {
		return fmt.Errorf("oldest: %w", err)
	}

	fmt.Println("=== outbox status ===")
	fmt.Printf("pending rows (attempt < 10): %d\n", totalPending)
	fmt.Printf("stuck rows (attempt >= 10, not in DLQ): %d\n", totalStuck)
	if oldest.Valid {
		fmt.Printf("oldest pending: %s (%.0fs ago)\n",
			oldest.Time.Format(time.RFC3339),
			time.Since(oldest.Time).Seconds(),
		)
	} else {
		fmt.Println("oldest pending: none")
	}

	// Per-subject breakdown.
	type subjRow struct {
		Subject   string    `db:"subject"`
		Count     int64     `db:"cnt"`
		MaxAttempt int      `db:"max_attempt"`
		Oldest    time.Time `db:"oldest"`
	}
	var subjRows []subjRow
	if err := db.SelectContext(ctx, &subjRows, `
		SELECT subject, COUNT(*) AS cnt, MAX(attempt_count) AS max_attempt, MIN(created_at) AS oldest
		FROM nats_outbox
		GROUP BY subject
		ORDER BY cnt DESC
		LIMIT 20
	`); err != nil {
		return fmt.Errorf("subject breakdown: %w", err)
	}
	if len(subjRows) > 0 {
		fmt.Println()
		fmt.Println("top subjects (by pending count):")
		fmt.Printf("  %-50s %8s %12s  %s\n", "subject", "count", "max_attempt", "oldest")
		for _, r := range subjRows {
			fmt.Printf("  %-50s %8d %12d  %s\n",
				truncate(r.Subject, 50), r.Count, r.MaxAttempt,
				r.Oldest.Format(time.RFC3339),
			)
		}
	}

	// Rows with sustained errors (attempt >= 3) — likely headed to DLQ.
	type stuckRow struct {
		ID          int64     `db:"id"`
		Subject     string    `db:"subject"`
		AttemptCount int      `db:"attempt_count"`
		LastError   sql.NullString `db:"last_error"`
		CreatedAt   time.Time `db:"created_at"`
	}
	var stuck []stuckRow
	if err := db.SelectContext(ctx, &stuck, `
		SELECT id, subject, attempt_count, last_error, created_at
		FROM nats_outbox
		WHERE attempt_count >= 3
		ORDER BY attempt_count DESC, id
		LIMIT 10
	`); err != nil {
		return fmt.Errorf("stuck rows: %w", err)
	}
	if len(stuck) > 0 {
		fmt.Println()
		fmt.Println("rows with attempt_count >= 3 (retrying):")
		for _, r := range stuck {
			errMsg := "(none)"
			if r.LastError.Valid {
				errMsg = truncate(r.LastError.String, 80)
			}
			fmt.Printf("  id=%d subject=%s attempts=%d created=%s\n    last_error: %s\n",
				r.ID, r.Subject, r.AttemptCount,
				r.CreatedAt.Format(time.RFC3339), errMsg,
			)
		}
	}

	return nil
}

// ---------------------------------------------------------------------------
// dlq list / inspect
// ---------------------------------------------------------------------------

func dlqList(db *sqlx.DB) error {
	limit := 20
	if len(os.Args) >= 4 {
		n, err := strconv.Atoi(os.Args[3])
		if err != nil || n <= 0 {
			return fmt.Errorf("invalid limit: %s", os.Args[3])
		}
		limit = n
	}

	type row struct {
		ID           int64          `db:"id"`
		OriginalID   int64          `db:"original_id"`
		Subject      string         `db:"subject"`
		ReferenceID  string         `db:"reference_id"`
		AttemptCount int            `db:"attempt_count"`
		LastError    sql.NullString `db:"last_error"`
		DLQReason    string         `db:"dlq_reason"`
		MovedAt      time.Time      `db:"moved_at"`
	}
	var rows []row
	if err := db.SelectContext(context.Background(), &rows, `
		SELECT id, original_id, subject, reference_id, attempt_count,
		       last_error, dlq_reason, moved_at
		FROM nats_outbox_dlq
		ORDER BY moved_at DESC
		LIMIT $1
	`, limit); err != nil {
		return fmt.Errorf("select dlq: %w", err)
	}

	if len(rows) == 0 {
		fmt.Println("nats_outbox_dlq is empty")
		return nil
	}
	fmt.Printf("=== nats_outbox_dlq (newest %d) ===\n", len(rows))
	for _, r := range rows {
		errMsg := "(none)"
		if r.LastError.Valid {
			errMsg = truncate(r.LastError.String, 100)
		}
		fmt.Printf("dlq_id=%d original=%d subject=%s ref=%s attempts=%d moved=%s\n  reason: %s\n  last_error: %s\n\n",
			r.ID, r.OriginalID, r.Subject, r.ReferenceID, r.AttemptCount,
			r.MovedAt.Format(time.RFC3339), r.DLQReason, errMsg,
		)
	}
	return nil
}

func dlqInspect(db *sqlx.DB) error {
	if len(os.Args) < 4 {
		return fmt.Errorf("usage: admin dlq inspect <dlq-id>")
	}
	id, err := strconv.ParseInt(os.Args[3], 10, 64)
	if err != nil {
		return fmt.Errorf("invalid dlq-id: %s", os.Args[3])
	}

	type row struct {
		ID              int64          `db:"id"`
		OriginalID      int64          `db:"original_id"`
		Subject         string         `db:"subject"`
		Payload         []byte         `db:"payload"`
		ReferenceID     string         `db:"reference_id"`
		CreatedAt       time.Time      `db:"created_at"`
		AttemptCount    int            `db:"attempt_count"`
		LastError       sql.NullString `db:"last_error"`
		LastAttemptedAt sql.NullTime   `db:"last_attempted_at"`
		PayloadVersion  int16          `db:"payload_version"`
		DLQReason       string         `db:"dlq_reason"`
		MovedAt         time.Time      `db:"moved_at"`
	}
	var r row
	if err := db.GetContext(context.Background(), &r, `
		SELECT id, original_id, subject, payload, reference_id, created_at,
		       attempt_count, last_error, last_attempted_at,
		       payload_version, dlq_reason, moved_at
		FROM nats_outbox_dlq
		WHERE id = $1
	`, id); err != nil {
		return fmt.Errorf("select dlq row %d: %w", id, err)
	}

	errMsg := "(none)"
	if r.LastError.Valid {
		errMsg = r.LastError.String
	}
	lastAttempt := "(never)"
	if r.LastAttemptedAt.Valid {
		lastAttempt = r.LastAttemptedAt.Time.Format(time.RFC3339)
	}

	fmt.Printf("dlq_id:           %d\n", r.ID)
	fmt.Printf("original_id:      %d\n", r.OriginalID)
	fmt.Printf("subject:          %s\n", r.Subject)
	fmt.Printf("reference_id:     %s\n", r.ReferenceID)
	fmt.Printf("payload_version:  %d\n", r.PayloadVersion)
	fmt.Printf("payload (%d bytes): %s\n", len(r.Payload), string(r.Payload))
	fmt.Printf("created_at:       %s\n", r.CreatedAt.Format(time.RFC3339))
	fmt.Printf("moved_at:         %s\n", r.MovedAt.Format(time.RFC3339))
	fmt.Printf("attempt_count:    %d\n", r.AttemptCount)
	fmt.Printf("last_attempt:     %s\n", lastAttempt)
	fmt.Printf("dlq_reason:       %s\n", r.DLQReason)
	fmt.Printf("last_error:       %s\n", errMsg)
	return nil
}

// ---------------------------------------------------------------------------
// dlq retry / retry-all / delete
// ---------------------------------------------------------------------------

// dlqRetry moves one DLQ row back to nats_outbox with attempt_count=0 and
// clears retry state. Same tx guarantees no row is lost if the INSERT or
// DELETE fails.
func dlqRetry(db *sqlx.DB) error {
	if len(os.Args) < 4 {
		return fmt.Errorf("usage: admin dlq retry <dlq-id>")
	}
	id, err := strconv.ParseInt(os.Args[3], 10, 64)
	if err != nil {
		return fmt.Errorf("invalid dlq-id: %s", os.Args[3])
	}

	ctx := context.Background()
	tx, err := db.BeginTxx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin tx: %w", err)
	}
	defer tx.Rollback() //nolint:errcheck

	res, err := tx.ExecContext(ctx, `
		INSERT INTO nats_outbox (subject, payload, reference_id, created_at, payload_version)
		SELECT subject, payload, reference_id, NOW(), payload_version
		FROM nats_outbox_dlq
		WHERE id = $1
	`, id)
	if err != nil {
		return fmt.Errorf("insert from dlq: %w", err)
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		return fmt.Errorf("dlq row %d not found", id)
	}

	if _, err := tx.ExecContext(ctx, `DELETE FROM nats_outbox_dlq WHERE id = $1`, id); err != nil {
		return fmt.Errorf("delete dlq row: %w", err)
	}

	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit: %w", err)
	}
	fmt.Printf("moved dlq_id=%d back to nats_outbox (drainer will pick up within 5s)\n", id)
	return nil
}

// dlqRetryAll moves every DLQ row back. Used after an incident where the
// root cause has been fixed and rows should flow normally again.
func dlqRetryAll(db *sqlx.DB) error {
	ctx := context.Background()
	tx, err := db.BeginTxx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin tx: %w", err)
	}
	defer tx.Rollback() //nolint:errcheck

	res, err := tx.ExecContext(ctx, `
		INSERT INTO nats_outbox (subject, payload, reference_id, created_at, payload_version)
		SELECT subject, payload, reference_id, NOW(), payload_version
		FROM nats_outbox_dlq
	`)
	if err != nil {
		return fmt.Errorf("insert from dlq: %w", err)
	}
	n, _ := res.RowsAffected()

	if _, err := tx.ExecContext(ctx, `DELETE FROM nats_outbox_dlq`); err != nil {
		return fmt.Errorf("delete dlq rows: %w", err)
	}

	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit: %w", err)
	}
	fmt.Printf("moved %d dlq row(s) back to nats_outbox\n", n)
	return nil
}

// dlqDelete permanently deletes a single DLQ row. Requires --confirm to guard
// against typos (the payload is genuinely unrecoverable — the corresponding
// accounting_logs entry shows a debit with no fulfillment, so operator must
// confirm they've separately handled the financial side).
func dlqDelete(db *sqlx.DB) error {
	if len(os.Args) < 5 || os.Args[4] != "--confirm" {
		return fmt.Errorf("usage: admin dlq delete <dlq-id> --confirm\n\n" +
			"WARNING: this permanently discards the NATS payload. The debit in\n" +
			"accounting_logs is NOT automatically reversed — you must separately\n" +
			"confirm whether coins were applied or a manual refund is required")
	}
	id, err := strconv.ParseInt(os.Args[3], 10, 64)
	if err != nil {
		return fmt.Errorf("invalid dlq-id: %s", os.Args[3])
	}

	res, err := db.ExecContext(context.Background(),
		`DELETE FROM nats_outbox_dlq WHERE id = $1`, id)
	if err != nil {
		return fmt.Errorf("delete: %w", err)
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		return fmt.Errorf("dlq row %d not found", id)
	}
	fmt.Printf("deleted dlq_id=%d\n", id)
	return nil
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n-1] + "…"
}
