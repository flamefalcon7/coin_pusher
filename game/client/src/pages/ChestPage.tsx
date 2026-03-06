import React, { useState, useCallback, useRef } from 'react';
import { Link } from 'react-router-dom';
import { InventoryClient, type ChestOpenResponse } from '../net/InventoryClient';
import type { ScrollCounts } from '../ui/Toolbar';
import type { SoundManager } from '../scene/SoundManager';
import {
  ChestViewer3D,
  type ChestViewer3DHandle,
  type RarityTier,
  RARITY_COLORS,
  RARITY_LABELS,
  BUILDUP_MS,
  BURST_MS,
} from './ChestViewer3D';
import './ChestPage.css';

/* ── Rarity mapping ─────────────────────────────────────────────────── */

function getRarityTier(scrollType: string): RarityTier {
  if (scrollType === 'super_push') return 'legendary';
  if (scrollType === 'tornado' || scrollType === 'explosion' || scrollType === 'lightning') return 'epic';
  if (scrollType === 'megaspeaker') return 'rare';
  return 'common';
}

const KEY_COINS_PER_CHEST = 3;

const PLAY_COINS_INFO = { label: 'Play Coins', emoji: '\uD83E\uDE99' };

/* ── Scroll definitions ─────────────────────────────────────────────── */

const SCROLL_INFO: { key: keyof ScrollCounts; label: string; emoji: string }[] = [
  { key: 'shock',       label: 'Shock',       emoji: '\u26A1' },
  { key: 'tornado',     label: 'Tornado',     emoji: '\uD83C\uDF2A\uFE0F' },
  { key: 'explosion',   label: 'Explosion',   emoji: '\uD83D\uDCA5' },
  { key: 'lightning',   label: 'Lightning',   emoji: '\uD83C\uDF29\uFE0F' },
  { key: 'superPush',   label: 'Super Push',  emoji: '\uD83D\uDCAA' },
  { key: 'megaspeaker', label: 'Megaspeaker', emoji: '\uD83D\uDCE2' },
];

const SCROLL_KEY_MAP: Record<string, keyof ScrollCounts> = {
  shock: 'shock',
  tornado: 'tornado',
  explosion: 'explosion',
  lightning: 'lightning',
  super_push: 'superPush',
  megaspeaker: 'megaspeaker',
};

/* ── Component ──────────────────────────────────────────────────────── */

interface ChestPageProps {
  token: string;
  apiUrl: string;
  keyCoins: number;
  scrollCounts: ScrollCounts;
  onInventoryChange: (keyCoins: number, scrollCounts: ScrollCounts) => void;
  onBalanceChange?: (balancePlay: string) => void;
  soundManager?: SoundManager | null;
}

type ChestState = 'idle' | 'buildup' | 'burst' | 'reveal';

