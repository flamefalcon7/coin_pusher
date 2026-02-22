import React from 'react';
import './HUD.css';

interface HUDProps {
  fps: number;
  ping: number;
  activeCoin: number;
}

export const HUD: React.FC<HUDProps> = ({ fps, ping, activeCoin }) => {
  return (
    <div className="hud">
      {activeCoin} coins &nbsp;|&nbsp; {fps}fps &nbsp;|&nbsp; {ping}ms
    </div>
  );
};
