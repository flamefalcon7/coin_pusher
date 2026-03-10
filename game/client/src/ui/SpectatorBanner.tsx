interface SpectatorBannerProps {
  onConnectWallet: () => void;
}

export function SpectatorBanner({ onConnectWallet }: SpectatorBannerProps) {
  return (
    <div className="spectator-banner">
      <span className="spectator-banner-text">Watching as spectator</span>
      <button className="spectator-banner-btn" onClick={onConnectWallet}>
        Connect Wallet
      </button>
    </div>
  );
}
