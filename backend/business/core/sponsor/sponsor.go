package sponsor

import (
	"context"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/jmoiron/sqlx"
	"github.com/shopspring/decimal"

	"github.com/flamefalcon/coin-pusher/backend/foundation/database"
)

// StorerFactory builds a Storer bound to the given DBTX (db or tx).
type StorerFactory func(database.DBTX) Storer

// Core manages the set of APIs for sponsor campaign access.
type Core struct {
	db        *sqlx.DB
	storer    Storer
	newStorer StorerFactory
}

// NewCore constructs a sponsor Core.
func NewCore(db *sqlx.DB, storer Storer, newStorer StorerFactory) *Core {
	return &Core{
		db:        db,
		storer:    storer,
		newStorer: newStorer,
	}
}

// execTx runs fn inside a database transaction.
// When db is nil (unit tests), fn receives the default (mock) storer directly.
func (c *Core) execTx(ctx context.Context, fn func(s Storer) error) error {
	if c.db == nil {
		return fn(c.storer)
	}

	return database.ExecTx(ctx, c.db, func(tx *sqlx.Tx) error {
		return fn(c.newStorer(tx))
	})
}

// Create inserts a new sponsor campaign.
func (c *Core) Create(ctx context.Context, nc NewCampaign) (Campaign, error) {
	now := time.Now().UTC()

	camp := Campaign{
		CampaignID:    uuid.New(),
		CreatedBy:     nc.CreatedBy,
		Chain:         nc.Chain,
		TokenAddress:  nc.TokenAddress,
		TokenSymbol:   nc.TokenSymbol,
		TokenDecimals: nc.TokenDecimals,
		BrandColor:    nc.BrandColor,
		BrandName:     nc.BrandName,
		LogoURL:       nc.LogoURL,
		AdImageURL:    nc.AdImageURL,
		PoolTotal:     nc.PoolTotal,
		PoolRemaining: nc.PoolTotal,
		RewardPerCoin: nc.RewardPerCoin,
		Status:        StatusActive,
		CreatedAt:     now,
		UpdatedAt:     now,
	}

	if err := c.storer.Create(ctx, camp); err != nil {
		return Campaign{}, fmt.Errorf("creating campaign: %w", err)
	}

	return camp, nil
}

// Get retrieves a campaign by ID.
func (c *Core) Get(ctx context.Context, campaignID uuid.UUID) (Campaign, error) {
	camp, err := c.storer.QueryByID(ctx, campaignID)
	if err != nil {
		return Campaign{}, fmt.Errorf("getting campaign %s: %w", campaignID, err)
	}
	return camp, nil
}

// ListActive returns all active campaigns.
func (c *Core) ListActive(ctx context.Context) ([]Campaign, error) {
	camps, err := c.storer.QueryActive(ctx)
	if err != nil {
		return nil, fmt.Errorf("listing active campaigns: %w", err)
	}
	return camps, nil
}

// ListByAccount returns all campaigns created by the given account.
func (c *Core) ListByAccount(ctx context.Context, accountID uuid.UUID) ([]Campaign, error) {
	camps, err := c.storer.QueryByAccount(ctx, accountID)
	if err != nil {
		return nil, fmt.Errorf("listing campaigns by account %s: %w", accountID, err)
	}
	return camps, nil
}

// Pause sets a campaign's status to "paused".
func (c *Core) Pause(ctx context.Context, campaignID uuid.UUID) error {
	if err := c.storer.UpdateStatus(ctx, campaignID, StatusPaused); err != nil {
		return fmt.Errorf("pausing campaign %s: %w", campaignID, err)
	}
	return nil
}

// Resume sets a campaign's status to "active".
func (c *Core) Resume(ctx context.Context, campaignID uuid.UUID) error {
	if err := c.storer.UpdateStatus(ctx, campaignID, StatusActive); err != nil {
		return fmt.Errorf("resuming campaign %s: %w", campaignID, err)
	}
	return nil
}

// Expire sets a campaign's status to "expired".
func (c *Core) Expire(ctx context.Context, campaignID uuid.UUID) error {
	if err := c.storer.UpdateStatus(ctx, campaignID, StatusExpired); err != nil {
		return fmt.Errorf("expiring campaign %s: %w", campaignID, err)
	}
	return nil
}

// DecrementPool atomically reduces pool_remaining and returns the new remaining value.
func (c *Core) DecrementPool(ctx context.Context, campaignID uuid.UUID, amount decimal.Decimal) (decimal.Decimal, error) {
	remaining, err := c.storer.DecrementPool(ctx, campaignID, amount)
	if err != nil {
		return decimal.Zero, fmt.Errorf("decrementing pool %s: %w", campaignID, err)
	}
	return remaining, nil
}

