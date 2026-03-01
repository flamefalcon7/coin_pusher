import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { getUserProgress, claimProgress, type UserProgressItem } from '../net/ProgressClient';
import './ProgressPage.css';

interface ProgressPageProps {
  token: string;
  apiUrl: string;
  onBalanceChange?: (balancePlay: string, balanceCash: string) => void;
}

function formatAmount(raw: string): string {
  const n = parseFloat(raw);
  if (!Number.isFinite(n)) return raw;
  if (n >= 1000) return n.toLocaleString(undefined, { maximumFractionDigits: 2 });
  return n % 1 === 0 ? n.toString() : n.toFixed(2);
}

function rewardLabel(rewardType: string, rewardAmount: string): string {
  const amt = formatAmount(rewardAmount);
  switch (rewardType) {
    case 'play_coin': return `${amt} Play Coin`;
    case 'cash_coin': return `${amt} Cash Coin`;
    default:
      if (rewardType.startsWith('scroll_')) {
        const name = rewardType.slice(7).replace(/_/g, ' ');
        return `${amt} ${name} scroll`;
      }
      return `${amt} ${rewardType}`;
  }
}

function statusIcon(status: string): string {
  switch (status) {
    case 'disbursed': return '\u2713';
    case 'achieved': return '\u{1F381}';
    case 'expired': return '\u23F0';
    default: return '';
  }
}

function timeRemaining(iso: string): string {
  const diff = new Date(iso).getTime() - Date.now();
  if (diff <= 0) return 'now';
  const mins = Math.floor(diff / 60000);
  const hrs = Math.floor(mins / 60);
  const days = Math.floor(hrs / 24);
  if (days > 0) return `${days}d ${hrs % 24}h`;
  if (hrs > 0) return `${hrs}h ${mins % 60}m`;
  return `${mins}m`;
}

export const ProgressPage: React.FC<ProgressPageProps> = ({ token, apiUrl, onBalanceChange }) => {
  const [items, setItems] = useState<UserProgressItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const refreshTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchData = useCallback(async () => {
    try {
      const data = await getUserProgress(apiUrl, token);
      setItems(data.progress ?? []);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load progress');
    } finally {
      setLoading(false);
    }
  }, [apiUrl, token]);

  useEffect(() => {
    fetchData();
    refreshTimer.current = setInterval(fetchData, 30_000);
    return () => {
      if (refreshTimer.current) clearInterval(refreshTimer.current);
    };
  }, [fetchData]);

  const handleClaim = useCallback(async (progressId: string) => {
    try {
      const result = await claimProgress(apiUrl, token, progressId);
      if (result.balance_play && onBalanceChange) {
        onBalanceChange(result.balance_play, result.balance_cash);
      }
      fetchData();
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Claim failed');
    }
  }, [apiUrl, token, fetchData, onBalanceChange]);

  return (
    <div className="progress-page">
      <div className="progress-header">
        <Link to="/" className="progress-back-link">&larr; Back to Game</Link>
        <h1 className="progress-title">Missions</h1>
      </div>

      {loading ? (
        <div className="progress-loading">Loading...</div>
      ) : error ? (
        <div className="progress-error">
          <p>{error}</p>
          <button className="progress-retry-btn" onClick={fetchData}>Retry</button>
        </div>
      ) : items.length === 0 ? (
        <div className="progress-empty">No active missions</div>
      ) : (
        <div className="progress-list">
          {items.map(item => (
            <ProgressCard key={item.progress_id} item={item} onClaim={handleClaim} />
          ))}
        </div>
      )}
    </div>
  );
};

function ProgressCard({ item, onClaim }: { item: UserProgressItem; onClaim: (id: string) => void }) {
  const current = parseFloat(item.current_value) || 0;
  const threshold = parseFloat(item.threshold) || 1;
  const pct = Math.min(current / threshold, 1) * 100;
  const done = item.status === 'achieved' || item.status === 'disbursed' || item.status === 'expired';

  const now = Date.now();
  const isAchieved = item.status === 'achieved';
  const canClaim = isAchieved && item.claimable_at && new Date(item.claimable_at).getTime() <= now;
  const inCooldown = isAchieved && item.claimable_at && new Date(item.claimable_at).getTime() > now;

  return (
    <div className={`progress-card ${done ? 'progress-card--done' : ''}`}>
      <div className="progress-card-top">
        <div className="progress-card-info">
          <div className="progress-card-title">{item.title}</div>
          {item.description && (
            <div className="progress-card-desc">{item.description}</div>
          )}
        </div>
        <div className={`progress-card-status progress-card-status--${item.status}`}>
          {statusIcon(item.status)} {item.status === 'disbursed' ? 'Claimed' : item.status === 'achieved' ? (canClaim ? 'Ready' : 'Pending') : item.status === 'expired' ? 'Expired' : ''}
        </div>
      </div>

      <div className="progress-card-bar-wrap">
        <div className="progress-card-bar">
          <div
            className={`progress-card-bar-fill ${done ? 'progress-card-bar-fill--done' : ''}`}
            style={{ width: `${pct}%` }}
          />
        </div>
        <div className="progress-card-nums">
          <span>{formatAmount(item.current_value)}</span>
          <span>{formatAmount(item.threshold)}</span>
        </div>
      </div>

      <div className="progress-card-reward">
        <span className="progress-card-reward-label">Reward</span>
        <span className="progress-card-reward-value">{rewardLabel(item.reward_type, item.reward_amount)}</span>
      </div>

      {/* Claim button or timing info */}
      {canClaim && (
        <div className="progress-card-claim-row">
          <button className="progress-card-claim-btn" onClick={() => onClaim(item.progress_id)}>
            Claim Reward
          </button>
          {item.expires_at && (
            <span className="progress-card-expires">Expires in {timeRemaining(item.expires_at)}</span>
          )}
        </div>
      )}

      {inCooldown && (
        <div className="progress-card-timing">
          Claimable in {timeRemaining(item.claimable_at!)}
        </div>
      )}

      {item.status === 'expired' && (
        <div className="progress-card-timing progress-card-timing--expired">
          Reward expired
        </div>
      )}
    </div>
  );
}
