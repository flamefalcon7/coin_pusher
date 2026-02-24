import React from 'react';
import './HeatMeter.css';

interface HeatMeterProps {
  share: number;
  rawHeat: number;
}

export const HeatMeter: React.FC<HeatMeterProps> = ({
  share,
  rawHeat: _rawHeat,
}) => {
  const sharePercent = (share * 100).toFixed(1);
  const barWidth = Math.min(share * 100, 100);

  return (
    <div className="heat-panel">
      <div className="heat-header">
        <span className="heat-label">My Heat: {sharePercent}%</span>
      </div>
      <div className="heat-bar-container">
        <div className="heat-bar-fill" style={{ width: `${barWidth}%` }} />
      </div>
    </div>
  );
};
