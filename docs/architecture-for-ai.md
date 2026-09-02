# Coin Pusher — Architecture & Design Document

## Overview

Multiplayer online arcade coin pusher game with server-authoritative 3D physics, real-time sync, and blockchain-based economy (USDC deposits/withdrawals).

**Architecture**: Server-authoritative physics → NATS pub/sub → Go relay/backend → WebSocket → BabylonJS client

```
┌─────────────┐     ┌──────────────┐     ┌─────────────┐     ┌──────────────┐
│  BabylonJS   │◄───►│  Go Backend  │◄───►│    NATS      │◄───►│ Game Server  │
│  Client      │ WS  │  (Relay/API) │     │  Pub/Sub     │     │ (Rapier 3D)  │
└─────────────┘     └──────────────┘     └─────────────┘     └──────────────┘
                          │
                     ┌────┴────┐
                     │ Postgres │
                     └─────────┘
```

---

## Tech Stack

| Layer | Tech |
|-------|------|
| Game Server | TypeScript, Rapier 3D physics (WASM), NATS |
| Game Client | TypeScript, BabylonJS, React, Vite |
| Shared | TypeScript protocol types & config |
| Backend | Go 1.22+, chi router, Zap logger, PostgreSQL |
| Messaging | NATS pub/sub, Protobuf + MessagePack |
| Auth | JWT (EVM wallet signature login via MetaMask / WalletConnect) |
| Blockchain | USDC on Base (EVM). No other chain is wired |

---

## Project Structure

```
coin_pusher/
├── game/
│   ├── client/src/           # BabylonJS game client
│   │   ├── App.tsx           # React root, auth, page routing, all UI overlays
│   │   ├── scene/
│   │   │   ├── SceneManager.ts    # Engine, camera, lighting, themes, ability VFX
│   │   │   ├── CameraSetup.ts     # ArcRotateCamera (responsive: portrait/landscape)
│   │   │   ├── CoinMeshManager.ts # Dynamic coin mesh pooling (up to 800)
│   │   │   ├── StaticMeshes.ts    # Board geometry (platform, walls, pins, pusher)
│   │   │   ├── VFXManager.ts      # Particle effects (shock, tornado, explosion, etc.)
│   │   │   ├── SoundManager.ts    # Audio playback
│   │   │   ├── ToonMaterial.ts    # Cel-shading material
│   │   │   └── PusherMesh.ts      # Kinematic pusher visualization
│   │   ├── net/
│   │   │   ├── GameClient.ts      # High-level game connection, event callbacks
│   │   │   ├── WebSocketClient.ts # WS connection, auto-reconnect, binary framing
│   │   │   ├── ClockSync.ts       # RTT measurement, server time offset
│   │   │   ├── StateBuffer.ts     # Circular buffer for state snapshots
│   │   │   ├── Interpolator.ts    # Coin pos/rot interpolation & extrapolation
│   │   │   ├── auth.ts            # JWT + wallet persistence
│   │   │   └── InventoryClient.ts # Inventory HTTP API client
│   │   ├── ui/
│   │   │   ├── CoinInsertButton.tsx  # 5-slot selector + batch insert (1/10/50/100)
│   │   │   ├── Toolbar.tsx           # Ability buttons with cooldowns
│   │   │   ├── Leaderboard.tsx       # Real-time heat share rankings
│   │   │   ├── MegaspeakerPanel.tsx  # Collapsible chat
│   │   │   ├── InventoryBar.tsx      # Key coins, scrolls, charges
│   │   │   ├── TutorialOverlay.tsx   # First-time guide
│   │   │   └── IdleOverlay.tsx       # 25min warning, 30min disconnect
│   │   ├── pages/
│   │   │   ├── DepositPage.tsx       # USDC deposit (multi-chain)
│   │   │   ├── WithdrawPage.tsx      # Cash out rewards
│   │   │   ├── ChestPage.tsx         # Open chests (3D animation)
│   │   │   ├── ProfilePage.tsx       # User info, stats
│   │   │   └── ProgressPage.tsx      # Milestones
│   │   └── editor/
│   │       ├── EditorManager.ts      # Admin physics tuning
│   │       └── EditorPanel.tsx       # Place/move/scale primitives
│   │
│   ├── server/src/           # Game server (physics simulation)
│   │   ├── index.ts          # Init: PhysicsWorld, GameState, NATS, GameLoop
│   │   ├── game/
│   │   │   ├── GameLoop.ts        # 30Hz tick: pusher, drops, physics, despawn, network
│   │   │   ├── GameState.ts       # All bodies, world snapshot generation
│   │   │   ├── CoinManager.ts     # Coin ID allocation
│   │   │   ├── DropScheduler.ts   # Per-slot queues, round-robin fairness
│   │   │   └── StackSpawner.ts    # Batch patterns (wall, tower, pyramid)
│   │   ├── physics/
│   │   │   ├── PhysicsWorld.ts    # Rapier WASM init, gravity, solver config
│   │   │   ├── Coin.ts           # Rigid body: r=0.06m, mass=0.01kg
│   │   │   ├── KeyCoin.ts        # 33% larger variant: r=0.08m
│   │   │   ├── Pusher.ts         # Kinematic oscillation + super push state machine
│   │   │   ├── SceneBuilder.ts   # Procedural board (platform, walls, pins)
│   │   │   └── EditorPhysics.ts  # Dynamic primitive sync
│   │   └── nats/
│   │       └── NATSClient.ts     # NATS pub/sub, Protobuf encoding
│   │
│   └── shared/src/           # Shared protocol
│       └── types.ts          # All message types, physics config, scene config
│
├── backend/                  # Go backend (Ardan Labs layout)
│   ├── app/services/api/     # HTTP API server + handlers
│   │   └── handlers/v1/
│   │       ├── usergrp/      # Auth login, profile
│   │       ├── gamegrp/      # Game events (insert, rewards)
│   │       ├── inventorygrp/ # Scroll/chest management
│   │       ├── depositgrp/   # Deposit API
│   │       └── progressgrp/  # Progress API
│   ├── business/core/
│   │   ├── user/             # Auth, JWT, profile
│   │   ├── accounting/       # Ledger (deposit, withdraw, reward)
│   │   ├── inventory/        # Scrolls, key coins, chests
│   │   ├── heat/             # Heat calculation (reward distribution)
│   │   ├── game/             # Game orchestration
│   │   ├── deposit/          # Deposit history
│   │   └── progress/         # Milestones
│   ├── business/web/
│   │   └── ws/               # WebSocket relay hub
│   ├── foundation/           # Reusable libs (database, logger, NATS, SUI SDK)
│   └── zarf/                 # Docker, K8s configs
│
└── docs/
    └── spec.md               # Product spec (game loop, economy, abilities)
```

