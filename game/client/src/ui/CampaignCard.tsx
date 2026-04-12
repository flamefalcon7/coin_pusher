import type { ReactNode } from 'react';
import type { Campaign } from '../net/SponsorClient';
import './CampaignCard.css';

interface CampaignCardProps {
  campaign: Campaign;
  expanded?: boolean;
  onToggle?: () => void;
  children?: ReactNode;
}

function statusClass(status: string): string {
  switch (status) {
    case 'active': return 'campaign-card-status--active';
    case 'depleted': return 'campaign-card-status--depleted';
    case 'paused': return 'campaign-card-status--paused';
    case 'expired': return 'campaign-card-status--expired';
    default: return 'campaign-card-status--expired';
  }
}

function poolPercent(remaining: string, total: string): number {
  const r = parseFloat(remaining);
  const t = parseFloat(total);
  if (!t || !Number.isFinite(r) || !Number.isFinite(t)) return 0;
  return Math.min(Math.max((r / t) * 100, 0), 100);
}

export function CampaignCard({ campaign, expanded, onToggle, children }: CampaignCardProps) {
  const pct = poolPercent(campaign.pool_remaining, campaign.pool_total);

  return (
    <div className="campaign-card" onClick={onToggle}>
      <div className="campaign-card-header">
        <div
          className="campaign-card-color-swatch"
          style={{ backgroundColor: campaign.brand_color || '#888' }}
        />
        <span className="campaign-card-brand">{campaign.brand_name}</span>
        <span className="campaign-card-symbol">{campaign.token_symbol}</span>
        <span className={`campaign-card-status ${statusClass(campaign.status)}`}>
          {campaign.status}
        </span>
      </div>

      <div className="campaign-card-pool">
        <div className="campaign-card-pool-label">
          <span>Pool</span>
          <span>{campaign.pool_remaining} / {campaign.pool_total}</span>
        </div>
        <div className="campaign-card-pool-bar">
          <div className="campaign-card-pool-fill" style={{ width: `${pct}%` }} />
        </div>
      </div>

      {expanded && (
        <div className="campaign-card-details">
          <div className="campaign-card-detail-row">
            <span className="campaign-card-detail-label">Chain</span>
            <span className="campaign-card-detail-value">{campaign.chain}</span>
          </div>
          <div className="campaign-card-detail-row">
            <span className="campaign-card-detail-label">Token Address</span>
            <span className="campaign-card-detail-value">{campaign.token_address}</span>
          </div>
          <div className="campaign-card-detail-row">
            <span className="campaign-card-detail-label">Reward / Coin</span>
            <span className="campaign-card-detail-value">{campaign.reward_per_coin}</span>
          </div>
          <div className="campaign-card-detail-row">
            <span className="campaign-card-detail-label">Created</span>
            <span className="campaign-card-detail-value">
              {new Date(campaign.created_at).toLocaleDateString()}
            </span>
          </div>
        </div>
      )}

      {children && (
        <div className="campaign-card-actions" onClick={(e) => e.stopPropagation()}>
          {children}
        </div>
      )}
    </div>
  );
}
