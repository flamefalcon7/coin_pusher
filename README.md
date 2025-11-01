# 🎮 Coin Pusher - Multi-User Physics PoC

A proof-of-concept multi-user coin pusher game demonstrating real-time authoritative server physics with client-side interpolation.

## 📋 Project Overview

- **Platform**: Mobile Web (desktop compatible)
- **Frontend**: TypeScript + React + BabylonJS (3D rendering) + Rapier WASM (client-side visualization)
- **Backend**: Node.js + TypeScript + Rapier (authoritative physics) + WebSocket
- **Architecture**: Authoritative server with 100-120ms client interpolation

## ✨ Features

- ✅ Real-time multi-user synchronization
- ✅ Server-authoritative physics simulation (30Hz with substeps=2)
- ✅ Client-side interpolation for smooth visuals
- ✅ Clock synchronization with RTT compensation
- ✅ Right-handed coordinate system (BabylonJS + Rapier aligned)
- ✅ Kinematic pusher with sinusoidal motion
- ✅ CCD (Continuous Collision Detection) for falling coins
- ✅ Thin instances for efficient coin rendering

## 🏗️ Architecture

```
┌─────────────────────────────────────────┐
│  Client (Browser)                       │
│  ┌─────────────────────────────────┐   │
│  │ React UI Layer                  │   │
│  │ - Insert Coin Button            │   │
│  │ - HUD (FPS, Ping, Coin Count)   │   │
│  └─────────────────────────────────┘   │
│  ┌─────────────────────────────────┐   │
│  │ BabylonJS Scene (Rendering)     │   │
│  │ - Static Meshes                 │   │
│  │ - Pusher Mesh                   │   │
│  │ - Coin Instances (Thin)         │   │
│  └─────────────────────────────────┘   │
│  ┌─────────────────────────────────┐   │
│  │ Network Layer                   │   │
│  │ - WebSocket Client              │   │
│  │ - Clock Sync (RTT median)       │   │
│  │ - State Buffer                  │   │
│  │ - Interpolator (Lerp + Slerp)   │   │
│  └─────────────────────────────────┘   │
└──────────────┬──────────────────────────┘
               │ WebSocket (JSON)
               │ ID: int, Values: 3 decimals
               │
┌──────────────▼──────────────────────────┐
│  Server (Node.js)                       │
│  ┌─────────────────────────────────┐   │
│  │ WebSocket Server                │   │
│  │ - Connection Management         │   │
│  │ - Message Handler               │   │
│  │ - Rate Limiting (1 coin/100ms)  │   │
│  └─────────────────────────────────┘   │
│  ┌─────────────────────────────────┐   │
│  │ Game Loop (30Hz)                │   │
│  │ - Update Pusher (Kinematic)     │   │
│  │ - Step Physics                  │   │
│  │ - Broadcast State               │   │
│  │ - Handle Despawns               │   │
│  └─────────────────────────────────┘   │
│  ┌─────────────────────────────────┐   │
│  │ Rapier Physics (Authoritative)  │   │
│  │ - Gravity: (0, -9.81, 0)        │   │
│  │ - Substeps: 2                   │   │
│  │ - Static Scene (Platform+Walls) │   │
│  │ - Kinematic Pusher              │   │
│  │ - Dynamic Coins (CCD enabled)   │   │
│  └─────────────────────────────────┘   │
└─────────────────────────────────────────┘
```

## 🚀 Getting Started

### Prerequisites

- Node.js 20+ (LTS)
- pnpm 8+

### Installation

```bash
# Install all dependencies
pnpm install
```

### Running the Application

#### Option 1: Run Both (Parallel)
```bash
pnpm dev
```

#### Option 2: Run Separately

**Terminal 1 - Server:**
```bash
cd server
pnpm dev
# Server runs on ws://localhost:3000
```

**Terminal 2 - Client:**
```bash
cd client
pnpm dev
# Client runs on http://localhost:5173
```

### Testing

1. Open browser to `http://localhost:5173`
2. Wait for "Connected" status (top left)
3. Click "🪙 Insert Coin" button
4. Watch coins fall and interact with pusher
5. Open multiple tabs to see multi-user sync

## 📦 Project Structure

```
coin-pusher/
├── client/               # Frontend (React + BabylonJS)
│   ├── src/
│   │   ├── ui/          # React components
│   │   ├── scene/       # BabylonJS 3D scene
│   │   └── net/         # WebSocket + Interpolation
│   └── package.json
│
├── server/              # Backend (Node.js + Rapier)
│   ├── src/
│   │   ├── ws/         # WebSocket server
│   │   ├── game/       # Game state + loop
│   │   └── physics/    # Rapier physics
│   └── package.json
│
├── shared/              # Shared TypeScript types
│   └── src/
│       └── types.ts    # Protocol definitions
│
└── package.json         # Workspace root
```

