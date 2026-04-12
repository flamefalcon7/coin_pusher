import { useState, useEffect, useRef } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { InfoTip } from './InfoTip';
import { useIsMobile } from './useIsMobile';

interface PlayerInfoProps {
  balancePlay: string;
  balanceCash: string;
  displayName: string | null;
  address: string;
  role?: string;
  onLogout: () => void;
}

function fmt(raw: string): string {
  const num = parseFloat(raw);
  return Number.isFinite(num) ? num.toLocaleString(undefined, {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  }) : raw;
}

function fmtTotal(play: string, cash: string): string {
  const p = parseFloat(play);
  const c = parseFloat(cash);
  const total = (Number.isFinite(p) ? p : 0) + (Number.isFinite(c) ? c : 0);
  return total.toLocaleString(undefined, {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  });
}

const WALLET_INFO_TEXT =
  "Your balance is the sum of play coins and withdrawable rewards. " +
  "Inserting coins consumes play coins first; once play coins are empty, " +
  "withdrawable rewards are used. Only the withdrawable balance can be withdrawn.";

function truncAddr(addr: string): string {
  if (addr.length <= 12) return addr;
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
}

export function PlayerInfo({ balancePlay, balanceCash, displayName, address, role, onLogout }: PlayerInfoProps) {
  const isMobile = useIsMobile();
  const [collapsed, setCollapsed] = useState(true);
  const panelRef = useRef<HTMLDivElement>(null);
  const location = useLocation();

  // Auto-collapse on route change (navigating to sub-pages)
  useEffect(() => {
    setCollapsed(true);
  }, [location.pathname]);

  // Close on outside tap
  useEffect(() => {
    if (!isMobile || collapsed) return;
    const handler = (e: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        setCollapsed(true);
      }
    };
    document.addEventListener('pointerdown', handler);
    return () => document.removeEventListener('pointerdown', handler);
  }, [isMobile, collapsed]);

  if (isMobile && collapsed) {
    return (
      <div className="player-info player-info--collapsed" onClick={() => setCollapsed(false)}>
        <div className="player-info-balances">
          <span className="player-info-balance">
            <span className="player-info-label">Balance</span> {fmtTotal(balancePlay, balanceCash)}
          </span>
          <span className="player-info-balance player-info-cash">
            <span className="player-info-label">Withdrawable</span> {fmt(balanceCash)}
          </span>
          <span className="player-info-expand">▾</span>
        </div>
      </div>
    );
  }

  return (
    <div className="player-info" ref={panelRef}>
      {isMobile && (
        <button className="player-info-collapse-btn" onClick={() => setCollapsed(true)}>▴</button>
      )}
      <div className="player-info-name">{displayName ?? truncAddr(address)}</div>
      <div className="player-info-balances">
        <span className="player-info-balance">
          <span className="player-info-label">Balance <InfoTip text={WALLET_INFO_TEXT} position="bottom" /></span> {fmtTotal(balancePlay, balanceCash)}
        </span>
        <span className="player-info-balance player-info-cash">
          <span className="player-info-label">Withdrawable</span> {fmt(balanceCash)}
        </span>
      </div>
      <div className="player-info-actions">
        <Link to="/profile" className="player-info-action-btn player-info-profile">Profile</Link>
        <Link to="/progress" className="player-info-action-btn player-info-missions">Missions</Link>
        <Link to="/deposit" className="player-info-action-btn player-info-deposit">Deposit</Link>
        <Link to="/withdraw" className="player-info-action-btn player-info-withdraw">Withdraw</Link>
        <Link to="/sponsor" className="player-info-action-btn player-info-sponsor">Sponsor</Link>
        {role === 'admin' && (
          <Link to="/admin/sponsors" className="player-info-action-btn player-info-admin-sponsors">Admin: Sponsors</Link>
        )}
        <button className="player-info-logout" onClick={onLogout}>
          Logout
        </button>
      </div>
    </div>
  );
}
