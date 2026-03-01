import React, { useState, useEffect, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { getProfile, setDisplayName, setReferralCode, getReferralInfo, type ReferralInfo } from '../net/ProfileClient';
import type { Account } from '../net/auth';
import './ProfilePage.css';

interface ProfilePageProps {
  token: string;
  apiUrl: string;
  address: string;
}

function truncateAddress(addr: string): string {
  if (addr.length <= 12) return addr;
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
}

export const ProfilePage: React.FC<ProfilePageProps> = ({ token, apiUrl, address }) => {
  const [profile, setProfile] = useState<Account | null>(null);
  const [referral, setReferral] = useState<ReferralInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Username form
  const [nameInput, setNameInput] = useState('');
  const [nameError, setNameError] = useState<string | null>(null);
  const [nameSuccess, setNameSuccess] = useState(false);
  const [nameSubmitting, setNameSubmitting] = useState(false);

  // Referral code form
  const [codeInput, setCodeInput] = useState('');
  const [codeError, setCodeError] = useState<string | null>(null);
  const [codeSuccess, setCodeSuccess] = useState(false);
  const [codeSubmitting, setCodeSubmitting] = useState(false);

  const [copied, setCopied] = useState(false);

  const fetchData = useCallback(async () => {
    try {
      const [profileData, referralData] = await Promise.all([
        getProfile(apiUrl, token),
        getReferralInfo(apiUrl, token),
      ]);
      setProfile(profileData);
      setReferral(referralData);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load profile');
    } finally {
      setLoading(false);
    }
  }, [apiUrl, token]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const handleSetName = useCallback(async () => {
    if (!nameInput.trim()) return;
    setNameSubmitting(true);
    setNameError(null);
    setNameSuccess(false);
    try {
      await setDisplayName(apiUrl, token, nameInput.trim());
      setNameSuccess(true);
      setNameInput('');
      fetchData();
    } catch (err) {
      setNameError(err instanceof Error ? err.message : 'Failed to set username');
    } finally {
      setNameSubmitting(false);
    }
  }, [apiUrl, token, nameInput, fetchData]);

  const handleSetCode = useCallback(async () => {
    if (!codeInput.trim()) return;
    setCodeSubmitting(true);
    setCodeError(null);
    setCodeSuccess(false);
    try {
      await setReferralCode(apiUrl, token, codeInput.trim());
      setCodeSuccess(true);
      setCodeInput('');
      fetchData();
    } catch (err) {
      setCodeError(err instanceof Error ? err.message : 'Failed to set referral code');
    } finally {
      setCodeSubmitting(false);
    }
  }, [apiUrl, token, codeInput, fetchData]);

  const handleCopy = useCallback(() => {
    if (!referral?.referral_code) return;
    navigator.clipboard.writeText(referral.referral_code).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }, [referral]);

  const deposit = parseFloat(profile?.lifetime_deposit_usdc ?? '0') || 0;
  const nameThreshold = 100;
  const codeThreshold = 10;
  const nameUnlocked = deposit >= nameThreshold;
  const codeUnlocked = deposit >= codeThreshold;

  return (
    <div className="profile-page">
      <div className="profile-header">
        <Link to="/" className="profile-back-link">&larr; Back to Game</Link>
        <h1 className="profile-title">Profile</h1>
      </div>

      {loading ? (
        <div className="profile-loading">Loading...</div>
      ) : error ? (
        <div className="profile-error">
          <p>{error}</p>
          <button className="profile-retry-btn" onClick={fetchData}>Retry</button>
        </div>
      ) : (
        <div className="profile-sections">
          {/* ── Username Section ── */}
          <div className="profile-card">
            <div className="profile-card-label">Username</div>
            {profile?.display_name ? (
              <div className="profile-card-value">{profile.display_name}</div>
            ) : nameUnlocked ? (
              <>
                <div className="profile-card-value">{truncateAddress(address)}</div>
                <div className="profile-form-row">
                  <input
                    className="profile-input"
                    type="text"
                    placeholder="Choose a username"
                    value={nameInput}
                    onChange={(e) => setNameInput(e.target.value)}
                    maxLength={30}
                    onKeyDown={(e) => e.key === 'Enter' && handleSetName()}
                  />
                  <button
                    className="profile-submit-btn"
                    onClick={handleSetName}
                    disabled={nameSubmitting || !nameInput.trim()}
                  >
                    {nameSubmitting ? '...' : 'Set Username'}
                  </button>
                </div>
                {nameError && <div className="profile-inline-error">{nameError}</div>}
                {nameSuccess && <div className="profile-inline-success">Username set!</div>}
              </>
            ) : (
              <>
                <div className="profile-card-value">{truncateAddress(address)}</div>
                <div className="profile-lock-msg">
                  Deposit ${(nameThreshold - deposit).toFixed(2)} more to unlock username
                </div>
                <div className="profile-lock-bar">
                  <div
                    className="profile-lock-bar-fill"
                    style={{ width: `${Math.min((deposit / nameThreshold) * 100, 100)}%` }}
                  />
                </div>
              </>
            )}
          </div>

          {/* ── Referral Code Section ── */}
          <div className="profile-card">
            <div className="profile-card-label">Referral Code</div>
            {referral && (
              <>
                <div className="profile-copy-row">
                  <div className="profile-card-value">{referral.referral_code}</div>
                  <button className="profile-copy-btn" onClick={handleCopy}>
                    {copied ? 'Copied!' : 'Copy'}
                  </button>
                </div>

                {referral.referral_customized ? null : codeUnlocked ? (
                  <>
                    <div className="profile-form-row">
                      <input
                        className="profile-input"
                        type="text"
                        placeholder="Custom referral code"
                        value={codeInput}
                        onChange={(e) => setCodeInput(e.target.value)}
                        maxLength={20}
                        onKeyDown={(e) => e.key === 'Enter' && handleSetCode()}
                      />
                      <button
                        className="profile-submit-btn"
                        onClick={handleSetCode}
                        disabled={codeSubmitting || !codeInput.trim()}
                      >
                        {codeSubmitting ? '...' : 'Customize'}
                      </button>
                    </div>
                    {codeError && <div className="profile-inline-error">{codeError}</div>}
                    {codeSuccess && <div className="profile-inline-success">Referral code updated!</div>}
                  </>
                ) : (
                  <>
                    <div className="profile-lock-msg">
                      Deposit ${(codeThreshold - deposit).toFixed(2)} more to customize
                    </div>
                    <div className="profile-lock-bar">
                      <div
                        className="profile-lock-bar-fill"
                        style={{ width: `${Math.min((deposit / codeThreshold) * 100, 100)}%` }}
                      />
                    </div>
                  </>
                )}

                <div className="profile-referral-stats">
                  {referral.referral_count} referral{referral.referral_count !== 1 ? 's' : ''}
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
};
