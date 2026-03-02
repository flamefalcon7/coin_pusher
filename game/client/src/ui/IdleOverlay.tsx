import "./IdleOverlay.css";

export function IdleWarningBanner() {
  return (
    <div className="idle-warning-banner">
      You'll be disconnected due to inactivity. Insert a coin or use an ability to stay connected.
    </div>
  );
}

export function IdleTimeoutOverlay() {
  return (
    <div className="idle-timeout-overlay">
      <div className="idle-timeout-card">
        <h2>Disconnected</h2>
        <p>You were disconnected due to inactivity.</p>
        <button
          className="idle-timeout-btn"
          onClick={() => window.location.reload()}
        >
          Refresh
        </button>
      </div>
    </div>
  );
}
