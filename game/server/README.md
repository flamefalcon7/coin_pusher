# 🖥️ Coin Pusher Server

Authoritative game server with Rapier physics simulation and WebSocket communication.

## 🚀 Quick Start

```bash
# Install dependencies
pnpm install

# Run development server (with hot reload)
pnpm dev

# Build for production
pnpm build

# Run production server
pnpm start
```

Server will start on `ws://localhost:3000` (or port specified in `.env`)

## 📁 Project Structure

```
server/
├── src/
│   ├── index.ts           # Entry point
│   ├── ws/                # WebSocket layer
│   │   ├── WebSocketServer.ts
│   │   ├── Connection.ts
│   │   └── MessageHandler.ts
│   ├── game/              # Game logic
│   │   ├── GameState.ts   # State management
│   │   ├── CoinManager.ts # Coin lifecycle
│   │   ├── GameLoop.ts    # Main game loop
│   │   └── TickScheduler.ts
│   └── physics/           # Rapier physics
│       ├── PhysicsWorld.ts
│       ├── SceneBuilder.ts
│       ├── Pusher.ts      # Kinematic pusher
│       └── Coin.ts        # Dynamic coins
└── package.json
```

## ⚙️ Configuration

Create `.env` file (see `.env.example`):

```bash
PORT=3000
```

## 🎮 Game Loop

Runs at **30Hz** (33.33ms per tick):

1. Update pusher position (kinematic)
2. Update coins (check CCD state)
3. Step physics simulation (with substeps=2)
4. Collect body states
5. Detect despawns (y < -0.1)
6. Broadcast `state_delta` to all clients
7. Increment tick counter

## 🌍 Physics World

**Configuration:**
- Gravity: `{x: 0, y: -9.81, z: 0}`
- Substeps: 2
- Solver iterations: velocity=8, position=3
- Right-handed coordinate system
- Sleep enabled for performance

**Static Scene:**
- Main platform: 1.2m × 0.8m × 0.05m
- Back wall: 1.2m × 0.3m × 0.05m
- Side walls (with 1.5° inner tilt)
- Drop zone detection

**Kinematic Pusher:**
- Size: 1.1m × 0.7m × 0.05m
- Movement: `z = 0.3 * sin(2π * 0.5 * t)`
- Updated via `setNextKinematicTranslation`

**Dynamic Coins:**
- Cylinder: radius=0.02m, thickness=0.009m
- Mass: 0.01kg
- CCD enabled during free-fall
- CCD disabled when velocity < 0.5 m/s and y < 0.5m

## 📡 WebSocket Protocol

**Incoming Messages:**
```typescript
// Insert coin
{ "op": "coin_insert", "x": 0.123 }

// Clock sync
{ "op": "ping", "clientTime": 1234567890 }
```

**Outgoing Messages:**
```typescript
// Initial state (on connect)
{
  "op": "world_snapshot",
  "protocolVersion": 1,
  "serverTime": 1234567890,
  "tick": 100,
  "bodies": [...]
}

// State updates (every 33ms)
{
  "op": "state_delta",
  "serverTime": 1234567891,
  "tick": 101,
  "updates": [...],
  "pusherZ": 0.148
}

// Remove coins
{
  "op": "despawn",
  "tick": 102,
  "ids": [17, 19]
}

// Clock sync response
{
  "op": "pong",
  "serverTime": 1234567890
}
```

## 🔒 Rate Limiting

- Max 1 coin insert per 100ms per connection
- X coordinate validation: [-0.5, 0.5]
- Invalid requests logged and discarded

## 📊 Console Output

```
🎮 Starting Coin Pusher Server...
📡 Port: 3000
📡 WebSocket server listening on port 3000
⚙️  Rapier physics world initialized
   Gravity: (0, -9.81, 0)
   Substeps: 2
   Solver iterations: vel=8, pos=3
🏗️  Building static scene...
  ✓ Main platform created
  ✓ Back wall created
  ✓ Side walls created
✅ Static scene built
🔨 Pusher created
   Amplitude: 0.3m, Frequency: 0.5Hz
🎮 Game loop started at 30Hz
✅ Server ready!
```

## 🧪 Testing

Use the provided test client:
```bash
# Open test-ws-client.html in browser
open ../test-ws-client.html
```

Or use `wscat`:
```bash
npm install -g wscat
wscat -c ws://localhost:3000
> {"op":"ping","clientTime":1234567890}
< {"op":"pong","serverTime":1234567891}
```

## 📦 Dependencies

- `ws` - WebSocket server
- `@dimforge/rapier3d-compat` - Physics engine (Node.js compatible)
- `@coin-pusher/shared` - Shared types
- `tsx` - TypeScript execution (dev)

## 🐛 Debugging

Enable detailed logging:
```typescript
// Add to src/index.ts
console.log('State delta:', JSON.stringify(stateDelta, null, 2));
```

Monitor connections:
```bash
lsof -i :3000
```

## ⚡ Performance

**Target:**
- 30Hz tick rate (stable)
- < 10ms per tick execution
- < 50KB/s per client (10 active coins)

**Optimization:**
- Sleep enabled for static coins
- Quantize values to 3 decimals
- Thin instances on client side
- CCD only during free-fall

