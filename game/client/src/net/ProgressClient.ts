// REST client for progress endpoints

export interface UserProgressItem {
  progress_id: string;
  title: string;
  description: string;
  metric_type: string;
  threshold: string;
  reward_type: string;
  reward_amount: string;
  current_value: string;
  status: string;
  achieved_at?: string;
  disbursed_at?: string;
  claimable_at?: string;
  expires_at?: string;
}

export async function getUserProgress(apiUrl: string, token: string): Promise<{ progress: UserProgressItem[] }> {
  const res = await fetch(`${apiUrl}/v1/progress`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`Failed to fetch progress: ${res.status}`);
  return res.json();
}

export interface ClaimResult {
  status: string;
  balance_play: string;
  balance_cash: string;
}

export async function claimProgress(apiUrl: string, token: string, progressId: string): Promise<ClaimResult> {
  const res = await fetch(`${apiUrl}/v1/progress/${progressId}/claim`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(body?.error ?? `Claim failed: ${res.status}`);
  }
  return res.json();
}
