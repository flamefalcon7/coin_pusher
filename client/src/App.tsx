import { useEffect, useRef, useState } from 'react';
import './App.css';
import { HUD } from './ui/HUD';
import { CoinInsertButton } from './ui/CoinInsertButton';
import { ConnectionStatus } from './ui/ConnectionStatus';
import { SceneManager } from './scene/SceneManager';

function App() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const sceneManagerRef = useRef<SceneManager | null>(null);
  
  const [fps, setFps] = useState(0);
  const [ping] = useState(0);
  const [activeCoinCount, setActiveCoinCount] = useState(0);
  const [connectionStatus] = useState<'connecting' | 'connected' | 'disconnected'>('disconnected');
  const [buttonDisabled, setButtonDisabled] = useState(false);

  useEffect(() => {
    if (!canvasRef.current) return;

    // Initialize scene
    const sceneManager = new SceneManager(canvasRef.current);
    sceneManagerRef.current = sceneManager;

    // Set FPS callback
    sceneManager.setFpsCallback((fps) => {
      setFps(fps);
    });

    // Start render loop
    sceneManager.startRenderLoop();

    // Test: Add a test coin to verify rendering
    sceneManager.addCoin(999, [0, 0.5, 0], [0, 0, 0, 1]);
    setActiveCoinCount(1);

    // Cleanup on unmount
    return () => {
      sceneManager.dispose();
    };
  }, []);

  const handleInsertCoin = () => {
    console.log('Insert coin clicked');
    setButtonDisabled(true);
    setTimeout(() => setButtonDisabled(false), 100);
    
    // Test: Add a coin at random position
    if (sceneManagerRef.current) {
      const x = (Math.random() - 0.5) * 0.8;
      const id = Date.now();
      sceneManagerRef.current.addCoin(id, [x, 1.5, 0], [0, 0, 0, 1]);
      setActiveCoinCount(sceneManagerRef.current.getCoinCount());
    }
  };

  return (
    <div id="app-container">
      <ConnectionStatus status={connectionStatus} />
      <HUD fps={fps} ping={ping} activeCoin={activeCoinCount} />
      <div id="canvas-container">
        <canvas ref={canvasRef} id="babylon-canvas" />
      </div>
      <CoinInsertButton onClick={handleInsertCoin} disabled={buttonDisabled} />
    </div>
  );
}

export default App;

