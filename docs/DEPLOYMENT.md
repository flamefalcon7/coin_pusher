# Deployment Guide

## Architecture Overview

```
Cloudflare Pages             Services Machine (DO Droplet)       Game Machine (DO Droplet)
(static client)              (docker-compose.services.yml)       (docker-compose.game.yml)
                             +-------------------------+         +-------------------+
Browser ---HTTPS/WSS--->     | Nginx :80/:443          |         |                   |
  Cloudflare DNS proxy  ---> |   |                     |         |                   |
                             |   v                     |         |                   |
                             | Go Backend :4000        |         |                   |
                             |   |                     |         |                   |
                             |   v                     |         |                   |
                             | NATS :4222 ----VPC------|-------> | TS Game Server    |
                             | PostgreSQL              |         |   (Rapier physics) |
                             | Executor                |         +-------------------+
                             | Indexer                 |
                             +-------------------------+
```

| Component | Hosting | Cost |
|-----------|---------|------|
| Frontend (client) | Cloudflare Pages | Free |
| Services (Go API + NATS + Postgres + Nginx + Executor + Indexer) | DigitalOcean Droplet | ~$12/mo |
| Game Server (TS physics, CPU-heavy) | DigitalOcean Droplet | ~$12/mo |
| DNS + SSL + CDN | Cloudflare (free plan) | Free |
| Domain | Namecheap (or any registrar) | ~$10/yr |

Cloudflare proxies both HTTPS and WSS. An Nginx container listens on ports 80/443, redirects HTTP to HTTPS, and proxies `/` and `/ws` to the Go backend. The game server communicates with the backend via NATS over DigitalOcean's VPC private network.

---

## Local Development

### Prerequisites

- Docker + Docker Compose
- (Optional) Node.js 20+, pnpm 9+, Go 1.22+ for running services outside Docker

### Option 1: Docker (recommended)

Start the full stack with hot reload:

```bash
make up_local
# or: docker compose -f docker-compose.dev.yml up --build
```

This starts 6 services:

| Service | Port | Description |
|---------|------|-------------|
| client | :5173 | Vite dev server (HMR) |
| backend | :4000 | Go API + WebSocket gateway |
| backend (debug) | :4010 | Debug/admin endpoints |
| game | (internal) | TS physics server (NATS worker) |
| postgres | :5432 | Database (user: `postgres`, pass: `postgres`, db: `coinpusher`) |
| nats | :4222 | Message queue (monitoring: :8222) |

Open http://localhost:5173 in your browser. The client connects to `ws://localhost:4000/ws`.

To stop:

```bash
make down_local
# or: docker compose -f docker-compose.dev.yml down
```

To reset the database (delete volume):

```bash
docker compose -f docker-compose.dev.yml down -v
```

### Option 2: Manual (services run natively)

```bash
# 1. Start dependencies only
docker compose -f docker-compose.dev.yml up postgres nats

# 2. Run Go backend (new terminal)
cd backend
make admin-migrate   # Run DB migrations
make admin-seed      # Seed initial data (optional)
make run             # Starts on :4000

# 3. Run TS packages (new terminal, from repo root)
pnpm install
pnpm dev             # Starts shared (watch) + game server + client (:5173)
```

### Useful commands

```bash
# Run Go backend tests
make backend-test

# Run RTP simulation
make rtp_sim

# Rebuild only one service
docker compose -f docker-compose.dev.yml up --build backend
```

---

## Production Deployment

### Step 1: Create two DigitalOcean Droplets

Create both droplets in the **same region** with **VPC networking** enabled:

1. **Services machine** — runs backend, database, NATS, nginx, executor, indexer
   - **Image**: Ubuntu 22.04 LTS
   - **Plan**: Basic $12/mo (2 GB RAM, 1 vCPU) — sufficient for MVP
   - **VPC**: Enable (note the **private IP**)

2. **Game machine** — runs the TS physics server (Rapier, CPU-heavy)
   - **Image**: Ubuntu 22.04 LTS
   - **Plan**: Basic $12/mo (2 GB RAM, 1 vCPU)
   - **VPC**: Same VPC as services machine (note the **private IP**)

Both machines must be in the same VPC so the game server can reach NATS on the services machine via private IP.

### Step 2: Set up the Services machine

SSH into the services droplet as root:

```bash
ssh root@<SERVICES_PUBLIC_IP>

git clone https://github.com/flamefalcon/coin_pusher.git /opt/coin_pusher
cd /opt/coin_pusher
chmod +x deploy/setup.sh
./deploy/setup.sh
```

