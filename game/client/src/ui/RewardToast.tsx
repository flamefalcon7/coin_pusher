import React, { useEffect, useState } from 'react';
import './RewardToast.css';

interface RewardToastProps {
  amount: number;
  id: number; // unique key to trigger re-animation
}

export const RewardToast: React.FC<RewardToastProps> = ({ amount, id }) => {
  const [visible, setVisible] = useState(true);

  useEffect(() => {
    setVisible(true);
    const timer = setTimeout(() => setVisible(false), 3000);
    return () => clearTimeout(timer);
  }, [id]);

  if (!visible) return null;

  return (
    <div className="reward-toast" key={id}>
      +{amount.toFixed(1)} coins
    </div>
  );
};
