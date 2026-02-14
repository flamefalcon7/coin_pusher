# Game Server

Authoritative physics simulation running as a NATS worker. Receives commands from the Go backend via NATS, runs Rapier 3D physics, and publishes state updates back.

## Quick Start

```bash
pnpm install
pnpm dev       # Development with hot reload (tsx watch)
pnpm build     # Compile TypeScript
pnpm start     # Run compiled output
```

Requires a NATS server running (default: `nats://localhost:4222`).

## Architecture

The game server has **no HTTP or WebSocket ports**. It communicates exclusively via NATS:

```
Go Backend                    NATS                    Game Server
(WebSocket hub) --publish--> [coin_insert] --sub-->  (Rapier physics)
                --request--> [snapshot_req] --reply-> (world state)
                <--subscribe- [state_delta] <--pub-- (30Hz updates)
                <--subscribe- [despawn]     <--pub-- (coin removal)
```

## Project Structure

```
game/server/src/
├── index.ts              # Entry point (NATS subscriptions)
├── nats/                 # NATS message queue client
│   └── NatsClient.ts
├── game/                 # Game logic
│   ├── GameLoop.ts       # Main 30Hz loop
│   ├── GameState.ts      # Central state management
│   ├── CoinManager.ts    # Coin lifecycle
│   ├── StackSpawner.ts   # Stack spawning logic
│   └── TickScheduler.ts  # Fixed timestep scheduler
├── physics/              # Rapier 3D simulation
│   ├── PhysicsWorld.ts   # World setup + stepping
│   ├── SceneBuilder.ts   # Static geometry (platform, walls)
│   ├── Pusher.ts         # Kinematic pusher (sinusoidal motion)
│   ├── Coin.ts           # Dynamic coin bodies
│   └── config.ts         # Physics parameters
└── rtp_sim.ts            # RTP simulation tool
```

## Physics Configuration

- **Tick rate**: 30Hz (33.33ms per tick)
- **Gravity**: `{x: 0, y: -9.81, z: 0}`
- **Substeps**: 2
- **Solver**: velocity=8, position=3
- **CCD**: Enabled during free-fall, disabled when resting
- **Sleep**: Enabled for performance

## Dependencies

- `@dimforge/rapier3d-compat` - Physics engine (WASM, Node.js compatible)
- `@msgpack/msgpack` - Binary serialization
- `nats` - NATS messaging client
- `@coin-pusher/shared` - Shared protocol types
