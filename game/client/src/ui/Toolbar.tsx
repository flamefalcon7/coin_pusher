import React, { useState } from 'react';
import './Toolbar.css';

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
        disabled={shockDisabled || shockCooldown}
        title="Shock Pins"
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
      </button>

      {/* Ability buttons — vertical stack on the right */}
      <div className="toolbar-abilities">
        <button
          className={`toolbar-action-btn toolbar-action-img superPush ${superPushCooldown ? 'cooldown' : ''}`}
          onClick={onSuperPush}
          disabled={superPushDisabled || superPushCooldown}
          title="Super Push"
        >
          <img className="toolbar-action-icon" src="/ui/abilities/superPush.png" alt="Super Push" draggable={false} />
        </button>

        <button
          className={`toolbar-action-btn toolbar-action-img tornado ${tornadoTargeting ? 'targeting' : ''} ${tornadoCooldown ? 'cooldown' : ''}`}
          onClick={onTornado}
          disabled={tornadoDisabled || tornadoCooldown}
          title="Tornado — click platform to place"
        >
          <img className="toolbar-action-icon" src="/ui/abilities/tornado.png" alt="Tornado" draggable={false} />
        </button>

        <button
          className={`toolbar-action-btn toolbar-action-img explosion ${explosionTargeting ? 'targeting' : ''} ${explosionCooldown ? 'cooldown' : ''}`}
          onClick={onExplosion}
          disabled={explosionDisabled || explosionCooldown}
          title="Explosion — click platform to place"
        >
          <img className="toolbar-action-icon" src="/ui/abilities/blast.png" alt="Explosion" draggable={false} />
        </button>

        <button
          className={`toolbar-action-btn toolbar-action-img lightning ${lightningCooldown ? 'cooldown' : ''}`}
          onClick={onLightning}
          disabled={lightningDisabled || lightningCooldown}
          title="Lightning — random bolts rain down"
        >
          <img className="toolbar-action-icon" src="/ui/abilities/thunder.png" alt="Lightning" draggable={false} />
        </button>
      </div>
    </div>
  );
};
