package sponsor

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/nats-io/nats.go"
	"go.uber.org/zap"
)

// Publisher publishes sponsor-related messages to NATS topics.
type Publisher struct {
	log  *zap.SugaredLogger
	nc   *nats.Conn
	core *Core
	room string
}

// NewPublisher constructs a Publisher.
func NewPublisher(log *zap.SugaredLogger, nc *nats.Conn, core *Core, room string) *Publisher {
	return &Publisher{
		log:  log,
		nc:   nc,
		core: core,
		room: room,
	}
}

// sponsorConfigEntry is a single sponsor in the config message.
type sponsorConfigEntry struct {
	ID          string `json:"id"`
	BrandName   string `json:"brand_name"`
	BrandColor  string `json:"brand_color"`
	TokenSymbol string `json:"token_symbol"`
	LogoURL     string `json:"logo_url"`
	AdImageURL  string `json:"ad_image_url"`
}

// sponsorConfigMessage is the NATS message payload for sponsor config updates.
type sponsorConfigMessage struct {
	Op       string               `json:"op"`
	Sponsors []sponsorConfigEntry `json:"sponsors"`
}

// PublishConfig queries active campaigns and publishes the sponsor_config message.
func (p *Publisher) PublishConfig(ctx context.Context) error {
	camps, err := p.core.ListActive(ctx)
	if err != nil {
		return fmt.Errorf("listing active campaigns: %w", err)
	}

	msg := sponsorConfigMessage{
		Op:       "sponsor_config",
		Sponsors: make([]sponsorConfigEntry, 0, len(camps)),
	}

	for _, camp := range camps {
		msg.Sponsors = append(msg.Sponsors, sponsorConfigEntry{
			ID:          camp.CampaignID.String(),
			BrandName:   camp.BrandName,
			BrandColor:  camp.BrandColor,
			TokenSymbol: camp.TokenSymbol,
			LogoURL:     camp.LogoURL,
			AdImageURL:  camp.AdImageURL,
		})
	}

	data, err := json.Marshal(msg)
	if err != nil {
		return fmt.Errorf("marshaling sponsor config: %w", err)
	}

	topic := "game." + p.room + ".sponsor_config"
	if err := p.nc.Publish(topic, data); err != nil {
		return fmt.Errorf("publishing sponsor config: %w", err)
	}

	p.log.Infow("published sponsor config", "sponsors", len(msg.Sponsors))
	return nil
}

// PublishQuota publishes a sponsor_quota command to the game server.
func (p *Publisher) PublishQuota(quotaID, sponsorID string, coinCount int) error {
	msg := struct {
		QuotaID   string `json:"quota_id"`
		SponsorID string `json:"sponsor_id"`
		CoinCount int    `json:"coin_count"`
	}{
		QuotaID:   quotaID,
		SponsorID: sponsorID,
		CoinCount: coinCount,
	}

	data, err := json.Marshal(msg)
	if err != nil {
		return fmt.Errorf("marshaling sponsor quota: %w", err)
	}

	topic := "game." + p.room + ".cmd.sponsor_quota"
	if err := p.nc.Publish(topic, data); err != nil {
		return fmt.Errorf("publishing sponsor quota: %w", err)
	}

	return nil
}

// PublishBonusDrop publishes a sponsor bonus drop command.
func (p *Publisher) PublishBonusDrop(sponsorID, sponsorName, tokenSymbol string, coinCount int) error {
	msg := struct {
		SponsorID   string `json:"sponsor_id"`
		SponsorName string `json:"sponsor_name"`
		TokenSymbol string `json:"token_symbol"`
		CoinCount   int    `json:"coin_count"`
	}{
		SponsorID:   sponsorID,
		SponsorName: sponsorName,
		TokenSymbol: tokenSymbol,
		CoinCount:   coinCount,
	}

	data, err := json.Marshal(msg)
	if err != nil {
		return fmt.Errorf("marshaling sponsor bonus drop: %w", err)
	}

	topic := "game." + p.room + ".cmd.sponsor_bonus"
	if err := p.nc.Publish(topic, data); err != nil {
		return fmt.Errorf("publishing sponsor bonus drop: %w", err)
	}

	p.log.Infow("published sponsor bonus drop", "sponsor_id", sponsorID, "coins", coinCount)
	return nil
}
