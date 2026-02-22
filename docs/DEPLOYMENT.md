# Deployment Guide

## Architecture Overview

```
Cloudflare Pages                        DigitalOcean Droplet
(static client)                         (docker compose)
                                        +--------------------+
Browser ---HTTPS/WSS---> Cloudflare --> | Nginx :80/:443     |
                          DNS proxy     |   |                |
                                        |   v                |
                                        | Go Backend :4000   |
                                        |   | NATS           |
                                        |   v                |
                                        | TS Game Server     |
                                        | PostgreSQL         |
                                        +--------------------+
```

| Component | Hosting | Cost |
|-----------|---------|------|
| Frontend (client) | Cloudflare Pages | Free |
| Backend (Go + TS game + NATS + Postgres) | DigitalOcean Droplet | ~$12/mo |
| DNS + SSL + CDN | Cloudflare (free plan) | Free |
| Domain | Namecheap (or any registrar) | ~$10/yr |

Cloudflare proxies both HTTPS and WSS. An Nginx container listens on ports 80/443, redirects HTTP to HTTPS, and proxies `/` and `/ws` to the Go backend.

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

### Step 1: Create a DigitalOcean Droplet

1. Create a droplet on [DigitalOcean](https://cloud.digitalocean.com/):
   - **Image**: Ubuntu 22.04 LTS
   - **Plan**: Basic $12/mo (2 GB RAM, 1 vCPU) — sufficient for MVP
   - **Region**: Choose closest to your users
   - **Authentication**: SSH key (you'll need this key later for GitHub Actions)

2. Note the droplet's **public IP address**.

### Step 2: Run the setup script

SSH into the droplet as root and run:

```bash
ssh root@<DROPLET_IP>

# Download and run setup script (or clone repo first)
git clone https://github.com/flamefalcon/coin_pusher.git /opt/coin_pusher
cd /opt/coin_pusher
chmod +x deploy/setup.sh
./deploy/setup.sh
```

The script does the following automatically:
1. Installs Docker + Docker Compose
2. Creates a `deploy` user with Docker access (copies your SSH key)
3. Clones the repo to `/opt/coin_pusher`
4. Creates `.env` from `.env.example` with a random DB password
5. Generates an RSA key for JWT signing (`backend/zarf/keys/default.pem`)
6. Generates TLS cert files for Nginx at `deploy/nginx/certs/`
7. Starts all services via `docker-compose.prod.yml`
8. Runs database migrations
9. Configures UFW firewall (allows ports 22, 80, and 443)

Verify services are running:

```bash
docker compose -f docker-compose.prod.yml ps
```

You should see 5 services: `nginx`, `nats`, `postgres`, `backend`, `game`.

### Step 3: Configure Cloudflare DNS

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
   | A | `api` | `<DROPLET_IP>` | Proxied (orange cloud) |

   The `api` record points your backend to the droplet. Cloudflare handles SSL.

4. **Set SSL/TLS mode**:
   - Cloudflare Dashboard > SSL/TLS > set to **Full**
   - Enable "Always Use HTTPS"
   - For **Full (strict)**, replace `deploy/nginx/certs/origin.crt` and `origin.key` with a Cloudflare Origin Certificate pair.

5. **Verify**: After DNS propagates, `curl https://api.<your-domain>/debug/readiness` should return 200.

### Step 4: Set up Cloudflare Pages (frontend)

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

### Step 5: Set up CI/CD (GitHub Actions)

The workflow at `.github/workflows/deploy-docker.yml` auto-deploys when you push changes to `main` (backend, game server, or Docker configs).

Add these **secrets** in GitHub (repo > Settings > Secrets and variables > Actions):

| Secret | Value |
|--------|-------|
| `DEPLOY_HOST` | Your droplet's IP address |
| `DEPLOY_USER` | `deploy` |
| `DEPLOY_KEY` | The private SSH key for the `deploy` user |

The workflow SSHs into the server, pulls latest code, rebuilds Docker images, and restarts services.

Frontend deploys are automatic — Cloudflare Pages rebuilds on every push to `main`.

---

## Production Operations

### View logs

```bash
ssh deploy@<DROPLET_IP>
cd /opt/coin_pusher

# All services
docker compose -f docker-compose.prod.yml logs -f

# Single service
docker compose -f docker-compose.prod.yml logs -f backend
docker compose -f docker-compose.prod.yml logs -f game
```

### Restart services

```bash
docker compose -f docker-compose.prod.yml restart backend game
```

### Manual deploy (without CI/CD)

```bash
ssh deploy@<DROPLET_IP>
cd /opt/coin_pusher
git pull origin main
docker compose -f docker-compose.prod.yml build --no-cache backend game
docker compose -f docker-compose.prod.yml up -d
docker image prune -f
```

### Run DB migrations

```bash
docker compose -f docker-compose.prod.yml exec backend /bin/admin migrate
```

### Check service health

```bash
# Service status
docker compose -f docker-compose.prod.yml ps

# Resource usage
docker stats

# Test API
curl https://api.<your-domain>/debug/readiness
```

---

## Production Services

`docker-compose.prod.yml` runs 5 containers on a shared `app` network:

| Service | Image | Exposed Port | Notes |
|---------|-------|-------------|-------|
| nginx | nginx:1.27-alpine | :80, :443 | Public entrypoint. Redirects HTTP to HTTPS and proxies WebSocket `/ws` to backend. |
| nats | nats:2.10-alpine | (internal) | Message queue between backend and game server |
| postgres | postgres:16-alpine | (internal) | Data persisted in `pgdata` Docker volume |
| backend | Built from `backend/zarf/docker/Dockerfile.backend` | (internal :4000) | Go API + WebSocket gateway behind nginx. |
| game | Built from `Dockerfile` | (none) | TS physics server. NATS worker, no HTTP port. |

Environment variables are read from `.env` (created by `deploy/setup.sh`):

```
DB_USER=postgres
DB_PASSWORD=<auto-generated>
DB_NAME=coinpusher
```

The JWT signing key lives at `backend/zarf/keys/default.pem` (generated by `deploy/setup.sh`, not checked into git).
