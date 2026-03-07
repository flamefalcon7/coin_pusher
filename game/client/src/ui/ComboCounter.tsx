import React, { useEffect, useState, useRef } from 'react';
import './ComboCounter.css';

interface ComboCounterProps {
  rewardId: number;
  rewardAmount: number;
}

const COMBO_TIMEOUT = 5000;

export const ComboCounter: React.FC<ComboCounterProps> = ({ rewardId, rewardAmount }) => {
  const [combo, setCombo] = useState(0);
  const [total, setTotal] = useState(0);
  const [visible, setVisible] = useState(false);
  const [popKey, setPopKey] = useState(0);
  const timerRef = useRef<ReturnType<typeof setTimeout>>();
  const prevIdRef = useRef(0);

  useEffect(() => {
    if (rewardId === 0 || rewardId === prevIdRef.current) return;
    prevIdRef.current = rewardId;

    clearTimeout(timerRef.current);
    setCombo(prev => prev + 1);
    setTotal(prev => prev + rewardAmount);
    setVisible(true);
    setPopKey(k => k + 1);

    timerRef.current = setTimeout(() => {
      setVisible(false);
      setTimeout(() => {
        setCombo(0);
        setTotal(0);
      }, 500);
    }, COMBO_TIMEOUT);

    return () => clearTimeout(timerRef.current);
  }, [rewardId, rewardAmount]);

  if (!visible && combo === 0) return null;

  const tier = combo >= 10 ? 3 : combo >= 5 ? 2 : combo >= 2 ? 1 : 0;

  return (
    <div className={`combo-counter tier-${tier} ${visible ? 'visible' : 'fade-out'}`}>
      <div className="combo-total" key={popKey}>+{total.toFixed(1)}</div>
    </div>
  );
};
