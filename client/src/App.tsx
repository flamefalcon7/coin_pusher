import { useEffect, useRef, useState } from "react";
import "./App.css";
import { HUD } from "./ui/HUD";
import { CoinInsertButton } from "./ui/CoinInsertButton";
import { ConnectionStatus } from "./ui/ConnectionStatus";
import { SceneManager } from "./scene/SceneManager";
import { GameClient } from "./net/GameClient";
import { SLOT_CONFIG } from "@coin-pusher/shared";

const WS_URL = import.meta.env.VITE_WS_URL || "ws://localhost:3000";

function App() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const sceneManagerRef = useRef<SceneManager | null>(null);
  const gameClientRef = useRef<GameClient | null>(null);

  const [fps, setFps] = useState(0);
  const [ping, setPing] = useState(0);
  const [activeCoinCount, setActiveCoinCount] = useState(0);
  const [connectionStatus, setConnectionStatus] = useState<
    "connecting" | "connected" | "disconnected"
  >("disconnected");
  const [buttonDisabled, setButtonDisabled] = useState(false);

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

    // Connect to server
    gameClient.connect();

    // Start render loop with interpolation
    sceneManager.startRenderLoop();

    // Track known coin IDs
    const knownCoins = new Set<number>();

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

          // Update coins
          const currentCoinIds = new Set<number>();

          for (const coin of state.coins) {
            currentCoinIds.add(coin.id);

            if (!knownCoins.has(coin.id)) {
              // New coin
              sceneManager.addCoin(coin.id, coin.pos, coin.rot);
              knownCoins.add(coin.id);
            } else {
              // Update existing coin
              sceneManager.updateCoin(coin.id, coin.pos, coin.rot);
            }
          }

          // Remove despawned coins
          for (const id of knownCoins) {
            if (!currentCoinIds.has(id)) {
              sceneManager.removeCoin(id);
              knownCoins.delete(id);
            }
          }

          // Update coin count
          setActiveCoinCount(knownCoins.size);
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
      gameClient.disconnect();
      sceneManager.dispose();
    };
  }, []);

  const handleInsertCoin = (slotIndex: number) => {
    if (!gameClientRef.current || !gameClientRef.current.isConnected()) {
      console.warn("Not connected to server");
      return;
    }

    // Get X position from slot configuration
    const x = SLOT_CONFIG.POSITIONS[slotIndex];

    // Send to server
    gameClientRef.current.insertCoin(x);

    // Visual feedback
    setButtonDisabled(true);
    setTimeout(() => setButtonDisabled(false), 100);
  };

  return (
    <div id="app-container">
      <ConnectionStatus status={connectionStatus} />
      <HUD fps={fps} ping={ping} activeCoin={activeCoinCount} />
      <div id="canvas-container">
        <canvas ref={canvasRef} id="babylon-canvas" />
      </div>
      <CoinInsertButton
        onClick={handleInsertCoin}
        disabled={buttonDisabled || connectionStatus !== "connected"}
      />
    </div>
  );
}

export default App;
