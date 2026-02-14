# Coin Pusher

A multi-user coin pusher game with server-authoritative physics and real-time synchronization.

## Tech Stack

- **Client**: TypeScript, React, BabylonJS, Vite
- **Game Server**: TypeScript, Rapier 3D physics (WASM), MessagePack
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
# Go backend tests
cd backend && make test

# Open browser to http://localhost:5173
# Click "Insert Coin" and watch physics in action
# Open multiple tabs to see multi-user sync
```

## Deployment

Production uses Docker Compose on a DigitalOcean droplet with Cloudflare for DNS/SSL/CDN.

- **Server provisioning**: `deploy/setup.sh` (one-time)
- **CI/CD**: `.github/workflows/deploy-docker.yml` (auto-deploy on push to main)
- **Frontend**: Cloudflare Pages (auto-deploy from GitHub)

## License

MIT
