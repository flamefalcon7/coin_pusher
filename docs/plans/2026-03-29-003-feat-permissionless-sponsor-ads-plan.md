---
title: "feat: Permissionless Sponsor Ads"
type: feat
status: active
date: 2026-03-29
origin: docs/brainstorms/2026-03-29-permissionless-sponsor-ads-requirements.md
---

# feat: Permissionless Sponsor Ads

## Enhancement Summary

**Deepened on:** 2026-03-29
**Sections enhanced:** 8
**Research agents used:** Architecture Strategist, Security Sentinel, Performance Oracle, Data Integrity Guardian, Best Practices Researcher, Context7 BabylonJS docs

### Key Improvements
1. **Quota reconciliation protocol** — track issued quotas in DB with ACK from game server to prevent silent token loss on crashes (flagged by architecture, security, and data integrity reviews)
2. **NATS JetStream for economic messages** — use durable consumers with explicit ACK for quota/config/reward messages; keep core NATS for physics only
3. **Authentication + input validation** — all sponsor endpoints require JWT auth; image uploads validated by magic bytes and re-encoded via govips
4. **Deterministic ref_key** — derive idempotency keys from event data (`sponsor:{campaign_id}:{account_id}:{flush_epoch}`), not random UUIDs
5. **WorldSnapshot sponsor_id** — persist sponsor coin mapping in protobuf BodyState so it survives game server restarts

### New Considerations Discovered
- 7-8 thin-instance draw calls is fine for mobile (no texture atlas needed) — BabylonJS forum confirms negligible overhead at this scale
- DynamicTexture must be created AFTER image loads (timing issue with ShaderMaterial compilation)
- Bonus drops should be staggered (1 coin per 100ms) not burst-spawned to avoid frame spikes
- Platform ad plane is nearly invisible on mobile at 6.5m camera distance — consider skipping on mobile
- Bonus drop intervals should be randomized (3-7 min) to prevent timing-based farming

## Overview

Add a permissionless sponsorship system where any token with liquidity on a supported chain can sponsor the coin pusher game. Sponsors deposit tokens into a reward pool, upload ad creatives, and receive in-game exposure through branded coins, bonus drop events, and 3D ad placements. Players earn sponsor tokens by pushing sponsor coins off the front edge, distributed via the existing heat-based system.

(see origin: `docs/brainstorms/2026-03-29-permissionless-sponsor-ads-requirements.md`)

## Problem Statement

Traditional ad platforms (Google Ad Manager, AdinPlay) reject Web3/gambling-adjacent content, offer poor fill rates, and inject low-quality ads that break the toon-shaded aesthetic. A custom permissionless sponsorship protocol aligns sponsor incentives (token distribution) with player incentives (earning diverse rewards), making ads part of the game economy rather than an overlay.

## Proposed Solution

Four-phase implementation:

1. **Backend sponsor domain** — DB schema, CRUD API, image storage
2. **Protocol & game server** — sponsor coin spawning, tracking, despawn events, bonus drops
3. **Client rendering** — sponsor coin meshes, 3D ad placements, bonus drop UI/VFX
4. **Integration** — end-to-end sponsor config propagation, dynamic updates

## Technical Approach

### Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                      Go Backend                             │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────┐  │
│  │ Sponsor Core  │  │ Sponsor API  │  │ Image Storage    │  │
│  │ (CRUD, pool)  │  │ (HTTP)       │  │ (local/S3)       │  │
│  └──────┬───────┘  └──────────────┘  └──────────────────┘  │
│         │                                                    │
│  ┌──────▼───────────────────────────────────────────────┐   │
│  │ Sponsor Config Publisher (NATS)                       │   │
│  │ game.{room}.sponsor_config                            │   │
│  └──────┬───────────────────────────────────────────────┘   │
│         │                                                    │
│  ┌──────▼───────────────────────────────────────────────┐   │
│  │ Reward Handler (extends despawn subscription)         │   │
│  │ - Regular coins → heat → PLAY balance                 │   │
│  │ - Sponsor coins → heat → sponsor_balances table       │   │
│  └──────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────┘
         │ NATS                              │ NATS
         ▼                                   ▼
