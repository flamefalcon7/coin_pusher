import React from 'react';

interface HUDProps {
  fps: number;
  ping: number;
  activeCoin: number;
}

export const HUD: React.FC<HUDProps> = ({ fps, ping, activeCoin }) => {
  return (
    <div className="hud">
      <div className="hud-item">FPS: {fps}</div>
      <div className="hud-item">Ping: {ping}ms</div>
      <div className="hud-item">Coins: {activeCoin}</div>
    </div>
  );
};

