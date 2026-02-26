interface PlayerInfoProps {
  balance: string;
  onLogout: () => void;
}

export function PlayerInfo({ balance, onLogout }: PlayerInfoProps) {
  // Format balance: strip trailing zeros, show 2 decimal places minimum
  const num = parseFloat(balance);
  const display = Number.isFinite(num) ? num.toLocaleString(undefined, {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  }) : balance;

  return (
    <div className="player-info">
      <span className="player-info-balance">{display} play coin</span>
      <button className="player-info-logout" onClick={onLogout}>
        Logout
      </button>
    </div>
  );
}
