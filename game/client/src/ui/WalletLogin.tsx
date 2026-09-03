import { useState } from "react";
import { adminLogin, connectAndSign, type AuthResult } from "../net/auth";
import {
  connectInjected,
  connectWalletConnect,
  isInjectedWalletAvailable,
  isWalletConnectAvailable,
} from "../net/walletProvider";

type WalletMethod = "injected" | "walletconnect";
type LoginState = "idle" | "connecting" | "signing" | "error";

interface WalletLoginProps {
  apiBase: string;
  onSuccess: (result: AuthResult) => void;
  onClose?: () => void;
}

export function WalletLogin({ apiBase, onSuccess, onClose }: WalletLoginProps) {
  const [state, setState] = useState<LoginState>("idle");
  const [activeMethod, setActiveMethod] = useState<WalletMethod | null>(null);
  const [error, setError] = useState<string>("");
  const [referralCode, setReferralCode] = useState("");
  const [adminMode, setAdminMode] = useState(false);
  const [passcode, setPasscode] = useState("");
  const [adminBusy, setAdminBusy] = useState(false);
  const [adminError, setAdminError] = useState("");

  const handleConnect = async (method: WalletMethod) => {
    setState("connecting");
    setActiveMethod(method);
    setError("");

    try {
      const wallet =
        method === "injected"
          ? await connectInjected()
          : await connectWalletConnect();

      setState("signing");
      const result = await connectAndSign(apiBase, wallet, referralCode || undefined);
      onSuccess(result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Login failed";
      setError(msg);
      setState("error");
    }
  };

  const handleAdminLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!passcode) return;
    setAdminBusy(true);
    setAdminError("");
    try {
      onSuccess(await adminLogin(apiBase, passcode));
    } catch (err) {
      setAdminError(err instanceof Error ? err.message : "Login failed");
    } finally {
      setAdminBusy(false);
    }
  };

  // One login in flight at a time — wallet and passcode both write the same
  // sessionStorage keys, so they must not race.
  const busy = state === "connecting" || state === "signing" || adminBusy;
  const hasInjected = isInjectedWalletAvailable();
  const hasWC = isWalletConnectAvailable();

  return (
    <div className="wallet-login-overlay">
      <div className="wallet-login-card">
        {onClose && (
          <button className="wallet-login-close" onClick={onClose} aria-label="Close">
            ✕
          </button>
        )}
        <h1 className="wallet-login-title">Coin Pusher</h1>
        <p className="wallet-login-subtitle">Connect your wallet to play</p>

        <input
          className="wallet-login-referral"
          type="text"
          placeholder="Referral Code (optional)"
          value={referralCode}
          onChange={(e) => setReferralCode(e.target.value)}
          disabled={busy}
        />

        <div className="wallet-login-buttons">
          {hasInjected && (
            <button
              className="wallet-login-btn"
              onClick={() => handleConnect("injected")}
              disabled={busy}
            >
              {busy && activeMethod === "injected" ? "Waiting for wallet..." : "MetaMask"}
            </button>
          )}

          {hasWC && (
            <button
              className="wallet-login-btn wallet-login-btn-wc"
              onClick={() => handleConnect("walletconnect")}
              disabled={busy}
            >
              {busy && activeMethod === "walletconnect" ? "Waiting for wallet..." : "WalletConnect"}
            </button>
          )}

          {!hasInjected && !hasWC && (
            <p className="wallet-login-error">
              No wallet available. Install MetaMask or configure WalletConnect.
            </p>
          )}
        </div>

        {state === "error" && activeMethod && (
          <div className="wallet-login-error">
            <p>{error}</p>
            <button className="wallet-login-retry" onClick={() => handleConnect(activeMethod)}>
              Retry
            </button>
          </div>
        )}

        {adminMode ? (
          <form className="wallet-login-admin" onSubmit={handleAdminLogin}>
            <input
              className="wallet-login-referral"
              type="password"
              placeholder="Admin passcode"
              autoComplete="current-password"
              autoFocus
              value={passcode}
              onChange={(e) => setPasscode(e.target.value)}
              disabled={busy}
            />
            <button className="wallet-login-btn" type="submit" disabled={busy || !passcode}>
              {adminBusy ? "Signing in..." : "Sign in as admin"}
            </button>
            {adminError && <p className="wallet-login-error">{adminError}</p>}
          </form>
        ) : (
          <button
            type="button"
            className="wallet-login-admin-toggle"
            onClick={() => setAdminMode(true)}
            disabled={busy}
          >
            Admin
          </button>
        )}
      </div>
    </div>
  );
}
