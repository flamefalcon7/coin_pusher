// Package progressdb provides PostgreSQL storage for the progress domain.
package progressdb

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/shopspring/decimal"

	"github.com/flamefalcon/coin-pusher/backend/business/core/progress"
	v1 "github.com/flamefalcon/coin-pusher/backend/business/web/v1"
	"github.com/flamefalcon/coin-pusher/backend/foundation/database"
)

// Store manages the PostgreSQL interactions for progress.
type Store struct {
	db database.DBTX
}

// NewStore constructs a Store for progress database operations.
func NewStore(db database.DBTX) *Store {
	return &Store{db: db}
}

// dbProgress is the database representation with INTERVAL as string.
type dbProgress struct {
	ProgressID    uuid.UUID       `db:"progress_id"`
	Title         string          `db:"title"`
	Description   string          `db:"description"`
	MetricType    string          `db:"metric_type"`
	Threshold     decimal.Decimal `db:"threshold"`
	RewardType    string          `db:"reward_type"`
	RewardAmount  decimal.Decimal `db:"reward_amount"`
	DisburseDelay string          `db:"disburse_delay"`
	ClaimDeadline *string         `db:"claim_deadline"`
	ActiveFrom    *time.Time      `db:"active_from"`
	ActiveUntil   *time.Time      `db:"active_until"`
	Enabled       bool            `db:"enabled"`
	CreatedAt     time.Time       `db:"created_at"`
	UpdatedAt     time.Time       `db:"updated_at"`
}

// toProgress converts the DB row to the domain model.
func (d dbProgress) toProgress() progress.Progress {
	p := progress.Progress{
		ProgressID:    d.ProgressID,
		Title:         d.Title,
		Description:   d.Description,
		MetricType:    d.MetricType,
		Threshold:     d.Threshold,
		RewardType:    d.RewardType,
		RewardAmount:  d.RewardAmount,
		DisburseDelay: parseInterval(d.DisburseDelay),
		ActiveFrom:    d.ActiveFrom,
		ActiveUntil:   d.ActiveUntil,
		Enabled:       d.Enabled,
		CreatedAt:     d.CreatedAt,
		UpdatedAt:     d.UpdatedAt,
	}
	if d.ClaimDeadline != nil {
		dur := parseInterval(*d.ClaimDeadline)
		p.ClaimDeadline = &dur
	}
	return p
}

// parseInterval converts a PostgreSQL interval string to time.Duration.
// We handle the common formats: "HH:MM:SS", "N days HH:MM:SS", "N days".
func parseInterval(s string) time.Duration {
	if s == "" || s == "00:00:00" {
		return 0
	}

	var days int
	rest := s

	// Check for "N day(s)" prefix.
	n, err := fmt.Sscanf(s, "%d day", &days)
	if n == 1 && err == nil {
		// Find the time part after "day(s) ".
		for i := 0; i < len(s); i++ {
			if s[i] == ' ' && i > 0 && (s[i-1] == 'y' || s[i-1] == 's') {
				rest = s[i+1:]
				break
			}
		}
		if rest == s {
			// No time part, just days.
			return time.Duration(days) * 24 * time.Hour
		}
	} else {
		days = 0
		rest = s
	}

	// Parse HH:MM:SS.
	var h, m, sec int
	if _, err := fmt.Sscanf(rest, "%d:%d:%d", &h, &m, &sec); err == nil {
		return time.Duration(days)*24*time.Hour +
			time.Duration(h)*time.Hour +
			time.Duration(m)*time.Minute +
			time.Duration(sec)*time.Second
	}

	return 0
}

// durationToInterval converts a time.Duration to a PostgreSQL interval string.
func durationToInterval(d time.Duration) string {
	totalSeconds := int(d.Seconds())
	return fmt.Sprintf("%d seconds", totalSeconds)
}

