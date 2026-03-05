import React, { useEffect, useRef, useState } from 'react';
import './AbilityToast.css';

export interface AbilityToastEntry {
  id: number;
  username: string;
  ability: string;
}

const ABILITY_LABELS: Record<string, string> = {
  shock: "Shock",
  tornado: "Tornado",
  explosion: "Explosion",
  lightning: "Lightning",
  superPush: "Super Push",
};

const ABILITY_ICONS: Record<string, string> = {
  shock: "\u26A1",
  tornado: "\uD83C\uDF2A\uFE0F",
  explosion: "\uD83D\uDCA5",
  lightning: "\u2601\uFE0F",
  superPush: "\uD83D\uDCAA",
};

interface AbilityToastItemProps {
  entry: AbilityToastEntry;
  onDone: (id: number) => void;
}

const AbilityToastItem: React.FC<AbilityToastItemProps> = ({ entry, onDone }) => {
  const [visible, setVisible] = useState(true);
  const onDoneRef = useRef(onDone);
  onDoneRef.current = onDone;

  useEffect(() => {
    const timer = setTimeout(() => {
      setVisible(false);
      setTimeout(() => onDoneRef.current(entry.id), 400);
    }, 3000);
    return () => clearTimeout(timer);
  }, [entry.id]);

  return (
    <div className={`ability-toast-item ${visible ? 'visible' : 'fading'}`}>
      <span className="ability-toast-icon">{ABILITY_ICONS[entry.ability] || "\u2728"}</span>
      <span className="ability-toast-text">
        <strong>{entry.username}</strong> used {ABILITY_LABELS[entry.ability] || entry.ability}!
      </span>
    </div>
  );
};

interface AbilityToastProps {
  entries: AbilityToastEntry[];
  onRemove: (id: number) => void;
}

export const AbilityToast: React.FC<AbilityToastProps> = ({ entries, onRemove }) => {
  if (entries.length === 0) return null;

  return (
    <div className="ability-toast-container">
      {entries.map((entry) => (
        <AbilityToastItem key={entry.id} entry={entry} onDone={onRemove} />
      ))}
    </div>
  );
};
