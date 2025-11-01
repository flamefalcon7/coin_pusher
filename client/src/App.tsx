import { useEffect, useRef, useState } from 'react';
import './App.css';
import { HUD } from './ui/HUD';
import { CoinInsertButton } from './ui/CoinInsertButton';
import { ConnectionStatus } from './ui/ConnectionStatus';

function App() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [fps, setFps] = useState(0);
  const [ping, setPing] = useState(0);
  const [activeCoinCount, setActiveCoinCount] = useState(0);
  const [connectionStatus, setConnectionStatus] = useState<'connecting' | 'connected' | 'disconnected'>('disconnected');
  const [buttonDisabled, setButtonDisabled] = useState(false);

  useEffect(() => {
    // Scene will be initialized here later
    console.log('Canvas ready:', canvasRef.current);
  }, []);

  const handleInsertCoin = () => {
    console.log('Insert coin clicked');
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
      <CoinInsertButton onClick={handleInsertCoin} disabled={buttonDisabled} />
    </div>
  );
}

export default App;

