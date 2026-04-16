package accounting

import (
	"context"
	"time"

	"github.com/google/uuid"
	"github.com/shopspring/decimal"
)

// Storer interface declares the core database operations for accounting.
type Storer interface {
	Create(ctx context.Context, log AccountingLog) error
	QueryByAccountID(ctx context.Context, accountID uuid.UUID, page, pageSize int) ([]AccountingLog, error)
	QueryByReference(ctx context.Context, actionType, referenceID string) (AccountingLog, error)
	// QueryAllByReference returns every ledger entry matching (actionType,
	// referenceID). Use this when a split operation may write multiple rows
	// under the same reference (for example, GAME_INSERT can write one PLAY
	// + one CASH entry). The singular QueryByReference keeps first-row-match
	// semantics and is fine for idempotency lookups where any match means
	// "already processed".
	QueryAllByReference(ctx context.Context, actionType, referenceID string) ([]AccountingLog, error)
	SumByActionSince(ctx context.Context, actionType string, since time.Time) (decimal.Decimal, error)
	SumByPlayerSince(ctx context.Context, actionType string, since time.Time) ([]PlayerSum, error)
	// SumByActionSinceExcludingRole returns the total amount like SumByActionSince,
	// but joins accounts and filters out rows where accounts.role == excludeRole.
	// Used by RTP/liability reports to exclude bot activity (excludeRole="bot").
	// If excludeRole is empty, behaves identically to SumByActionSince.
	SumByActionSinceExcludingRole(ctx context.Context, actionType, excludeRole string, since time.Time) (decimal.Decimal, error)
	// SumByPlayerSinceExcludingRole returns per-player sums like SumByPlayerSince,
	// but joins accounts and filters out rows where accounts.role == excludeRole.
	// Used by RTP/liability reports to exclude bot activity (excludeRole="bot").
	// If excludeRole is empty, behaves identically to SumByPlayerSince.
	SumByPlayerSinceExcludingRole(ctx context.Context, actionType, excludeRole string, since time.Time) ([]PlayerSum, error)

	// InsertOutboxRow appends a row to nats_outbox. Called from within an
	// execTx transaction by an OutboxWriter callback, so the outbox row
	// commits atomically with the balance debit. The drainer (see
	// business/core/outbox) later publishes the row's payload to NATS and
	// deletes on success. subject is the NATS topic; payload is the exact
	// bytes to publish; referenceID enables cross-lookup with
	// accounting_logs.reference_id for debug and audit.
	InsertOutboxRow(ctx context.Context, subject string, payload []byte, referenceID string) error
}

// PlayerSum holds the aggregate amount for a single player.
type PlayerSum struct {
	AccountID uuid.UUID       `db:"account_id"`
	Total     decimal.Decimal `db:"total"`
}
