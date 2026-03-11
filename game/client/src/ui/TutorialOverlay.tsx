import React, { useState, useEffect, useCallback, useRef } from 'react';
import './TutorialOverlay.css';

const STORAGE_KEY = 'coin-pusher-tutorial-seen';

interface TutorialStep {
  /** CSS selector for the element to highlight (null = center screen) */
  target: string | null;
  title: string;
  body: string;
  /** Where to position the tooltip relative to the spotlight */
  position: 'bottom' | 'top' | 'left' | 'right';
}

const STEPS: TutorialStep[] = [
  {
    target: '.coin-panel',
    title: 'Insert Coins',
    body: 'Choose a slot and tap INSERT to drop coins onto the platform. The pusher will nudge them toward the edge!',
    position: 'bottom',
  },
  {
    target: '.player-info-balances',
    title: 'Play & Cash',
    body: 'Play coins are for inserting. When coins fall off the front edge, you earn Cash — which you can withdraw as USDC.',
    position: 'bottom',
  },
  {
    target: '.leaderboard-panel',
    title: 'Heat = Your Reward Share',
    body: 'Inserting coins builds your Heat. Higher heat means a bigger share of every coin that falls off the edge.',
    position: 'right',
  },
  {
    target: '.inventory-bar',
    title: 'Key Coins & Chests',
    body: 'Side-wall exits trigger the Slot Machine and Jackpot Wheel. The wheel drops Key Coins — collect them to open Chests for ability scrolls!',
    position: 'top',
  },
  {
    target: '.toolbar-abilities',
    title: 'Use Abilities',
    body: 'Each ability needs a scroll charge from Chests. Use Tornado, Explosion, Lightning, or Super Push to create massive cascades!',
    position: 'left',
  },
];

export function shouldShowTutorial(): boolean {
  return !localStorage.getItem(STORAGE_KEY);
}

export function markTutorialSeen(): void {
  localStorage.setItem(STORAGE_KEY, '1');
}

interface SpotlightRect {
  top: number;
  left: number;
  width: number;
  height: number;
}

interface TutorialOverlayProps {
  onComplete: () => void;
}

