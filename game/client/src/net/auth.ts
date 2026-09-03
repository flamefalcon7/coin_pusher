// Wallet authentication flow: nonce → sign → login → JWT
import { disconnectWalletConnect } from "./walletProvider";

export interface Account {
  account_id: string;
  display_name: string | null;
  balance_usdc: string;
  balance_play: string;
  balance_cash: string;
  referral_code: string;
  referral_code_customized: boolean;
  lifetime_deposit_usdc: string;
  role: string;
  created_at: string;
  updated_at: string;
}

export interface AuthResult {
  token: string;
  account: Account;
}

const TOKEN_KEY = "coin_pusher_token";
const ACCOUNT_KEY = "coin_pusher_account";
const ADDRESS_KEY = "coin_pusher_address";

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
  sessionStorage.removeItem(ADDRESS_KEY);
  disconnectWalletConnect().catch(() => {});
}

export function getSavedAddress(): string | null {
  return sessionStorage.getItem(ADDRESS_KEY);
}

export function updateSavedBalance(balancePlay?: string, balanceCash?: string): void {
  const raw = sessionStorage.getItem(ACCOUNT_KEY);
  if (!raw) return;
  try {
    const account = JSON.parse(raw) as Account;
    if (balancePlay !== undefined) account.balance_play = balancePlay;
    if (balanceCash !== undefined) account.balance_cash = balanceCash;
    sessionStorage.setItem(ACCOUNT_KEY, JSON.stringify(account));
  } catch { /* ignore */ }
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
  referralCode?: string,
): Promise<AuthResult> {
  const body: Record<string, string> = { address, nonce, signature };
  if (referralCode) body.referral_code = referralCode;
  const res = await fetch(`${apiBase}/v1/auth/wallet/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`Login failed: ${res.status}`);
  }
  return res.json();
}

/**
 * Admin passcode login (POST /v1/auth/admin/login). Exchanges the operator's
 * shared passcode for an admin JWT — no wallet involved, so the saved address
 * stays empty. The route only exists when the backend has a passcode configured.
 */
export async function adminLogin(apiBase: string, passcode: string): Promise<AuthResult> {
  const res = await fetch(`${apiBase}/v1/auth/admin/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ passcode }),
  });
  if (res.status === 401) throw new Error("Wrong passcode");
  if (res.status === 404) throw new Error("Admin login is not enabled on this server");
  if (res.status === 429) throw new Error("Too many attempts — try again later");
  if (!res.ok) throw new Error(`Admin login failed: ${res.status}`);

  const result: AuthResult = await res.json();
  saveAuth(result.token, result.account);
  // Replacing a wallet session: drop its address and release the wallet
  // connection, same as clearAuth does.
  sessionStorage.removeItem(ADDRESS_KEY);
  disconnectWalletConnect().catch(() => {});
  return result;
}

/**
 * Full wallet login flow using a pre-connected wallet:
 * 1. Use provided address + sign function from wallet provider
 * 2. fetchNonce → get server nonce + message
 * 3. sign → user signs the message
 * 4. walletLogin → exchange signature for JWT
 */
export async function connectAndSign(
  apiBase: string,
  wallet: { address: string; sign: (message: string) => Promise<string> },
  referralCode?: string,
): Promise<AuthResult> {
  const { address, sign } = wallet;

  // 1. Fetch nonce
  const { nonce, message } = await fetchNonce(apiBase);

  // 2. Sign message
  const signature = await sign(message);

  // 3. Login
  const result = await walletLogin(apiBase, address, nonce, signature, referralCode);

  // Persist token + account + address for session
  saveAuth(result.token, result.account);
  sessionStorage.setItem(ADDRESS_KEY, address);

  return result;
}
