---
title: "fix: NATS reconnection failure and public port exposure"
type: fix
status: active
date: 2026-03-28
---

# fix: NATS reconnection failure and public port exposure

## Overview

Game server NATS connection drops and never recovers, killing all real-time game state for clients. Simultaneously, NATS port 4222 is exposed to the public internet, attracting scanner garbage that may trigger disconnects.

## Problem Statement

**Incident (2026-03-28):** Client-side game state froze. Investigation found:

1. **Game server (167.99.64.157)** NATS client disconnected and never reconnected. 30,373+ `CONNECTION_CLOSED` errors in the last hour alone. Physics engine still running, but all `state_delta` and `slot_status` publishes fail silently (caught, logged, dropped).

2. **Root cause:** nats.js default `maxReconnectAttempts = 10` with 2s wait = 20 seconds of retries, then permanent death. The Go backend configures 60 retries (120s). The TypeScript game server passes zero reconnection options.

3. **Contributing factor:** NATS port 4222 bound to `0.0.0.0` in `docker-compose.services.yml`, exposing it to the public internet. Scanner traffic at 09:27 UTC sent MQTT, SMB, Redis, TLS, SIP, and other garbage protocols to NATS. While NATS handles these gracefully (parser error + disconnect), the volume of junk connections on a 1.9GB RAM droplet adds unnecessary load and risk.

## Proposed Solution

Two changes, independent of each other:

### Fix 1: NATS reconnection in game server

**File:** `game/server/src/nats/NATSClient.ts` line 106

Change:
```typescript
this.nc = await connect({ servers: url });
```

To:
```typescript
this.nc = await connect({
  servers: url,
  maxReconnectAttempts: -1,    // infinite retries
  reconnectTimeWait: 2_000,    // 2s between attempts
  waitOnFirstConnect: true,    // block until first connect succeeds
});
```

`maxReconnectAttempts: -1` means infinite. This matches the game server's role: it should never stop trying to reach NATS. The physics loop runs regardless, and state delivery should resume the moment NATS is back.

The `monitorConnection()` method already logs reconnect/disconnect events. No changes needed there.

### Fix 2: Bind NATS to VPC interface only

**File:** `docker-compose.services.yml` line 10-11

Change:
```yaml
ports:
  - "4222:4222"
```

To:
```yaml
ports:
  - "10.104.0.3:4222:4222"
```

This binds NATS to the DigitalOcean VPC private IP only. The game server already connects via `nats://10.104.0.3:4222` (confirmed in game server's `.env`). Backend connects internally via `nats://nats:4222` (Docker network). Neither path is affected.

PostgreSQL already uses this pattern: `127.0.0.1:5432:5432` (line 18).

**Note:** The VPC IP `10.104.0.3` is hardcoded. If the droplet is destroyed and recreated, the VPC IP may change. This is acceptable for now since it's a single-droplet setup. If it becomes a problem, use an env var: `${VPC_IP:-10.104.0.3}:4222:4222`.

## Technical Considerations

- **Zero downtime for Fix 1:** Code change only affects game server. Deploy via `git pull` + `docker compose build + up` on game machine. NATS connection re-establishes on container restart.
- **Brief NATS interruption for Fix 2:** Changing the port binding requires restarting the NATS container on the services machine. Backend will reconnect (60 retries configured). Game server will reconnect (after Fix 1 is deployed first).
- **Deploy order matters:** Deploy Fix 1 (game server) FIRST, then Fix 2 (services). If Fix 2 goes first, the game server restart during Fix 2's NATS downtime would hit the old 10-retry limit.

## Acceptance Criteria

- [ ] Game server NATS client retries indefinitely on disconnect
- [ ] `maxReconnectAttempts: -1` set in connect options
- [ ] NATS port 4222 only listens on VPC IP (10.104.0.3), not 0.0.0.0
- [ ] After deploy, `ss -tlnp | grep 4222` on backend machine shows `10.104.0.3:4222`, not `0.0.0.0:4222`
- [ ] Game server reconnects to NATS after deploy and state flows to clients

## Deploy Steps

### 1. Fix code locally, push to GitHub

```bash
# Edit NATSClient.ts and docker-compose.services.yml
git add game/server/src/nats/NATSClient.ts docker-compose.services.yml
git commit -m "fix: NATS infinite reconnect + bind to VPC only"
git push origin main
```

### 2. Deploy game server FIRST (Fix 1)

```bash
ssh root@167.99.64.157
cd /opt/coin_pusher
git pull origin main
docker compose -f docker-compose.game.yml build game
docker compose -f docker-compose.game.yml up -d game
docker logs -f coin_pusher-game-1  # verify NATS connected
```

### 3. Deploy services (Fix 2)

```bash
ssh root@146.190.104.138
cd /opt/coin_pusher
git pull origin main
docker compose -f docker-compose.services.yml up -d nats
# NATS restarts, game server reconnects (now with infinite retries)
ss -tlnp | grep 4222  # verify bound to 10.104.0.3 only
```

### 4. Verify

- Client loads game, sees real-time coin movement
- `docker logs coin_pusher-game-1 --tail 20` shows no CONNECTION_CLOSED errors
- `ss -tlnp | grep 4222` shows `10.104.0.3:4222` not `0.0.0.0:4222`

## Files Changed

| File | Change |
|------|--------|
| `game/server/src/nats/NATSClient.ts:106` | Add reconnect options to `connect()` |
| `docker-compose.services.yml:11` | Bind NATS port to VPC IP only |
