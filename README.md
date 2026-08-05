# Coin Pusher

A multi-user coin pusher game with server-authoritative physics and real-time synchronization.

## Tech Stack

- **Client**: TypeScript, React, BabylonJS, Vite
- **Game Server**: TypeScript, Rapier 3D physics (WASM), Protobuf
- **Backend**: Go 1.22+, PostgreSQL, chi router, Zap logger
- **Messaging**: NATS for backend <-> game server communication
- **Monorepo**: pnpm workspace (TS) + Go module (backend)

## Architecture

```
Cloudflare Pages                    DigitalOcean Droplet
(static client)                     (docker compose)
     |                              +------------------+
     |                              | Go Backend :4000 |
Browser --HTTPS--> Cloudflare --->  |   WebSocket /ws  |
         WSS       DNS proxy        |     | NATS       |
                                    | TS Game Server   |
                                    | PostgreSQL       |
                                    | NATS             |
                                    +------------------+
```

- **Go backend** handles HTTP API, authentication, WebSocket gateway, and relays messages via NATS
- **TS game server** runs Rapier physics simulation as a NATS worker (no exposed ports)
- **Client** connects via WebSocket to the Go backend on port 4000

### Simulation properties

- **Fixed timestep, drift corrected** — 30Hz with 2 solver substeps. The scheduler measures real
  elapsed time and spends it in whole dt steps, capping catch-up at 5 steps so a stall cannot
  spiral. State is broadcast at 15Hz, once per firing.
- **Pusher on simulated time** — the pusher's position is a function of the tick index, not the wall
  clock, so it cannot drift out of phase with the coins. Ability durations (tornado, lightning) are
  still measured against `performance.now()`, so the server does not yet run on a single clock.
- **Broadcast equals physics** — the pusher is a position-based kinematic body advanced per
  substep; the Z sent to clients is the same value handed to the solver (residual ~3e-8 m).
- **Seeded physics randomness** — coin scatter and ability jitter come from a per-session 128-bit
  seed, written to the process log and **never sent to clients**: lightning strike positions are
  drawn from that stream and the player picks when to spend the scroll, so a published seed is a
  predictable payout. Slot reel and wheel outcomes stay on `node:crypto`. See ADR D-005 (and its
  2026-08-05 amendment) for the boundary and the residual risk.

  Replay is **not** end-to-end: ability durations run on the wall clock (above), so a session
  containing a tornado or lightning does not reproduce.
- **Bounded body count** — a hard cap (`MAX_ACTIVE_COINS`) applies to every spawn path. Queued
  coins are held rather than dropped when the table is full.

## Project Structure

```
coin-pusher/
├── game/
│   ├── client/          # Frontend (React + BabylonJS)
│   │   └── src/
│   │       ├── ui/      # React components (HUD, buttons)
│   │       ├── scene/   # BabylonJS 3D rendering
│   │       └── net/     # WebSocket client + interpolation
│   ├── server/          # Game server (NATS worker + Rapier physics)
│   │   └── src/
│   │       ├── game/    # Game state, loop, coin lifecycle
│   │       ├── physics/ # Rapier simulation, scene, pusher
│   │       └── nats/    # NATS message queue client
│   └── shared/          # Shared TypeScript protocol types
│       └── src/
├── backend/             # Go backend (Ardan Labs layout)
│   ├── app/
│   │   ├── services/api/    # HTTP server, handlers, WebSocket hub
│   │   └── tooling/         # CLI tools (admin, indexer)
│   ├── business/
│   │   ├── core/            # Domain logic (user, accounting, game)
│   │   └── web/             # Middleware, auth, WebSocket relay
│   ├── foundation/          # Reusable libs (database, logger, keystore, NATS)
│   └── zarf/                # Docker, DB schema, K8s configs
├── deploy/              # Server provisioning scripts
├── docker-compose.dev.yml   # Full dev stack
├── docker-compose.prod.yml  # Production deployment
├── Dockerfile           # Game server container
└── Makefile             # Dev convenience targets
```

## Getting Started

### Prerequisites

- Node.js 20+, pnpm 9+
- Go 1.22+
- Docker + Docker Compose

### Development (Docker)

```bash
# Start full dev stack (all services with hot reload)
docker compose -f docker-compose.dev.yml up
```

This starts: PostgreSQL, NATS, Go backend (:4000), TS game server, client (:5173).

### Development (Manual)

```bash
# Terminal 1: Start dependencies
docker compose -f docker-compose.dev.yml up postgres nats

# Terminal 2: Go backend
cd backend && make run

# Terminal 3: TS packages
pnpm dev
```

- Client: http://localhost:5173
- Backend API: http://localhost:4000
- WebSocket: ws://localhost:4000/ws

### Testing

```bash
# TypeScript packages (client, server, shared)
pnpm -r test

# Go backend tests
cd backend && make test

# Open browser to http://localhost:5173
# Click "Insert Coin" and watch physics in action
# Open multiple tabs to see multi-user sync
```

CI (`.github/workflows/ci.yml`) runs `pnpm -r test` plus `go vet ./...` and `go test ./...` on
every push and PR to main.

To re-run a recorded session against a changed build, start the game server with the seed from
that session's logs or snapshot:

```bash
SESSION_RNG_SEED=deadbeef pnpm --filter @coin-pusher/game dev
```

## Deployment

Production uses Docker Compose on a DigitalOcean droplet with Cloudflare for DNS/SSL/CDN.

- **Server provisioning**: `deploy/setup.sh` (one-time)
- **CI/CD**: `.github/workflows/deploy-game.yml` and `deploy-services.yml` (SSH deploy on push to
  main; both require `DEPLOY_*` repository secrets to be configured)
- **Frontend**: Cloudflare Pages (auto-deploy from GitHub)

## License

MIT
