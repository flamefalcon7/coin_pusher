import { useState } from "react";
import { connectAndSign, type AuthResult } from "../net/auth";
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

  const busy = state === "connecting" || state === "signing";
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
      </div>
    </div>
  );
}
