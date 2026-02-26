// Wallet authentication flow: nonce → sign → login → JWT

export interface Account {
  account_id: string;
  display_name: string;
  balance_usdc: string;
  balance_play: string;
  balance_cash: string;
  created_at: string;
  updated_at: string;
}

export interface AuthResult {
  token: string;
  account: Account;
}

const TOKEN_KEY = "coin_pusher_token";

export function getSavedToken(): string | null {
  return sessionStorage.getItem(TOKEN_KEY);
}

export function saveToken(token: string): void {
  sessionStorage.setItem(TOKEN_KEY, token);
}

export function clearToken(): void {
  sessionStorage.removeItem(TOKEN_KEY);
}

async function fetchNonce(apiBase: string): Promise<{ nonce: string; message: string }> {
  const res = await fetch(`${apiBase}/v1/auth/nonce`);
  if (!res.ok) {
    throw new Error(`Failed to fetch nonce: ${res.status}`);
  }
  return res.json();
}

async function walletLogin(
  apiBase: string,
  address: string,
  nonce: string,
  signature: string,
): Promise<AuthResult> {
  const res = await fetch(`${apiBase}/v1/auth/wallet/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ address, nonce, signature }),
  });
  if (!res.ok) {
    throw new Error(`Login failed: ${res.status}`);
  }
  return res.json();
}

/**
 * Full wallet login flow:
 * 1. eth_requestAccounts → get address
 * 2. fetchNonce → get server nonce + message
 * 3. personal_sign → user signs the message
 * 4. walletLogin → exchange signature for JWT
 */
export async function connectAndSign(apiBase: string): Promise<AuthResult> {
  const eth = window.ethereum;
  if (!eth) {
    throw new Error("No wallet found. Please install MetaMask.");
  }

  // 1. Connect wallet
  const accounts = (await eth.request({ method: "eth_requestAccounts" })) as string[];
  if (!accounts.length) {
    throw new Error("No accounts returned from wallet.");
  }
  const address = accounts[0];

  // 2. Fetch nonce
  const { nonce, message } = await fetchNonce(apiBase);

  // 3. Sign message
  const signature = (await eth.request({
    method: "personal_sign",
    params: [message, address],
  })) as string;

  // 4. Login
  const result = await walletLogin(apiBase, address, nonce, signature);

  // Persist token for session
  saveToken(result.token);

  return result;
}