// CreateProgress inserts a new progress definition.
func (s *Store) CreateProgress(ctx context.Context, p progress.Progress) error {
	const q = `
		INSERT INTO progress (progress_id, title, description, metric_type, threshold,
			reward_type, reward_amount, disburse_delay, claim_deadline,
			active_from, active_until, enabled, created_at, updated_at)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8::INTERVAL, $9::INTERVAL,
			$10, $11, $12, $13, $14)`

	var claimDeadline *string
	if p.ClaimDeadline != nil {
		s := durationToInterval(*p.ClaimDeadline)
		claimDeadline = &s
	}

	if _, err := s.db.ExecContext(ctx, q,
		p.ProgressID, p.Title, p.Description, p.MetricType, p.Threshold,
		p.RewardType, p.RewardAmount, durationToInterval(p.DisburseDelay), claimDeadline,
		p.ActiveFrom, p.ActiveUntil, p.Enabled, p.CreatedAt, p.UpdatedAt,
	); err != nil {
		return fmt.Errorf("inserting progress: %w", err)
	}

	return nil
}

// UpdateProgress updates an existing progress definition.
func (s *Store) UpdateProgress(ctx context.Context, p progress.Progress) error {
	const q = `
		UPDATE progress SET
			title = $2, description = $3, metric_type = $4, threshold = $5,
			reward_type = $6, reward_amount = $7, disburse_delay = $8::INTERVAL,
			claim_deadline = $9::INTERVAL,
			active_from = $10, active_until = $11, enabled = $12, updated_at = $13
		WHERE progress_id = $1`

	var claimDeadline *string
	if p.ClaimDeadline != nil {
		s := durationToInterval(*p.ClaimDeadline)
		claimDeadline = &s
	}

	res, err := s.db.ExecContext(ctx, q,
		p.ProgressID, p.Title, p.Description, p.MetricType, p.Threshold,
		p.RewardType, p.RewardAmount, durationToInterval(p.DisburseDelay), claimDeadline,
		p.ActiveFrom, p.ActiveUntil, p.Enabled, p.UpdatedAt,
	)
	if err != nil {
		return fmt.Errorf("updating progress: %w", err)
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		return v1.NewRequestError(v1.ErrNotFound, 404)
	}
	return nil
}

// QueryProgressByID retrieves a single progress definition by ID.
func (s *Store) QueryProgressByID(ctx context.Context, progressID uuid.UUID) (progress.Progress, error) {
	const q = `SELECT progress_id, title, description, metric_type, threshold,
		reward_type, reward_amount, disburse_delay::TEXT, claim_deadline::TEXT,
		active_from, active_until, enabled, created_at, updated_at
		FROM progress WHERE progress_id = $1`

	var row dbProgress
	if err := s.db.GetContext(ctx, &row, q, progressID); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return progress.Progress{}, v1.NewRequestError(v1.ErrNotFound, 404)
		}
		return progress.Progress{}, fmt.Errorf("selecting progress by id: %w", err)
	}
	return row.toProgress(), nil
}

// QueryAllProgress retrieves all progress definitions.
func (s *Store) QueryAllProgress(ctx context.Context) ([]progress.Progress, error) {
	const q = `SELECT progress_id, title, description, metric_type, threshold,
		reward_type, reward_amount, disburse_delay::TEXT, claim_deadline::TEXT,
		active_from, active_until, enabled, created_at, updated_at
		FROM progress ORDER BY created_at DESC`

	var rows []dbProgress
	if err := s.db.SelectContext(ctx, &rows, q); err != nil {
		return nil, fmt.Errorf("selecting all progress: %w", err)
	}

	result := make([]progress.Progress, len(rows))
	for i, r := range rows {
		result[i] = r.toProgress()
	}
	return result, nil
}

// QueryEnabledByMetric returns enabled progress defs matching a metric type
// where the current time falls within the active window.
func (s *Store) QueryEnabledByMetric(ctx context.Context, metricType string, now time.Time) ([]progress.Progress, error) {
	const q = `SELECT progress_id, title, description, metric_type, threshold,
		reward_type, reward_amount, disburse_delay::TEXT, claim_deadline::TEXT,
		active_from, active_until, enabled, created_at, updated_at
		FROM progress
		WHERE enabled = TRUE
			AND metric_type = $1
			AND (active_from IS NULL OR active_from <= $2)
			AND (active_until IS NULL OR active_until >= $2)`

	var rows []dbProgress
	if err := s.db.SelectContext(ctx, &rows, q, metricType, now); err != nil {
		return nil, fmt.Errorf("selecting enabled progress by metric: %w", err)
	}

	result := make([]progress.Progress, len(rows))
	for i, r := range rows {
		result[i] = r.toProgress()
	}
	return result, nil
}

