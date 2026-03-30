// REST client for sponsor campaign endpoints

export interface Campaign {
  campaign_id: string;
  created_by: string;
  chain: string;
  token_address: string;
  token_symbol: string;
  token_decimals: number;
  brand_color: string;
  brand_name: string;
  logo_url: string;
  ad_image_url: string;
  pool_total: string;
  pool_remaining: string;
  reward_per_coin: string;
  status: string;
  created_at: string;
}

export interface SponsorBalance {
  account_id: string;
  campaign_id: string;
  balance: string;
  updated_at: string;
}

export interface NewCampaign {
  chain: string;
  token_address: string;
  token_symbol: string;
  token_decimals: number;
  brand_color: string;
  brand_name: string;
  pool_total: string;
  reward_per_coin: string;
}

export async function listActiveCampaigns(apiUrl: string): Promise<Campaign[]> {
  const res = await fetch(`${apiUrl}/v1/sponsor/campaigns`);
  if (!res.ok) throw new Error(`Failed to fetch campaigns: ${res.status}`);
  return res.json();
}

export async function listMyCampaigns(apiUrl: string, token: string): Promise<Campaign[]> {
  const res = await fetch(`${apiUrl}/v1/sponsor/campaigns/mine`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`Failed to fetch my campaigns: ${res.status}`);
  return res.json();
}

export async function createCampaign(apiUrl: string, token: string, data: NewCampaign): Promise<Campaign> {
  const res = await fetch(`${apiUrl}/v1/sponsor/campaign`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(data),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(body?.error ?? `Create campaign failed: ${res.status}`);
  }
  return res.json();
}

export async function uploadImages(
  apiUrl: string,
  token: string,
  campaignId: string,
  logo?: File,
  adImage?: File,
): Promise<{ logo_url: string; ad_image_url: string }> {
  const form = new FormData();
  if (logo) form.append('logo', logo);
  if (adImage) form.append('ad_image', adImage);

  const res = await fetch(`${apiUrl}/v1/sponsor/campaign/${campaignId}/upload`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(body?.error ?? `Upload images failed: ${res.status}`);
  }
  return res.json();
}

export async function getBalances(apiUrl: string, token: string): Promise<SponsorBalance[]> {
  const res = await fetch(`${apiUrl}/v1/sponsor/balances`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`Failed to fetch sponsor balances: ${res.status}`);
  return res.json();
}

// Admin endpoints

export async function pauseCampaign(apiUrl: string, token: string, id: string): Promise<void> {
  const res = await fetch(`${apiUrl}/v1/admin/sponsor/campaign/${id}/pause`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(body?.error ?? `Pause campaign failed: ${res.status}`);
  }
}

export async function resumeCampaign(apiUrl: string, token: string, id: string): Promise<void> {
  const res = await fetch(`${apiUrl}/v1/admin/sponsor/campaign/${id}/resume`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(body?.error ?? `Resume campaign failed: ${res.status}`);
  }
}

export async function removeCampaign(apiUrl: string, token: string, id: string): Promise<void> {
  const res = await fetch(`${apiUrl}/v1/admin/sponsor/campaign/${id}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(body?.error ?? `Remove campaign failed: ${res.status}`);
  }
}