┌─────────────────────┐           ┌──────────────────────┐
│    Game Server       │           │    WS Relay → Client │
│  ┌────────────────┐  │           │                      │
│  │ SponsorManager │  │           │  sponsor_config msg  │
│  │ - active list   │  │           │  bonus_drop msg      │
│  │ - coin→sponsor  │  │           │  reward_notify msg   │
│  │ - injection %   │  │           │  (incl sponsor tok)  │
│  │ - bonus sched   │  │           └──────────────────────┘
│  └────────────────┘  │
│  ┌────────────────┐  │
│  │ DropScheduler   │  │
│  │ (extended)      │  │
│  └────────────────┘  │
└─────────────────────┘
```

### Key Design Decisions

**Pool decrement at spawn time, not despawn (backend-driven quota with reconciliation).**
The Go backend owns pool state and pushes coin quotas to the game server via NATS JetStream (durable consumer, explicit ACK). Flow: backend periodically evaluates active sponsors → decrements `pool_remaining` atomically for a batch (e.g., 5 coins × `reward_per_coin`) → records quota in `sponsor_quota_ledger` table with status `issued` → publishes `sponsor_coin_quota` message with `quota_id` → game server receives, spawns coins, publishes `sponsor_quota_consumed { quota_id, coins_spawned }` → backend marks quota as `consumed` and refunds any unspawned difference. A reconciliation goroutine on startup reclaims any `issued` quotas older than 5 minutes. Batch size kept small (5, not 20) to minimize liability window. (Resolves SpecFlow Q1/Q6)

> **Research insight (Architecture + Data Integrity):** Without quota tracking, game server crashes silently lose pool-decremented tokens. The original batch size of 20 with 30s intervals meant up to 100s of pre-committed but unspawned coins. Smaller batches + ACK protocol eliminates this.

**Sponsor token balances: new `sponsor_balances` table, v1 display-only.**
The existing three-currency model (`USDC`/`PLAY`/`CASH`) won't accommodate arbitrary tokens. A new `sponsor_balances` table tracks per-user per-sponsor-token earnings. For v1, balances are display-only in the UI. On-chain withdrawal is v2. (Resolves SpecFlow Q2)

**Sponsor coin injection: backend-driven, game server executes.**
The Go backend decides when and how many sponsor coins to inject. It publishes `sponsor_coin_quota` messages via NATS with a batch of coins to spawn per sponsor. The game server's `SponsorManager` receives these quotas and drains them by spawning ~1 sponsor coin per 5 seconds per active sponsor (round-robin) into random slot positions at normal drop height. This is separate from bonus drops. The game server has no opinion on *whether* to spawn — it only executes what the backend authorizes. (Resolves SpecFlow Q3)

**Image delivery: CDN URL in config message, client HTTP fetch.**
Sponsor images are uploaded to the backend, stored on disk or S3, served via HTTP URL. The `sponsor_config` WebSocket message contains only URLs. The client fetches images via `Image()` constructor and creates `DynamicTexture` from them. No binary data over WebSocket. (Resolves SpecFlow Q5)

**Side-wall sponsor coins: trigger slot/wheel normally, no sponsor token reward.**
Sponsor coins that exit through side walls increment the slot machine / jackpot wheel counters just like regular coins. Sponsor token reward is only for front-edge despawns. (Resolves SpecFlow Q7)

**Sponsor coins have no `owner_id` for heat attribution.**
System-injected sponsor coins carry `owner_id = "system"` (or empty). The heat share calculation still works — the front-edge drop reward amount per player is determined by heat share percentages, which are independent of who "owns" the falling coin. (Resolves SpecFlow gap 11)

**Bonus drops respect `MAX_ACTIVE_COINS` (800).**
Bonus drop volume is capped at `MAX_ACTIVE_COINS - currentCoinCount`. If the platform is near capacity, the bonus drop spawns fewer coins. (Resolves SpecFlow gap 9)

**Sponsor creative is locked at deposit time.**
Brand color, logo, and ad images cannot change while the sponsorship is active. To update creatives, sponsor must create a new campaign. This avoids runtime texture regeneration. (Resolves SpecFlow gap 10)

**Use NATS JetStream for economic messages, core NATS for physics.**
Quota pushes, config updates, and reward notifications use JetStream with durable pull consumers and explicit ACK — these messages must not be lost. State deltas (15Hz) and despawn broadcasts stay on core NATS (at-most-once is acceptable for physics). Add `foundation/nats/jetstream.go` with `ConnectWithJetStream()`.

> **Research insight (Best Practices):** Core NATS is at-most-once delivery. If the game server restarts during a quota publish, that message is permanently lost. JetStream with `WorkQueuePolicy` retention, `MaxDeliver: 5`, and `AckWait: 30s` provides at-least-once with automatic retry. Minimal migration from existing `foundation/nats/nats.go`.

**Keep protobuf Despawn as-is (just IDs). Add sponsor_id only to JSON coin_despawn event.**
The client-facing protobuf `Despawn` message stays as `repeated uint32 ids` — the client already knows which buffer a coin belongs to from spawn time. The `sponsor_id` is added only to the JSON `coin_despawn` event consumed by the backend for reward routing. Do NOT create a `CoinDespawnEntry` protobuf message.

> **Research insight (Architecture):** The existing despawn protobuf at `game.proto:38-41` is just a list of IDs. There is no structured `CoinDespawnEntry`. The plan originally conflated the two despawn paths (client rendering vs backend reward routing). Keeping them separate avoids unnecessary protobuf schema changes.

**Drop protobuf BonusDrop. Use msgpack only.**
Bonus drops are low-frequency (every 3-7 minutes). No need for protobuf. The announcement goes via msgpack `BonusDropMessage`, and the actual coins arrive via the existing `CoinSpawn` protobuf stream (which carries `sponsor_id`).

**Persist sponsor_id in WorldSnapshot BodyState protobuf.**
Add `string sponsor_id = 11` to `BodyState` message. On game server restart or client reconnect, sponsor coin mappings survive via the existing snapshot mechanism. Without this, all sponsor coins on the platform would be treated as regular coins after restart — violating pool accounting.

> **Research insight (Architecture + Data Integrity):** The `coinSponsorMap` is in-memory only. Pool was already decremented for those coins. If they revert to regular coins, the sponsor loses tokens and players get PLAY instead. Encoding sponsor_id in BodyState is the cheapest fix — it flows through the existing snapshot pipeline.

**Randomize bonus drop intervals (3-7 minutes).**
Fixed intervals are predictable and gameable — a player can time heat buildup to maximize sponsor token farming at minimal PLAY cost. Uniform random distribution within 3-7 minutes per sponsor prevents this.

> **Research insight (Security):** Fixed 5-minute intervals let players calculate exact drop times and spike heat share just before each drop. Different asset types (PLAY cost vs sponsor token reward) make this arbitrage profitable.

### Data Model

```sql
-- Sponsor campaigns
CREATE TABLE sponsor_campaigns (
    campaign_id    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    created_by     UUID NOT NULL REFERENCES accounts(account_id),  -- who created this campaign
    chain          TEXT NOT NULL,                    -- e.g. "sui", "solana"
    token_address  TEXT NOT NULL,                    -- on-chain contract address
    token_symbol   TEXT NOT NULL CHECK (token_symbol ~ '^[A-Z0-9]{1,10}$'),  -- uppercase alphanumeric, max 10
    token_decimals INT NOT NULL CHECK (token_decimals BETWEEN 0 AND 18),
    brand_color    TEXT NOT NULL CHECK (brand_color ~ '^#[0-9A-Fa-f]{6}$'),  -- hex color
    brand_name     TEXT NOT NULL CHECK (length(brand_name) BETWEEN 1 AND 32),
    logo_url       TEXT NOT NULL,                    -- server-generated path (never user input)
    ad_image_url   TEXT NOT NULL,                    -- server-generated path
    pool_total     NUMERIC(38,18) NOT NULL CHECK (pool_total > 0),
    pool_remaining NUMERIC(38,18) NOT NULL CHECK (pool_remaining >= 0),
    reward_per_coin NUMERIC(38,18) NOT NULL CHECK (reward_per_coin > 0),
    status         TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'depleted', 'paused', 'expired')),
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT min_campaign_coins CHECK (pool_total / reward_per_coin >= 100)  -- at least 100 coins worth
);