// UpsertAccountProgress atomically increments the user's progress value.
// Only increments if status = 'active'. Returns the updated row, or nil if
// no update happened (already achieved/disbursed or no matching row was created).
func (s *Store) UpsertAccountProgress(ctx context.Context, accountID, progressID uuid.UUID, delta decimal.Decimal) (*progress.AccountProgress, error) {
	const q = `
		INSERT INTO account_progress (account_id, progress_id, current_value, status, created_at, updated_at)
		VALUES ($1, $2, $3, 'active', NOW(), NOW())
		ON CONFLICT (account_id, progress_id) DO UPDATE
		SET current_value = account_progress.current_value + $3, updated_at = NOW()
		WHERE account_progress.status = 'active'
		RETURNING account_id, progress_id, current_value, status, achieved_at, disbursed_at, created_at, updated_at`

	var ap progress.AccountProgress
	if err := s.db.GetContext(ctx, &ap, q, accountID, progressID, delta); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, nil
		}
		return nil, fmt.Errorf("upserting account progress: %w", err)
	}
	return &ap, nil
}

// MarkAchieved transitions an account_progress row to 'achieved'.
func (s *Store) MarkAchieved(ctx context.Context, accountID, progressID uuid.UUID, achievedAt time.Time) error {
	const q = `
		UPDATE account_progress
		SET status = 'achieved', achieved_at = $3, updated_at = NOW()
		WHERE account_id = $1 AND progress_id = $2 AND status = 'active'`

	if _, err := s.db.ExecContext(ctx, q, accountID, progressID, achievedAt); err != nil {
		return fmt.Errorf("marking achieved: %w", err)
	}
	return nil
}

// QueryClaimable checks if a specific account_progress entry is claimable
// (status = 'achieved' AND past disburse_delay).
func (s *Store) QueryClaimable(ctx context.Context, accountID, progressID uuid.UUID, now time.Time) (*progress.ClaimableEntry, error) {
	const q = `
		SELECT ap.account_id, ap.progress_id, p.reward_type, p.reward_amount,
			ap.achieved_at, ap.achieved_at + p.disburse_delay AS claimable_at
		FROM account_progress ap
		JOIN progress p ON p.progress_id = ap.progress_id
		WHERE ap.account_id = $1 AND ap.progress_id = $2
			AND ap.status = 'achieved'
			AND ap.achieved_at + p.disburse_delay <= $3`

	var entry progress.ClaimableEntry
	if err := s.db.GetContext(ctx, &entry, q, accountID, progressID, now); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, nil
		}
		return nil, fmt.Errorf("querying claimable: %w", err)
	}
	return &entry, nil
}

// MarkDisbursed transitions an account_progress row to 'disbursed'.
func (s *Store) MarkDisbursed(ctx context.Context, accountID, progressID uuid.UUID, disbursedAt time.Time) error {
	const q = `
		UPDATE account_progress
		SET status = 'disbursed', disbursed_at = $3, updated_at = NOW()
		WHERE account_id = $1 AND progress_id = $2 AND status = 'achieved'`

	if _, err := s.db.ExecContext(ctx, q, accountID, progressID, disbursedAt); err != nil {
		return fmt.Errorf("marking disbursed: %w", err)
	}
	return nil
}

// QueryExpirable returns account_progress entries that are achieved and
// past their claim_deadline (achieved_at + claim_deadline <= now).
// Only considers progress defs that have a non-NULL claim_deadline.
func (s *Store) QueryExpirable(ctx context.Context, now time.Time, limit int) ([]progress.ExpirableEntry, error) {
	const q = `
		SELECT ap.account_id, ap.progress_id,
			ap.achieved_at, ap.achieved_at + p.claim_deadline AS expires_at
		FROM account_progress ap
		JOIN progress p ON p.progress_id = ap.progress_id
		WHERE ap.status = 'achieved'
			AND p.claim_deadline IS NOT NULL
			AND ap.achieved_at + p.claim_deadline <= $1
		ORDER BY ap.achieved_at ASC LIMIT $2`

	var entries []progress.ExpirableEntry
	if err := s.db.SelectContext(ctx, &entries, q, now, limit); err != nil {
		return nil, fmt.Errorf("selecting expirable: %w", err)
	}
	return entries, nil
}

