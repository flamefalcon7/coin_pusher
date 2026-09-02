package progress

import (
	"context"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/jmoiron/sqlx"
	"github.com/shopspring/decimal"
	"go.uber.org/zap"

	"github.com/flamefalcon/coin-pusher/backend/business/core/accounting"
	"github.com/flamefalcon/coin-pusher/backend/business/core/inventory"
	"github.com/flamefalcon/coin-pusher/backend/business/core/user"
	"github.com/flamefalcon/coin-pusher/backend/foundation/database"
)

// MetricRecorder is a callback for recording metric events to the progress system.
type MetricRecorder func(ctx context.Context, accountID uuid.UUID, metricType string, delta decimal.Decimal) error

// StorerFactory builds a Storer bound to the given DBTX.
type StorerFactory func(database.DBTX) Storer

// AcctStorerFactory builds an accounting.Storer bound to the given DBTX.
type AcctStorerFactory func(database.DBTX) accounting.Storer

// UserStorerFactory builds a user.Storer bound to the given DBTX.
type UserStorerFactory func(database.DBTX) user.Storer

// Core manages the set of APIs for progress access.
type Core struct {
	log           *zap.SugaredLogger
	db            *sqlx.DB
	storer        Storer
	newStorer     StorerFactory
	newAcctStorer AcctStorerFactory
	newUserStorer UserStorerFactory
	inventoryCore *inventory.Core
}

// NewCore constructs a progress Core.
func NewCore(
	log *zap.SugaredLogger,
	db *sqlx.DB,
	storer Storer,
	newStorer StorerFactory,
	newAcctStorer AcctStorerFactory,
	newUserStorer UserStorerFactory,
	inventoryCore *inventory.Core,
) *Core {
	return &Core{
		log:           log,
		db:            db,
		storer:        storer,
		newStorer:     newStorer,
		newAcctStorer: newAcctStorer,
		newUserStorer: newUserStorer,
		inventoryCore: inventoryCore,
	}
}

// ==========================================================================
// CRUD
// ==========================================================================

// CreateProgress creates a new progress definition.
func (c *Core) CreateProgress(ctx context.Context, np NewProgress) (Progress, error) {
	now := time.Now().UTC()
	p := Progress{
		ProgressID:    uuid.New(),
		Title:         np.Title,
		Description:   np.Description,
		MetricType:    np.MetricType,
		Threshold:     np.Threshold,
		RewardType:    np.RewardType,
		RewardAmount:  np.RewardAmount,
		DisburseDelay: np.DisburseDelay,
		ClaimDeadline: np.ClaimDeadline,
		ActiveFrom:    np.ActiveFrom,
		ActiveUntil:   np.ActiveUntil,
		Enabled:       true,
		CreatedAt:     now,
		UpdatedAt:     now,
	}

	if err := c.storer.CreateProgress(ctx, p); err != nil {
		return Progress{}, fmt.Errorf("creating progress: %w", err)
	}
	return p, nil
}

// UpdateProgress updates an existing progress definition.
func (c *Core) UpdateProgress(ctx context.Context, progressID uuid.UUID, up UpdateProgress) (Progress, error) {
	p, err := c.storer.QueryProgressByID(ctx, progressID)
	if err != nil {
		return Progress{}, fmt.Errorf("query progress: %w", err)
	}

	if up.Title != nil {
		p.Title = *up.Title
	}
	if up.Description != nil {
		p.Description = *up.Description
	}
	if up.MetricType != nil {
		p.MetricType = *up.MetricType
	}
	if up.Threshold != nil {
		p.Threshold = *up.Threshold
	}
	if up.RewardType != nil {
		p.RewardType = *up.RewardType
	}
	if up.RewardAmount != nil {
		p.RewardAmount = *up.RewardAmount
	}
	if up.DisburseDelay != nil {
		p.DisburseDelay = *up.DisburseDelay
	}
	if up.ClaimDeadline != nil {
		p.ClaimDeadline = up.ClaimDeadline
	}
	if up.ActiveFrom != nil {
		p.ActiveFrom = up.ActiveFrom
	}
	if up.ActiveUntil != nil {
		p.ActiveUntil = up.ActiveUntil
	}
	if up.Enabled != nil {
		p.Enabled = *up.Enabled
	}
	p.UpdatedAt = time.Now().UTC()

	if err := c.storer.UpdateProgress(ctx, p); err != nil {
		return Progress{}, fmt.Errorf("updating progress: %w", err)
	}
	return p, nil
}

// QueryAllProgress retrieves all progress definitions.
func (c *Core) QueryAllProgress(ctx context.Context) ([]Progress, error) {
	return c.storer.QueryAllProgress(ctx)
}

// QueryUserProgress returns a joined view for the user.
func (c *Core) QueryUserProgress(ctx context.Context, accountID uuid.UUID) ([]UserProgressView, error) {
	return c.storer.QueryUserProgress(ctx, accountID)
}

// QueryAccountProgressByProgressID returns all user entries for a progress def.
func (c *Core) QueryAccountProgressByProgressID(ctx context.Context, progressID uuid.UUID) ([]AccountProgress, error) {
	return c.storer.QueryAccountProgressByProgressID(ctx, progressID)
}

// ==========================================================================
// RecordMetric
// ==========================================================================

