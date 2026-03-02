import React from 'react';
import './TargetingHint.css';

interface TargetingHintProps {
  visible: boolean;
  abilityName: string;
}

export const TargetingHint: React.FC<TargetingHintProps> = ({ visible, abilityName }) => {
  return (
    <div className={`targeting-hint ${visible ? 'visible' : ''}`}>
      <span className="targeting-hint-action">Click to place {abilityName}</span>
      <span className="targeting-hint-cancel">ESC cancel</span>
    </div>
  );
};
