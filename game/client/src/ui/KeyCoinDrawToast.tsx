import React, { useEffect, useState } from 'react';
import './KeyCoinDrawToast.css';

interface KeyCoinDrawToastProps {
  winnerName: string;
  count: number;
  isMe: boolean;
  id: number; // unique key to trigger re-animation
}

export const KeyCoinDrawToast: React.FC<KeyCoinDrawToastProps> = ({ winnerName, count, isMe, id }) => {
  const [visible, setVisible] = useState(true);

  useEffect(() => {
    setVisible(true);
    const timer = setTimeout(() => setVisible(false), 5000);
    return () => clearTimeout(timer);
  }, [id]);

  if (!visible) return null;

  return (
    <div className={`key-coin-draw-toast ${isMe ? 'is-me' : ''}`} key={id}>
      <span className="key-coin-draw-icon">&#x1F511;</span>
      <span className="key-coin-draw-text">
        <strong>{winnerName}</strong> won {count} key coin{count > 1 ? 's' : ''}!
      </span>
    </div>
  );
};