---

## Game Board Layout

```
Top-down view (looking down Y axis):

         ← 1.2m →
    ┌─────────────────┐  ─┐
    │   BACK WALL     │   │
    │                 │   │
    │  · · · · ·     │   │  Pin rows (5 rows, staggered)
    │   · · · · · ·  │   │  Odd rows: 5 pins
    │  · · · · ·     │   │  Even rows: 6 pins
    │   · · · · · ·  │   │
    │  · · · · ·     │   │
    │                 │   │
    │  ┌───────────┐  │   │  1.3m deep
    │  │  PUSHER   │  │   │  (oscillates Z: 0.6Hz)
    │  │           │  │   │
    │  └───────────┘  │   │
    │                 │   │
  ┌─┤                 ├─┐ │  Side wall openings
  │ │                 │ │ │  Left: slot machine trigger
  │L│  COIN FIELD    │R│ │  Right: wheel trigger
  │ │                 │ │ │
  └─┤                 ├─┘ │
    │  ═══════════════│   │  Front lip (0.035m wedge)
    └─────────────────┘  ─┘
         FRONT EDGE
    (coins fall off → rewards)

Side view:
    Back Wall (2m tall)
    │
    │  Pin zone
    │  ·  ·  ·
    │
    │  ┌──────┐ Pusher
    │  │      │ (oscillates back/forth)
    │  └──────┘
    │          ╲  2° forward tilt
    │           ╲
    ═════════════╲ Front lip
                  ↓ Coins fall here
```

### Board Dimensions
| Component | Value |
|-----------|-------|
| Platform width | 1.2m |
| Platform depth | 1.3m |
| Platform tilt | 2° forward |
| Back wall height | 2m |
| Pin rows | 5 (staggered: 5/6/5/6/5) |
| Pin radius | 0.01m |
| Pin vertical spacing | 0.18m |
| Side wall openings | 0.32m × 0.32m |
| Front lip height | 0.035m (wedge) |
| Left platform extension | 0.35m outward |

---

## Camera Setup

**Type**: ArcRotateCamera (orbital, looking at board center)

| Parameter | Value |
|-----------|-------|
| Alpha (horizontal) | 90° (π/2) — looking from front |
| Beta (vertical) | 60° (π/3) — slight top-down angle |
| Base radius | 3m |
| Min radius | 2m |
| Max radius | 5.5m |
| Target | Board center |
| FOV | Default BabylonJS |

