import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { getDepositAddress, getDeposits, type DepositAddress, type DepositRecord } from '../net/DepositClient';
import './DepositPage.css';

interface DepositPageProps {
  token: string;
  apiUrl: string;
}

function formatAmount(raw: string): string {
  const n = parseFloat(raw);
  return Number.isFinite(n) ? n.toFixed(2) : raw;
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

export const DepositPage: React.FC<DepositPageProps> = ({ token, apiUrl }) => {
  const [address, setAddress] = useState<DepositAddress | null>(null);
  const [deposits, setDeposits] = useState<DepositRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const refreshTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchData = useCallback(async () => {
    try {
      const [addr, hist] = await Promise.all([
        getDepositAddress(apiUrl, token),
        getDeposits(apiUrl, token),
      ]);
      setAddress(addr);
      setDeposits(hist.deposits ?? []);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load deposit info');
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

  const handleCopy = useCallback(async () => {
    if (!address) return;
    try {
      await navigator.clipboard.writeText(address.address);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // fallback: select text
    }
  }, [address]);

  return (
    <div className="deposit-page">
      <div className="deposit-header">
        <Link to="/" className="deposit-back-link">&larr; Back to Game</Link>
        <h1 className="deposit-title">Deposit USDC</h1>
      </div>

      {loading ? (
        <div className="deposit-loading">Loading...</div>
      ) : error ? (
        <div className="deposit-error">
          <p>{error}</p>
          <button className="deposit-retry-btn" onClick={fetchData}>Retry</button>
        </div>
      ) : address ? (
        <>
          <div className="deposit-card">
            <div className="deposit-card-label">Your Base Chain Address</div>
            <div className="deposit-address">{address.address}</div>
            <button className="deposit-copy-btn" onClick={handleCopy}>
              {copied ? 'Copied!' : 'Copy Address'}
            </button>
            <div className="deposit-meta">
              <div className="deposit-meta-row">
                <span className="deposit-meta-key">Chain</span>
                <span className="deposit-meta-val">Base ({address.chain_id})</span>
              </div>
              <div className="deposit-meta-row">
                <span className="deposit-meta-key">Token</span>
                <span className="deposit-meta-val">USDC</span>
              </div>
              <div className="deposit-meta-row">
                <span className="deposit-meta-key">Min Deposit</span>
                <span className="deposit-meta-val">{formatAmount(address.min_deposit)} USDC</span>
              </div>
            </div>
          </div>

          <div className="deposit-warning">
            Send only USDC on Base chain. Other tokens will be lost.
          </div>

          <div className="deposit-history">
            <div className="deposit-history-title">Recent Deposits</div>
            {deposits.length === 0 ? (
              <div className="deposit-history-empty">No deposits yet</div>
            ) : (
              <div className="deposit-history-list">
                {deposits.map(d => (
                  <div key={d.deposit_id} className="deposit-history-row">
                    <span className="deposit-history-amount">{formatAmount(d.amount)} USDC</span>
                    <span className={`deposit-history-status status-${d.status}`}>
                      {d.status === 'confirmed' ? '\u2713' : '\u23F3'} {d.status}
                    </span>
                    <span className="deposit-history-date">{formatDate(d.created_at)}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </>
      ) : null}
    </div>
  );
};
