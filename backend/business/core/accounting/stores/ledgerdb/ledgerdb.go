// Package ledgerdb provides PostgreSQL storage for the accounting domain.
package ledgerdb

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/shopspring/decimal"

	"github.com/flamefalcon/coin-pusher/backend/business/core/accounting"
	v1 "github.com/flamefalcon/coin-pusher/backend/business/web/v1"
	"github.com/flamefalcon/coin-pusher/backend/foundation/database"
)

// Store manages the PostgreSQL interactions for accounting logs.
type Store struct {
	db database.DBTX
}

// NewStore constructs a Store for accounting database operations.
func NewStore(db database.DBTX) *Store {
	return &Store{db: db}
}

// Create inserts a new accounting log entry.
func (s *Store) Create(ctx context.Context, log accounting.AccountingLog) error {
	const q = `
		INSERT INTO accounting_logs (log_id, account_id, action_type, amount, currency, reference_id, created_at)
		VALUES ($1, $2, $3, $4, $5, $6, $7)`

	if _, err := s.db.ExecContext(ctx, q,
		log.LogID, log.AccountID, log.ActionType, log.Amount,
		log.Currency, log.ReferenceID, log.CreatedAt,
	); err != nil {
		return fmt.Errorf("inserting accounting log: %w", err)
	}

	return nil
}

// QueryByAccountID retrieves accounting logs for an account with pagination.
func (s *Store) QueryByAccountID(ctx context.Context, accountID uuid.UUID, page, pageSize int) ([]accounting.AccountingLog, error) {
	const q = `
		SELECT * FROM accounting_logs
		WHERE account_id = $1
		ORDER BY created_at DESC
		LIMIT $2 OFFSET $3`

	offset := (page - 1) * pageSize
	var logs []accounting.AccountingLog
	if err := s.db.SelectContext(ctx, &logs, q, accountID, pageSize, offset); err != nil {
		return nil, fmt.Errorf("selecting accounting logs: %w", err)
	}

	return logs, nil
}

// QueryByReference finds an accounting log by action type and reference ID.
func (s *Store) QueryByReference(ctx context.Context, actionType, referenceID string) (accounting.AccountingLog, error) {
	const q = `
		SELECT * FROM accounting_logs
		WHERE action_type = $1 AND reference_id = $2`

	var log accounting.AccountingLog
	if err := s.db.GetContext(ctx, &log, q, actionType, referenceID); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return accounting.AccountingLog{}, v1.NewRequestError(v1.ErrNotFound, 404)
		}
		return accounting.AccountingLog{}, fmt.Errorf("selecting accounting log by reference: %w", err)
	}

	return log, nil
}

// SumByActionSince returns the sum of amounts for a given action type since the given time.
func (s *Store) SumByActionSince(ctx context.Context, actionType string, since time.Time) (decimal.Decimal, error) {
	const q = `
		SELECT COALESCE(SUM(amount), 0) FROM accounting_logs
		WHERE action_type = $1 AND created_at >= $2`

	var total decimal.Decimal
	if err := s.db.GetContext(ctx, &total, q, actionType, since); err != nil {
		return decimal.Zero, fmt.Errorf("summing %s since %v: %w", actionType, since, err)
	}

	return total, nil
}

// SumByPlayerSince returns per-player sum of amounts for a given action type since the given time.
func (s *Store) SumByPlayerSince(ctx context.Context, actionType string, since time.Time) ([]accounting.PlayerSum, error) {
	const q = `
		SELECT account_id, SUM(amount) AS total FROM accounting_logs
		WHERE action_type = $1 AND created_at >= $2
		GROUP BY account_id
		HAVING SUM(amount) > 0`

	var results []accounting.PlayerSum
	if err := s.db.SelectContext(ctx, &results, q, actionType, since); err != nil {
		return nil, fmt.Errorf("summing %s by player since %v: %w", actionType, since, err)
	}

	return results, nil
}