### Responsive Scaling
```
aspect < 0.5  → radius ≈ 6.5m  (phone portrait)
aspect 0.5–1.3 → radius scales progressively
aspect ≥ 1.3  → radius = 3m    (desktop/landscape)
```

Non-admin players: rotation and zoom are locked after initial setup.

---

## Physics Configuration

| Parameter | Value |
|-----------|-------|
| Tick rate | 30 Hz (33.3ms) |
| Physics substeps | 2 |
| Gravity | (0, -9.81, 0) m/s² |
| Solver velocity iterations | 4 |
| Solver position iterations | 3 |
| Max active coins | 800 |
| Position quantization | 3 decimal places |
| Network send rate | 15 Hz (every 2 ticks) |

### Coin Physics
| Param | Regular | Key Coin |
|-------|---------|----------|
| Radius | 0.06m | 0.08m |
| Thickness | 0.012m | 0.015m |
| Mass | 0.01 kg | 0.015 kg |
| Friction | 0.7 | 0.7 |
| Restitution | 0.3 | 0.3 |
| Spawn height | 1.5m | 1.5m |
| CCD | enabled | enabled |

### Pusher
| Param | Value |
|-------|-------|
| Frequency | 0.6 Hz |
| Z offset | 0.1m |
| Base amplitude (empty board) | 0.08m |
| Max amplitude (400+ coins) | 0.24m |
| Amplitude ramp range | 250–400 coins (smoothstep) |

---

## Abilities

| Ability | Cooldown | Radius | Duration | Effect |
|---------|----------|--------|----------|--------|
| Shock | 2s | ~0.25m | Instant | Dislodge stuck coins in pin zone |
| Lightning | 6s | 0.35m/strike | 3s | 22 random strikes |
| Explosion | 8s | 0.6m | Instant | Radial blast (quadratic falloff) |
| Tornado | 10s | 0.4m | 4s | Sustained vortex (lift + spin) |
| Super Push | 12s | Full platform | 1.7s | Pullback → explosive thrust |

### Super Push State Machine
1. **Pullback** — -0.05m over 400ms (easeInCubic)
2. **Thrust** — 0.6m over 350ms (easeOutExpo)
3. **Hold** — 0.6m for 250ms
4. **Recovery** — back to normal oscillation over 700ms (easeInOutQuad)

---

## Economy & Reward System

### Coin Insert
- 5 drop slots: positions [-0.4, -0.2, 0.0, 0.2, 0.4]
- Batch sizes: 1, 10, 50, 100
- Per-slot capacity: 500 coins
- Drop rate: ~7.5 coins/sec/slot (4-tick cooldown)
- Random X offset: ±0.03m per drop

### Coin Exits & Triggers
| Exit Zone | Trigger |
|-----------|---------|
| Front edge | Reward distribution (via heat share) |
| Left wall (50 coins) | Slot machine spin |
| Right wall (50 coins) | Jackpot wheel spin + key coin drops |

### Slot Machine
- 3 reels, symbols: bitcoin/ethereum/solana
- Jackpot: 3 matching = 100 bonus coins (probability 1/9)

### Jackpot Wheel
- 6 segments: [3, 3, 3, 6, 6, 9] key coins
- Expected: 5 key coins per 50-coin trigger

### Heat System (Reward Distribution)
- Exponential decay: 180s half-life
- Diminishing returns: α=0.95 (power law; `heat.go` default)
- Minimum floor: disabled in prod (0); activity decay with coinHalfLife=30 instead
- Updated: 1Hz broadcast to all clients

---

## Network Protocol

### Message Flow
```
Client → [WS] → Go Backend → [NATS] → Game Server
Game Server → [NATS] → Go Backend → [WS broadcast] → All Clients
```

### Key Messages
| Direction | Message | Frequency |
|-----------|---------|-----------|
| Server → Client | StateDelta (coin positions) | 15 Hz |
| Server → Client | Despawn (coin exits) | On event |
| Server → Client | AbilityEvent (VFX trigger) | On event |
| Server → Client | CoinSpawn (new coin) | On event |
| Server → Client | SlotSpin / WheelSpin | On trigger |
| Server → Client | HeatUpdate (leaderboard) | 1 Hz |
| Server → Client | InventoryUpdate | On change |
| Client → Server | BatchInsert | User action |
| Client → Server | Ability (shock/tornado/etc.) | User action |

