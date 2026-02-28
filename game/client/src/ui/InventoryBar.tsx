import React from 'react';
import { Link } from 'react-router-dom';
import './InventoryBar.css';

interface InventoryBarProps {
  keyCoins: number;
}

export const InventoryBar: React.FC<InventoryBarProps> = ({ keyCoins }) => {
  return (
    <Link to="/chest" className="inventory-bar">
      <span className="inventory-bar-chest">&#x1F4E6;</span>
      <div className="inventory-bar-info">
        <span className="inventory-bar-label">Chest</span>
        <span className="inventory-bar-keys">
          <span className="inventory-bar-key-icon">&#x1F511;</span>
          {keyCoins}
        </span>
      </div>
    </Link>
  );
};
