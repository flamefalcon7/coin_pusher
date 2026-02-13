import React from 'react';
import { SLOT_CONFIG } from '@coin-pusher/shared';

interface CoinInsertButtonProps {
  onClick: (slotIndex: number) => void;
  disabled: boolean;
}

export const CoinInsertButton: React.FC<CoinInsertButtonProps> = ({ onClick, disabled }) => {
  return (
    <div className="slot-buttons-container">
      {SLOT_CONFIG.POSITIONS.map((_, index) => (
        <button
          key={index}
          className="slot-button"
          onClick={() => onClick(index)}
          disabled={disabled}
        >
          Slot {index + 1}
        </button>
      ))}
    </div>
  );
};

