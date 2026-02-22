import { useEffect, useRef, useState, useCallback } from "react";
import "./App.css";
import { HUD } from "./ui/HUD";
import { CoinInsertButton } from "./ui/CoinInsertButton";
import { ConnectionStatus } from "./ui/ConnectionStatus";
import { Toolbar } from "./ui/Toolbar";
import { HoleTooltip, HoleTooltipData } from "./ui/HoleTooltip";
import { HeatMeter } from "./ui/HeatMeter";
import { RewardToast } from "./ui/RewardToast";

import { SceneManager } from "./scene/SceneManager";
import { ToonDebugGUI } from "./scene/ToonDebugGUI";
import { GameClient } from "./net/GameClient";
import { SLOT_CONFIG, RATE_LIMIT_CONFIG, type EditorObjectNet } from "@coin-pusher/shared";
import { Vector3 } from "@babylonjs/core";
import { EditorManager, GizmoMode } from "./editor/EditorManager";
import { EditorPanel } from "./editor/EditorPanel";
import { EditorObjectData } from "./editor/EditorObject";

// Auto-detect WS host from browser location so mobile on same WiFi works
const WS_URL = import.meta.env.VITE_WS_URL || `ws://${window.location.hostname}:4000/ws`;

function App() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const sceneManagerRef = useRef<SceneManager | null>(null);
  const gameClientRef = useRef<GameClient | null>(null);
  const toonGuiRef = useRef<ToonDebugGUI | null>(null);

  const [fps, setFps] = useState(0);
  const [ping, setPing] = useState(0);
  const [activeCoinCount, setActiveCoinCount] = useState(0);
  const [connectionStatus, setConnectionStatus] = useState<
    "connecting" | "connected" | "disconnected"
  >("disconnected");
  const [buttonDisabled, setButtonDisabled] = useState(false);
  const [shockCooldown, setShockCooldown] = useState(false);
  const [tornadoCooldown, setTornadoCooldown] = useState(false);
  const [tornadoTargeting, setTornadoTargeting] = useState(false);
  const [explosionCooldown, setExplosionCooldown] = useState(false);
  const [explosionTargeting, setExplosionTargeting] = useState(false);
  const [lightningCooldown, setLightningCooldown] = useState(false);
  const [superPushCooldown, setSuperPushCooldown] = useState(false);
  const [isTesting, setIsTesting] = useState(false);
  const [themeName, setThemeName] = useState("Psychedelic Pop");
  const [celShading, setCelShading] = useState(true);
  const [muted, setMuted] = useState(false);
  const [devToolsOpen, setDevToolsOpen] = useState(false);
  const [slotCounter, setSlotCounter] = useState(0);
  const [holeTooltip, setHoleTooltip] = useState<HoleTooltipData | null>(null);
  const lastHolePickTime = useRef(0);
  const [heatShare, setHeatShare] = useState(0);
  const [heatRaw, setHeatRaw] = useState(0);
  const [queuePending, setQueuePending] = useState(0);
  const [rewardToast, setRewardToast] = useState<{ amount: number; id: number } | null>(null);
  const rewardIdRef = useRef(0);

  // Editor state
  const editorManagerRef = useRef<EditorManager | null>(null);
  const [editorActive, setEditorActive] = useState(false);
  const [editorObjects, setEditorObjects] = useState<EditorObjectData[]>([]);
  const [selectedObjectId, setSelectedObjectId] = useState<string | null>(null);
  const [gizmoMode, setGizmoMode] = useState<GizmoMode>("position");

  useEffect(() => {
    if (!canvasRef.current) return;

    // Initialize scene
    const sceneManager = new SceneManager(canvasRef.current);
    sceneManagerRef.current = sceneManager;

    // Initialize game client
    const gameClient = new GameClient(WS_URL);
    gameClientRef.current = gameClient;

    // Set FPS callback
    sceneManager.setFpsCallback((fps) => {
      setFps(fps);
    });

    // Set connection status callback
    gameClient.onConnectionStatus((status) => {
      setConnectionStatus(status);
    });

    // Set ping callback
    gameClient.onPing((ping) => {
      setPing(ping);
    });

    // Set slot machine callbacks
    gameClient.onSlotSpin((reels, jackpot) => {
      sceneManager.playSlotSpin(reels, jackpot);
    });

    gameClient.onSlotCounter((counter) => {
      sceneManager.updateSlotCounter(counter);
      setSlotCounter(counter);
    });

    // Set ability event callback — plays VFX/sound + syncs cooldown for ALL clients
    gameClient.onAbilityEvent((ability, x, z) => {
      const platformY = 0.25 + 0.05 / 2;
      switch (ability) {
        case "shock":
          sceneManager.playShockEffect();
          sceneManager.getSoundManager().playShock();
          setShockCooldown(true);
          setTimeout(() => setShockCooldown(false), RATE_LIMIT_CONFIG.SHOCK_COOLDOWN);
          break;
        case "tornado":
          if (x !== undefined && z !== undefined) {
            sceneManager.playTornadoEffect(new Vector3(x, platformY, z));
          }
          setTornadoCooldown(true);
          setTimeout(() => setTornadoCooldown(false), RATE_LIMIT_CONFIG.TORNADO_COOLDOWN);
          break;
        case "explosion":
          if (x !== undefined && z !== undefined) {
            sceneManager.playExplosionEffect(new Vector3(x, platformY, z));
          }
          setExplosionCooldown(true);
          setTimeout(() => setExplosionCooldown(false), RATE_LIMIT_CONFIG.EXPLOSION_COOLDOWN);
          break;
        case "lightning":
          sceneManager.playLightningEffect();
          setLightningCooldown(true);
          setTimeout(() => setLightningCooldown(false), RATE_LIMIT_CONFIG.LIGHTNING_COOLDOWN);
          break;
        case "superPush":
          sceneManager.playSuperPushEffect();
          setSuperPushCooldown(true);
          setTimeout(() => setSuperPushCooldown(false), RATE_LIMIT_CONFIG.SUPER_PUSH_COOLDOWN);
          break;
      }
    });

    // Set up heat system callbacks
    gameClient.onCoinSpawn((coins) => {
      const myUserId = gameClient.getUserId();
      for (const coin of coins) {
        if (coin.owner_id === myUserId) {
          sceneManager.addCoinHighlight(coin.id);
        }
      }
    });

    gameClient.onHeatUpdate((players) => {
      const myUserId = gameClient.getUserId();
      const me = players.find(p => p.user_id === myUserId);
      if (me) {
        setHeatShare(me.share);
        setHeatRaw(me.raw_heat);
      } else {
        setHeatShare(0);
        setHeatRaw(0);
      }
    });

    gameClient.onQueueUpdate((userId, pending) => {
      const myUserId = gameClient.getUserId();
      if (userId === myUserId) {
        setQueuePending(pending);
      }
    });

    gameClient.onReward((userId, amount, _balance) => {
      const myUserId = gameClient.getUserId();
      if (userId === myUserId) {
        rewardIdRef.current++;
        setRewardToast({ amount, id: rewardIdRef.current });
      }
    });

    // Connect to server
    gameClient.connect();

    // Start render loop with interpolation
    sceneManager.startRenderLoop();

    // Initialize editor manager
    const editorManager = new EditorManager(sceneManager.getScene());
    editorManagerRef.current = editorManager;
    editorManager.setOnChange((objects, selectedId) => {
      setEditorObjects([...objects]);
      setSelectedObjectId(selectedId);
      setGizmoMode(editorManager.getGizmoMode());

      // Sync editor objects to game server for physics
      const netObjects: EditorObjectNet[] = objects.map((obj) => ({
        id: obj.id,
        type: obj.type,
        position: obj.position,
        rotation: obj.rotation,
        scale: obj.scale,
      }));
      gameClient.updateSceneObjects(netObjects);
    });

    // Track known coin IDs
    const knownCoins = new Set<number>();

    // Reusable set for reconciliation — cleared each frame instead of re-allocated
    const currentCoinIds = new Set<number>();

    // Track last reported coin count to avoid unnecessary React re-renders
    let lastReportedCoinCount = 0;

    // Update loop using requestAnimationFrame for smooth rendering
    let animationFrameId: number;
    let lastUpdateTime = 0;
    const targetFPS = 60;
    const targetFrameTime = 1000 / targetFPS;

    const updateLoop = (currentTime: number) => {
      // Update game client (check for pings, etc.) - do this every frame
      gameClient.update();

      // Throttle game state updates to target FPS
      const deltaTime = currentTime - lastUpdateTime;
      if (deltaTime >= targetFrameTime) {
        lastUpdateTime = currentTime - (deltaTime % targetFrameTime);

        // Get interpolated state
        const state = gameClient.getInterpolatedState();
        if (state) {
          // Update pusher position
          sceneManager.updatePusherPosition(state.pusherZ);

          // Update coins — reuse the Set instead of allocating a new one
          currentCoinIds.clear();
          const coins = state.coins;

          for (let i = 0, len = coins.length; i < len; i++) {
            const coin = coins[i];
            currentCoinIds.add(coin.id);

            if (!knownCoins.has(coin.id)) {
              // New coin
              sceneManager.addCoin(coin.id, coin.pos, coin.rot);
              knownCoins.add(coin.id);
              sceneManager.getSoundManager().playCoinLand();
            } else {
              // Update existing coin
              sceneManager.updateCoin(coin.id, coin.pos, coin.rot);
            }
          }

          // Remove despawned coins (coins no longer in interpolated state
          // have been removed by the Interpolator via despawn messages)
          let despawnCount = 0;
          for (const id of knownCoins) {
            if (!currentCoinIds.has(id)) {
              sceneManager.removeCoinWithEffect(id);
              knownCoins.delete(id);
              despawnCount++;
            }
          }
          if (despawnCount > 0) {
            sceneManager.getSoundManager().playCoinDespawn(despawnCount);
          }

          // Batch update coin instances to GPU (pass dt in seconds for animations)
          sceneManager.updateCoinBuffers(deltaTime / 1000);
          sceneManager.updateCoinHighlights();

          // Only trigger React re-render when coin count actually changes
          const size = knownCoins.size;
          if (size !== lastReportedCoinCount) {
            lastReportedCoinCount = size;
            setActiveCoinCount(size);
          }
        }
      }

      // Continue animation loop
      animationFrameId = requestAnimationFrame(updateLoop);
    };

    // Start the animation loop
    animationFrameId = requestAnimationFrame(updateLoop);

    // Cleanup on unmount
    return () => {
      cancelAnimationFrame(animationFrameId);
      toonGuiRef.current?.dispose();
      toonGuiRef.current = null;
      editorManager.dispose();
      gameClient.disconnect();
      sceneManager.dispose();
    };
  }, []);

  // Toggle editor mode
  const toggleEditor = useCallback(() => {
    const mgr = editorManagerRef.current;
    if (!mgr) return;
    const next = !mgr.isActive();
    mgr.setActive(next);
    setEditorActive(next);
  }, []);

  // Keyboard controls for stack spawning (Dev/Test feature) and editor toggle
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      // Don't handle shortcuts when typing in an input
      if ((event.target as HTMLElement).tagName === "INPUT") return;

      // Editor toggle
      if (event.key === "e" || event.key === "E") {
        toggleEditor();
        return;
      }

      // Delete selected editor object
      if ((event.key === "Delete" || event.key === "Backspace") && editorManagerRef.current?.isActive()) {
        editorManagerRef.current.removeSelected();
        return;
      }

      if (!gameClientRef.current || !gameClientRef.current.isConnected())
        return;

      const x = 0; // Center spawn for stacks

      switch (event.key) {
        case "1":
          console.log("Spawning wall");
          gameClientRef.current.spawnStack("wall", x);
          break;
        case "2":
          console.log("Spawning tower");
          gameClientRef.current.spawnStack("tower", x);
          break;
        case "3":
          console.log("Spawning pyramid");
          gameClientRef.current.spawnStack("pyramid", x);
          break;
        case "4":
          console.log("Spawning pyramid3bleLayer");
          gameClientRef.current.spawnStack("pyramid3bleLayer", x);
          break;
        case "5":
          console.log("Spawning cylinder");
          gameClientRef.current.spawnStack("cylinder", x);
          break;
        case "0":
          console.log("Clearing all coins");
          gameClientRef.current.clearAll();
          break;
        case "9":
          console.log("Filling platform");
          gameClientRef.current.fillPlatform();
          break;
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [toggleEditor]);

  const handleInsertCoin = (slotIndex: number, count: number = 1) => {
    if (!gameClientRef.current || !gameClientRef.current.isConnected()) {
      console.warn("Not connected to server");
      return;
    }

    gameClientRef.current.batchInsert(slotIndex, count);
    sceneManagerRef.current?.getSoundManager().playCoinInsert();
    sceneManagerRef.current?.playCoinInsertVFX(slotIndex);

    setButtonDisabled(true);
    setTimeout(() => setButtonDisabled(false), 100);
  };

  const handleShock = () => {
    if (!gameClientRef.current || !gameClientRef.current.isConnected() || shockCooldown) {
      return;
    }
    gameClientRef.current.shock();
    // VFX/sound/cooldown now synced via server ability broadcast
  };

  const handleTornadoClick = () => {
    if (!gameClientRef.current || !gameClientRef.current.isConnected() || tornadoCooldown) {
      return;
    }
    setTornadoTargeting(true);
  };

  const handleTornadoPlace = (x: number, z: number) => {
    if (!gameClientRef.current || !gameClientRef.current.isConnected()) return;
    gameClientRef.current.tornado(x, z);
    // VFX/cooldown now synced via server ability broadcast
    setTornadoTargeting(false);
  };

  const handleExplosionClick = () => {
    if (!gameClientRef.current || !gameClientRef.current.isConnected() || explosionCooldown) {
      return;
    }
    setExplosionTargeting(true);
  };

  const handleExplosionPlace = (x: number, z: number) => {
    if (!gameClientRef.current || !gameClientRef.current.isConnected()) return;
    gameClientRef.current.explosion(x, z);
    // VFX/cooldown now synced via server ability broadcast
    setExplosionTargeting(false);
  };

  const handleLightning = () => {
    if (!gameClientRef.current || !gameClientRef.current.isConnected() || lightningCooldown) {
      return;
    }
    gameClientRef.current.lightning();
    // VFX/cooldown now synced via server ability broadcast
  };

  const handleSuperPush = () => {
    if (!gameClientRef.current || !gameClientRef.current.isConnected() || superPushCooldown) {
      return;
    }
    gameClientRef.current.superPush();
    // VFX/cooldown now synced via server ability broadcast
  };

  const handleCanvasPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!tornadoTargeting && !explosionTargeting) return;

    const scene = sceneManagerRef.current?.getScene();
    if (!scene) return;

    const pickResult = scene.pick(e.nativeEvent.offsetX, e.nativeEvent.offsetY);
    if (pickResult?.hit && pickResult.pickedPoint) {
      if (tornadoTargeting) {
        handleTornadoPlace(pickResult.pickedPoint.x, pickResult.pickedPoint.z);
      } else if (explosionTargeting) {
        handleExplosionPlace(pickResult.pickedPoint.x, pickResult.pickedPoint.z);
      }
    } else {
      // Cancel targeting if clicked outside platform
      setTornadoTargeting(false);
      setExplosionTargeting(false);
    }
  };

  const handleCanvasPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    // Throttle to ~30fps
    const now = performance.now();
    if (now - lastHolePickTime.current < 33) return;
    lastHolePickTime.current = now;

    const scene = sceneManagerRef.current?.getScene();
    if (!scene) return;

    const pickResult = scene.pick(e.nativeEvent.offsetX, e.nativeEvent.offsetY);
    if (pickResult?.hit && pickResult.pickedMesh?.metadata?.holeId) {
      setHoleTooltip({
        holeId: pickResult.pickedMesh.metadata.holeId,
        x: e.clientX,
        y: e.clientY,
      });
    } else {
      setHoleTooltip(null);
    }
  };

  const handleCycleTheme = () => {
    const label = sceneManagerRef.current?.cycleTheme();
    if (label) setThemeName(label);
  };

  const handleToggleCel = () => {
    const enabled = sceneManagerRef.current?.toggleCelShading();
    if (enabled !== undefined) setCelShading(enabled);
  };

  const handleToggleMute = () => {
    const sm = sceneManagerRef.current?.getSoundManager();
    if (sm) {
      const nowMuted = sm.toggleMute();
      setMuted(nowMuted);
    }
  };

  const handleTestLoop = () => {
    if (isTesting || !gameClientRef.current?.isConnected()) return;

    setIsTesting(true);
    let count = 0;
    const maxCoins = 200;
    const intervalTime = 60; // ms — must be above COIN_INSERT_COOLDOWN (50ms)

    const interval = setInterval(() => {
      if (count >= maxCoins) {
        clearInterval(interval);
        setIsTesting(false);
        return;
      }

      // Pick a random slot index (0 to 4)
      const randomSlotIndex = Math.floor(
        Math.random() * SLOT_CONFIG.POSITIONS.length
      );
      handleInsertCoin(randomSlotIndex);

      count++;
    }, intervalTime);
  };

  const handleToggleToonDebug = useCallback(() => {
    if (toonGuiRef.current) {
      toonGuiRef.current.dispose();
      toonGuiRef.current = null;
    } else if (sceneManagerRef.current) {
      toonGuiRef.current = new ToonDebugGUI(sceneManagerRef.current);
    }
  }, []);

  const handleEditorObjectsChange = useCallback(() => {
    const mgr = editorManagerRef.current;
    if (!mgr) return;
    setEditorObjects([...mgr.getObjects()]);
    setSelectedObjectId(mgr.getSelectedId());
    setGizmoMode(mgr.getGizmoMode());
  }, []);

  return (
    <div id="app-container">
      <ConnectionStatus status={connectionStatus} />
      <HUD fps={fps} ping={ping} activeCoin={activeCoinCount} />

      <Toolbar
        muted={muted}
        onToggleMute={handleToggleMute}
        celShading={celShading}
        onToggleCel={handleToggleCel}
        themeName={themeName}
        onCycleTheme={handleCycleTheme}
        onShock={handleShock}
        shockDisabled={connectionStatus !== "connected"}
        shockCooldown={shockCooldown}
        onTornado={handleTornadoClick}
        tornadoDisabled={connectionStatus !== "connected"}
        tornadoCooldown={tornadoCooldown}
        tornadoTargeting={tornadoTargeting}
        onExplosion={handleExplosionClick}
        explosionDisabled={connectionStatus !== "connected"}
        explosionCooldown={explosionCooldown}
        explosionTargeting={explosionTargeting}
        onLightning={handleLightning}
        lightningDisabled={connectionStatus !== "connected"}
        lightningCooldown={lightningCooldown}
        onSuperPush={handleSuperPush}
        superPushDisabled={connectionStatus !== "connected"}
        superPushCooldown={superPushCooldown}
      />

      <button
        className={`editor-toggle-btn ${editorActive ? "active" : ""}`}
        onClick={toggleEditor}
      >
        Editor [E]
      </button>
      {editorActive && editorManagerRef.current && (
        <EditorPanel
          manager={editorManagerRef.current}
          objects={editorObjects}
          selectedId={selectedObjectId}
          gizmoMode={gizmoMode}
          onObjectsChange={handleEditorObjectsChange}
        />
      )}
      <div id="canvas-container">
        <canvas
          ref={canvasRef}
          id="babylon-canvas"
          onPointerDown={handleCanvasPointerDown}
          onPointerMove={handleCanvasPointerMove}
          onPointerLeave={() => setHoleTooltip(null)}
          style={tornadoTargeting || explosionTargeting ? { cursor: "crosshair" } : undefined}
        />
      </div>

      {/* Dev tools (collapsed by default) */}
      <div className="dev-tools-corner">
        <button
          className="dev-tools-toggle"
          onClick={() => setDevToolsOpen(!devToolsOpen)}
        >
          Dev {devToolsOpen ? "▲" : "▼"}
        </button>
        {devToolsOpen && (
          <div className="dev-tools-panel">
            <button
              onClick={handleTestLoop}
              disabled={isTesting || connectionStatus !== "connected"}
              className="dev-button"
            >
              {isTesting ? "Testing..." : "Insert 200 Coins"}
            </button>
            <button
              onClick={() => gameClientRef.current?.clearAll()}
              disabled={connectionStatus !== "connected"}
              className="dev-button"
            >
              Clear All [0]
            </button>
            <button
              onClick={() => gameClientRef.current?.fillPlatform()}
              disabled={connectionStatus !== "connected"}
              className="dev-button"
            >
              Fill Platform [9]
            </button>
            <button
              onClick={() => sceneManagerRef.current?.playRewardCoinRain()}
              className="dev-button"
            >
              Coin Rain
            </button>
            <button
              onClick={() => sceneManagerRef.current?.playRewardTicketRain()}
              className="dev-button"
            >
              Ticket Rain
            </button>
            <button
              onClick={handleToggleToonDebug}
              className="dev-button"
            >
              Toon Debug
            </button>
          </div>
        )}
      </div>


      <CoinInsertButton
        onClick={handleInsertCoin}
        disabled={buttonDisabled || connectionStatus !== "connected"}
        queuePending={queuePending}
      />

      {heatShare > 0 && (
        <HeatMeter
          share={heatShare}
          rawHeat={heatRaw}
          queuePending={queuePending}
        />
      )}

      {rewardToast && (
        <RewardToast amount={rewardToast.amount} id={rewardToast.id} />
      )}

      {holeTooltip && (
        <HoleTooltip data={holeTooltip} slotCounter={slotCounter} />
      )}
    </div>
  );
}

export default App;
