// REST client for profile endpoints

import type { Account } from './auth';

export interface ReferralInfo {
  referral_code: string;
  referral_customized: boolean;
  referral_count: number;
}

export async function getProfile(apiUrl: string, token: string): Promise<Account> {
  const res = await fetch(`${apiUrl}/v1/user/profile`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`Failed to fetch profile: ${res.status}`);
  return res.json();
}

export async function setDisplayName(apiUrl: string, token: string, name: string): Promise<{ display_name: string }> {
  const res = await fetch(`${apiUrl}/v1/user/display-name`, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ display_name: name }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(body?.error ?? `Set display name failed: ${res.status}`);
  }
  return res.json();
}

export async function setReferralCode(apiUrl: string, token: string, code: string): Promise<{ referral_code: string }> {
  const res = await fetch(`${apiUrl}/v1/user/referral-code`, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ referral_code: code }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(body?.error ?? `Set referral code failed: ${res.status}`);
  }
  return res.json();
}

export async function getReferralInfo(apiUrl: string, token: string): Promise<ReferralInfo> {
  const res = await fetch(`${apiUrl}/v1/user/referral`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`Failed to fetch referral info: ${res.status}`);
  return res.json();
}
