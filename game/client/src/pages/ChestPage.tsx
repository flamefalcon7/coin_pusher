import React, { useState, useCallback, useRef, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { InventoryClient, type ChestOpenResponse } from '../net/InventoryClient';
import type { ScrollCounts } from '../ui/Toolbar';
import { ChestViewer3D } from './ChestViewer3D';
import './ChestPage.css';

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

interface ChestPageProps {
  token: string;
  apiUrl: string;
  keyCoins: number;
  scrollCounts: ScrollCounts;
  onInventoryChange: (keyCoins: number, scrollCounts: ScrollCounts) => void;
}

type ChestState = 'idle' | 'shaking' | 'open' | 'reveal';

export const ChestPage: React.FC<ChestPageProps> = ({
  token,
  apiUrl,
  keyCoins,
  scrollCounts,
  onInventoryChange,
}) => {
  const [chestState, setChestState] = useState<ChestState>('idle');
  const [revealResult, setRevealResult] = useState<ChestOpenResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [particles, setParticles] = useState<{ id: number; color: string; px: string; py: string }[]>([]);
  const particleIdRef = useRef(0);
  const inventoryClientRef = useRef(new InventoryClient(apiUrl));

  const spawnParticles = useCallback(() => {
    const colors = ['#FFD700', '#E89620', '#E8396B', '#4ECDC4', '#fff'];
    const newParticles = Array.from({ length: 12 }, () => {
      const angle = Math.random() * Math.PI * 2;
      const dist = 40 + Math.random() * 60;
      return {
        id: particleIdRef.current++,
        color: colors[Math.floor(Math.random() * colors.length)],
        px: `${Math.cos(angle) * dist}px`,
        py: `${Math.sin(angle) * dist - 30}px`,
      };
    });
    setParticles(newParticles);
  }, []);

  // Clear particles after animation
  useEffect(() => {
    if (particles.length === 0) return;
    const timer = setTimeout(() => setParticles([]), 1100);
    return () => clearTimeout(timer);
  }, [particles]);

  // Fetch fresh inventory from server and sync to parent
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

  const handleOpen = useCallback(async () => {
    if (keyCoins <= 0 || chestState !== 'idle') return;
    setError(null);

    // Phase 1: shake
    setChestState('shaking');

    // Phase 2: open lid after shake
    await new Promise(r => setTimeout(r, 550));
    setChestState('open');
    spawnParticles();

    // Call API during the open animation
    try {
      const result = await inventoryClientRef.current.openChest(token);

      // Phase 3: reveal after a short delay
      await new Promise(r => setTimeout(r, 600));
      setRevealResult(result);
      setChestState('reveal');

      // Fetch fresh inventory from server
      await refreshInventory();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to open chest');
      setChestState('idle');
    }
  }, [keyCoins, chestState, token, spawnParticles, refreshInventory]);

  const handleContinue = useCallback(() => {
    setChestState('idle');
    setRevealResult(null);
    setParticles([]);
  }, []);

  const revealScrollInfo = revealResult
    ? SCROLL_INFO.find(s => SCROLL_KEY_MAP[revealResult.scroll_type] === s.key)
    : null;

  return (
    <div className="chest-page">
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
        <div className="chest-visual-3d">
          <ChestViewer3D chestState={chestState} />
          <div className="chest-glow-overlay" data-visible={chestState === 'open' || chestState === 'reveal' ? '' : undefined} />
          <div className="chest-particles">
            {particles.map(p => (
              <div
                key={p.id}
                className="chest-particle"
                style={{
                  background: p.color,
                  '--px': p.px,
                  '--py': p.py,
                } as React.CSSProperties}
              />
            ))}
          </div>
        </div>

        {chestState === 'reveal' && revealResult && revealScrollInfo ? (
          <div className="chest-reveal">
            <div className="chest-reveal-scroll">
              {revealScrollInfo.emoji}
            </div>
            <div className="chest-reveal-name">{revealScrollInfo.label}</div>
            <div className="chest-reveal-count">x{revealResult.scroll_count}</div>
            <div className="chest-reveal-congrats">Congratulations!</div>
            <button className="chest-reveal-continue" onClick={handleContinue}>
              Continue
            </button>
          </div>
        ) : (
          <>
            <button
              className="chest-open-btn"
              onClick={handleOpen}
              disabled={keyCoins <= 0 || chestState !== 'idle'}
            >
              {chestState === 'idle'
                ? keyCoins > 0
                  ? 'Open Chest'
                  : 'No Key Coins'
                : 'Opening...'}
            </button>
            {error && <div style={{ color: 'var(--accent-pink)', fontSize: 13 }}>{error}</div>}
          </>
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
  );
};
