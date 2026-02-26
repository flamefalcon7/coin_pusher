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
const ACCOUNT_KEY = "coin_pusher_account";

export function getSavedAuth(): { token: string; account: Account } | null {
  const token = sessionStorage.getItem(TOKEN_KEY);
  const raw = sessionStorage.getItem(ACCOUNT_KEY);
  if (!token || !raw) return null;
  try {
    return { token, account: JSON.parse(raw) };
  } catch {
    return null;
  }
}

export function saveAuth(token: string, account: Account): void {
  sessionStorage.setItem(TOKEN_KEY, token);
  sessionStorage.setItem(ACCOUNT_KEY, JSON.stringify(account));
}

export function clearAuth(): void {
  sessionStorage.removeItem(TOKEN_KEY);
  sessionStorage.removeItem(ACCOUNT_KEY);
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

  // Persist token + account for session
  saveAuth(result.token, result.account);

  return result;
}