### Interpolation
- Buffer: Circular buffer of state snapshots
- Delay: `max(110ms, RTT × 1.5, smoothed jitter + 120ms margin)`, clamped [100–500ms]
- Extrapolation: Up to 150ms beyond last known state
- Sleeping coins: Maintain last position until updated
- RTT sampling: Ping every 3s, median of last 12 samples

### Connection
- Auto-reconnect: Exponential backoff (1s → 15s max)
- Idle timeout: 30min (warning at 25min)
- Auth: JWT token via WS query params
- Protocol: Protobuf primary, MessagePack fallback

---

## UI Layout (Current)

```
Desktop Layout:
┌──────────────────────────────────────────┐
│ [Balance] [Heat Meter]      [Leaderboard]│  ← Top bar
│                                          │
│                                          │
│           3D GAME CANVAS                 │
│         (BabylonJS scene)                │
│                                          │
│                                          │
│ [Chat]                                   │  ← MegaspeakerPanel (collapsible)
│                                          │
│ [Inventory: keys, scrolls, charges]      │  ← InventoryBar
│ [Shock][Lightning][Explosion][Tornado][SP]│  ← Toolbar (abilities)
│        [Slot 1-5 selector] [Insert]      │  ← CoinInsertButton
└──────────────────────────────────────────┘
```

### UI Components
| Component | Location | Behavior |
|-----------|----------|----------|
| Balance display | Top-left | Always visible |
| Heat meter | Top area | Personal heat gauge |
| Leaderboard | Top-right | Scrollable list, 1Hz updates |
| Megaspeaker chat | Left side | Collapsible, 50-message buffer |
| Inventory bar | Bottom overlay | Key coins + scroll counts |
| Ability toolbar | Bottom | 5 buttons with cooldown timers |
| Coin insert | Bottom | 5-slot selector + batch amount |
| Reward toast | Center | Transient notification |
| Tutorial overlay | Full screen | First-time only |
| Idle overlay | Full screen | 25min warning |

### Pages (Full-screen overlays)
- **Deposit** — Chain selector + USDC amount
- **Withdraw** — Chain selector + amount (from balance_cash)
- **Chest** — 3D chest opening animation + reward reveal
- **Profile** — Username, stats, referral code
- **Progress** — Milestones, lifetime deposits

---

## Input Controls

| Action | Desktop | Mobile |
|--------|---------|--------|
| Select slot | ← → arrow keys | Tap slot buttons |
| Insert coins | SPACE | Tap insert button |
| Use ability | Click ability button | Tap ability button |
| Aim tornado/explosion | Mouse hover → click | Tap on board |
| Camera rotate | Mouse drag (admin only) | Two-finger rotate |
| Camera zoom | Mouse wheel (admin only) | Pinch zoom |

---

## Visual Style

- **Aesthetic**: Toon/cel-shading (custom ToonMaterial)
- **Theme**: "Psychedelic Pop" (configurable)
- **Coordinate system**: BabylonJS left-handed, Y-up
- **Coin rendering**: Pooled meshes, batched updates per frame
- **VFX**: BabylonJS ParticleSystem (shock flashes, tornado vortex, explosion bursts, lightning strikes)
- **Slot/Wheel**: Animated reel spin with symbol reveal

---

## Backend API Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| POST | /v1/auth/login | Wallet login (address + signature) |
| GET | /v1/user/profile | Fetch user profile (JWT required) |
| POST | /v1/game/batch_insert | Queue coin insertion |
| POST | /v1/game/ability | Execute ability |
| GET | /v1/inventory | Fetch scrolls/key coins |
| POST | /v1/chest/open | Open chest → random reward |
| POST | /v1/deposit | Create deposit request |
| POST | /v1/withdraw | Create withdrawal request |
| GET | /v1/progress | User milestones |

---

## Data Flow Examples

### Coin Insert → Reward
```
1. Client sends batch_insert {slot: 2, count: 50}
2. Backend validates balance, deducts coins
3. NATS → Game Server: DropScheduler enqueues 50 coins
4. Each tick: 1 coin spawned per slot (round-robin)
5. Coin falls through pins, lands on platform
6. Pusher oscillates, pushes coins forward
7. Coin falls off front edge → despawn event
8. Backend calculates heat-share reward for all active players
9. Balance updated, reward toast shown to players
```

### Ability (Tornado)
```
1. Client: user taps tornado + taps target location
2. Backend: validates scroll count ≥ 1, consumes scroll
3. NATS → Game Server: starts 4s vortex at (x, z)
4. Each tick: radial forces applied to nearby coins
5. AbilityEvent broadcast → all clients play VFX + sound
6. Coins scatter, some fall off edges → rewards
```
