import React, { useRef } from 'react';
import './Leaderboard.css';

export interface LeaderboardEntry {
  user_id: string;
  username: string;
  share: number;
  rank: number;
}

interface LeaderboardProps {
  entries: LeaderboardEntry[];
  myEntry: LeaderboardEntry | null;
  myUserId: string;
}

const ROW_HEIGHT = 28;

export const Leaderboard: React.FC<LeaderboardProps> = ({ entries, myEntry, myUserId }) => {
  // Track previous index per user_id so we can animate from old position.
  const prevOrderRef = useRef<Map<string, number>>(new Map());
  // Bump counter per user_id when their index changes, to re-trigger CSS animation.
  const animKeyRef = useRef<Map<string, number>>(new Map());

  const prevOrder = prevOrderRef.current;
  const animKeys = animKeyRef.current;

  // Compute anim keys and build next order map.
  const nextOrder = new Map<string, number>();
  entries.forEach((e, i) => {
    nextOrder.set(e.user_id, i);
    const prev = prevOrder.get(e.user_id);
    if (prev !== undefined && prev !== i) {
      animKeys.set(e.user_id, (animKeys.get(e.user_id) ?? 0) + 1);
    }
  });

  const myInTop5 = entries.some(e => e.user_id === myUserId);

  // Build rows before updating prevOrderRef so we read the old positions.
  const rows = entries.map((entry, i) => {
    const prevIdx = prevOrder.get(entry.user_id);
    const fromY = prevIdx !== undefined ? prevIdx * ROW_HEIGHT : i * ROW_HEIGHT;
    const toY = i * ROW_HEIGHT;
    const isMe = entry.user_id === myUserId;
    const isTop1 = i === 0;
    const ak = animKeys.get(entry.user_id) ?? 0;

    return (
      <div
        key={`${entry.user_id}-${ak}`}
        className={`lb-row${isTop1 ? ' on-fire' : ''}${isMe ? ' is-me' : ''}`}
        style={{
          transform: `translateY(${toY}px)`,
          '--from-y': `${fromY}px`,
          '--to-y': `${toY}px`,
        } as React.CSSProperties}
      >
        <span className="lb-rank">{entry.rank}.</span>
        {isTop1 && <span className="fire-icon">&#x1F525;</span>}
        <span className="lb-name">{entry.username}</span>
        <span className="lb-share">{(entry.share * 100).toFixed(1)}%</span>
      </div>
    );
  });

  // Update prevOrder after rendering so next render sees old positions.
  prevOrderRef.current = nextOrder;

  return (
    <div className="leaderboard-panel">
      <div className="leaderboard-title">HEAT RANKING</div>
      <div className="leaderboard-list" style={{ height: entries.length * ROW_HEIGHT }}>
        {rows}
      </div>
      {myEntry && !myInTop5 && (
        <>
          <div className="leaderboard-divider" />
          <div className="lb-my-rank">
            <span className="lb-rank">#{myEntry.rank}</span>
            <span className="lb-name">{myEntry.username}</span>
            <span className="lb-share">{(myEntry.share * 100).toFixed(1)}%</span>
          </div>
        </>
      )}
    </div>
  );
};
