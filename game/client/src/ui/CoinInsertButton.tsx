import React, { useState, useCallback, useEffect } from 'react';
import { SLOT_CONFIG, DROP_SCHEDULER_CONFIG } from '@coin-pusher/shared';
import './CoinInsertButton.css';
import { InfoTip } from './InfoTip';

interface CoinInsertButtonProps {
  onClick: (slotIndex: number, count: number) => void;
  disabled: boolean;
  slotCounts?: number[];
  ackMessage?: string | null;
  rejected?: boolean;
}

const SLOT_COUNT = SLOT_CONFIG.POSITIONS.length;

const BATCH_AMOUNTS = [1, 10, 50, 100];

const SLOT_CAP = DROP_SCHEDULER_CONFIG.SLOT_CAP;

export const CoinInsertButton: React.FC<CoinInsertButtonProps> = ({ onClick, disabled, slotCounts, ackMessage, rejected }) => {
  const [selectedSlot, setSelectedSlot] = useState(Math.floor(SLOT_COUNT / 2)); // start center
  const [pressed, setPressed] = useState(false);
  const [selectedAmount, setSelectedAmount] = useState(1);

  const moveLeft = useCallback(() => {
    setSelectedSlot(prev => Math.max(0, prev - 1));
  }, []);

  const moveRight = useCallback(() => {
    setSelectedSlot(prev => Math.min(SLOT_COUNT - 1, prev + 1));
  }, []);

  const handleInsert = useCallback(() => {
    if (disabled) return;
    onClick(selectedSlot, selectedAmount);
  }, [disabled, onClick, selectedSlot, selectedAmount]);

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

  const selCount = slotCounts?.[selectedSlot] ?? 0;
  const selPct = Math.min(selCount / SLOT_CAP, 1);
  const selFull = selCount >= SLOT_CAP;

  return (
    <div className="coin-panel">
      {/* Slot strategy hint */}
      <InfoTip text="Left slots feed the slot machine. Center slots maximize front-edge drops for direct rewards." position="bottom" />
      {/* Batch + Slot selectors on one row */}
      <div className="coin-panel-top-row">
        <div className="coin-batch-selector">
          {BATCH_AMOUNTS.map((amount) => (
            <button
              key={amount}
              className={`coin-batch-btn ${amount === selectedAmount ? 'active' : ''}`}
              onClick={() => setSelectedAmount(amount)}
            >
              {amount}
            </button>
          ))}
        </div>

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

          <div className="coin-slot-cols">
            <div className="coin-slot-dots">
              {Array.from({ length: SLOT_COUNT }, (_, i) => {
                const isFull = (slotCounts?.[i] ?? 0) >= SLOT_CAP;
                return (
                  <button
                    key={i}
                    className={`coin-dot ${i === selectedSlot ? 'active' : ''} ${isFull ? 'full' : ''}`}
                    onClick={() => setSelectedSlot(i)}
                  />
                );
              })}
            </div>
            <div className="coin-slot-counts">
              {Array.from({ length: SLOT_COUNT }, (_, i) => {
                const c = slotCounts?.[i] ?? 0;
                return (
                  <span
                    key={i}
                    className={`coin-slot-count ${i === selectedSlot ? 'active' : ''} ${c >= SLOT_CAP ? 'full' : ''}`}
                  >
                    {c > 0 ? c : ''}
                  </span>
                );
              })}
            </div>
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
      </div>

      {/* Slot progress bar (always visible when there are queued coins) */}
      {selCount > 0 && (
        <div className="slot-progress-row">
          <div className={`slot-progress-bar ${selFull ? 'full' : ''}`}>
            <div
              className="slot-progress-fill"
              style={{ width: `${selPct * 100}%` }}
            />
          </div>
          <span className={`slot-progress-label ${selFull ? 'full' : ''}`}>
            {selFull ? 'FULL' : `${selCount}/${SLOT_CAP}`}
          </span>
        </div>
      )}

      {/* Insert coin button */}
      <button
        className={`coin-insert-btn ${pressed ? 'pressed' : ''} ${rejected ? 'rejected' : ''}`}
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
        <span className="coin-insert-btn-text">
          INSERT {selectedAmount > 1 ? `${selectedAmount} COINS` : 'COIN'}
        </span>
      </button>

      {ackMessage && (
        <div className="coin-ack-message">{ackMessage}</div>
      )}
    </div>
  );
};
