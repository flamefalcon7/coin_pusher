import { useState, useEffect, useRef } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { InfoTip } from './InfoTip';
import { useIsMobile } from './useIsMobile';

interface PlayerInfoProps {
  balancePlay: string;
  balanceCash: string;
  displayName: string | null;
  address: string;
  onLogout: () => void;
}

function fmt(raw: string): string {
  const num = parseFloat(raw);
  return Number.isFinite(num) ? num.toLocaleString(undefined, {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  }) : raw;
}

function truncAddr(addr: string): string {
  if (addr.length <= 12) return addr;
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
}

export function PlayerInfo({ balancePlay, balanceCash, displayName, address, onLogout }: PlayerInfoProps) {
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
            <span className="player-info-label">Play</span> {fmt(balancePlay)}
          </span>
          <span className="player-info-balance player-info-cash">
            <span className="player-info-label">Cash</span> {fmt(balanceCash)}
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
          <span className="player-info-label">Play <InfoTip text="Chips for inserting coins. Deposit USDC to get more." position="bottom" /></span> {fmt(balancePlay)}
        </span>
        <span className="player-info-balance player-info-cash">
          <span className="player-info-label">Cash <InfoTip text="Withdrawable rewards. Earned when coins fall off the front edge." position="bottom" /></span> {fmt(balanceCash)}
        </span>
      </div>
      <div className="player-info-actions">
        <Link to="/profile" className="player-info-action-btn player-info-profile">Profile</Link>
        <Link to="/progress" className="player-info-action-btn player-info-missions">Missions</Link>
        <Link to="/deposit" className="player-info-action-btn player-info-deposit">Deposit</Link>
        <Link to="/withdraw" className="player-info-action-btn player-info-withdraw">Withdraw</Link>
        <button className="player-info-logout" onClick={onLogout}>
          Logout
        </button>
      </div>
    </div>
  );
}