The script does the following automatically:
1. Installs Docker + Docker Compose
2. Creates a `deploy` user with Docker access (copies your SSH key)
3. Creates `.env` from `.env.example` with a random DB password
4. Generates an RSA key for JWT signing (`backend/zarf/keys/default.pem`)
5. Generates TLS cert files for Nginx at `deploy/nginx/certs/`
6. Starts all services via `docker-compose.services.yml`
7. Runs database migrations
8. Configures UFW firewall (allows ports 22, 80, and 443)

After setup, **add the NATS firewall rule** for the game machine:

```bash
ufw allow from <GAME_PRIVATE_IP> to any port 4222
```

Verify services are running:

```bash
docker compose -f docker-compose.services.yml ps
```

You should see 6 services: `nginx`, `nats`, `postgres`, `backend`, `executor`, `indexer`.

### Step 3: Set up the Game machine

SSH into the game droplet as root:

```bash
ssh root@<GAME_PUBLIC_IP>

git clone https://github.com/flamefalcon/coin_pusher.git /opt/coin_pusher
cd /opt/coin_pusher
chmod +x deploy/setup-game.sh
./deploy/setup-game.sh
```

Then edit `.env` with the services machine's private IP:

```bash
vi /opt/coin_pusher/.env
# Set: NATS_URL=nats://<SERVICES_PRIVATE_IP>:4222
```

Restart and verify:

```bash
cd /opt/coin_pusher
docker compose -f docker-compose.game.yml up -d
docker compose -f docker-compose.game.yml logs -f game
```

You should see `Connected to NATS at nats://<SERVICES_PRIVATE_IP>:4222`.

### Step 4: Configure Cloudflare DNS

