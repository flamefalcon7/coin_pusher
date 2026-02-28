import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { requestWithdrawal, getWithdrawals, type WithdrawalRecord } from '../net/DepositClient';
import './WithdrawPage.css';

const WITHDRAW_FEE = 0.5;

interface WithdrawPageProps {
  token: string;
  apiUrl: string;
  balanceCash: string;
  onBalanceChange?: (newBalance: string) => void;
}

function formatAmount(raw: string): string {
  const n = parseFloat(raw);
  return Number.isFinite(n) ? n.toFixed(2) : raw;
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

function isValidAddress(addr: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(addr);
}

export const WithdrawPage: React.FC<WithdrawPageProps> = ({ token, apiUrl, balanceCash, onBalanceChange }) => {
  const [toAddress, setToAddress] = useState('');
  const [amount, setAmount] = useState('');
  const [withdrawals, setWithdrawals] = useState<WithdrawalRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const refreshTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchWithdrawals = useCallback(async () => {
    try {
      const res = await getWithdrawals(apiUrl, token);
      setWithdrawals(res.withdrawals ?? []);
    } catch (err) {
      console.warn('Failed to fetch withdrawals:', err);
    } finally {
      setLoading(false);
    }
  }, [apiUrl, token]);

  useEffect(() => {
    fetchWithdrawals();
    refreshTimer.current = setInterval(fetchWithdrawals, 30_000);
    return () => {
      if (refreshTimer.current) clearInterval(refreshTimer.current);
    };
  }, [fetchWithdrawals]);

  const cashNum = parseFloat(balanceCash) || 0;
  const amountNum = parseFloat(amount) || 0;
  const netReceive = Math.max(0, amountNum - WITHDRAW_FEE);

  const handleMax = useCallback(() => {
    const max = Math.max(0, cashNum);
    setAmount(max > 0 ? max.toFixed(2) : '');
  }, [cashNum]);

  const handleSubmit = useCallback(async () => {
    if (submitting) return;
    setError(null);
    setSuccess(null);

    if (!isValidAddress(toAddress)) {
      setError('Invalid address. Must be 0x followed by 40 hex characters.');
      return;
    }
    if (amountNum < 1) {
      setError('Minimum withdrawal is 1 USDC.');
      return;
    }
    if (amountNum > cashNum) {
      setError('Insufficient balance.');
      return;
    }

    setSubmitting(true);
    try {
      const res = await requestWithdrawal(apiUrl, token, {
        to_address: toAddress,
        amount: amountNum.toFixed(6),
      });
      setSuccess(`Withdrawal submitted: ${formatAmount(res.net_amount)} USDC`);
      setAmount('');
      setToAddress('');

      // Notify parent of balance change
      const newBal = (cashNum - amountNum).toFixed(6);
      onBalanceChange?.(newBal);

      // Refresh list
      await fetchWithdrawals();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Withdrawal failed');
    } finally {
      setSubmitting(false);
    }
  }, [toAddress, amountNum, cashNum, apiUrl, token, fetchWithdrawals, onBalanceChange]);

  const statusIcon = (status: string) => {
    switch (status) {
      case 'review': return '\uD83D\uDD0D';
      case 'approved':
      case 'submitted': return '\u23F3';
      case 'confirmed': return '\u2713';
      case 'failed':
      case 'rejected': return '\u2717';
      case 'refunded': return '\u21A9';
      default: return '\u23F3';
    }
  };

  return (
    <div className="withdraw-page">
      <div className="withdraw-header">
        <Link to="/" className="withdraw-back-link">&larr; Back to Game</Link>
        <h1 className="withdraw-title">Withdraw USDC</h1>
      </div>

      <div className="withdraw-balance-banner">
        Available: <span className="withdraw-balance-amount">{formatAmount(balanceCash)} USDC</span> (Cash)
      </div>

      <div className="withdraw-card">
        <label className="withdraw-label">To Address</label>
        <input
          className="withdraw-input"
          type="text"
          placeholder="0x..."
          value={toAddress}
          onChange={e => setToAddress(e.target.value.trim())}
          disabled={submitting}
          spellCheck={false}
          autoComplete="off"
        />

        <label className="withdraw-label">Amount (USDC)</label>
        <div className="withdraw-amount-row">
          <input
            className="withdraw-input withdraw-amount-input"
            type="number"
            placeholder="0.00"
            value={amount}
            onChange={e => setAmount(e.target.value)}
            disabled={submitting}
            min="1"
            step="0.01"
          />
          <button className="withdraw-max-btn" onClick={handleMax} disabled={submitting}>MAX</button>
        </div>

        <div className="withdraw-fee-row">
          <span>Fee</span>
          <span>{WITHDRAW_FEE.toFixed(2)} USDC</span>
        </div>
        <div className="withdraw-fee-row withdraw-receive">
          <span>You receive</span>
          <span>{netReceive > 0 ? netReceive.toFixed(2) : '0.00'} USDC</span>
        </div>

        {error && <div className="withdraw-msg withdraw-msg-error">{error}</div>}
        {success && <div className="withdraw-msg withdraw-msg-success">{success}</div>}

        <button
          className="withdraw-submit-btn"
          onClick={handleSubmit}
          disabled={submitting || amountNum < 1}
        >
          {submitting ? 'Processing...' : 'Withdraw'}
        </button>
      </div>

      <div className="withdraw-history">
        <div className="withdraw-history-title">Recent Withdrawals</div>
        {loading ? (
          <div className="withdraw-history-empty">Loading...</div>
        ) : withdrawals.length === 0 ? (
          <div className="withdraw-history-empty">No withdrawals yet</div>
        ) : (
          <div className="withdraw-history-list">
            {withdrawals.map(w => (
              <div key={w.withdrawal_id} className="withdraw-history-row">
                <span className="withdraw-history-amount">{formatAmount(w.amount)} USDC</span>
                <span className={`withdraw-history-status status-${w.status}`}>
                  {statusIcon(w.status)} {w.status}
                </span>
                <span className="withdraw-history-date">{formatDate(w.created_at)}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};