// MarkExpired transitions an account_progress row to 'expired'.
func (s *Store) MarkExpired(ctx context.Context, accountID, progressID uuid.UUID, now time.Time) error {
	const q = `
		UPDATE account_progress
		SET status = 'expired', updated_at = $3
		WHERE account_id = $1 AND progress_id = $2 AND status = 'achieved'`

	if _, err := s.db.ExecContext(ctx, q, accountID, progressID, now); err != nil {
		return fmt.Errorf("marking expired: %w", err)
	}
	return nil
}

// dbUserProgressView is the DB representation for the user progress view.
type dbUserProgressView struct {
	ProgressID    uuid.UUID       `db:"progress_id"`
	Title         string          `db:"title"`
	Description   string          `db:"description"`
	MetricType    string          `db:"metric_type"`
	Threshold     decimal.Decimal `db:"threshold"`
	RewardType    string          `db:"reward_type"`
	RewardAmount  decimal.Decimal `db:"reward_amount"`
	CurrentValue  decimal.Decimal `db:"current_value"`
	Status        string          `db:"status"`
	AchievedAt    *time.Time      `db:"achieved_at"`
	DisbursedAt   *time.Time      `db:"disbursed_at"`
	DisburseDelay string          `db:"disburse_delay"`
	ClaimDeadline *string         `db:"claim_deadline"`
}

// QueryUserProgress returns a joined view of all enabled progress definitions
// with the user's current values (LEFT JOIN).
func (s *Store) QueryUserProgress(ctx context.Context, accountID uuid.UUID) ([]progress.UserProgressView, error) {
	const q = `
		SELECT p.progress_id, p.title, p.description, p.metric_type, p.threshold,
			p.reward_type, p.reward_amount,
			COALESCE(ap.current_value, 0) AS current_value,
			COALESCE(ap.status, 'active') AS status,
			ap.achieved_at, ap.disbursed_at,
			p.disburse_delay::TEXT, p.claim_deadline::TEXT
		FROM progress p
		LEFT JOIN account_progress ap ON ap.progress_id = p.progress_id AND ap.account_id = $1
		WHERE p.enabled = TRUE
			AND (p.active_from IS NULL OR p.active_from <= NOW())
			AND (p.active_until IS NULL OR p.active_until >= NOW())
		ORDER BY p.created_at DESC`

	var rows []dbUserProgressView
	if err := s.db.SelectContext(ctx, &rows, q, accountID); err != nil {
		return nil, fmt.Errorf("selecting user progress: %w", err)
	}

	views := make([]progress.UserProgressView, len(rows))
	for i, r := range rows {
		v := progress.UserProgressView{
			ProgressID:    r.ProgressID,
			Title:         r.Title,
			Description:   r.Description,
			MetricType:    r.MetricType,
			Threshold:     r.Threshold,
			RewardType:    r.RewardType,
			RewardAmount:  r.RewardAmount,
			CurrentValue:  r.CurrentValue,
			Status:        r.Status,
			AchievedAt:    r.AchievedAt,
			DisbursedAt:   r.DisbursedAt,
			DisburseDelay: parseInterval(r.DisburseDelay),
		}
		if r.ClaimDeadline != nil {
			dur := parseInterval(*r.ClaimDeadline)
			v.ClaimDeadline = &dur
		}
		views[i] = v
	}
	return views, nil
}

// QueryAccountProgressByProgressID returns all user progress entries for a given progress ID.
func (s *Store) QueryAccountProgressByProgressID(ctx context.Context, progressID uuid.UUID) ([]progress.AccountProgress, error) {
	const q = `
		SELECT account_id, progress_id, current_value, status, achieved_at, disbursed_at, created_at, updated_at
		FROM account_progress
		WHERE progress_id = $1
		ORDER BY updated_at DESC`

	var entries []progress.AccountProgress
	if err := s.db.SelectContext(ctx, &entries, q, progressID); err != nil {
		return nil, fmt.Errorf("selecting account progress by progress_id: %w", err)
	}
	return entries, nil
}
