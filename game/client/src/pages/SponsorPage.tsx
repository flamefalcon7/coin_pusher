import React, { useState, useEffect, useCallback, useRef } from 'react';
import { Link } from 'react-router-dom';
import {
  listMyCampaigns,
  createCampaign,
  uploadImages,
  getBalances,
  type Campaign,
  type SponsorBalance,
  type NewCampaign,
} from '../net/SponsorClient';
import { CampaignCard } from '../ui/CampaignCard';
import './SponsorPage.css';

interface SponsorPageProps {
  token: string;
  apiUrl: string;
}

const MAX_FILE_SIZE = 512 * 1024; // 512KB
const ACCEPTED_TYPES = ['image/png', 'image/jpeg'];

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  return `${(bytes / 1024).toFixed(1)} KB`;
}

export const SponsorPage: React.FC<SponsorPageProps> = ({ token, apiUrl }) => {
  // ── Data state ──
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [balances, setBalances] = useState<SponsorBalance[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  // ── Form state ──
  const [chain, setChain] = useState('sui');
  const [tokenAddress, setTokenAddress] = useState('');
  const [tokenSymbol, setTokenSymbol] = useState('');
  const [tokenDecimals, setTokenDecimals] = useState(9);
  const [brandColor, setBrandColor] = useState('#4ECDC4');
  const [brandName, setBrandName] = useState('');
  const [poolTotal, setPoolTotal] = useState('');
  const [rewardPerCoin, setRewardPerCoin] = useState('');
  const [formErrors, setFormErrors] = useState<Record<string, string>>({});
  const [creating, setCreating] = useState(false);

  // ── Upload state ──
  const [newCampaignId, setNewCampaignId] = useState<string | null>(null);
  const [logoFile, setLogoFile] = useState<File | null>(null);
  const [adImageFile, setAdImageFile] = useState<File | null>(null);
  const [logoPreview, setLogoPreview] = useState<string | null>(null);
  const [adImagePreview, setAdImagePreview] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [uploadSuccess, setUploadSuccess] = useState(false);

  const logoInputRef = useRef<HTMLInputElement>(null);
  const adImageInputRef = useRef<HTMLInputElement>(null);

  const fetchData = useCallback(async () => {
    try {
      const [campaignData, balanceData] = await Promise.all([
        listMyCampaigns(apiUrl, token),
        getBalances(apiUrl, token),
      ]);
      setCampaigns(campaignData ?? []);
      setBalances(balanceData ?? []);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load data');
    } finally {
      setLoading(false);
    }
  }, [apiUrl, token]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  // ── Validation ──
  const validateForm = useCallback((): boolean => {
    const errs: Record<string, string> = {};

    if (!tokenAddress.trim()) errs.tokenAddress = 'Required';
    if (!tokenSymbol.trim()) errs.tokenSymbol = 'Required';
    else if (tokenSymbol.length > 10) errs.tokenSymbol = 'Max 10 characters';
    if (!brandName.trim()) errs.brandName = 'Required';
    else if (brandName.length > 32) errs.brandName = 'Max 32 characters';

    const pt = parseFloat(poolTotal);
    const rpc = parseFloat(rewardPerCoin);
    if (!poolTotal || !Number.isFinite(pt) || pt <= 0) errs.poolTotal = 'Must be a positive number';
    if (!rewardPerCoin || !Number.isFinite(rpc) || rpc <= 0) errs.rewardPerCoin = 'Must be a positive number';
    if (Number.isFinite(pt) && Number.isFinite(rpc) && rpc > 0 && pt / rpc < 100) {
      errs.poolTotal = 'pool_total / reward_per_coin must be >= 100';
    }

    if (tokenDecimals < 0 || tokenDecimals > 18) errs.tokenDecimals = '0-18';

    setFormErrors(errs);
    return Object.keys(errs).length === 0;
  }, [tokenAddress, tokenSymbol, brandName, poolTotal, rewardPerCoin, tokenDecimals]);

  // ── Create campaign ──
  const handleCreate = useCallback(async () => {
    if (!validateForm()) return;
    setCreating(true);
    try {
      const data: NewCampaign = {
        chain,
        token_address: tokenAddress.trim(),
        token_symbol: tokenSymbol.trim().toUpperCase(),
        token_decimals: tokenDecimals,
        brand_color: brandColor,
        brand_name: brandName.trim(),
        pool_total: poolTotal,
        reward_per_coin: rewardPerCoin,
      };
      const campaign = await createCampaign(apiUrl, token, data);
      setNewCampaignId(campaign.campaign_id);
      // Reset form
      setTokenAddress('');
      setTokenSymbol('');
      setBrandName('');
      setPoolTotal('');
      setRewardPerCoin('');
      setFormErrors({});
      // Refresh list
      await fetchData();
    } catch (err) {
      setFormErrors({ submit: err instanceof Error ? err.message : 'Create failed' });
    } finally {
      setCreating(false);
    }
  }, [validateForm, chain, tokenAddress, tokenSymbol, tokenDecimals, brandColor, brandName, poolTotal, rewardPerCoin, apiUrl, token, fetchData]);

  // ── File selection helpers ──
  const handleFileSelect = useCallback((
    file: File | undefined,
    setFile: (f: File | null) => void,
    setPreview: (p: string | null) => void,
  ) => {
    if (!file) return;
    if (!ACCEPTED_TYPES.includes(file.type)) {
      setUploadError('Only PNG and JPEG files are accepted');
      return;
    }
    if (file.size > MAX_FILE_SIZE) {
      setUploadError('File must be under 512KB');
      return;
    }
    setUploadError(null);
    setFile(file);
    setPreview(URL.createObjectURL(file));
  }, []);

  const handleDrop = useCallback((
    e: React.DragEvent,
    setFile: (f: File | null) => void,
    setPreview: (p: string | null) => void,
  ) => {
    e.preventDefault();
    e.stopPropagation();
    const file = e.dataTransfer.files[0];
    handleFileSelect(file, setFile, setPreview);
  }, [handleFileSelect]);

  const clearFile = useCallback((
    setFile: (f: File | null) => void,
    setPreview: (p: string | null) => void,
    preview: string | null,
  ) => {
    setFile(null);
    if (preview) URL.revokeObjectURL(preview);
    setPreview(null);
  }, []);

  // ── Upload images ──
  const handleUpload = useCallback(async () => {
    if (!newCampaignId) return;
    setUploading(true);
    setUploadError(null);
    try {
      await uploadImages(apiUrl, token, newCampaignId, logoFile ?? undefined, adImageFile ?? undefined);
      setUploadSuccess(true);
      setNewCampaignId(null);
      setLogoFile(null);
      setAdImageFile(null);
      if (logoPreview) URL.revokeObjectURL(logoPreview);
      if (adImagePreview) URL.revokeObjectURL(adImagePreview);
      setLogoPreview(null);
      setAdImagePreview(null);
      await fetchData();
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : 'Upload failed');
    } finally {
      setUploading(false);
    }
  }, [newCampaignId, apiUrl, token, logoFile, adImageFile, logoPreview, adImagePreview, fetchData]);

  // Cleanup previews on unmount
  useEffect(() => {
    return () => {
      if (logoPreview) URL.revokeObjectURL(logoPreview);
      if (adImagePreview) URL.revokeObjectURL(adImagePreview);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="sponsor-page">
      <div className="sponsor-header">
        <Link to="/" className="sponsor-back-link">&larr; Back to Game</Link>
        <h1 className="sponsor-title">Sponsor</h1>
      </div>

      {loading ? (
        <div className="sponsor-loading">Loading...</div>
      ) : error ? (
        <div className="sponsor-error">
          <p>{error}</p>
          <button className="sponsor-retry-btn" onClick={fetchData}>Retry</button>
        </div>
      ) : (
        <div className="sponsor-sections">

          {/* ── Section A: My Campaigns ── */}
          <h2 className="sponsor-section-title">My Campaigns</h2>
          {campaigns.length === 0 ? (
            <div className="sponsor-empty">No campaigns yet. Create your first one below.</div>
          ) : (
            <div className="sponsor-campaign-list">
              {campaigns.map((c) => (
                <CampaignCard
                  key={c.campaign_id}
                  campaign={c}
                  expanded={expandedId === c.campaign_id}
                  onToggle={() => setExpandedId(expandedId === c.campaign_id ? null : c.campaign_id)}
                />
              ))}
            </div>
          )}

          {/* ── Section B: Create Campaign ── */}
          <h2 className="sponsor-section-title">Create Campaign</h2>
          <div className="sponsor-card">
            <div className="sponsor-form-group">
              <label className="sponsor-form-label">Chain</label>
              <select
                className="sponsor-select"
                value={chain}
                onChange={(e) => setChain(e.target.value)}
              >
                <option value="sui">Sui</option>
                <option value="solana">Solana</option>
              </select>
            </div>

            <div className="sponsor-form-group">
              <label className="sponsor-form-label">Token Address</label>
              <input
                className="sponsor-input"
                type="text"
                placeholder="0x..."
                value={tokenAddress}
                onChange={(e) => setTokenAddress(e.target.value)}
              />
              {formErrors.tokenAddress && <span className="sponsor-inline-error">{formErrors.tokenAddress}</span>}
            </div>

            <div className="sponsor-form-group">
              <label className="sponsor-form-label">Token Symbol</label>
              <input
                className="sponsor-input"
                type="text"
                placeholder="e.g. USDC"
                value={tokenSymbol}
                onChange={(e) => setTokenSymbol(e.target.value.toUpperCase().slice(0, 10))}
                maxLength={10}
              />
              {formErrors.tokenSymbol && <span className="sponsor-inline-error">{formErrors.tokenSymbol}</span>}
            </div>

            <div className="sponsor-form-group">
              <label className="sponsor-form-label">Token Decimals</label>
              <input
                className="sponsor-input"
                type="number"
                min={0}
                max={18}
                value={tokenDecimals}
                onChange={(e) => setTokenDecimals(Math.min(18, Math.max(0, parseInt(e.target.value) || 0)))}
              />
              {formErrors.tokenDecimals && <span className="sponsor-inline-error">{formErrors.tokenDecimals}</span>}
            </div>

            <div className="sponsor-form-group">
              <label className="sponsor-form-label">Brand Color</label>
              <div className="sponsor-color-row">
                <input
                  className="sponsor-color-input"
                  type="color"
                  value={brandColor}
                  onChange={(e) => setBrandColor(e.target.value)}
                />
                <span className="sponsor-color-hex">{brandColor}</span>
              </div>
            </div>

            <div className="sponsor-form-group">
              <label className="sponsor-form-label">Brand Name</label>
              <input
                className="sponsor-input"
                type="text"
                placeholder="Your brand name"
                value={brandName}
                onChange={(e) => setBrandName(e.target.value.slice(0, 32))}
                maxLength={32}
              />
              {formErrors.brandName && <span className="sponsor-inline-error">{formErrors.brandName}</span>}
            </div>

            <div className="sponsor-form-group">
              <label className="sponsor-form-label">Pool Total</label>
              <input
                className="sponsor-input"
                type="number"
                placeholder="Total tokens in pool"
                value={poolTotal}
                onChange={(e) => setPoolTotal(e.target.value)}
                min={0}
              />
              {formErrors.poolTotal && <span className="sponsor-inline-error">{formErrors.poolTotal}</span>}
            </div>

            <div className="sponsor-form-group">
              <label className="sponsor-form-label">Reward Per Coin</label>
              <input
                className="sponsor-input"
                type="number"
                placeholder="Tokens rewarded per coin drop"
                value={rewardPerCoin}
                onChange={(e) => setRewardPerCoin(e.target.value)}
                min={0}
              />
              {formErrors.rewardPerCoin && <span className="sponsor-inline-error">{formErrors.rewardPerCoin}</span>}
            </div>

            {formErrors.submit && <span className="sponsor-inline-error">{formErrors.submit}</span>}

            <button
              className="sponsor-submit-btn"
              onClick={handleCreate}
              disabled={creating}
            >
              {creating ? 'Creating...' : 'Create Campaign'}
            </button>
          </div>

          {/* ── Image Upload (after create) ── */}
          {newCampaignId && (
            <>
              <h2 className="sponsor-section-title">Upload Images</h2>
              <div className="sponsor-card">
                {/* Logo */}
                <div className="sponsor-form-group">
                  <label className="sponsor-form-label">Logo</label>
                  {logoFile && logoPreview ? (
                    <div className="sponsor-upload-preview">
                      <img src={logoPreview} alt="Logo preview" />
                      <div className="sponsor-upload-preview-info">
                        <span className="sponsor-upload-preview-name">{logoFile.name}</span>
                        <span className="sponsor-upload-preview-size">{formatFileSize(logoFile.size)}</span>
                      </div>
                      <button
                        className="sponsor-upload-remove"
                        onClick={() => clearFile(setLogoFile, setLogoPreview, logoPreview)}
                      >
                        Remove
                      </button>
                    </div>
                  ) : (
                    <div
                      className="sponsor-upload-area"
                      onClick={() => logoInputRef.current?.click()}
                      onDragOver={(e) => e.preventDefault()}
                      onDrop={(e) => handleDrop(e, setLogoFile, setLogoPreview)}
                    >
                      <span className="sponsor-upload-area-text">Drop image here or click to select</span>
                      <span className="sponsor-upload-hint">PNG / JPEG, max 512KB</span>
                    </div>
                  )}
                  <input
                    ref={logoInputRef}
                    type="file"
                    accept="image/png,image/jpeg"
                    style={{ display: 'none' }}
                    onChange={(e) => handleFileSelect(e.target.files?.[0], setLogoFile, setLogoPreview)}
                  />
                </div>

                {/* Ad Image */}
                <div className="sponsor-form-group">
                  <label className="sponsor-form-label">Ad Image</label>
                  {adImageFile && adImagePreview ? (
                    <div className="sponsor-upload-preview">
                      <img src={adImagePreview} alt="Ad preview" />
                      <div className="sponsor-upload-preview-info">
                        <span className="sponsor-upload-preview-name">{adImageFile.name}</span>
                        <span className="sponsor-upload-preview-size">{formatFileSize(adImageFile.size)}</span>
                      </div>
                      <button
                        className="sponsor-upload-remove"
                        onClick={() => clearFile(setAdImageFile, setAdImagePreview, adImagePreview)}
                      >
                        Remove
                      </button>
                    </div>
                  ) : (
                    <div
                      className="sponsor-upload-area"
                      onClick={() => adImageInputRef.current?.click()}
                      onDragOver={(e) => e.preventDefault()}
                      onDrop={(e) => handleDrop(e, setAdImageFile, setAdImagePreview)}
                    >
                      <span className="sponsor-upload-area-text">Drop image here or click to select</span>
                      <span className="sponsor-upload-hint">PNG / JPEG, max 512KB</span>
                    </div>
                  )}
                  <input
                    ref={adImageInputRef}
                    type="file"
                    accept="image/png,image/jpeg"
                    style={{ display: 'none' }}
                    onChange={(e) => handleFileSelect(e.target.files?.[0], setAdImageFile, setAdImagePreview)}
                  />
                </div>

                {uploadError && <span className="sponsor-inline-error">{uploadError}</span>}

                <button
                  className="sponsor-submit-btn"
                  onClick={handleUpload}
                  disabled={uploading || (!logoFile && !adImageFile)}
                >
                  {uploading ? 'Uploading...' : uploadError ? 'Retry Upload' : 'Upload Images'}
                </button>
              </div>
            </>
          )}

          {uploadSuccess && <div className="sponsor-success">Campaign created and images uploaded successfully!</div>}

          {/* ── Section C: My Sponsor Balances ── */}
          <h2 className="sponsor-section-title">My Sponsor Balances</h2>
          {balances.length === 0 ? (
            <div className="sponsor-empty">No sponsor tokens earned yet.</div>
          ) : (
            <div className="sponsor-card">
              <div className="sponsor-balance-list">
                {balances.map((b) => (
                  <div key={b.campaign_id} className="sponsor-balance-item">
                    <span className="sponsor-balance-symbol">{b.campaign_id}</span>
                    <span className="sponsor-balance-amount">{b.balance}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
};
