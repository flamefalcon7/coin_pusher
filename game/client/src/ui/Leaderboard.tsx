import React, { useRef, useState, useEffect } from 'react';
import './Leaderboard.css';
import { InfoTip } from './InfoTip';
import { useIsMobile } from './useIsMobile';
import { useIsLandscape } from './useIsLandscape';
import { RANK_COLORS } from '@coin-pusher/shared';

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

type ShareDelta = { direction: 'up' | 'down'; key: number };

export const Leaderboard: React.FC<LeaderboardProps> = ({ entries, myEntry, myUserId }) => {
  const isMobile = useIsMobile();
  const isLandscape = useIsLandscape();
  const [collapsed, setCollapsed] = useState(false);

  // Auto-collapse on mobile/landscape
  useEffect(() => {
    if (isMobile || isLandscape) setCollapsed(true);
  }, [isMobile, isLandscape]);

  // Track previous index per user_id so we can animate from old position.
  const prevOrderRef = useRef<Map<string, number>>(new Map());
  // Bump counter per user_id when their index changes, to re-trigger CSS animation.
  const animKeyRef = useRef<Map<string, number>>(new Map());

  // Heat change tracking for my entry
  const prevShareRef = useRef<number | null>(null);
  const prevRankRef = useRef<number | null>(null);
  const [shareDelta, setShareDelta] = useState<ShareDelta | null>(null);
  const [rankUp, setRankUp] = useState(0);
  const deltaKeyRef = useRef(0);

  // Detect share and rank changes for current user
  useEffect(() => {
    const myShare = myEntry?.share ?? entries.find(e => e.user_id === myUserId)?.share;
    const myRank = myEntry?.rank ?? entries.find(e => e.user_id === myUserId)?.rank;

    if (myShare !== undefined && prevShareRef.current !== null) {
      const diff = myShare - prevShareRef.current;
      // Only show if change is meaningful (> 0.1%)
      if (Math.abs(diff) > 0.001) {
        deltaKeyRef.current++;
        setShareDelta({ direction: diff > 0 ? 'up' : 'down', key: deltaKeyRef.current });
      }
    }

    if (myRank !== undefined && prevRankRef.current !== null && myRank < prevRankRef.current) {
      setRankUp(r => r + 1);
    }

    if (myShare !== undefined) prevShareRef.current = myShare;
    if (myRank !== undefined) prevRankRef.current = myRank;
  }, [entries, myEntry, myUserId]);

  // Clear share delta after animation
  useEffect(() => {
    if (!shareDelta) return;
    const t = setTimeout(() => setShareDelta(null), 1500);
    return () => clearTimeout(t);
  }, [shareDelta]);

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
        className={`lb-row${isTop1 ? ' on-fire' : ''}${isMe ? ' is-me' : ''}${isMe && rankUp > 0 ? ' rank-up' : ''}`}
        style={{
          transform: `translateY(${toY}px)`,
          '--from-y': `${fromY}px`,
          '--to-y': `${toY}px`,
        } as React.CSSProperties}
      >
        <span className="lb-rank" style={{ color: RANK_COLORS[i] }}>{entry.rank}.</span>
        {isTop1 && <span className="fire-icon">&#x1F525;</span>}
        <span className="lb-name" style={{ color: RANK_COLORS[i] }}>{isMe ? 'You' : entry.username}</span>
        <span className="lb-share" style={{ color: RANK_COLORS[i] }}>
          {(entry.share * 100).toFixed(1)}%
          {isMe && shareDelta && (
            <span
              key={shareDelta.key}
              className={`lb-share-delta ${shareDelta.direction}`}
            >
              {shareDelta.direction === 'up' ? '\u25B2' : '\u25BC'}
            </span>
          )}
        </span>
      </div>
    );
  });

  // Update prevOrder after rendering so next render sees old positions.
  prevOrderRef.current = nextOrder;

  const myInfo = myEntry ?? entries.find(e => e.user_id === myUserId) ?? null;

  return (
    <div className="leaderboard-panel">
      <div className="leaderboard-title" onClick={() => setCollapsed(c => !c)}>
        HEAT RANKING {collapsed ? '▸' : '▾'} <InfoTip text="Insert more coins = higher Heat = bigger share of rewards. Heat decays over time — keep inserting to maintain your rank." position="right" />
      </div>
      {collapsed && myInfo && (
        <div className="lb-collapsed-summary" style={myInfo.rank <= 5 ? { color: RANK_COLORS[myInfo.rank - 1] } : undefined}>
          #{myInfo.rank} — {(myInfo.share * 100).toFixed(1)}%
        </div>
      )}
      {!collapsed && (
        <>
          <div className="leaderboard-list" style={{ height: entries.length * ROW_HEIGHT }}>
            {rows}
          </div>
          {myEntry && !myInTop5 && (
            <>
              <div className="leaderboard-divider" />
              <div className={`lb-my-rank ${rankUp > 0 ? 'rank-up' : ''}`}>
                <span className="lb-rank">#{myEntry.rank}</span>
                <span className="lb-name">You</span>
                <span className="lb-share">
                  {(myEntry.share * 100).toFixed(1)}%
                  {shareDelta && (
                    <span
                      key={shareDelta.key}
                      className={`lb-share-delta ${shareDelta.direction}`}
                    >
                      {shareDelta.direction === 'up' ? '\u25B2' : '\u25BC'}
                    </span>
                  )}
                </span>
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
};
