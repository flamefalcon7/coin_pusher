// Package sponsor provides the sponsor campaign domain logic.
package sponsor

import (
	"time"

	"github.com/google/uuid"
	"github.com/shopspring/decimal"
)

// Campaign status values.
const (
	StatusActive   = "active"
	StatusDepleted = "depleted"
	StatusPaused   = "paused"
	StatusExpired  = "expired"
)

// Quota status values.
const (
	QuotaIssued   = "issued"
	QuotaConsumed = "consumed"
	QuotaRefunded = "refunded"
)

// Campaign represents a sponsor campaign with a token reward pool.
type Campaign struct {
	CampaignID   uuid.UUID       `db:"campaign_id" json:"campaign_id"`
	CreatedBy    uuid.UUID       `db:"created_by" json:"created_by"`
	Chain        string          `db:"chain" json:"chain"`
	TokenAddress string          `db:"token_address" json:"token_address"`
	TokenSymbol  string          `db:"token_symbol" json:"token_symbol"`
	TokenDecimals int            `db:"token_decimals" json:"token_decimals"`
	BrandColor   string          `db:"brand_color" json:"brand_color"`
	BrandName    string          `db:"brand_name" json:"brand_name"`
	LogoURL      string          `db:"logo_url" json:"logo_url"`
	AdImageURL   string          `db:"ad_image_url" json:"ad_image_url"`
	PoolTotal    decimal.Decimal `db:"pool_total" json:"pool_total"`
	PoolRemaining decimal.Decimal `db:"pool_remaining" json:"pool_remaining"`
	RewardPerCoin decimal.Decimal `db:"reward_per_coin" json:"reward_per_coin"`
	Status       string          `db:"status" json:"status"`
	CreatedAt    time.Time       `db:"created_at" json:"created_at"`
	UpdatedAt    time.Time       `db:"updated_at" json:"updated_at"`
}

// NewCampaign contains information needed to create a new sponsor campaign.
type NewCampaign struct {
	CreatedBy     uuid.UUID
	Chain         string
	TokenAddress  string
	TokenSymbol   string
	TokenDecimals int
	BrandColor    string
	BrandName     string
	LogoURL       string
	AdImageURL    string
	PoolTotal     decimal.Decimal
	RewardPerCoin decimal.Decimal
}

// QuotaEntry represents a quota allocation from a campaign pool.
type QuotaEntry struct {
	QuotaID      uuid.UUID       `db:"quota_id" json:"quota_id"`
	CampaignID   uuid.UUID       `db:"campaign_id" json:"campaign_id"`
	CoinCount    int             `db:"coin_count" json:"coin_count"`
	CoinsSpawned int             `db:"coins_spawned" json:"coins_spawned"`
	TokenAmount  decimal.Decimal `db:"token_amount" json:"token_amount"`
	Status       string          `db:"status" json:"status"`
	IssuedAt     time.Time       `db:"issued_at" json:"issued_at"`
	ConsumedAt   *time.Time      `db:"consumed_at" json:"consumed_at"`
}

// SponsorBalance represents a player's accumulated sponsor token balance.
type SponsorBalance struct {
	AccountID  uuid.UUID       `db:"account_id" json:"account_id"`
	CampaignID uuid.UUID       `db:"campaign_id" json:"campaign_id"`
	Balance    decimal.Decimal `db:"balance" json:"balance"`
	UpdatedAt  time.Time       `db:"updated_at" json:"updated_at"`
}

// RewardLog represents a single sponsor reward distribution event.
type RewardLog struct {
	LogID      uuid.UUID       `db:"log_id" json:"log_id"`
	AccountID  uuid.UUID       `db:"account_id" json:"account_id"`
	CampaignID uuid.UUID       `db:"campaign_id" json:"campaign_id"`
	Amount     decimal.Decimal `db:"amount" json:"amount"`
	RefKey     string          `db:"ref_key" json:"ref_key"`
	CreatedAt  time.Time       `db:"created_at" json:"created_at"`
}