## 🎯 Key Technical Decisions

### Coordinate System
- **Right-handed system** (explicitly set)
- **Y-up**: Gravity along negative Y axis
- **Z-forward**: Pusher moves along Z axis

### Network Protocol

**Client → Server:**
```json
{ "op": "coin_insert", "x": 0.123 }
{ "op": "ping", "clientTime": 1234567890 }
```

**Server → Client:**
```json
{
  "op": "world_snapshot",
  "serverTime": 1234567890,
  "tick": 100,
  "bodies": [
    { "id": 0, "type": "pusher", "z": 0.150 },
    { "id": 1, "type": "coin", "pos": [0.1, 1.2, 0.5], "rot": [0, 0.707, 0, 0.707] }
  ]
}
```

```json
{
  "op": "state_delta",
  "serverTime": 1234567891,
  "tick": 101,
  "updates": [
    { "id": 1, "pos": [0.1, 1.15, 0.48], "rot": [0, 0.705, 0, 0.709] }
  ],
  "pusherZ": 0.148
}
```

### Physics Configuration

**Server (Rapier):**
- Tick rate: 30Hz (33.33ms)
- Substeps: 2
- Solver iterations: velocity=8, position=3
- CCD: Enabled during free-fall, disabled when resting
- Sleep: Enabled for performance

**Client (Interpolation):**
- Update rate: 60fps (16ms)
- Buffer delay: 100-120ms
- Position: Linear interpolation (lerp)
- Rotation: Spherical linear interpolation (slerp)
- Clock sync: RTT median from last 5 samples

## 🔧 Configuration

### Server (`server/.env`)
```bash
PORT=3000
```

### Client (`client/.env`)
```bash
VITE_WS_URL=ws://localhost:3000
```

## 📊 Performance Targets (PoC)

- ✅ FPS ≥ 20 on mobile
- ✅ RTT < 50ms on local network
- ✅ Clock offset < 20ms between clients
- ✅ Position error < 0.02m (visual inspection)
- ✅ 0% tunneling with CCD enabled
- ✅ Smooth pusher motion (no jitter)

## 🧪 Testing Scenarios

### Single Client
- [x] Connect to server
- [x] Receive world snapshot
- [x] See pusher moving (sinusoidal)
- [x] Insert coin
- [x] Coin falls and interacts with pusher
- [x] Coin despawns when y < -0.1

### Multi-Client
- [x] Open 2+ browser tabs
- [x] All see same pusher motion
- [x] Insert coin in tab A → appears in tab B
- [x] Position synchronized (< 0.02m error)
- [x] Smooth interpolation (no teleporting)

## 🎮 Game Mechanics

### Pusher Plate
- **Movement**: Sinusoidal along Z axis
- **Formula**: `z = 0.3 * sin(2π * 0.5 * t)`
- **Amplitude**: 0.3 meters
- **Frequency**: 0.5 Hz (completes cycle every 2 seconds)

### Coins
- **Spawn**: Top of scene (y = 1.5m)
- **Position range**: x ∈ [-0.5, 0.5]
- **Size**: Radius 0.02m, Thickness 0.009m
- **Mass**: 0.01kg
- **Friction**: 0.3
- **Restitution**: 0.2
- **Despawn**: When y < -0.1m

### Rate Limiting
- Max 1 coin insert per 100ms per connection
- X coordinate validated: [-0.5, 0.5]

## 🚧 Known Limitations (PoC)

- ❌ No authentication/authorization
- ❌ No persistence (in-memory only)
- ❌ No reconnection handling
- ❌ No scoring system
- ❌ No advanced visual effects (shadows, PBR)
- ❌ Single room only (no matchmaking)
- ❌ Basic error handling

## 📈 Future Enhancements

- [ ] Redis for event streaming
- [ ] JWT authentication
- [ ] State persistence & replay
- [ ] Multi-room architecture
- [ ] Advanced physics materials
- [ ] Score tracking & RTP calculation
- [ ] Binary protocol (MessagePack)
- [ ] Dynamic interpolation buffer
- [ ] Packet loss compensation

## 📝 License

MIT

## 👥 Contributors

Built as a technical PoC for exploring real-time multi-user physics synchronization.

