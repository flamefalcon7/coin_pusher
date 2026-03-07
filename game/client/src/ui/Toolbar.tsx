import React, { useState } from 'react';
import './Toolbar.css';

export interface ScrollCounts {
  shock: number;
  tornado: number;
  explosion: number;
  lightning: number;
  superPush: number;
  megaspeaker: number;
}

interface ToolbarProps {
  muted: boolean;
  onToggleMute: () => void;
  celShading: boolean;
  onToggleCel: () => void;
  themeName: string;
  onCycleTheme: () => void;
  onShock: () => void;
  shockDisabled: boolean;
  shockCooldown: boolean;
  onTornado: () => void;
  tornadoDisabled: boolean;
  tornadoCooldown: boolean;
  tornadoTargeting: boolean;
  onExplosion: () => void;
  explosionDisabled: boolean;
  explosionCooldown: boolean;
  explosionTargeting: boolean;
  onLightning: () => void;
  lightningDisabled: boolean;
  lightningCooldown: boolean;
  onSuperPush: () => void;
  superPushDisabled: boolean;
  superPushCooldown: boolean;
  scrollCounts?: ScrollCounts;
}

export const Toolbar: React.FC<ToolbarProps> = ({
  muted,
  onToggleMute,
  celShading,
  onToggleCel,
  themeName,
  onCycleTheme,
  onShock,
  shockDisabled,
  shockCooldown,
  onTornado,
  tornadoDisabled,
  tornadoCooldown,
  tornadoTargeting,
  onExplosion,
  explosionDisabled,
  explosionCooldown,
  explosionTargeting,
  onLightning,
  lightningDisabled,
  lightningCooldown,
  onSuperPush,
  superPushDisabled,
  superPushCooldown,
  scrollCounts,
}) => {
  const [settingsOpen, setSettingsOpen] = useState(false);

  return (
    <div className="toolbar">
      {/* Audio toggle */}
      <button className="toolbar-icon-btn" onClick={onToggleMute} title={muted ? 'Unmute' : 'Mute'}>
        <img
          src={muted
            ? '/ui/kenney-game-icons/PNG/White/2x/audioOff.png'
            : '/ui/kenney-game-icons/PNG/White/2x/audioOn.png'}
          alt={muted ? 'Muted' : 'Sound On'}
          draggable={false}
        />
      </button>

      {/* Settings gear */}
      <div className="toolbar-settings-wrap">
        <button
          className={`toolbar-icon-btn ${settingsOpen ? 'active' : ''}`}
          onClick={() => setSettingsOpen(!settingsOpen)}
          title="Settings"
        >
          <img
            src="/ui/kenney-game-icons/PNG/White/2x/gear.png"
            alt="Settings"
            draggable={false}
          />
        </button>

        {settingsOpen && (
          <div className="toolbar-dropdown">
            <button className="toolbar-dropdown-item" onClick={onToggleCel}>
              <img
                className="toolbar-dropdown-check"
                src={celShading
                  ? '/ui/kenney-ui-pack/PNG/Yellow/Default/check_square_color_checkmark.png'
                  : '/ui/kenney-ui-pack/PNG/Yellow/Default/check_square_grey.png'}
                alt=""
                draggable={false}
              />
              <span>Cel Shading</span>
            </button>
            <button className="toolbar-dropdown-item" onClick={onCycleTheme}>
              <img
                className="toolbar-dropdown-icon"
                src="/ui/kenney-game-icons/PNG/White/2x/contrast.png"
                alt=""
                draggable={false}
              />
              <span>{themeName}</span>
            </button>
          </div>
        )}
      </div>

      {/* Shock button */}
      <button
        className="toolbar-action-btn shock"
        onClick={onShock}
        disabled={shockDisabled || shockCooldown || (scrollCounts !== undefined && scrollCounts.shock <= 0)}
        data-tooltip="Shock (2s) — Dislodges coins stuck in the pin zone"
      >
        <img
          className="toolbar-action-bg"
          src="/ui/kenney-ui-pack/PNG/Red/Default/button_rectangle_depth_flat.png"
          alt=""
          draggable={false}
        />
        <span className="toolbar-action-text">
          {shockCooldown ? '...' : 'SHOCK'}
        </span>
        {scrollCounts !== undefined && scrollCounts.shock > 0 && (
          <span className="toolbar-scroll-badge">{scrollCounts.shock}</span>
        )}
      </button>

      {/* Ability buttons — vertical stack on the right */}
      <div className="toolbar-abilities">
        <button
          className={`toolbar-action-btn toolbar-action-img superPush ${superPushCooldown ? 'cooldown' : ''}`}
          onClick={onSuperPush}
          disabled={superPushDisabled || superPushCooldown || (scrollCounts !== undefined && scrollCounts.superPush <= 0)}
          data-tooltip="Super Push (12s) — Pusher slams forward with maximum force"
        >
          <img className="toolbar-action-icon" src="/ui/abilities/superPush.png" alt="Super Push" draggable={false} />
          {scrollCounts !== undefined && scrollCounts.superPush > 0 && (
            <span className="toolbar-scroll-badge">{scrollCounts.superPush}</span>
          )}
        </button>

        <button
          className={`toolbar-action-btn toolbar-action-img tornado ${tornadoTargeting ? 'targeting' : ''} ${tornadoCooldown ? 'cooldown' : ''}`}
          onClick={onTornado}
          disabled={tornadoDisabled || tornadoCooldown || (scrollCounts !== undefined && scrollCounts.tornado <= 0)}
          data-tooltip="Tornado (10s) — Click platform to place a vortex that gathers coins"
        >
          <img className="toolbar-action-icon" src="/ui/abilities/tornado.png" alt="Tornado" draggable={false} />
          {scrollCounts !== undefined && scrollCounts.tornado > 0 && (
            <span className="toolbar-scroll-badge">{scrollCounts.tornado}</span>
          )}
        </button>

        <button
          className={`toolbar-action-btn toolbar-action-img explosion ${explosionTargeting ? 'targeting' : ''} ${explosionCooldown ? 'cooldown' : ''}`}
          onClick={onExplosion}
          disabled={explosionDisabled || explosionCooldown || (scrollCounts !== undefined && scrollCounts.explosion <= 0)}
          data-tooltip="Explosion (8s) — Click platform to blast coins outward"
        >
          <img className="toolbar-action-icon" src="/ui/abilities/blast.png" alt="Explosion" draggable={false} />
          {scrollCounts !== undefined && scrollCounts.explosion > 0 && (
            <span className="toolbar-scroll-badge">{scrollCounts.explosion}</span>
          )}
        </button>

        <button
          className={`toolbar-action-btn toolbar-action-img lightning ${lightningCooldown ? 'cooldown' : ''}`}
          onClick={onLightning}
          disabled={lightningDisabled || lightningCooldown || (scrollCounts !== undefined && scrollCounts.lightning <= 0)}
          data-tooltip="Lightning (6s) — Random bolts strike across the entire platform"
        >
          <img className="toolbar-action-icon" src="/ui/abilities/thunder.png" alt="Lightning" draggable={false} />
          {scrollCounts !== undefined && scrollCounts.lightning > 0 && (
            <span className="toolbar-scroll-badge">{scrollCounts.lightning}</span>
          )}
        </button>
      </div>
    </div>
  );
};