CREATE INDEX idx_sponsor_campaigns_status ON sponsor_campaigns(status);
CREATE UNIQUE INDEX idx_sponsor_campaigns_token ON sponsor_campaigns(chain, token_address) WHERE status = 'active';

-- Quota tracking for reconciliation
CREATE TABLE sponsor_quota_ledger (
    quota_id       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    campaign_id    UUID NOT NULL REFERENCES sponsor_campaigns(campaign_id),
    coin_count     INT NOT NULL CHECK (coin_count > 0),
    coins_spawned  INT NOT NULL DEFAULT 0,
    token_amount   NUMERIC(38,18) NOT NULL,         -- total token value reserved
    status         TEXT NOT NULL DEFAULT 'issued' CHECK (status IN ('issued', 'consumed', 'refunded')),
    issued_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    consumed_at    TIMESTAMPTZ
);

CREATE INDEX idx_sponsor_quota_ledger_status ON sponsor_quota_ledger(status, issued_at);

-- Player sponsor token balances (v1: display-only, v2: withdrawable)
CREATE TABLE sponsor_balances (
    account_id    UUID NOT NULL REFERENCES accounts(account_id),
    campaign_id   UUID NOT NULL REFERENCES sponsor_campaigns(campaign_id),
    balance       NUMERIC(38,18) NOT NULL DEFAULT 0 CHECK (balance >= 0),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (account_id, campaign_id)
);

