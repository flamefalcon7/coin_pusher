// REST client for deposit / withdraw endpoints

export interface DepositAddress {
  address: string;
  chain: string;
  chain_id: number;
  usdc_contract: string;
  min_deposit: string;
}

export interface DepositRecord {
  deposit_id: string;
  amount: string;
  tx_hash: string;
  from_address: string;
  status: string;
  created_at: string;
}

export interface WithdrawalRecord {
  withdrawal_id: string;
  status: string;
  amount: string;
  fee: string;
  net_amount: string;
  to_address: string;
  tx_hash: string | null;
  created_at: string;
}

export interface WithdrawRequest {
  to_address: string;
  amount: string;
}

export interface WithdrawResponse {
  withdrawal_id: string;
  status: string;
  amount: string;
  fee: string;
  net_amount: string;
  to_address: string;
  created_at: string;
}

export async function getDepositAddress(apiUrl: string, token: string): Promise<DepositAddress> {
  const res = await fetch(`${apiUrl}/v1/deposit/address`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`Failed to fetch deposit address: ${res.status}`);
  return res.json();
}

export async function getDeposits(apiUrl: string, token: string): Promise<{ deposits: DepositRecord[] }> {
  const res = await fetch(`${apiUrl}/v1/deposits`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`Failed to fetch deposits: ${res.status}`);
  return res.json();
}

export async function requestWithdrawal(apiUrl: string, token: string, req: WithdrawRequest): Promise<WithdrawResponse> {
  const res = await fetch(`${apiUrl}/v1/withdraw`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(req),
  });
  if (!res.ok) {
    const body = await res.text();
    let msg = `Withdrawal failed: ${res.status}`;
    try {
      const parsed = JSON.parse(body);
      if (parsed.error) msg = parsed.error;
    } catch { /* use default */ }
    throw new Error(msg);
  }
  return res.json();
}

export async function getWithdrawals(apiUrl: string, token: string): Promise<{ withdrawals: WithdrawalRecord[] }> {
  const res = await fetch(`${apiUrl}/v1/withdrawals`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`Failed to fetch withdrawals: ${res.status}`);
  return res.json();
}