// DistributeReward credits a sponsor token reward to a player's balance within a transaction.
// The refKey provides idempotency (unique constraint in sponsor_reward_logs).
func (c *Core) DistributeReward(ctx context.Context, campaignID, accountID uuid.UUID, amount decimal.Decimal, refKey string) error {
	return c.execTx(ctx, func(s Storer) error {
		now := time.Now().UTC()
		log := RewardLog{
			LogID:      uuid.New(),
			AccountID:  accountID,
			CampaignID: campaignID,
			Amount:     amount,
			RefKey:     refKey,
			CreatedAt:  now,
		}

		if err := s.CreateRewardLog(ctx, log); err != nil {
			return fmt.Errorf("creating reward log: %w", err)
		}

		if err := s.CreditBalance(ctx, campaignID, accountID, amount); err != nil {
			return fmt.Errorf("crediting balance: %w", err)
		}

		return nil
	})
}

// GetBalances returns all sponsor token balances for a given account.
func (c *Core) GetBalances(ctx context.Context, accountID uuid.UUID) ([]SponsorBalance, error) {
	bals, err := c.storer.QueryBalancesByAccount(ctx, accountID)
	if err != nil {
		return nil, fmt.Errorf("getting balances for %s: %w", accountID, err)
	}
	return bals, nil
}

// IssueQuota allocates a coin quota from a campaign pool atomically.
// It decrements pool_remaining and creates a quota entry in one transaction.
func (c *Core) IssueQuota(ctx context.Context, campaignID uuid.UUID, coinCount int) (QuotaEntry, error) {
	var entry QuotaEntry

	err := c.execTx(ctx, func(s Storer) error {
		// Look up reward_per_coin from the campaign.
		camp, err := s.QueryByID(ctx, campaignID)
		if err != nil {
			return fmt.Errorf("querying campaign: %w", err)
		}

		tokenAmount := camp.RewardPerCoin.Mul(decimal.NewFromInt(int64(coinCount)))

		if _, err := s.DecrementPool(ctx, campaignID, tokenAmount); err != nil {
			return fmt.Errorf("decrementing pool: %w", err)
		}

		now := time.Now().UTC()
		entry = QuotaEntry{
			QuotaID:     uuid.New(),
			CampaignID:  campaignID,
			CoinCount:   coinCount,
			CoinsSpawned: 0,
			TokenAmount: tokenAmount,
			Status:      QuotaIssued,
			IssuedAt:    now,
		}

		if err := s.CreateQuota(ctx, entry); err != nil {
			return fmt.Errorf("creating quota: %w", err)
		}

		return nil
	})

	if err != nil {
		return QuotaEntry{}, err
	}
	return entry, nil
}

// ConsumeQuota marks a quota entry as consumed with the actual coins spawned count.
func (c *Core) ConsumeQuota(ctx context.Context, quotaID uuid.UUID, coinsSpawned int) error {
	if err := c.storer.ConsumeQuota(ctx, quotaID, coinsSpawned); err != nil {
		return fmt.Errorf("consuming quota %s: %w", quotaID, err)
	}
	return nil
}

// ReconcileStaleQuotas finds issued quotas older than the given threshold and refunds them.
func (c *Core) ReconcileStaleQuotas(ctx context.Context, olderThan time.Duration) error {
	cutoff := time.Now().UTC().Add(-olderThan)

	stale, err := c.storer.QueryStaleQuotas(ctx, cutoff)
	if err != nil {
		return fmt.Errorf("querying stale quotas: %w", err)
	}

	for _, q := range stale {
		if err := c.execTx(ctx, func(s Storer) error {
			if err := s.RefundQuota(ctx, q.QuotaID); err != nil {
				return fmt.Errorf("refunding quota %s: %w", q.QuotaID, err)
			}
			// Return the unused token amount back to the campaign pool.
			// DecrementPool with a negative amount effectively increments.
			// Instead, we use a dedicated approach: negate the amount.
			negAmount := q.TokenAmount.Neg()
			if _, err := s.DecrementPool(ctx, q.CampaignID, negAmount); err != nil {
				return fmt.Errorf("restoring pool for quota %s: %w", q.QuotaID, err)
			}
			return nil
		}); err != nil {
			return fmt.Errorf("reconciling quota %s: %w", q.QuotaID, err)
		}
	}

	return nil
}