1. **Add your domain to Cloudflare**:
   - Go to [Cloudflare Dashboard](https://dash.cloudflare.com/) > "Add a site"
   - Enter your domain, select Free plan
   - Cloudflare gives you two nameservers (e.g. `ada.ns.cloudflare.com`)

2. **Update nameservers at your registrar** (e.g. Namecheap):
   - Domain List > Manage > set nameservers to Custom DNS
   - Paste the two Cloudflare nameservers
   - Save. DNS propagation takes 5-30 minutes (up to 48h).

3. **Add DNS records in Cloudflare**:

   | Type | Name | Content | Proxy |
   |------|------|---------|-------|
   | A | `api` | `<SERVICES_PUBLIC_IP>` | Proxied (orange cloud) |

   The `api` record points your backend to the services droplet. Cloudflare handles SSL.

4. **Set SSL/TLS mode**:
   - Cloudflare Dashboard > SSL/TLS > set to **Full**
   - Enable "Always Use HTTPS"
   - For **Full (strict)**, replace `deploy/nginx/certs/origin.crt` and `origin.key` with a Cloudflare Origin Certificate pair.

5. **Verify**: After DNS propagates, `curl https://api.<your-domain>/debug/readiness` should return 200.

### Step 5: Set up Cloudflare Pages (frontend)

1. **Cloudflare Dashboard** > Pages > "Create a project" > Connect to Git
2. Select the `coin_pusher` repository
3. Configure build settings:

   | Setting | Value |
   |---------|-------|
   | Build command | `pnpm install && pnpm --filter @coin-pusher/shared build && pnpm --filter @coin-pusher/client build` |
   | Build output directory | `game/client/dist` |
   | Root directory | `/` |

4. **Add environment variable**:
   - `VITE_WS_URL` = `wss://api.<your-domain>/ws`

5. **Add custom domain** (Pages > your project > Custom domains):
   - Add `<your-domain>` and/or `www.<your-domain>`
   - Cloudflare Pages auto-creates CNAME records and provisions SSL

6. **Verify**: Visit `https://<your-domain>` — the game should load and connect via WebSocket.

### Step 6: Set up CI/CD (GitHub Actions)

Two separate workflows auto-deploy when you push changes to `main`:

- **`deploy-services.yml`** — triggers on `backend/**` or `game/shared/**` changes, deploys to services machine
- **`deploy-game.yml`** — triggers on `game/server/**` or `game/shared/**` changes, deploys to game machine

> **Note:** Changes to `game/shared/**` trigger both workflows, since shared types affect both sides.

Add these **secrets** in GitHub (repo > Settings > Secrets and variables > Actions):

| Secret | Value |
|--------|-------|
| `DEPLOY_SERVICES_HOST` | Services droplet's public IP |
| `DEPLOY_SERVICES_USER` | `deploy` |
| `DEPLOY_SERVICES_KEY` | SSH private key for `deploy` user on services machine |
| `DEPLOY_GAME_HOST` | Game droplet's public IP |
| `DEPLOY_GAME_USER` | `deploy` |
| `DEPLOY_GAME_KEY` | SSH private key for `deploy` user on game machine |

The services workflow runs migrations before restarting the backend. The game workflow respects the graceful drain (`stop_grace_period: 90s`) — Docker sends SIGTERM, the game server drains its coin queue and waits for physics to settle before exiting.

Frontend deploys are automatic — Cloudflare Pages rebuilds on every push to `main`.

> **Breaking NATS changes:** If a commit changes the NATS message format and affects both backend and game server, both workflows trigger simultaneously. For breaking protocol changes, deploy the **receiver side first** (the side that needs to understand the new format). Use `workflow_dispatch` to manually control deploy order if needed.

---

## Production Operations

### Services Machine

```bash
ssh deploy@<SERVICES_PUBLIC_IP>
cd /opt/coin_pusher

# View logs
docker compose -f docker-compose.services.yml logs -f
docker compose -f docker-compose.services.yml logs -f backend
docker compose -f docker-compose.services.yml logs -f indexer

# Restart services
docker compose -f docker-compose.services.yml restart backend

# Run DB migrations
docker compose -f docker-compose.services.yml run --rm backend /bin/admin migrate

# Check service health
docker compose -f docker-compose.services.yml ps
docker stats
curl https://api.<your-domain>/debug/readiness
```

### Game Machine

```bash
ssh deploy@<GAME_PUBLIC_IP>
cd /opt/coin_pusher

# View logs
docker compose -f docker-compose.game.yml logs -f game

# Restart (triggers graceful drain — waits up to 90s for coins to settle)
docker compose -f docker-compose.game.yml restart game

# Force restart (skips drain, coins in-flight may be lost)
docker compose -f docker-compose.game.yml kill game
docker compose -f docker-compose.game.yml up -d game
```

### Manual deploy (without CI/CD)

```bash
# Services machine
ssh deploy@<SERVICES_PUBLIC_IP>
cd /opt/coin_pusher
git pull origin main
docker compose -f docker-compose.services.yml run --rm backend /bin/admin migrate
docker compose -f docker-compose.services.yml build
docker compose -f docker-compose.services.yml up -d
docker image prune -f

# Game machine
ssh deploy@<GAME_PUBLIC_IP>
cd /opt/coin_pusher
git pull origin main
docker compose -f docker-compose.game.yml build
docker compose -f docker-compose.game.yml up -d
docker image prune -f
```

---

## Production Services

### Services Machine (`docker-compose.services.yml`)

| Service | Image | Exposed Port | Notes |
|---------|-------|-------------|-------|
| nginx | nginx:1.27-alpine | :80, :443 | Public entrypoint. Redirects HTTP→HTTPS, proxies `/ws` to backend. |
| nats | nats:2.10-alpine | :4222 (host) | Exposed to host for game machine access via VPC. |
| postgres | postgres:16-alpine | (internal) | Data persisted in `pgdata` Docker volume. |
| backend | Built from `backend/zarf/docker/Dockerfile.backend` | (internal :4000) | Go API + WebSocket gateway behind nginx. |
| executor | Built from `backend/zarf/docker/Dockerfile.backend` | (none) | On-chain withdrawal executor. |
| indexer | Built from `backend/zarf/docker/Dockerfile.backend` | (none) | On-chain deposit event listener. |

### Game Machine (`docker-compose.game.yml`)

| Service | Image | Exposed Port | Notes |
|---------|-------|-------------|-------|
| game | Built from `Dockerfile` | (none) | TS physics server. NATS worker, no HTTP port. `stop_grace_period: 90s` for graceful drain. |

### Environment Variables & Secrets

All Go backend env vars use the `BACKEND_` prefix (parsed by `conf` library). Docker compose maps `.env` values into container env vars.

#### Services Machine `.env` — Sensitive

> These values must be kept secret. Never commit to git.

| `.env` key | Container env var | Description |
|------------|-------------------|-------------|
| `DB_PASSWORD` | `BACKEND_DB_PASSWORD` | PostgreSQL password. Auto-generated by `setup.sh`. |
| `WALLET_SEED` | `BACKEND_WALLET_SEED` | **BIP-39 mnemonic** — derives ALL on-chain private keys: deposit addresses, hot wallet (index 999999) for withdrawals, and sweeper keys. This is the highest-sensitivity secret. |
| `GAME_API_KEY` | `BACKEND_GAME_API_KEY` | Shared secret between backend and game server. Prevents unauthorized game commands. |

#### Services Machine `.env` — Non-Sensitive

| `.env` key | Container env var | Default | Description |
|------------|-------------------|---------|-------------|
| `DB_USER` | `BACKEND_DB_USER` | `postgres` | PostgreSQL username. |
| `DB_NAME` | `BACKEND_DB_NAME` | `coinpusher` | PostgreSQL database name. |
| `CORS_ORIGINS` | `BACKEND_WEB_CORS_ORIGINS` | `*` | Allowed CORS origins, e.g. `https://<your-domain>`. |
| `EXECUTOR_RPC_URL` | `BACKEND_EXECUTOR_RPC_URL` | `https://mainnet.base.org` | Base chain RPC for withdrawal executor. Use a paid provider (Alchemy/QuickNode) in production. |
| `EXECUTOR_USDC_CONTRACT` | `BACKEND_EXECUTOR_USDC_CONTRACT` | `0x8335...2913` | USDC contract address on Base. |
| `INDEXER_RPC_URL` | `BACKEND_INDEXER_RPC_URL` | `https://mainnet.base.org` | Base chain RPC for deposit indexer. Can use a different provider than executor. |
| `INDEXER_USDC_CONTRACT` | `BACKEND_INDEXER_USDC_CONTRACT` | `0x8335...2913` | USDC contract address on Base. |
| `INDEXER_POLL_INTERVAL` | `BACKEND_INDEXER_POLL_INTERVAL` | `10s` | How often the indexer polls for new blocks. |

#### Services Machine — Sensitive Files (not in `.env`)

| File | Generated by | Description |
|------|-------------|-------------|
| `backend/zarf/keys/default.pem` | `setup.sh` | RSA private key for JWT signing. Never commit to git. |
| `deploy/nginx/certs/origin.key` | `setup.sh` (self-signed) or Cloudflare | Nginx TLS private key. Replace with Cloudflare Origin CA key for Full (strict) SSL. |
| `deploy/nginx/certs/origin.crt` | `setup.sh` (self-signed) or Cloudflare | Nginx TLS certificate. |

#### Game Machine `.env`

| `.env` key | Container env var | Description |
|------------|-------------------|-------------|
| `NATS_URL` | `NATS_URL` | NATS connection URL via VPC, e.g. `nats://10.x.x.x:4222`. Not sensitive (VPC-internal). |

#### GitHub Actions Secrets

| Secret | Sensitive? | Description |
|--------|-----------|-------------|
| `DEPLOY_SERVICES_HOST` | No | Services droplet public IP. |
| `DEPLOY_SERVICES_USER` | No | `deploy`. |
| `DEPLOY_SERVICES_KEY` | **Yes** | SSH private key for services machine. |
| `DEPLOY_GAME_HOST` | No | Game droplet public IP. |
| `DEPLOY_GAME_USER` | No | `deploy`. |
| `DEPLOY_GAME_KEY` | **Yes** | SSH private key for game machine. |

#### Cloudflare Pages (Frontend)

| Env var | Sensitive? | Description |
|---------|-----------|-------------|
| `VITE_WS_URL` | No | WebSocket endpoint, e.g. `wss://api.<your-domain>/ws`. |
| `VITE_API_URL` | No | API endpoint, e.g. `https://api.<your-domain>`. |

#### How `WALLET_SEED` derives keys

The single mnemonic derives all on-chain keys via BIP-32/BIP-44 (`m/44'/60'/0'/0/<index>`):

| Derived key | Index | Purpose |
|-------------|-------|---------|
| Deposit addresses | 0, 1, 2, ... | Each user gets a unique deposit address. Indexer watches for incoming USDC transfers. |
| Hot wallet | 999999 | Executor signs withdrawal transactions and sweep gas-funding transactions from this key. |
| Sweeper (per-address) | Same as deposit index | Executor uses each deposit address's key to sign the USDC sweep back to hot wallet. |

> **If `WALLET_SEED` is compromised, all deposit funds and the hot wallet are at risk.** Keep it in `.env` with `chmod 600`, never in git or logs.

---

## Graceful Drain (Game Server)

When the game server receives SIGTERM (e.g. during `docker compose up -d` with a new image):

1. **Unsubscribe** from all NATS command subscriptions (stop accepting new coin inserts and abilities)
2. **Cancel** active abilities (tornado, lightning) so coins can settle
3. **Continue ticking** the game loop — DropScheduler drains its pending queue, physics resolves remaining coins
4. **Wait** until all coins have despawned/settled, or **60s timeout**
5. **Stop** the game loop and close the NATS connection
6. **Exit** with code 0

Docker's `stop_grace_period: 90s` gives 90 seconds before SIGKILL, allowing the 60s drain + buffer.
