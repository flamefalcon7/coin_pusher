import { useState } from "react";
import { connectAndSign, type AuthResult } from "../net/auth";

type LoginState = "idle" | "connecting" | "signing" | "error";

interface WalletLoginProps {
  apiBase: string;
  onSuccess: (result: AuthResult) => void;
  onClose?: () => void;
}

export function WalletLogin({ apiBase, onSuccess, onClose }: WalletLoginProps) {
  const [state, setState] = useState<LoginState>("idle");
  const [error, setError] = useState<string>("");
  const [referralCode, setReferralCode] = useState("");

  const handleConnect = async () => {
    setState("connecting");
    setError("");

    try {
      setState("signing");
      const result = await connectAndSign(apiBase, referralCode || undefined);
      onSuccess(result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Login failed";
      setError(msg);
      setState("error");
    }
  };

  const busy = state === "connecting" || state === "signing";

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

        <button
          className="wallet-login-btn"
          onClick={handleConnect}
          disabled={busy}
        >
          {busy ? "Waiting for wallet..." : "Connect Wallet"}
        </button>

        {state === "error" && (
          <div className="wallet-login-error">
            <p>{error}</p>
            <button className="wallet-login-retry" onClick={handleConnect}>
              Retry
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
