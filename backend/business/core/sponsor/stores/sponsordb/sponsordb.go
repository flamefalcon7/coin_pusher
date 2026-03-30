// Package sponsordb provides PostgreSQL storage for the sponsor domain.
package sponsordb

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/shopspring/decimal"

	"github.com/flamefalcon/coin-pusher/backend/business/core/sponsor"
	v1 "github.com/flamefalcon/coin-pusher/backend/business/web/v1"
	"github.com/flamefalcon/coin-pusher/backend/foundation/database"
)

// Store manages the PostgreSQL interactions for sponsor campaigns.
type Store struct {
	db database.DBTX
}

// NewStore constructs a Store for sponsor database operations.
func NewStore(db database.DBTX) *Store {
	return &Store{db: db}
}

// Create inserts a new sponsor campaign.
func (s *Store) Create(ctx context.Context, camp sponsor.Campaign) error {
	const q = `
		INSERT INTO sponsor_campaigns (
			campaign_id, created_by, chain, token_address, token_symbol,
			token_decimals, brand_color, brand_name, logo_url, ad_image_url,
			pool_total, pool_remaining, reward_per_coin, status, created_at, updated_at
		) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)`

	if _, err := s.db.ExecContext(ctx, q,
		camp.CampaignID, camp.CreatedBy, camp.Chain, camp.TokenAddress, camp.TokenSymbol,
		camp.TokenDecimals, camp.BrandColor, camp.BrandName, camp.LogoURL, camp.AdImageURL,
		camp.PoolTotal, camp.PoolRemaining, camp.RewardPerCoin, camp.Status, camp.CreatedAt, camp.UpdatedAt,
	); err != nil {
		return fmt.Errorf("inserting sponsor campaign: %w", err)
	}

	return nil
}

// QueryByID retrieves a campaign by its ID.
func (s *Store) QueryByID(ctx context.Context, campaignID uuid.UUID) (sponsor.Campaign, error) {
	const q = `SELECT * FROM sponsor_campaigns WHERE campaign_id = $1`

	var camp sponsor.Campaign
	if err := s.db.GetContext(ctx, &camp, q, campaignID); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return sponsor.Campaign{}, v1.NewRequestError(v1.ErrNotFound, 404)
		}
		return sponsor.Campaign{}, fmt.Errorf("selecting campaign %s: %w", campaignID, err)
	}

	return camp, nil
}

// QueryActive returns all active campaigns.
func (s *Store) QueryActive(ctx context.Context) ([]sponsor.Campaign, error) {
	const q = `SELECT * FROM sponsor_campaigns WHERE status = 'active' ORDER BY created_at DESC`

	var camps []sponsor.Campaign
	if err := s.db.SelectContext(ctx, &camps, q); err != nil {
		return nil, fmt.Errorf("selecting active campaigns: %w", err)
	}

	return camps, nil
}

// DecrementPool atomically decrements pool_remaining and returns the new value.
// Returns an error if pool_remaining would go below zero.
func (s *Store) DecrementPool(ctx context.Context, campaignID uuid.UUID, amount decimal.Decimal) (decimal.Decimal, error) {
	const q = `
		UPDATE sponsor_campaigns
		SET pool_remaining = pool_remaining - $1,
		    updated_at = now(),
		    status = CASE WHEN pool_remaining - $1 <= 0 THEN 'depleted' ELSE status END
		WHERE campaign_id = $2
		  AND pool_remaining - $1 >= 0
		RETURNING pool_remaining`

	var remaining decimal.Decimal
	if err := s.db.QueryRowContext(ctx, q, amount, campaignID).Scan(&remaining); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return decimal.Zero, fmt.Errorf("insufficient pool balance for campaign %s", campaignID)
		}
		return decimal.Zero, fmt.Errorf("decrementing pool: %w", err)
	}

	return remaining, nil
}

// CreditBalance upserts the sponsor balance for an account+campaign pair.
func (s *Store) CreditBalance(ctx context.Context, campaignID, accountID uuid.UUID, amount decimal.Decimal) error {
	const q = `
		INSERT INTO sponsor_balances (account_id, campaign_id, balance, updated_at)
		VALUES ($1, $2, $3, now())
		ON CONFLICT (account_id, campaign_id) DO UPDATE
		SET balance = sponsor_balances.balance + EXCLUDED.balance,
		    updated_at = now()`

	if _, err := s.db.ExecContext(ctx, q, accountID, campaignID, amount); err != nil {
		return fmt.Errorf("crediting sponsor balance: %w", err)
	}

	return nil
}

// CreateRewardLog inserts a new reward log entry.
func (s *Store) CreateRewardLog(ctx context.Context, log sponsor.RewardLog) error {
	const q = `
		INSERT INTO sponsor_reward_logs (log_id, account_id, campaign_id, amount, ref_key, created_at)
		VALUES ($1, $2, $3, $4, $5, $6)`

	if _, err := s.db.ExecContext(ctx, q,
		log.LogID, log.AccountID, log.CampaignID, log.Amount, log.RefKey, log.CreatedAt,
	); err != nil {
		return fmt.Errorf("inserting sponsor reward log: %w", err)
	}

	return nil
}