export const TutorialOverlay: React.FC<TutorialOverlayProps> = ({ onComplete }) => {
  const [step, setStep] = useState(0);
  const [spotlight, setSpotlight] = useState<SpotlightRect | null>(null);
  const [tooltipStyle, setTooltipStyle] = useState<React.CSSProperties>({});
  const [visible, setVisible] = useState(false);
  const overlayRef = useRef<HTMLDivElement>(null);

  const current = STEPS[step];

  const computeLayout = useCallback(() => {
    if (!current) return;

    if (current.target) {
      const el = document.querySelector(current.target);
      if (el) {
        const rect = el.getBoundingClientRect();
        const pad = 8;
        const sr: SpotlightRect = {
          top: rect.top - pad,
          left: rect.left - pad,
          width: rect.width + pad * 2,
          height: rect.height + pad * 2,
        };
        setSpotlight(sr);

        // Position tooltip relative to spotlight, clamped within viewport
        const gap = 16;
        const margin = 12;
        const tooltipW = window.innerWidth <= 480 ? 280 : 320;
        const tooltipH = 180; // estimated tooltip height
        const vw = window.innerWidth;
        const vh = window.innerHeight;
        const style: React.CSSProperties = {};

        switch (current.position) {
          case 'bottom':
          case 'top': {
            const centerX = sr.left + sr.width / 2;
            style.left = Math.max(margin, Math.min(centerX - tooltipW / 2, vw - tooltipW - margin));
            if (current.position === 'bottom') {
              style.top = Math.min(sr.top + sr.height + gap, vh - tooltipH - margin);
            } else {
              style.bottom = Math.max(margin, vh - sr.top + gap);
            }
            break;
          }
          case 'left':
          case 'right': {
            const centerY = sr.top + sr.height / 2;
            style.top = Math.max(margin, Math.min(centerY - tooltipH / 2, vh - tooltipH - margin));
            if (current.position === 'left') {
              style.left = Math.max(margin, sr.left - tooltipW - gap);
            } else {
              style.left = Math.min(sr.left + sr.width + gap, vw - tooltipW - margin);
            }
            break;
          }
        }
        setTooltipStyle(style);
        return;
      }
    }

    // Target element not found — show tooltip centered without spotlight
    setSpotlight(null);
    setTooltipStyle({
      top: '50%',
      left: '50%',
      transform: 'translate(-50%, -50%)',
    });
  }, [current, step]);

  useEffect(() => {
    // Small delay for entrance animation
    requestAnimationFrame(() => setVisible(true));
  }, []);

  useEffect(() => {
    computeLayout();
    window.addEventListener('resize', computeLayout);
    return () => window.removeEventListener('resize', computeLayout);
  }, [computeLayout]);

  const handleNext = useCallback(() => {
    if (step < STEPS.length - 1) {
      setStep(step + 1);
    } else {
      markTutorialSeen();
      onComplete();
    }
  }, [step, onComplete]);

  const handleSkip = useCallback(() => {
    markTutorialSeen();
    onComplete();
  }, [onComplete]);

  // Click on overlay (outside tooltip) advances
  const handleOverlayClick = useCallback((e: React.MouseEvent) => {
    // Only if clicking the overlay itself, not the tooltip
    if (e.target === overlayRef.current) {
      handleNext();
    }
  }, [handleNext]);

  const isLast = step === STEPS.length - 1;

  // Build clip-path to create the spotlight hole
  const clipPath = spotlight
    ? buildClipPath(spotlight)
    : undefined;

  return (
    <div
      ref={overlayRef}
      className={`tutorial-overlay ${visible ? 'visible' : ''}`}
      onClick={handleOverlayClick}
    >
      {/* Dark mask with spotlight cutout */}
      <div
        className="tutorial-mask"
        style={clipPath ? { clipPath } : undefined}
      />

      {/* Spotlight border glow */}
      {spotlight && (
        <div
          className="tutorial-spotlight-ring"
          style={{
            top: spotlight.top,
            left: spotlight.left,
            width: spotlight.width,
            height: spotlight.height,
          }}
        />
      )}

      {/* Tooltip card */}
      <div className="tutorial-tooltip" style={tooltipStyle} onClick={(e) => e.stopPropagation()}>
        <div className="tutorial-step-indicator">
          {STEPS.map((_, i) => (
            <span key={i} className={`tutorial-dot ${i === step ? 'active' : ''} ${i < step ? 'done' : ''}`} />
          ))}
        </div>
        <h3 className="tutorial-title">{current.title}</h3>
        <p className="tutorial-body">{current.body}</p>
        <div className="tutorial-actions">
          <button className="tutorial-skip-btn" onClick={handleSkip}>
            Skip
          </button>
          <button className="tutorial-next-btn" onClick={handleNext}>
            {isLast ? 'Got it!' : 'Next'}
          </button>
        </div>
      </div>
    </div>
  );
};

/** Build a polygon clip-path that covers the full viewport EXCEPT the spotlight rect */
function buildClipPath(r: SpotlightRect): string {
  const W = window.innerWidth;
  const H = window.innerHeight;
  const { top: t, left: l, width: w, height: h } = r;
  const br = 8; // border-radius approximation

  // Outer rectangle (full screen) + inner rectangle (cutout) wound in opposite direction
  return `polygon(
    0 0, ${W}px 0, ${W}px ${H}px, 0 ${H}px, 0 0,
    ${l + br}px ${t}px,
    ${l}px ${t + br}px,
    ${l}px ${t + h - br}px,
    ${l + br}px ${t + h}px,
    ${l + w - br}px ${t + h}px,
    ${l + w}px ${t + h - br}px,
    ${l + w}px ${t + br}px,
    ${l + w - br}px ${t}px,
    ${l + br}px ${t}px
  )`;
}
