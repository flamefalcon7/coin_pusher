import React from 'react';

interface CoinInsertButtonProps {
  onClick: () => void;
  disabled: boolean;
}

export const CoinInsertButton: React.FC<CoinInsertButtonProps> = ({ onClick, disabled }) => {
  return (
    <button 
      className="coin-insert-button" 
      onClick={onClick}
      disabled={disabled}
    >
      🪙 Insert Coin
    </button>
  );
};