-- Sponsor reward ledger (audit trail)
CREATE TABLE sponsor_reward_logs (
    log_id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id    UUID NOT NULL REFERENCES accounts(account_id),
    campaign_id   UUID NOT NULL REFERENCES sponsor_campaigns(campaign_id),
    amount        NUMERIC(38,18) NOT NULL CHECK (amount > 0),
    ref_key       TEXT NOT NULL UNIQUE,             -- deterministic: sponsor:{campaign_id}:{account_id}:{flush_epoch}
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_sponsor_reward_logs_account ON sponsor_reward_logs(account_id, campaign_id, created_at DESC);
```

> **Research insights (Data Integrity + Security):**
> - Added `created_by` field — without it, no authorization check for who can pause/modify a campaign
> - Added CHECK constraints on `status`, `balance`, `amount`, `brand_color`, `token_symbol`, `brand_name` — prevents silent data corruption and XSS vectors
> - Added `sponsor_quota_ledger` table for quota reconciliation — tracks issued/consumed/refunded quotas
> - Added unique partial index on `(chain, token_address)` for active campaigns — prevents duplicate active campaigns for the same token
> - Added composite index on `sponsor_reward_logs(account_id, campaign_id)` — prevents full table scans on balance queries
> - `ref_key` must be deterministic (`sponsor:{campaign_id}:{account_id}:{flush_epoch}`), not random UUID — random UUIDs provide zero idempotency protection on retry
> - `min_campaign_coins` CHECK ensures at least 100 coins worth of pool — prevents trivial/spam campaigns

### Protocol Changes

**Protobuf additions** (`game/shared/proto/game.proto`):

```protobuf
// Extend CoinSpawnEntry
message CoinSpawnEntry {
  uint32 id = 1;
  float x = 2;
  float y = 3;
  float z = 4;
  bool is_key_coin = 5;
  string sponsor_id = 6;  // NEW: empty = regular coin, non-empty = sponsor campaign ID
}

// Extend BodyState in WorldSnapshot (for restart/reconnect recovery)
message BodyState {
  // ... existing fields ...
  string sponsor_id = 11;  // NEW: persists sponsor mapping across snapshots
}

// NOTE: Despawn protobuf stays as-is (repeated uint32 ids).
// sponsor_id is added only to the JSON coin_despawn event for backend reward routing.
// NOTE: No protobuf BonusDrop message. Use msgpack only (low-frequency event).
```

**New msgpack messages** (lower frequency, via JSON-over-NATS):

```typescript
// Server → Client: Active sponsor config (sent on connect + on change)
type SponsorConfigMessage = {
  op: "sponsor_config";
  sponsors: Array<{
    id: string;
    brand_name: string;
    token_symbol: string;
    brand_color: string;       // hex
    logo_url: string;          // HTTP URL for coin texture
    ad_image_url: string;      // HTTP URL for wall/surface placement
    placement_tier: "primary" | "secondary" | "tertiary";
  }>;
};

// Server → Client: Sponsor balance update
type SponsorRewardMessage = {
  op: "sponsor_reward";
  campaign_id: string;
  token_symbol: string;
  amount: string;              // decimal string
  total_balance: string;       // cumulative
};

// Server → Client: Bonus drop (also in protobuf for timing)
type BonusDropMessage = {
  op: "bonus_drop";
  sponsor_id: string;
  sponsor_name: string;
  token_symbol: string;
  coin_count: number;
};
```

### Implementation Phases

#### Phase 1: Backend Sponsor Domain

**Goal:** Database schema, Go domain core, CRUD API, image upload.

**Tasks:**
- [ ] Add `sponsor_campaigns`, `sponsor_balances`, `sponsor_reward_logs` tables to `schema.sql`
- [ ] Create `business/core/sponsor/` domain:
  - `model.go` — Campaign, SponsorBalance, RewardLog structs
  - `sponsor.go` — Core business logic (Create, Get, List, UpdatePool, Deplete)
  - `storer.go` — Storage interface
  - `stores/sponsordb/sponsordb.go` — PostgreSQL implementation
- [ ] Create `app/services/api/handlers/v1/sponsorgrp/sponsorgrp.go`:
  - `POST /v1/sponsor/campaign` — create campaign (deposit + creative upload)
  - `GET /v1/sponsor/campaigns` — list active campaigns
  - `GET /v1/sponsor/campaign/:id` — get campaign details
  - `POST /v1/sponsor/campaign/:id/upload` — upload logo + ad image (multipart form)
  - `GET /v1/sponsor/balances` — get player's sponsor token balances (JWT-protected)
- [ ] Image upload handler with security hardening:
  - `http.MaxBytesReader(w, r.Body, 512KB)` — limit before parsing
  - Magic byte validation: PNG (`89 50 4E 47`), JPEG (`FF D8 FF`) via `http.DetectContentType`
  - Re-encode through govips (resize to target dimensions, strip ALL metadata, export as JPEG/PNG) — neutralizes polyglot attacks
  - Server-generated filenames (UUID, never user input) — prevents path traversal
  - Serve with `Content-Type: image/jpeg`, `X-Content-Type-Options: nosniff`, `Content-Disposition: inline`
  - Store to `./uploads/sponsors/{campaign_id}/{uuid}.jpg`
- [ ] Input validation on all campaign fields:
  - `brand_name`: alphanumeric + spaces, max 32 chars (DB CHECK enforces)
  - `token_symbol`: uppercase alphanumeric, max 10 chars (DB CHECK enforces)
  - `brand_color`: regex `^#[0-9A-Fa-f]{6}$` (DB CHECK enforces)
  - `reward_per_coin > 0`, `pool_total / reward_per_coin >= 100`
  - `campaign_id` URL param validated as UUID before use in file paths
- [ ] All sponsor endpoints require JWT auth (`mid.Authenticate`). Rate limit: max 5 campaigns per account per day, max 10 uploads per hour
- [ ] Register routes in `main.go` `buildAPIMux`
- [ ] Add `libvips-dev` to Dockerfile for image processing

> **Research insight (Security):** The plan originally had no auth on sponsor endpoints and no image validation beyond extension checking. An unauthenticated upload endpoint is an open file hosting service. Extension/Content-Type header checks are trivially bypassable — magic byte validation + re-encoding is required to neutralize polyglot files. govips is the recommended Go library for this (fast, strips metadata, active maintenance).

**Key files:**
- `backend/zarf/docker/database/schema.sql`
- `backend/business/core/sponsor/` (new)
- `backend/app/services/api/handlers/v1/sponsorgrp/` (new)
- `backend/app/services/api/main.go` (route registration)
- `zarf/docker/Dockerfile` (add libvips-dev)

#### Phase 2: Protocol & Game Server

**Goal:** Sponsor coin spawning, tracking, despawn classification, bonus drop scheduling, NATS integration.

**Tasks:**
- [ ] **Shared types** (`game/shared/src/types.ts`):
  - Add `"sponsor_coin"` to `BodyType` union
  - Add `SPONSOR_COIN_CONFIG` (reuse `COIN_CONFIG` dimensions)
  - Add `sponsor_id` field to `CoinSpawnEntry` and despawn types
  - Add `SponsorConfigMessage`, `BonusDropMessage`, `SponsorRewardMessage` to `ServerMessage` union
- [ ] **Protobuf** (`game/shared/proto/game.proto`):
  - Add `string sponsor_id = 6` to `CoinSpawnEntry`
  - Add `string sponsor_id` to `CoinDespawnEntry`
  - Add `BonusDrop` message, add to `GameMessage` oneof
- [ ] **Game server — SponsorManager** (`game/server/src/game/SponsorManager.ts`, new):
  - Subscribes to `game.{room}.sponsor_config` NATS topic for active sponsor list
  - Maintains `activeSponsors: Map<string, SponsorConfig>` cache
  - `coinSponsorMap: Map<number, string>` — tracks coinId → campaignId
  - `pendingQuotas: Map<string, { quotaId: string, remaining: number, total: number }>` — received from backend via JetStream
  - Subscribes to `game.{room}.cmd.sponsor_quota` (JetStream, explicit ACK) — receives `{ quota_id, sponsor_id, coin_count }`, adds to `pendingQuotas`
  - `tick()`: drains `pendingQuotas` by spawning ~1 coin per 5s per sponsor (round-robin). When a quota is fully drained, publishes `sponsor_quota_consumed { quota_id, coins_spawned }` to NATS
  - `scheduleBonusDrop(sponsorId, count)`: receives bonus drop command from backend, spawns coins **staggered** at ~1 per 100ms (not burst), publishes `bonus_drop` msgpack event for client announcement
  - On `coinSponsorMap` changes: persist sponsor_id into `GameState.bodies` so it flows through `WorldSnapshot` BodyState protobuf
  - `onCoinDespawn(coinId)`: returns sponsorId or null
  - `getActiveSponsorConfig()`: returns current config for client sync
- [ ] **GameLoop integration** (`game/server/src/game/GameLoop.ts`):
  - Call `sponsorManager.tick()` in game loop
  - On despawn: check `sponsorManager.onCoinDespawn(id)` to tag sponsor coins in despawn NATS event
  - Include `sponsor_id` in `coin_despawn` NATS publish
- [ ] **CoinManager** (`game/server/src/game/CoinManager.ts`):
  - `spawnSponsorCoin(sponsorId, slotX)` — creates coin with `bodyType: "sponsor_coin"`, registers in `SponsorManager.coinSponsorMap`
- [ ] **Backend — Despawn handler** (`backend/app/services/api/main.go`):
  - Extend despawn subscription to check `sponsor_id` field
  - If sponsor coin + front edge: call `sponsorCore.DistributeReward(campaignId, heatShares)` instead of regular reward path
  - Accumulate sponsor rewards in separate `sponsorRewardAccum` map (10s flush to `sponsor_balances` + `sponsor_reward_logs`)
  - Notify players via `sponsor_reward` message
- [ ] **Backend — Sponsor quota publisher** (extract to `business/core/sponsor/publisher.go`, not inline in main.go):
  - Accepts `sponsor.Core` + JetStream connection, exposes `Start(ctx)` and `Stop()`
  - Periodic ticker (every 30s): for each active sponsor, calculate partial batch `min(5, pool_remaining / reward_per_coin)`
  - Atomic SQL: `UPDATE sponsor_campaigns SET pool_remaining = pool_remaining - $1, status = CASE WHEN pool_remaining - $1 <= 0 THEN 'depleted' ELSE status END WHERE campaign_id = $2 AND pool_remaining >= $1 RETURNING pool_remaining`
  - Record quota in `sponsor_quota_ledger` with status `issued`
  - Publish via JetStream: `sponsor_coin_quota { quota_id, sponsor_id, coin_count }` to `game.{room}.cmd.sponsor_quota`
  - Reconciliation on startup: reclaim any `issued` quotas older than 5 minutes back to `pool_remaining`, set status `refunded`
- [ ] **Backend — Quota ACK handler**:
  - Subscribe to `game.{room}.evt.sponsor_quota_consumed` (JetStream)
  - On receive: update `sponsor_quota_ledger` set `coins_spawned`, `status = 'consumed'`, `consumed_at = now()`
  - Refund difference if `coins_spawned < coin_count`
- [ ] **Backend — Bonus drop publisher** (same publisher goroutine):
  - Randomized interval per sponsor: 3-7 minutes (uniform random), staggered
  - Publish `sponsor_bonus_drop { sponsor_id, coin_count: 15 }` via JetStream
  - Pool decrement uses same atomic SQL + quota ledger pattern
- [ ] **Backend — Reward flush hardening**:
  - Wrap each per-user flush in a single transaction: BEGIN → INSERT `sponsor_reward_logs` → UPDATE `sponsor_balances` → COMMIT
  - Generate deterministic `ref_key`: `sponsor:{campaign_id}:{account_id}:{flush_epoch_seconds}`
  - Flush accumulated rewards on graceful shutdown (drain before `stopFlush` returns)
  - Batch `sponsor_reward_logs` inserts using multi-row `INSERT INTO ... VALUES (...), (...), (...)`

> **Research insight (Architecture + Data Integrity):** The original plan had the quota publisher in main.go (already crowded with the existing reward accumulator). Extract to its own file with `Start/Stop` lifecycle. The combined depletion check + status transition in a single SQL statement prevents a race where another goroutine sees `pool_remaining = 0` but `status = 'active'`. The reward flush must use transactions — without them, a crash between balance UPDATE and log INSERT creates permanent divergence.
- [ ] **Backend — Sponsor config publisher**:
  - On campaign create/update/deplete: publish active sponsor list to `game.{room}.sponsor_config` NATS topic
  - On WS client connect: send current `sponsor_config` message

**Key files:**
- `game/shared/src/types.ts`
- `game/shared/proto/game.proto`
- `game/server/src/game/SponsorManager.ts` (new)
- `game/server/src/game/GameLoop.ts`
- `game/server/src/game/GameState.ts` (persist sponsor_id in BodyState)
- `game/server/src/game/CoinManager.ts`
- `backend/foundation/nats/jetstream.go` (new — JetStream connection helper)
- `backend/business/core/sponsor/publisher.go` (new — quota + bonus drop publisher)
- `backend/app/services/api/main.go` (despawn handler extension, startup reconciliation)
- `backend/business/web/ws/handler.go` (sponsor_config on connect)
- `backend/business/web/ws/relay.go` (relay sponsor messages)
- `backend/business/web/ws/topics.go` (new NATS topics)

#### Phase 3: Client Rendering

**Goal:** Sponsor coin meshes, 3D ad placements on walls/platform, bonus drop VFX, sponsor balance UI.

**Tasks:**
- [ ] **CoinMeshManager** (`game/client/src/scene/CoinMeshManager.ts`):
  - Add per-sponsor prototype meshes: `sponsorPrototypes: Map<string, Mesh>`
  - Per-sponsor thin-instance buffers: `sponsorBuffers: Map<string, { matrix: Float32Array, indices: Map<number, number>, count: number }>`
  - `createSponsorCoinPrototype(sponsorId, brandColor, logoUrl)`:
    - Chamfered cylinder (same geometry as regular coin)
    - **Create material AFTER image loads** (timing issue: ShaderMaterial compiles before texture is ready if created too early)
    - Load logo: `img.crossOrigin = "anonymous"` (required for external URLs), `img.onload` → `ctx.drawImage` → `dt.update(false)` → THEN create toon material
    - `createToonMaterial({ baseColor: brandColor, diffuseTexture: logoTexture, thinInstances: true })`
    - **Remember**: set `dt.hasAlpha = true` after `dt.update()` (memory pitfall)
    - Set `prototype.alwaysSelectAsActiveMesh = true` to skip per-frame frustum culling (coins are always on screen)
    - On mobile (camera radius > 5m): skip logo DynamicTexture, use flat brand-color material only (logo is <3px at 6.5m distance)
  - `addCoin()`: dispatch on `sponsorId` to correct buffer (extend existing isKeyCoin logic)
  - `removeCoin()`: swap-and-pop from correct buffer
  - Cleanup: `disposeSponsorPrototypes()` — null texture references before disposing material, then dispose texture separately (shared texture pitfall from MEMORY.md)
  - **Pre-load all sponsor textures during loading screen** before render loop starts. Use `createImageBitmap(blob)` for async decode off main thread. For mid-session sponsor changes, queue texture uploads one per frame via `onBeforeRender` callback

> **Research insight (Performance + Best Practices):** 7-8 thin-instance draw calls is fine — BabylonJS forum confirms negligible overhead at this scale. No texture atlas needed. However, DynamicTexture creation calls `texImage2D` which stalls the GPU pipeline (2-8ms per texture on mobile). Pre-loading during the loading screen eliminates mid-gameplay stalls. On mobile portrait at 6.5m, sponsor logos are ~3px — a flat color is sufficient and saves 1.25MB VRAM.
- [ ] **Ad placements** (`game/client/src/scene/SponsorAdPlacements.ts`, new):
  - `class SponsorAdPlacements`:
    - `createBackWallAd(scene, backWallGroup)`: `MeshBuilder.CreatePlane("sponsorBackWall", { width: 1.0, height: 0.5 })`, parent to `backWallGroup`, position Y=1.4 (above pin field), Z offset +0.03 (slightly in front of wall). Apply toon material with `diffuseTexture` loaded from `ad_image_url`
    - `createSideWallAd(scene, sideWallGroup, side)`: `MeshBuilder.CreatePlane`, 0.4m × 0.4m, positioned on inner face of back wall segment
    - `createPlatformAd(scene, platformGroup)`: `MeshBuilder.CreatePlane`, 0.8m × 0.4m, Y=0.251 (just above platform surface), face up, alpha 0.4 for subtlety
    - `updateSponsorCreatives(sponsors)`: swap textures on existing planes when rotation changes. Dispose old textures, create new ones
    - All planes use `createToonMaterial({ diffuseTexture, useCelShading: true })` — sponsor images pass through cel shading automatically
  - **Texture dimensions** (desktop): back wall 1024×512, side walls 512×512, platform 512×256
  - **Texture dimensions** (mobile, camera radius > 5m): back wall 512×256, side walls 256×256, skip platform ad entirely (face-up at alpha 0.4 is invisible from elevated camera angle in portrait)

> **Research insight (Performance):** At 6.5m camera distance on a 1080p phone, the back wall ad occupies ~150×75 CSS pixels. A 1024×512 texture is 7× oversampled. Each RGBA texture at 1024×512 = 2MB VRAM. Halving on mobile saves 4MB GPU memory.
- [ ] **Bonus drop VFX** (`game/client/src/scene/BonusDropVFX.ts`, new):
  - On `bonus_drop` message:
    - Full-width announcement banner using `textContent` (NEVER `innerHTML`) to render sponsor name — prevents XSS
    - Show actual spawn count: `Math.min(requested, MAX_ACTIVE_COINS - current)`, not the requested count
    - Auto-dismiss after 3s
    - No particle VFX — the coins themselves, appearing one by one (server staggers at 1/100ms), are the visual event

> **Research insight (Security + Performance):** `brand_name` and `token_symbol` come from sponsor input and flow to all connected clients. Using `innerHTML` to render them is stored XSS. React JSX auto-escapes, but `BonusDropVFX.ts` is plain TS — must use `textContent`. Bonus drop particle VFX on top of 10-20 coin spawns would spike the frame budget; the staggered coin appearance is sufficient visual feedback.
- [ ] **Sponsor balance UI** (`game/client/src/ui/SponsorBalances.tsx`, new):
  - Small panel showing earned sponsor tokens (token symbol + amount)
  - Updates on `sponsor_reward` messages
  - Positioned near existing player info panel (top-right)
- [ ] **GameClient message handling** (`game/client/src/net/GameClient.ts`):
  - Handle `sponsor_config`: create/update sponsor coin prototypes + ad placements
  - Handle `bonus_drop`: trigger VFX + announcement
  - Handle `sponsor_reward`: update balance display
  - Handle `sponsor_id` on coin spawn: route to correct CoinMeshManager buffer

**Key files:**
- `game/client/src/scene/CoinMeshManager.ts`
- `game/client/src/scene/SponsorAdPlacements.ts` (new)
- `game/client/src/scene/BonusDropVFX.ts` (new)
- `game/client/src/ui/SponsorBalances.tsx` (new)
- `game/client/src/net/GameClient.ts`
- `game/client/src/scene/SceneManager.ts` (wire up ad placements)
- `game/client/src/scene/StaticMeshes.ts` (expose backWallGroup, sideWallGroups for ad placement parenting)

#### Phase 4: Integration & Polish

**Goal:** End-to-end flow, reconnection handling, edge cases.

**Tasks:**
- [ ] **Reconnection**: On WS reconnect, client re-fetches `sponsor_config` + rebuilds sponsor prototypes. `WorldSnapshot` must identify existing sponsor coins (extend `BodyState.type` to carry `sponsor_id`)
- [ ] **Pool depletion**: When `pool_remaining` hits 0 via reward distribution, backend sets `status = 'depleted'`, publishes updated `sponsor_config` (without this sponsor), game server stops spawning that sponsor's coins
- [ ] **Bonus drop scheduling**: Backend triggers bonus drops by publishing `sponsor_bonus_drop` command to NATS on a configurable interval (default: every 5 minutes per sponsor, staggered). Game server's `SponsorManager` receives and executes. Volume: 10-20 coins per drop, capped by `MAX_ACTIVE_COINS`
- [ ] **Theme compatibility**: Verify sponsor coin toon materials look correct across all 4 themes (Psychedelic Pop, Neon, Retro, Industrial). The cel shader should auto-adapt, but test with bright/dark brand colors
- [ ] **Performance**: Profile with 5 sponsors active (5 extra prototype meshes, 5 thin-instance buffers, 3 ad placement planes with textures). Target: no FPS regression on mid-range mobile
- [ ] **Admin tooling**: Add admin endpoint to pause/remove campaigns. Wire to existing admin auth role

## System-Wide Impact

### Interaction Graph

Player inserts coins → Go backend debits balance + adds heat → NATS → game server `DropScheduler` queues coins → `SponsorManager.tick()` periodically injects sponsor coins from active pool → coin spawn published to NATS (protobuf with `sponsor_id`) → Go relay → WS → client creates sponsor coin in correct thin-instance buffer → physics runs → coin despawns → NATS event with `sponsor_id` + zone → Go backend: if front-edge + sponsor, distribute sponsor token via heat shares to `sponsor_balances`, else regular reward path → notify player via WS

### Error Propagation

- Sponsor image upload fails → HTTP 400, campaign not created
- Sponsor pool depletes mid-session → no new sponsor coins spawned, existing coins still pay out (pool was decremented at spawn)
- NATS sponsor_config publish fails → game server uses stale config (acceptable for seconds), retry on next change
- Client fails to load sponsor image URL → fallback to solid brand-color texture (no logo), log warning

### State Lifecycle Risks

- **Partial sponsor coin spawn**: Pool decremented but coin spawn fails → refund pool amount in catch block
- **Orphaned sponsor coins on server restart**: GameState is rebuilt from physics world; `coinSponsorMap` must be rebuilt from stored metadata or coins treated as regular on restart
- **Stale sponsor config after backend deploy**: Game server should re-request config on reconnect to NATS

### API Surface Parity

- New HTTP endpoints: 5 sponsor endpoints (create, list, get, upload, balances)
- New WS message types: 3 (sponsor_config, bonus_drop, sponsor_reward)
- New protobuf fields: 2 (sponsor_id on CoinSpawnEntry, CoinDespawnEntry) + 1 new message (BonusDrop)

## Acceptance Criteria

### Functional Requirements

- [ ] Sponsor can create campaign via API (token address, chain, brand info, images, deposit amount)
- [ ] Sponsor coins appear on platform with brand color + logo, toon-shaded to match current theme
- [ ] Sponsor coins are physically identical to regular coins (same size, same physics)
- [ ] Front-edge sponsor coin despawn distributes sponsor token to players via heat shares
- [ ] Bonus drop events spawn sponsor coins with announcement banner + VFX
- [ ] Back wall, side walls, platform surface show sponsor ad creatives
- [ ] Ad placements update dynamically when sponsor rotation changes
- [ ] Sponsor balance UI shows earned tokens per sponsor
- [ ] System handles 3-5 simultaneous sponsors without performance regression
- [ ] Pool depletion stops new sponsor coin spawning; existing coins still pay out

### Non-Functional Requirements

- [ ] No FPS regression on mobile with 5 active sponsors
- [ ] Sponsor image loading does not block game start (async, with fallback)
- [ ] Sponsor coin thin-instance rendering performs identically to regular coin rendering

### Quality Gates

- [ ] All 4 themes tested with sponsor content
- [ ] Reconnection flow restores sponsor state correctly
- [ ] Pool depletion edge case tested (mid-session depletion)
- [ ] Idempotent reward distribution (ref_key prevents double-credit)

## Dependencies & Prerequisites

- Existing heat-based reward system (no changes to heat algorithm needed)
- Existing toon shader with `diffuseTexture` support
- Existing thin-instance coin rendering pattern
- Image storage solution (local disk for dev, S3/CDN for prod)
- NATS JetStream enabled on NATS server (add `-js` flag or `jetstream {}` config block)
- `libvips-dev` in Docker image for Go image processing (govips)
- `github.com/davidbyttow/govips/v2` Go dependency for image re-encoding

## Risk Analysis & Mitigation

| Risk | Impact | Mitigation |
|------|--------|------------|
| Sponsor coin textures look bad with toon shader | Medium | Test with varied brand colors early. Cel shader auto-adapts, but extreme colors may need clamping |
| 5 sponsor thin-instance buffers hurt mobile perf | Low | 7-8 draw calls confirmed negligible. Skip logo textures on mobile (flat color). Pre-load during loading screen |
| Pool accounting race condition | High | Atomic SQL with combined depletion check + status transition. Quota ledger with ACK protocol for reconciliation |
| Sponsor image as attack vector | High | Magic byte validation + govips re-encoding + server-generated filenames + security headers. `MaxBytesReader(512KB)` |
| Reward flush data loss on crash | High | Transaction-wrapped flushes, deterministic ref_keys, flush on graceful shutdown, consider JetStream for despawn events |
| NATS message loss (quota/config) | High | JetStream with durable consumers and explicit ACK for all economic messages |
| XSS via sponsor brand_name/token_symbol | Medium | DB CHECK constraints on format, client uses `textContent` not `innerHTML` |
| Bonus drop timing exploitation | Medium | Randomized intervals (3-7 min), not fixed 5-minute |
| coinSponsorMap loss on server restart | High | Persist sponsor_id in WorldSnapshot BodyState protobuf; survives via existing snapshot mechanism |

## Scope Boundaries (from origin)

- **Out of scope**: Pricing/allocation mechanism, on-chain smart contracts, sponsor analytics dashboard, content moderation, slot machine/wheel integration (v2)
- **In scope**: Game client rendering, game server sponsor coin mechanics, backend sponsor CRUD API, ad placement system

## Sources & References

### Origin

- **Origin document:** [docs/brainstorms/2026-03-29-permissionless-sponsor-ads-requirements.md](docs/brainstorms/2026-03-29-permissionless-sponsor-ads-requirements.md)
- Key decisions carried forward: permissionless over curated (R1), custom implementation over ad SDK, toon-shader integration for all sponsor visuals (R14), dual appearance model — mixed coins + bonus drops (R4-R10), 3-5 sponsor capacity (R17), no mobile-specific ad adaptation (R16)

### Internal References

- Coin rendering pattern: `game/client/src/scene/CoinMeshManager.ts` (key coin prototype at line 121-149, key coin texture at line 152-190)
- Toon shader with texture: `game/client/src/scene/ToonMaterial.ts` (diffuseTexture support via `#define DIFFUSE_TEX`)
- Back wall mesh: `game/client/src/scene/StaticMeshes.ts:445-469`
- Despawn classification: `game/server/src/game/GameLoop.ts:252-269`
- Heat distribution: `backend/business/core/heat/heat.go:73-134`
- Reward accumulation: `backend/app/services/api/main.go:425-556`
- Go domain pattern: `backend/business/core/game/`
- Handler pattern: `backend/app/services/api/handlers/v1/gamegrp/gamegrp.go`
- DB schema: `backend/zarf/docker/database/schema.sql`
- NATS topics: `backend/business/web/ws/topics.go`
- Protobuf schema: `game/shared/proto/game.proto`

### Institutional Knowledge

- DynamicTexture must have `hasAlpha = true` set after `update()` — otherwise renders as opaque squares (MEMORY.md)
- ParticleSystem texture disposal: set `particleTexture = null` before `dispose()` if shared (MEMORY.md)
- Cross-layer agent coordination: include exact data contracts with field names and types in task descriptions (MEMORY.md)
- Create toon material AFTER `DynamicTexture.update()` — ShaderMaterial compiles before texture is ready otherwise (Best Practices research)
- Set `img.crossOrigin = "anonymous"` BEFORE `img.src` for external URLs — canvas becomes tainted otherwise (BabylonJS docs)
- Set `alwaysSelectAsActiveMesh = true` on all coin prototypes — frustum culling is wasted for coins always in view (BabylonJS docs)

### External References

- [BabylonJS DynamicTexture docs](https://doc.babylonjs.com/features/featuresDeepDive/materials/using/dynamicTexture)
- [BabylonJS Thin Instances docs](https://doc.babylonjs.com/features/featuresDeepDive/mesh/copies/thinInstances)
- [BabylonJS ShaderMaterial docs](https://doc.babylonjs.com/features/featuresDeepDive/materials/shaders/shaderMaterial)
- [NATS JetStream docs](https://docs.nats.io/nats-concepts/jetstream)
- [govips Go image processing](https://github.com/davidbyttow/govips)