// QueryBalancesByAccount returns all sponsor token balances for an account.
func (s *Store) QueryBalancesByAccount(ctx context.Context, accountID uuid.UUID) ([]sponsor.SponsorBalance, error) {
	const q = `SELECT * FROM sponsor_balances WHERE account_id = $1 ORDER BY updated_at DESC`

	var bals []sponsor.SponsorBalance
	if err := s.db.SelectContext(ctx, &bals, q, accountID); err != nil {
		return nil, fmt.Errorf("selecting sponsor balances: %w", err)
	}

	return bals, nil
}

// UpdateStatus sets the status of a campaign.
func (s *Store) UpdateStatus(ctx context.Context, campaignID uuid.UUID, status string) error {
	const q = `UPDATE sponsor_campaigns SET status = $1, updated_at = now() WHERE campaign_id = $2`

	res, err := s.db.ExecContext(ctx, q, status, campaignID)
	if err != nil {
		return fmt.Errorf("updating campaign status: %w", err)
	}

	rows, err := res.RowsAffected()
	if err != nil {
		return fmt.Errorf("checking rows affected: %w", err)
	}
	if rows == 0 {
		return v1.NewRequestError(v1.ErrNotFound, 404)
	}

	return nil
}

// QueryByAccount returns all campaigns created by the given account.
func (s *Store) QueryByAccount(ctx context.Context, accountID uuid.UUID) ([]sponsor.Campaign, error) {
	const q = `SELECT * FROM sponsor_campaigns WHERE created_by = $1 ORDER BY created_at DESC`

	var camps []sponsor.Campaign
	if err := s.db.SelectContext(ctx, &camps, q, accountID); err != nil {
		return nil, fmt.Errorf("selecting campaigns by account %s: %w", accountID, err)
	}

	return camps, nil
}

// CreateQuota inserts a new quota entry.
func (s *Store) CreateQuota(ctx context.Context, entry sponsor.QuotaEntry) error {
	const q = `
		INSERT INTO sponsor_quota_ledger (quota_id, campaign_id, coin_count, coins_spawned, token_amount, status, issued_at)
		VALUES ($1, $2, $3, $4, $5, $6, $7)`

	if _, err := s.db.ExecContext(ctx, q,
		entry.QuotaID, entry.CampaignID, entry.CoinCount, entry.CoinsSpawned,
		entry.TokenAmount, entry.Status, entry.IssuedAt,
	); err != nil {
		return fmt.Errorf("inserting quota entry: %w", err)
	}

	return nil
}

// ConsumeQuota marks a quota entry as consumed with the actual coins spawned.
func (s *Store) ConsumeQuota(ctx context.Context, quotaID uuid.UUID, coinsSpawned int) error {
	const q = `
		UPDATE sponsor_quota_ledger
		SET status = 'consumed', coins_spawned = $1, consumed_at = now()
		WHERE quota_id = $2 AND status = 'issued'`

	res, err := s.db.ExecContext(ctx, q, coinsSpawned, quotaID)
	if err != nil {
		return fmt.Errorf("consuming quota: %w", err)
	}

	rows, err := res.RowsAffected()
	if err != nil {
		return fmt.Errorf("checking rows affected: %w", err)
	}
	if rows == 0 {
		return fmt.Errorf("quota %s not found or already consumed", quotaID)
	}

	return nil
}

// QueryStaleQuotas finds issued quotas older than the given cutoff time.
func (s *Store) QueryStaleQuotas(ctx context.Context, olderThan time.Time) ([]sponsor.QuotaEntry, error) {
	const q = `
		SELECT * FROM sponsor_quota_ledger
		WHERE status = 'issued' AND issued_at < $1
		ORDER BY issued_at ASC`

	var entries []sponsor.QuotaEntry
	if err := s.db.SelectContext(ctx, &entries, q, olderThan); err != nil {
		return nil, fmt.Errorf("selecting stale quotas: %w", err)
	}

	return entries, nil
}

// RefundQuota marks a quota entry as refunded.
func (s *Store) RefundQuota(ctx context.Context, quotaID uuid.UUID) error {
	const q = `
		UPDATE sponsor_quota_ledger
		SET status = 'refunded'
		WHERE quota_id = $1 AND status = 'issued'`

	res, err := s.db.ExecContext(ctx, q, quotaID)
	if err != nil {
		return fmt.Errorf("refunding quota: %w", err)
	}

	rows, err := res.RowsAffected()
	if err != nil {
		return fmt.Errorf("checking rows affected: %w", err)
	}
	if rows == 0 {
		return fmt.Errorf("quota %s not found or not in issued status", quotaID)
	}

	return nil
}
