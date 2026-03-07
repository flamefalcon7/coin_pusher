import React from 'react';
import { Link } from 'react-router-dom';
import './InventoryBar.css';
import { InfoTip } from './InfoTip';

interface InventoryBarProps {
  keyCoins: number;
}

export const InventoryBar: React.FC<InventoryBarProps> = ({ keyCoins }) => {
  return (
    <div className="inventory-bar-wrap">
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
      <InfoTip text="Collect 3 keys to open a chest for ability scrolls. Keys drop from the right-side jackpot wheel." position="top" />
    </div>
  );
};