// RecordMetric is called by hooks after events. It queries all enabled progress
// defs matching the metric_type and upserts account_progress for each.
func (c *Core) RecordMetric(ctx context.Context, accountID uuid.UUID, metricType string, delta decimal.Decimal) error {
	now := time.Now().UTC()

	defs, err := c.storer.QueryEnabledByMetric(ctx, metricType, now)
	if err != nil {
		return fmt.Errorf("query enabled progress: %w", err)
	}

	for _, def := range defs {
		ap, err := c.storer.UpsertAccountProgress(ctx, accountID, def.ProgressID, delta)
		if err != nil {
			c.log.Errorw("upsert account progress error",
				"account_id", accountID,
				"progress_id", def.ProgressID,
				"error", err,
			)
			continue
		}
		if ap == nil {
			continue
		}

		// Check if threshold is met.
		if ap.CurrentValue.GreaterThanOrEqual(def.Threshold) && ap.Status == StatusActive {
			if err := c.storer.MarkAchieved(ctx, accountID, def.ProgressID, now); err != nil {
				c.log.Errorw("mark achieved error",
					"account_id", accountID,
					"progress_id", def.ProgressID,
					"error", err,
				)
			}
		}
	}

	return nil
}

// ==========================================================================
// ClaimReward — user-initiated claim
// ==========================================================================

// ClaimReward lets a user claim a reward for an achieved progress entry.
// Returns an error if not claimable (not achieved, still in cooldown, or expired).
func (c *Core) ClaimReward(ctx context.Context, accountID, progressID uuid.UUID) error {
	now := time.Now().UTC()

	entry, err := c.storer.QueryClaimable(ctx, accountID, progressID, now)
	if err != nil {
		return fmt.Errorf("query claimable: %w", err)
	}
	if entry == nil {
		return fmt.Errorf("not claimable: not achieved, still in cooldown, or already claimed/expired")
	}

	return c.disburseOne(ctx, *entry, now)
}

func (c *Core) disburseOne(ctx context.Context, entry ClaimableEntry, now time.Time) error {
	return database.ExecTx(ctx, c.db, func(tx *sqlx.Tx) error {
		txStorer := c.newStorer(tx)
		txAcctStorer := c.newAcctStorer(tx)
		txUserCore := user.NewCore(c.newUserStorer(tx))

		refID := fmt.Sprintf("progress:%s:%s", entry.ProgressID, entry.AccountID)

		// Idempotency check via accounting_logs reference_id.
		_, err := txAcctStorer.QueryByReference(ctx, accounting.ActionProgressReward, refID)
		if err == nil {
			// Already disbursed — just mark and return.
			return txStorer.MarkDisbursed(ctx, entry.AccountID, entry.ProgressID, now)
		}

		switch entry.RewardType {
		case "play_coin":
			logEntry := accounting.AccountingLog{
				LogID:       uuid.New(),
				AccountID:   entry.AccountID,
				ActionType:  accounting.ActionProgressReward,
				Amount:      entry.RewardAmount,
				Currency:    accounting.CurrencyPlay,
				ReferenceID: refID,
				CreatedAt:   now,
			}
			if err := txAcctStorer.Create(ctx, logEntry); err != nil {
				return fmt.Errorf("creating progress reward log: %w", err)
			}
			if err := txUserCore.IncrementPlayBalance(ctx, entry.AccountID, entry.RewardAmount); err != nil {
				return fmt.Errorf("credit play balance: %w", err)
			}

		case "cash_coin":
			logEntry := accounting.AccountingLog{
				LogID:       uuid.New(),
				AccountID:   entry.AccountID,
				ActionType:  accounting.ActionProgressReward,
				Amount:      entry.RewardAmount,
				Currency:    accounting.CurrencyCash,
				ReferenceID: refID,
				CreatedAt:   now,
			}
			if err := txAcctStorer.Create(ctx, logEntry); err != nil {
				return fmt.Errorf("creating progress reward log: %w", err)
			}
			if err := txUserCore.IncrementCashBalance(ctx, entry.AccountID, entry.RewardAmount); err != nil {
				return fmt.Errorf("credit cash balance: %w", err)
			}

		default:
			// Scroll rewards or unknown types.
			if isScrollReward(entry.RewardType) {
				scrollType := entry.RewardType[len("scroll_"):]
				count := int(entry.RewardAmount.IntPart())
				if count < 1 {
					count = 1
				}
				for i := 0; i < count; i++ {
					if err := c.inventoryCore.CreditScroll(ctx, entry.AccountID, scrollType); err != nil {
						return fmt.Errorf("credit scroll %s: %w", scrollType, err)
					}
				}
			}
			// Unknown reward types: just mark disbursed.
		}

		// Mark as disbursed.
		if err := txStorer.MarkDisbursed(ctx, entry.AccountID, entry.ProgressID, now); err != nil {
			return fmt.Errorf("mark disbursed: %w", err)
		}

		return nil
	})
}

func isScrollReward(rewardType string) bool {
	switch rewardType {
	case "scroll_shock", "scroll_tornado", "scroll_explosion", "scroll_lightning", "scroll_super_push":
		return true
	}
	return false
}

// ==========================================================================
// ExpireOverdue — background worker expires unclaimed rewards past deadline
// ==========================================================================

// ExpireOverdue marks achieved entries as expired when they pass their claim_deadline.
// Returns the count of expired entries.
func (c *Core) ExpireOverdue(ctx context.Context, now time.Time, batchSize int) (int, error) {
	entries, err := c.storer.QueryExpirable(ctx, now, batchSize)
	if err != nil {
		return 0, fmt.Errorf("query expirable: %w", err)
	}

	expired := 0
	for _, entry := range entries {
		if err := c.storer.MarkExpired(ctx, entry.AccountID, entry.ProgressID, now); err != nil {
			c.log.Errorw("expire error",
				"account_id", entry.AccountID,
				"progress_id", entry.ProgressID,
				"error", err,
			)
			continue
		}
		expired++
	}

	return expired, nil
}
