import React, { useState, useRef, useCallback, useEffect } from 'react';
import ReactDOM from 'react-dom';
import './InfoTip.css';

interface InfoTipProps {
  text: string;
  /** Position preference (auto-adjusts if overflowing viewport) */
  position?: 'top' | 'bottom' | 'left' | 'right';
}

export const InfoTip: React.FC<InfoTipProps> = ({ text, position = 'top' }) => {
  const [visible, setVisible] = useState(false);
  const [style, setStyle] = useState<React.CSSProperties>({});
  const iconRef = useRef<HTMLSpanElement>(null);
  const tipRef = useRef<HTMLDivElement>(null);
  const hideTimer = useRef<ReturnType<typeof setTimeout>>();

  const show = useCallback(() => {
    clearTimeout(hideTimer.current);
    setVisible(true);
  }, []);

  const hide = useCallback(() => {
    hideTimer.current = setTimeout(() => setVisible(false), 120);
  }, []);

  // Toggle on tap for mobile
  const toggle = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    setVisible(v => !v);
  }, []);

  // Close on outside click (mobile)
  useEffect(() => {
    if (!visible) return;
    const handleClick = (e: MouseEvent) => {
      if (iconRef.current?.contains(e.target as Node)) return;
      if (tipRef.current?.contains(e.target as Node)) return;
      setVisible(false);
    };
    document.addEventListener('pointerdown', handleClick);
    return () => document.removeEventListener('pointerdown', handleClick);
  }, [visible]);

  // Position the tooltip when shown
  useEffect(() => {
    if (!visible || !iconRef.current || !tipRef.current) return;
    const iconRect = iconRef.current.getBoundingClientRect();
    const tipRect = tipRef.current.getBoundingClientRect();
    const margin = 8;
    const gap = 6;
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    let top = 0;
    let left = 0;

    switch (position) {
      case 'top':
        top = iconRect.top - tipRect.height - gap;
        left = iconRect.left + iconRect.width / 2 - tipRect.width / 2;
        break;
      case 'bottom':
        top = iconRect.bottom + gap;
        left = iconRect.left + iconRect.width / 2 - tipRect.width / 2;
        break;
      case 'left':
        top = iconRect.top + iconRect.height / 2 - tipRect.height / 2;
        left = iconRect.left - tipRect.width - gap;
        break;
      case 'right':
        top = iconRect.top + iconRect.height / 2 - tipRect.height / 2;
        left = iconRect.right + gap;
        break;
    }

    // Clamp within viewport
    top = Math.max(margin, Math.min(top, vh - tipRect.height - margin));
    left = Math.max(margin, Math.min(left, vw - tipRect.width - margin));

    setStyle({ top, left });
  }, [visible, position]);

  return (
    <>
      <span
        ref={iconRef}
        className="infotip-icon"
        onMouseEnter={show}
        onMouseLeave={hide}
        onClick={toggle}
      >
        ?
      </span>
      {visible && ReactDOM.createPortal(
        <div
          ref={tipRef}
          className="infotip-popup"
          style={style}
          onMouseEnter={show}
          onMouseLeave={hide}
        >
          {text}
        </div>,
        document.body
      )}
    </>
  );
};
