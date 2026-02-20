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
      <div className="hud-inner">
        <div className="hud-title">GROOVY COINS</div>
        <div className="hud-coin-row">
          <img
            className="hud-coin-icon"
            src="/ui/kenney-ui-pack/PNG/Yellow/Default/button_round_depth_flat.png"
            alt=""
            draggable={false}
          />
          <span className="hud-coin-count">{activeCoin}</span>
        </div>
        <div className="hud-stats">
          FPS: {fps} | Ping: {ping}ms
        </div>
      </div>
    </div>
  );
};