export const ChestPage: React.FC<ChestPageProps> = ({
  token,
  apiUrl,
  keyCoins,
  scrollCounts,
  onInventoryChange,
  onBalanceChange,
  soundManager,
}) => {
  const [chestState, setChestState] = useState<ChestState>('idle');
  const [revealResult, setRevealResult] = useState<ChestOpenResponse | null>(null);
  const [rarityTier, setRarityTier] = useState<RarityTier>('common');
  const [error, setError] = useState<string | null>(null);

  const inventoryClientRef = useRef(new InventoryClient(apiUrl));
  const viewerRef = useRef<ChestViewer3DHandle>(null);
  const skipRef = useRef(false);
  const animTimersRef = useRef<number[]>([]);
  const apiResultRef = useRef<ChestOpenResponse | null>(null);

  const clearTimers = useCallback(() => {
    for (const t of animTimersRef.current) clearTimeout(t);
    animTimersRef.current = [];
  }, []);

  const schedule = useCallback((fn: () => void, ms: number) => {
    const id = window.setTimeout(fn, ms);
    animTimersRef.current.push(id);
    return id;
  }, []);

  const refreshInventory = useCallback(async () => {
    try {
      const inv = await inventoryClientRef.current.getInventory(token);
      onInventoryChange(inv.key_coins, {
        shock: inv.scroll_shock,
        tornado: inv.scroll_tornado,
        explosion: inv.scroll_explosion,
        lightning: inv.scroll_lightning,
        superPush: inv.scroll_super_push,
        megaspeaker: inv.megaspeaker,
      });
    } catch (err) {
      console.warn('Failed to refresh inventory:', err);
    }
  }, [token, onInventoryChange]);

  const skipToReveal = useCallback(() => {
    if (skipRef.current) return;
    skipRef.current = true;
    clearTimers();
    viewerRef.current?.skipToEnd();

    const result = apiResultRef.current;
    if (result) {
      const tier = getRarityTier(result.scroll_type);
      setRarityTier(tier);
      setRevealResult(result);
      setChestState('reveal');
    }
  }, [clearTimers]);

  const handleOpen = useCallback(async () => {
    if (keyCoins < KEY_COINS_PER_CHEST || chestState !== 'idle') return;
    setError(null);
    skipRef.current = false;
    apiResultRef.current = null;

    // Phase 1: Buildup
    setChestState('buildup');
    soundManager?.playChestBuildup('common');

    const apiPromise = inventoryClientRef.current.openChest(token);
    const minBuildupPromise = new Promise<void>(resolve => {
      schedule(() => resolve(), BUILDUP_MS.common);
    });

    let result: ChestOpenResponse;
    try {
      result = await apiPromise;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to open chest');
      clearTimers();
      setChestState('idle');
      return;
    }

    apiResultRef.current = result;
    if (result.balance_play && onBalanceChange) {
      onBalanceChange(result.balance_play);
    }
    const tier = getRarityTier(result.scroll_type);
    setRarityTier(tier);
    viewerRef.current?.setRarityTier(tier);

    if (skipRef.current) {
      setRevealResult(result);
      setChestState('reveal');
      await refreshInventory();
      return;
    }

    // Wait for tier-specific buildup duration
    if (BUILDUP_MS[tier] > BUILDUP_MS.common) {
      const extraMs = BUILDUP_MS[tier] - BUILDUP_MS.common;
      const extraPromise = new Promise<void>(resolve => {
        schedule(() => resolve(), extraMs);
      });
      await Promise.all([minBuildupPromise, extraPromise]);
    } else {
      await minBuildupPromise;
    }

    if (skipRef.current) {
      setRevealResult(result);
      setChestState('reveal');
      await refreshInventory();
      return;
    }

    // Phase 2: Burst
    setChestState('burst');
    soundManager?.playChestBurst(tier);

    await new Promise<void>(resolve => {
      schedule(() => resolve(), BURST_MS[tier]);
    });

    if (skipRef.current) {
      setRevealResult(result);
      setChestState('reveal');
      await refreshInventory();
      return;
    }

    // Phase 3: Reveal
    setRevealResult(result);
    setChestState('reveal');
    soundManager?.playChestReveal(tier);

    await refreshInventory();
  }, [keyCoins, chestState, token, soundManager, onBalanceChange, refreshInventory, clearTimers, schedule]);

  const handleSkipClick = useCallback(() => {
    if (chestState === 'buildup' || chestState === 'burst') {
      skipToReveal();
    }
  }, [chestState, skipToReveal]);

  const handleContinue = useCallback(() => {
    setChestState('idle');
    setRevealResult(null);
    setRarityTier('common');
    skipRef.current = false;
    apiResultRef.current = null;
  }, []);

  const isPlayCoins = revealResult?.scroll_type === 'play_coins';
  const revealScrollInfo = revealResult && !isPlayCoins
    ? SCROLL_INFO.find(s => SCROLL_KEY_MAP[revealResult.scroll_type] === s.key)
    : null;
  const revealInfo = isPlayCoins ? PLAY_COINS_INFO : revealScrollInfo;

  const isAnimating = chestState === 'buildup' || chestState === 'burst';
  const tierColor = RARITY_COLORS[rarityTier];

  return (
    <div className="chest-page">
      {/* Full-screen BabylonJS canvas */}
      <div className="chest-canvas-layer">
        <ChestViewer3D ref={viewerRef} chestState={chestState} rarityTier={rarityTier} />
      </div>

      {/* Tap-to-skip zone */}
      {isAnimating && (
        <div className="chest-skip-zone" onClick={handleSkipClick} />
      )}

      {/* UI overlay */}
      <div className="chest-ui-overlay">
        <div className="chest-header">
          <Link to="/" className="chest-back-link">
            &larr; Back to Game
          </Link>
          <div className="chest-key-balance">
            <span className="chest-key-icon">&#x1F511;</span>
            <span className="chest-key-count">{keyCoins}</span>
          </div>
        </div>

        <div className="chest-area">
          {isAnimating && (
            <div className="chest-skip-hint">Tap to skip</div>
          )}

          {chestState === 'reveal' && revealResult && revealInfo ? (
            <div className="chest-reveal">
              <div
                className="chest-reveal-scroll"
                style={{ borderColor: tierColor }}
              >
                {revealInfo.emoji}
              </div>
              <div className="chest-reveal-name" style={{ color: tierColor }}>
                {revealInfo.label}
              </div>
              <div className="chest-reveal-count">x{revealResult.scroll_count}</div>
              <div className="chest-reveal-congrats" style={{ color: tierColor }}>
                {RARITY_LABELS[rarityTier]}
              </div>
              <button className="chest-reveal-continue" onClick={handleContinue}>
                Continue
              </button>
            </div>
          ) : (
            !isAnimating && (
              <>
                <button
                  className="chest-open-btn"
                  onClick={handleOpen}
                  disabled={keyCoins < KEY_COINS_PER_CHEST || chestState !== 'idle'}
                >
                  {chestState === 'idle'
                    ? keyCoins >= KEY_COINS_PER_CHEST
                      ? `Open Chest (${KEY_COINS_PER_CHEST} Keys)`
                      : 'Not Enough Keys'
                    : 'Opening...'}
                </button>
                {error && <div style={{ color: 'var(--accent-pink)', fontSize: 13 }}>{error}</div>}
              </>
            )
          )}
        </div>

        <div className="chest-inventory">
          <div className="chest-inventory-title">Scroll Inventory</div>
          <div className="chest-inventory-grid">
            {SCROLL_INFO.map(s => {
              const count = scrollCounts[s.key];
              return (
                <div key={s.key} className={`chest-scroll-card ${count > 0 ? 'has-scroll' : ''}`}>
                  <span className="chest-scroll-card-icon">{s.emoji}</span>
                  <span className="chest-scroll-card-name">{s.label}</span>
                  <span className="chest-scroll-card-count">{count}</span>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
};
