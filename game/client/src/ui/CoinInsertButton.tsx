import React, { useState, useCallback, useEffect } from 'react';
import { SLOT_CONFIG } from '@coin-pusher/shared';
import './CoinInsertButton.css';

interface CoinInsertButtonProps {
  onClick: (slotIndex: number) => void;
  disabled: boolean;
}

const SLOT_COUNT = SLOT_CONFIG.POSITIONS.length;

export const CoinInsertButton: React.FC<CoinInsertButtonProps> = ({ onClick, disabled }) => {
  const [selectedSlot, setSelectedSlot] = useState(Math.floor(SLOT_COUNT / 2)); // start center
  const [pressed, setPressed] = useState(false);

  const moveLeft = useCallback(() => {
    setSelectedSlot(prev => Math.max(0, prev - 1));
  }, []);

  const moveRight = useCallback(() => {
    setSelectedSlot(prev => Math.min(SLOT_COUNT - 1, prev + 1));
  }, []);

  const handleInsert = useCallback(() => {
    if (disabled) return;
    onClick(selectedSlot);
  }, [disabled, onClick, selectedSlot]);

  const handleInsertDown = useCallback(() => {
    if (disabled) return;
    setPressed(true);
  }, [disabled]);

  const handleInsertUp = useCallback(() => {
    if (!pressed) return;
    setPressed(false);
    handleInsert();
  }, [pressed, handleInsert]);

  // Keyboard: arrow keys to select slot, space/enter to insert
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).tagName === 'INPUT') return;
      switch (e.key) {
        case 'ArrowLeft':
          e.preventDefault();
          moveLeft();
          break;
        case 'ArrowRight':
          e.preventDefault();
          moveRight();
          break;
        case ' ':
          e.preventDefault();
          if (!disabled) {
            setPressed(true);
          }
          break;
      }
    };
    const handleKeyUp = (e: KeyboardEvent) => {
      if (e.key === ' ') {
        e.preventDefault();
        setPressed(prev => {
          if (prev) {
            // Fire insert on next tick so selectedSlot is current
            setTimeout(() => handleInsert(), 0);
          }
          return false;
        });
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
    };
  }, [moveLeft, moveRight, disabled, handleInsert]);

  return (
    <div className="coin-panel">
      {/* Slot selector row */}
      <div className="coin-panel-selector">
        <button
          className="coin-arrow-btn"
          onClick={moveLeft}
          disabled={selectedSlot === 0}
        >
          <img
            src="/ui/kenney-ui-pack/PNG/Yellow/Default/arrow_basic_w.png"
            alt="Left"
            draggable={false}
          />
        </button>

        <div className="coin-slot-dots">
          {Array.from({ length: SLOT_COUNT }, (_, i) => (
            <button
              key={i}
              className={`coin-dot ${i === selectedSlot ? 'active' : ''}`}
              onClick={() => setSelectedSlot(i)}
            />
          ))}
        </div>

        <button
          className="coin-arrow-btn"
          onClick={moveRight}
          disabled={selectedSlot === SLOT_COUNT - 1}
        >
          <img
            src="/ui/kenney-ui-pack/PNG/Yellow/Default/arrow_basic_e.png"
            alt="Right"
            draggable={false}
          />
        </button>
      </div>

      {/* Insert coin button */}
      <button
        className={`coin-insert-btn ${pressed ? 'pressed' : ''}`}
        onPointerDown={handleInsertDown}
        onPointerUp={handleInsertUp}
        onPointerLeave={() => setPressed(false)}
        disabled={disabled}
      >
        <img
          className="coin-insert-btn-bg"
          src="/ui/kenney-ui-pack/PNG/Yellow/Double/button_rectangle_depth_flat.png"
          alt=""
          draggable={false}
        />
        <span className="coin-insert-btn-text">INSERT COIN</span>
      </button>
    </div>
  );
};
