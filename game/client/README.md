# Game Client

Browser-based 3D client with BabylonJS rendering and real-time server synchronization.

## Quick Start

```bash
pnpm install
pnpm dev       # Vite dev server with HMR
pnpm build     # Production build
pnpm preview   # Preview production build
```

Client runs on http://localhost:5173. Connects to the Go backend WebSocket at `ws://localhost:4000/ws`.

## Project Structure

```
game/client/src/
├── main.tsx              # React entry point
├── App.tsx               # Main application + game loop
├── App.css               # Styles
├── ui/                   # React UI components
│   ├── HUD.tsx           # FPS, Ping, Coin count
│   ├── CoinInsertButton.tsx
│   └── ConnectionStatus.tsx
├── scene/                # BabylonJS 3D rendering
│   ├── SceneManager.ts   # Scene lifecycle
│   ├── CameraSetup.ts    # ArcRotateCamera
│   ├── Lighting.ts       # Hemispheric light
│   ├── StaticMeshes.ts   # Platform, walls, drop zone
│   ├── PusherMesh.ts     # Pusher plate
│   └── CoinMeshManager.ts # Coin thin instances
└── net/                  # Networking layer
    ├── GameClient.ts     # Integration layer
    ├── WebSocketClient.ts # WebSocket + MessagePack
    ├── ClockSync.ts      # RTT measurement + offset
    ├── StateBuffer.ts    # Server state history
    └── Interpolator.ts   # Lerp + Slerp interpolation
```

## Configuration

Set WebSocket URL via environment variable:

```bash
VITE_WS_URL=ws://localhost:4000/ws    # Development (default)
VITE_WS_URL=wss://api.example.com/ws  # Production
```

## Scene

- **Coordinate system**: Right-handed, Y-up, Z-forward
- **Camera**: ArcRotateCamera targeting (0, 0.3, 0), radius 3m
- **Coins**: Gold cylinders rendered via thin instances
- **Pusher**: Blue plate, position synced from server

## Networking

- **Protocol**: MessagePack over WebSocket
- **Clock sync**: RTT median from last 5 ping/pong samples
- **Interpolation**: 100-120ms delay, position lerp, rotation slerp
- **Update rate**: 60fps rendering with interpolated state

## Dependencies

- `@babylonjs/core` - 3D rendering
- `@msgpack/msgpack` - Binary deserialization
- `@coin-pusher/shared` - Shared protocol types
- `react`, `react-dom` - UI framework
