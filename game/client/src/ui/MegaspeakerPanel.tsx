import React, { useState, useRef, useEffect } from 'react';
import './MegaspeakerPanel.css';

export interface MegaspeakerMsg {
  speakerName: string;
  message: string;
  timestamp: number;
}

const PROFANITY_LIST = ["fuck", "shit", "ass", "bitch", "dick", "damn", "cunt", "nigger", "faggot"];

function filterProfanity(text: string): string {
  let result = text;
  for (const word of PROFANITY_LIST) {
    const regex = new RegExp(word, 'gi');
    result = result.replace(regex, '***');
  }
  return result;
}

function formatRelativeTime(timestamp: number): string {
  const diff = Date.now() - timestamp;
  if (diff < 60000) return '剛剛';
  const minutes = Math.floor(diff / 60000);
  if (minutes < 60) return `${minutes}分鐘前`;
  const hours = Math.floor(minutes / 60);
  return `${hours}小時前`;
}

interface MegaspeakerPanelProps {
  messages: MegaspeakerMsg[];
  megaspeakerCount: number;
  onSend: (msg: string) => void;
  unreadCount: number;
  onToggle: () => void;
  isOpen: boolean;
}

export const MegaspeakerPanel: React.FC<MegaspeakerPanelProps> = ({
  messages,
  megaspeakerCount,
  onSend,
  unreadCount,
  onToggle,
  isOpen,
}) => {
  const [input, setInput] = useState('');
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (isOpen && listRef.current) {
      listRef.current.scrollTop = listRef.current.scrollHeight;
    }
  }, [messages, isOpen]);

  const handleSend = () => {
    const trimmed = input.trim();
    if (!trimmed || megaspeakerCount <= 0) return;
    onSend(trimmed);
    setInput('');
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleSend();
    }
  };

  if (!isOpen) {
    return (
      <button className="megaspeaker-toggle" onClick={onToggle}>
        📢
        {unreadCount > 0 && (
          <span className="megaspeaker-badge">{unreadCount}</span>
        )}
      </button>
    );
  }

  return (
    <div className="megaspeaker-panel">
      <div className="megaspeaker-header">
        <span className="megaspeaker-title">📢 Megaspeaker</span>
        <button className="megaspeaker-close" onClick={onToggle}>✕</button>
      </div>
      <div className="megaspeaker-messages" ref={listRef}>
        {messages.map((msg, i) => (
          <div key={i} className="megaspeaker-msg">
            <span className="megaspeaker-name">{filterProfanity(msg.speakerName)}</span>
            <span className="megaspeaker-text">{filterProfanity(msg.message)}</span>
            <span className="megaspeaker-time">{formatRelativeTime(msg.timestamp)}</span>
          </div>
        ))}
        {messages.length === 0 && (
          <div className="megaspeaker-empty">No messages yet</div>
        )}
      </div>
      <div className="megaspeaker-input-bar">
        <input
          className="megaspeaker-input"
          type="text"
          maxLength={150}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Type a message..."
        />
        <button
          className="megaspeaker-send"
          onClick={handleSend}
          disabled={megaspeakerCount <= 0 || !input.trim()}
        >
          Send ({megaspeakerCount})
        </button>
      </div>
    </div>
  );
};
