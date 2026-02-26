import { useState } from "react";
import { connectAndSign, type AuthResult } from "../net/auth";

type LoginState = "idle" | "connecting" | "signing" | "error";

interface WalletLoginProps {
  apiBase: string;
  onSuccess: (result: AuthResult) => void;
}

export function WalletLogin({ apiBase, onSuccess }: WalletLoginProps) {
  const [state, setState] = useState<LoginState>("idle");
  const [error, setError] = useState<string>("");

  const handleConnect = async () => {
    setState("connecting");
    setError("");

    try {
      setState("signing");
      const result = await connectAndSign(apiBase);
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
        <h1 className="wallet-login-title">Coin Pusher</h1>
        <p className="wallet-login-subtitle">Connect your wallet to play</p>

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
