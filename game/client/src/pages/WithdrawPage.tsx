import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { requestWithdrawal, getWithdrawals, getWithdrawNonce, type WithdrawalRecord } from '../net/DepositClient';
import { getSavedAddress } from '../net/auth';
import './WithdrawPage.css';

const WITHDRAW_FEE_USDC = 0.5;
const WITHDRAW_FEE_CASH = 5; // 0.50 USDC × 10
const EXCHANGE_RATE = 10;

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
  const netReceiveUSDC = Math.max(0, amountNum / EXCHANGE_RATE - WITHDRAW_FEE_USDC);

  const handleMax = useCallback(() => {
    const max = Math.max(0, cashNum);
    // Floor to 2 decimals to avoid rounding up past actual balance
    const floored = Math.floor(max * 100) / 100;
    setAmount(floored > 0 ? floored.toFixed(2) : '');
  }, [cashNum]);

  const handleSubmit = useCallback(async () => {
    if (submitting) return;
    setError(null);
    setSuccess(null);

    if (!isValidAddress(toAddress)) {
      setError('Invalid address. Must be 0x followed by 40 hex characters.');
      return;
    }
    if (amountNum < 10) {
      setError('Minimum withdrawal is 10 coins (1 USDC).');
      return;
    }
    if (amountNum > cashNum) {
      setError('Insufficient balance.');
      return;
    }

    setSubmitting(true);
    try {
      // 1. Fetch one-time nonce from server.
      const { nonce } = await getWithdrawNonce(apiUrl, token);

      // 2. Build the canonical withdraw message and sign with wallet.
      // Sign with USDC amount (real money), not cash coins.
      const usdcAmount = (amountNum / EXCHANGE_RATE).toFixed(6);
      const amountFixed = amountNum.toFixed(6); // cash coins for API
      const normalizedTo = toAddress; // Server normalizes via EIP-55
      const message = `Coin Pusher Withdraw\nTo: ${normalizedTo}\nAmount: ${usdcAmount} USDC\nNonce: ${nonce}`;

      const eth = window.ethereum;
      if (!eth) throw new Error('No wallet found. Please install MetaMask.');

      const savedAddr = getSavedAddress();
      if (!savedAddr) throw new Error('No wallet address found. Please reconnect your wallet.');

      const signature = (await eth.request({
        method: 'personal_sign',
        params: [message, savedAddr],
      })) as string;

      // 3. Submit withdrawal with nonce + signature.
      const res = await requestWithdrawal(apiUrl, token, {
        to_address: toAddress,
        amount: amountFixed,
        nonce,
        signature,
      });
      setSuccess(`Withdrawal submitted! You will receive ${formatAmount(res.net_amount)} USDC`);
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

  // Withdrawals must be signed by the linked wallet. A session with no wallet
  // address (passcode admin login) has nothing to sign with, and the server
  // refuses such accounts anyway — say so instead of showing a dead form.
  if (!getSavedAddress()) {
    return (
      <div className="withdraw-page">
        <div className="withdraw-header">
          <Link to="/" className="withdraw-back-link">&larr; Back to Game</Link>
          <h1 className="withdraw-title">Withdraw USDC</h1>
        </div>
        <div className="withdraw-card">
          <p className="withdraw-msg withdraw-msg-error">
            Withdrawals require a connected wallet. This session was signed in without one.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="withdraw-page">
      <div className="withdraw-header">
        <Link to="/" className="withdraw-back-link">&larr; Back to Game</Link>
        <h1 className="withdraw-title">Withdraw USDC</h1>
      </div>

      <div className="withdraw-balance-banner">
        Withdrawable balance: <span className="withdraw-balance-amount">{formatAmount(balanceCash)}</span>
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

        <label className="withdraw-label">Amount (coins)</label>
        <div className="withdraw-amount-row">
          <input
            className="withdraw-input withdraw-amount-input"
            type="number"
            placeholder="0.00"
            value={amount}
            onChange={e => setAmount(e.target.value)}
            disabled={submitting}
            min="10"
            step="1"
          />
          <button className="withdraw-max-btn" onClick={handleMax} disabled={submitting}>MAX</button>
        </div>

        <div className="withdraw-fee-row">
          <span>Fee</span>
          <span>{WITHDRAW_FEE_USDC.toFixed(2)} USDC ({WITHDRAW_FEE_CASH} coins)</span>
        </div>
        <div className="withdraw-fee-row withdraw-receive">
          <span>You receive</span>
          <span>{netReceiveUSDC > 0 ? netReceiveUSDC.toFixed(2) : '0.00'} USDC</span>
        </div>

        {error && <div className="withdraw-msg withdraw-msg-error">{error}</div>}
        {success && <div className="withdraw-msg withdraw-msg-success">{success}</div>}

        <button
          className="withdraw-submit-btn"
          onClick={handleSubmit}
          disabled={submitting || amountNum < 10}
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
                <span className="withdraw-history-amount">{formatAmount(w.amount)}</span>
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
