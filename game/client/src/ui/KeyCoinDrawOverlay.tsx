import React, { useEffect, useState, useRef } from 'react';
import './KeyCoinDrawOverlay.css';

interface Player {
  user_id: string;
  username: string;
}

interface DrawResult {
  winnerName: string;
  winnerId: string;
  count: number;
  isMe: boolean;
  id: number;
}

interface KeyCoinDrawOverlayProps {
  draw: DrawResult | null;
  players: Player[];
}

const TICK_INTERVAL = 60; // ms per name switch during fast phase
const FAST_TICKS = 10; // fast cycling ticks
const SLOW_TICKS = 4; // decelerating ticks
const RESULT_HOLD = 2500; // ms to show final result

export const KeyCoinDrawOverlay: React.FC<KeyCoinDrawOverlayProps> = ({ draw, players }) => {
  const [phase, setPhase] = useState<'idle' | 'rolling' | 'result'>('idle');
  const [displayName, setDisplayName] = useState('');
  const [resultData, setResultData] = useState<DrawResult | null>(null);
  const tickRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const processedIdRef = useRef(0);
  const playersRef = useRef<Player[]>(players);
  playersRef.current = players;

  useEffect(() => {
    if (!draw || draw.id === processedIdRef.current) return;
    processedIdRef.current = draw.id;

    // Resolve winner name: prefer draw.winnerName, fallback to leaderboard lookup
    const resolvedWinner = draw.winnerName
      || playersRef.current.find(p => p.user_id === draw.winnerId)?.username
      || '???';

    // Snapshot players at draw time
    const candidates = playersRef.current.length > 0
      ? playersRef.current.map(p => p.username).filter(Boolean)
      : [];
    if (candidates.length === 0) candidates.push(resolvedWinner);
    if (!candidates.includes(resolvedWinner)) {
      candidates.push(resolvedWinner);
    }

    // Clear any running animation
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    tickRef.current = 0;
    setPhase('rolling');
    setResultData(draw);

    const totalTicks = FAST_TICKS + SLOW_TICKS;

    const tick = () => {
      tickRef.current++;
      const t = tickRef.current;

      if (t <= FAST_TICKS) {
        const randIdx = Math.floor(Math.random() * candidates.length);
        setDisplayName(candidates[randIdx]);
        timerRef.current = setTimeout(tick, TICK_INTERVAL);
      } else if (t <= totalTicks) {
        const slowIdx = t - FAST_TICKS;
        const delay = TICK_INTERVAL + slowIdx * 60;
        const randIdx = Math.floor(Math.random() * candidates.length);
        setDisplayName(candidates[randIdx]);
        timerRef.current = setTimeout(tick, delay);
      } else {
        setDisplayName(resolvedWinner);
        setPhase('result');
        timerRef.current = setTimeout(() => {
          setPhase('idle');
        }, RESULT_HOLD);
      }
    };

    timerRef.current = setTimeout(tick, 200);

    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [draw]); // only re-run when draw changes, not players

  if (phase === 'idle') return null;

  const isResult = phase === 'result';

  return (
    <div className="kcd-overlay" key={resultData?.id}>
      <div className={`kcd-box ${isResult ? 'kcd-box-result' : ''} ${isResult && resultData?.isMe ? 'kcd-box-me' : ''}`}>
        <div className="kcd-title">Key Coin Draw</div>
        <div className={`kcd-name ${isResult ? 'kcd-name-winner' : 'kcd-name-rolling'}`}>
          {displayName}
        </div>
        {isResult && resultData && (
          <div className="kcd-reward">
            <span className="kcd-key-icon">&#x1F511;</span>
            <span className="kcd-count">&times;{resultData.count}</span>
          </div>
        )}
        {!isResult && (
          <div className="kcd-dots">
            <span className="kcd-dot" />
            <span className="kcd-dot" />
            <span className="kcd-dot" />
          </div>
        )}
      </div>
    </div>
  );
};
