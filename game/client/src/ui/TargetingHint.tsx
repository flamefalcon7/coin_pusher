import React from 'react';
import './TargetingHint.css';
import { useIsMobile } from './useIsMobile';

interface TargetingHintProps {
  visible: boolean;
  abilityName: string;
  onCancel?: () => void;
}

export const TargetingHint: React.FC<TargetingHintProps> = ({ visible, abilityName, onCancel }) => {
  const isMobile = useIsMobile();
  return (
    <div className={`targeting-hint ${visible ? 'visible' : ''}`}>
      <span className="targeting-hint-action">
        {isMobile ? 'Tap' : 'Click'} to place {abilityName}
      </span>
      {isMobile && onCancel ? (
        <button className="targeting-hint-cancel-btn" onClick={onCancel}>Cancel</button>
      ) : (
        <span className="targeting-hint-cancel">ESC cancel</span>
      )}
    </div>
  );
};
