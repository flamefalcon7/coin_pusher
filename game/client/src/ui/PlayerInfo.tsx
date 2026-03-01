import { Link } from 'react-router-dom';

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
  return (
    <div className="player-info">
      <div className="player-info-name">{displayName ?? truncAddr(address)}</div>
      <div className="player-info-balances">
        <span className="player-info-balance">
          <span className="player-info-label">Play</span> {fmt(balancePlay)}
        </span>
        <span className="player-info-balance player-info-cash">
          <span className="player-info-label">Cash</span> {fmt(balanceCash)}
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
