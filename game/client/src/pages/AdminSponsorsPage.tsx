import React, { useState, useEffect, useCallback } from 'react';
import { Link } from 'react-router-dom';
import {
  listActiveCampaigns,
  pauseCampaign,
  resumeCampaign,
  removeCampaign,
  type Campaign,
} from '../net/SponsorClient';
import { CampaignCard } from '../ui/CampaignCard';
import './AdminSponsorsPage.css';

interface AdminSponsorsPageProps {
  token: string;
  apiUrl: string;
}

type StatusFilter = 'all' | 'active' | 'depleted' | 'paused' | 'expired';

const FILTERS: StatusFilter[] = ['all', 'active', 'depleted', 'paused', 'expired'];

function countByStatus(campaigns: Campaign[]): Record<string, number> {
  const counts: Record<string, number> = { active: 0, depleted: 0, paused: 0, expired: 0 };
  for (const c of campaigns) {
    if (c.status in counts) counts[c.status]++;
  }
  return counts;
}

export const AdminSponsorsPage: React.FC<AdminSponsorsPageProps> = ({ token, apiUrl }) => {
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<StatusFilter>('all');
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [confirmRemoveId, setConfirmRemoveId] = useState<string | null>(null);

  const fetchData = useCallback(async () => {
    try {
      const data = await listActiveCampaigns(apiUrl);
      setCampaigns(data ?? []);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load campaigns');
    } finally {
      setLoading(false);
    }
  }, [apiUrl]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const handlePause = useCallback(async (id: string) => {
    setActionLoading(id);
    try {
      await pauseCampaign(apiUrl, token, id);
      await fetchData();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Pause failed');
    } finally {
      setActionLoading(null);
    }
  }, [apiUrl, token, fetchData]);

  const handleResume = useCallback(async (id: string) => {
    setActionLoading(id);
    try {
      await resumeCampaign(apiUrl, token, id);
      await fetchData();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Resume failed');
    } finally {
      setActionLoading(null);
    }
  }, [apiUrl, token, fetchData]);

  const handleRemove = useCallback(async (id: string) => {
    setConfirmRemoveId(null);
    setActionLoading(id);
    try {
      await removeCampaign(apiUrl, token, id);
      await fetchData();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Remove failed');
    } finally {
      setActionLoading(null);
    }
  }, [apiUrl, token, fetchData]);

  const counts = countByStatus(campaigns);
  const filtered = filter === 'all' ? campaigns : campaigns.filter((c) => c.status === filter);

  return (
    <div className="admin-sponsors-page">
      <div className="admin-sponsors-header">
        <Link to="/" className="admin-sponsors-back-link">&larr; Back to Game</Link>
        <h1 className="admin-sponsors-title">Admin: Sponsors</h1>
      </div>

      {loading ? (
        <div className="admin-sponsors-loading">Loading...</div>
      ) : error ? (
        <div className="admin-sponsors-error">
          <p>{error}</p>
          <button className="admin-sponsors-retry-btn" onClick={fetchData}>Retry</button>
        </div>
      ) : (
        <div className="admin-sponsors-sections">

          {/* ── Stats Bar ── */}
          <div className="admin-sponsors-stats">
            <span className="admin-sponsors-stat">
              Active:<span className="admin-sponsors-stat-count">{counts.active}</span>
            </span>
            <span className="admin-sponsors-stat">
              Depleted:<span className="admin-sponsors-stat-count">{counts.depleted}</span>
            </span>
            <span className="admin-sponsors-stat">
              Paused:<span className="admin-sponsors-stat-count">{counts.paused}</span>
            </span>
            <span className="admin-sponsors-stat">
              Expired:<span className="admin-sponsors-stat-count">{counts.expired}</span>
            </span>
          </div>

          {/* ── Status Filter ── */}
          <div className="admin-sponsors-filters">
            {FILTERS.map((f) => (
              <button
                key={f}
                className={`admin-sponsors-filter-btn ${filter === f ? 'admin-sponsors-filter-btn--active' : ''}`}
                onClick={() => setFilter(f)}
              >
                {f.charAt(0).toUpperCase() + f.slice(1)}
              </button>
            ))}
          </div>

          {/* ── Campaign List ── */}
          {filtered.length === 0 ? (
            <div className="admin-sponsors-empty">No campaigns match this filter.</div>
          ) : (
            <div className="admin-sponsors-list">
              {filtered.map((c) => (
                <CampaignCard
                  key={c.campaign_id}
                  campaign={c}
                  expanded={expandedId === c.campaign_id}
                  onToggle={() => setExpandedId(expandedId === c.campaign_id ? null : c.campaign_id)}
                >
                  {c.status === 'active' && (
                    <button
                      className="admin-sponsors-action-btn admin-sponsors-action-btn--pause"
                      onClick={() => handlePause(c.campaign_id)}
                      disabled={actionLoading === c.campaign_id}
                    >
                      {actionLoading === c.campaign_id ? '...' : 'Pause'}
                    </button>
                  )}
                  {c.status === 'paused' && (
                    <button
                      className="admin-sponsors-action-btn admin-sponsors-action-btn--resume"
                      onClick={() => handleResume(c.campaign_id)}
                      disabled={actionLoading === c.campaign_id}
                    >
                      {actionLoading === c.campaign_id ? '...' : 'Resume'}
                    </button>
                  )}
                  {c.status !== 'expired' && (
                    <button
                      className="admin-sponsors-action-btn admin-sponsors-action-btn--remove"
                      onClick={() => setConfirmRemoveId(c.campaign_id)}
                      disabled={actionLoading === c.campaign_id}
                    >
                      Remove
                    </button>
                  )}
                </CampaignCard>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ── Confirm Remove Dialog ── */}
      {confirmRemoveId && (
        <div className="admin-sponsors-confirm">
          <div className="admin-sponsors-confirm-card">
            <p className="admin-sponsors-confirm-text">
              Are you sure you want to remove this campaign? This cannot be undone.
            </p>
            <div className="admin-sponsors-confirm-actions">
              <button
                className="admin-sponsors-confirm-cancel"
                onClick={() => setConfirmRemoveId(null)}
              >
                Cancel
              </button>
              <button
                className="admin-sponsors-confirm-yes"
                onClick={() => handleRemove(confirmRemoveId)}
              >
                Remove
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
