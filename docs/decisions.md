# Decisions (ADR log)

Architecture / infrastructure / tech decisions, newest-relevant first. Number sequentially
from D-001; **never reuse numbers.** Respect `Accepted` decisions — don't reopen unless asked.
When superseding: new `D-XXX` status `Supersedes D-YYY`; set `D-YYY` to `Superseded by D-XXX`.

For the "what broke + how we fixed it" record (bugs, incidents), see `docs/solutions/`.
This file is for the **why** behind a choice — especially the alternatives we rejected.

---

## D-001: Cap monitoring memory + add swap instead of resizing the droplet
**Status**: Accepted
**Date**: 2026-06-07 · **Component**: infrastructure / monitoring

### Context
On 2026-06-07 Prometheus reached 1.1 GB RSS on the 2 GB / zero-swap backend droplet and was
OOM-killed, cascading into Docker embedded-DNS starvation and a ~40-min player-facing outage
(full incident: `docs/solutions/infrastructure/prometheus-oom-dns-outage-2026-06-07.md`). The
box runs 8 containers; the monitoring stack (Prometheus 724 MB + Grafana ~120 MB) is ~40% of RAM.
We needed an immediate fix that survives the next Prometheus compaction.

### Decision
Keep the monitoring stack on the backend droplet for now, but (1) add a 2 GB swapfile
(`swappiness=10`) as a reclaim cushion, and (2) set `mem_limit: 900m` on the Prometheus
container plus trim retention `30d → 15d` with a `512MB` size cap. The `mem_limit` is the load-
bearing decision: it **scopes any future Prometheus memory blowup to the Prometheus container**,
so it can never again trigger a *global* OOM that kills the backend/DB.

### Rationale
- Scoping the OOM to Prometheus removes the player-facing failure mode immediately, with zero
  cost and no migration.
- Swap + reduced retention shrink the likelihood of hitting the cap at all.
- It's reversible config, deployable in minutes, no new infrastructure to operate.

### Alternatives Considered
- **Resize droplet to 4 GB** — rejected for now: costs money monthly, doesn't *prevent* an
  unbounded Prometheus from eventually OOMing again (just raises the ceiling), and needs a reboot.
  Still the right durable move; see "Future".
- **Move Prometheus + Grafana to a separate / the game droplet** — best long-term isolation, but
  more work (provisioning, datasource networking, dashboards) than the incident response window
  allowed. Deferred, not rejected.
- **Just add swap, no mem_limit** — rejected: swap alone still lets Prometheus drive the *whole
  box* into reclaim thrash; it wouldn't have prevented the global OOM, only delayed it.

### Consequences
- ✅ A Prometheus memory spike can no longer take down the backend/DB or the game.
- ⚠️ Prometheus sits ~80% of the 900 M cap right after restart (WAL replay); if it crash-loops on
  the cap, raise to ~1100 m or cut retention to 7d.
- 🔮 Future durable fix: move monitoring off the backend droplet, or resize to 4 GB. Revisit as
  real-player load grows.

### Related
- `docs/solutions/infrastructure/prometheus-oom-dns-outage-2026-06-07.md`
- Commits `90ef844` (mem_limit + retention), `ceb221b` (RTP query hygiene)

---

## D-002: Adopt off-the-shelf MCP (Chrome DevTools + Babylon docs) over a custom Babylon/Rapier MCP
**Status**: Accepted
**Date**: 2026-06-25 · **Component**: dev-tooling / agent-feedback-loop

### Context
The AI agent codes blind — it cannot observe the rendered scene or the browser console, so it
guesses (spec drift) and falls back to "please eyeball this". It needs **eyes** on the running
client. A bespoke BabylonJS/Rapier MCP that introspects the live scene graph would be the most
powerful option but is high-maintenance to build and keep current with engine versions.

### Decision
Commit a repo-root `.mcp.json` declaring the **Chrome DevTools MCP** (screenshot, console,
network, perf) as the agent's eyes now. **Do NOT wire a Babylon docs/API MCP** (resolution of the
KTD-4 open question, 2026-06-25): the candidates evaluated are either the wrong category or track
the wrong Babylon version, and the existing **`node_modules` source-read fallback is pinned to the
exact installed `@babylonjs/core` (v6.49) — strictly more accurate** than any docs MCP that indexes
latest. Off-the-shelf eyes + headless harnesses + the pinned-source fallback cover the need.

### Rationale
- Chrome DevTools MCP is zero-maintenance and immediately gives screenshots + console reads, which
  is exactly what the "can't see the frame" pain needs.
- The top drift source (guessing v6 APIs) is already addressed by the house rule "read the actual
  `node_modules` source before matching another system's behavior" — and that source is the *exact*
  installed version, so it cannot answer for the wrong version the way an indexed docs MCP can.
- Pairs with the scrapeable HUD (`window.__coinpusher_debug`) so the agent reads exact counts
  rather than eyeballing.

### Alternatives Considered
- **Custom BabylonJS/Rapier MCP** — rejected (for now): high maintenance, must track engine
  versions; revisit only if live scene-graph introspection becomes necessary.
- **`immersiveidea/babylon-mcp`** (the only true docs/API/source-search candidate) — rejected: no
  npx (local clone + build), ~2GB index + 30–45 min setup, and **no version pinning** (indexes the
  latest Babylon, not our v6.49) → would *introduce* drift, the opposite of the goal.
- **`davidvanstory/babylonjs-mcp`** — rejected: it's a *scene-control* MCP (create/delete 3D objects
  via text), i.e. the custom-scene category already rejected above; not a docs MCP at all.
- **Context7 (`@upstash/context7-mcp`)** — viable lightweight, npx-able, version-aware general docs
  MCP; deferred — Babylon v6 coverage unconfirmed and the pinned-source fallback already wins on
  accuracy. Revisit if multi-library doc lookup becomes valuable.
- **No MCP at all** — rejected: leaves the agent blind, the root problem this work fixes.
- **Playwright MCP for driving interactions** — deferred to follow-up (optional later).

### Consequences
- ✅ Any session in this repo inherits screenshot + console eyes on the client.
- ✅ API-drift coverage comes from reading pinned `node_modules` source — exact-version accurate,
  zero setup, no extra `npx` server to break a clean boot.
- ⚠️ No docs-MCP convenience layer; the agent must read source for unfamiliar APIs (already the house
  rule). Revisit Context7 if/when it confirms Babylon v6 coverage or multi-lib lookup is wanted.
- 🔮 If scene-graph introspection is needed later, reconsider a custom MCP.

### Related
- `docs/agent-eyes-mcp.md` · `.mcp.json` · plan WS1 / KTD-1, KTD-4 · `game/client/src/scene/DebugReadout.ts`

---

## D-003: Standardize count-baseline as the leak-test method; add vitest to the game server
**Status**: Accepted
**Date**: 2026-06-25 · **Component**: testing / game-client + game-server

### Context
No leak tests existed; resource leaks surfaced as lag, not failures. The game **server** had no
test runner at all (only `tsx`), so server self-verification was impossible. On the **client**, the
scene managers build `DynamicTexture` via `getContext()`/`createRadialGradient` and use
`ToonMaterial`/`ShaderMaterial`, none of which load under a bare node `NullEngine` (no 2D canvas,
no GL shader compile).

### Decision
Make leaks **failing tests** via count baselines. **Client:** extend the existing
`vi.mock("@babylonjs/core")` idiom and assert the managers' *own* pool counters
(`getActiveBurstCount()`, `activeTimers.length`, thin-instance/pool sizes) return to baseline after
N spawn→despawn cycles + `dispose()`. **Server:** add `vitest` + a `test` script and snapshot real
Rapier `world.bodies.len()` / `colliders.len()` baselines. Both run headless under `vitest`
(`environment: "node"`).

### Rationale
- The mock-counter approach catches the leak class we own (forgot-to-dispose / forgot-to-unpool)
  without needing a canvas polyfill, and reuses the idiom already in `scene/__tests__/`.
- Real Rapier counts on the server need no canvas and measure true body/collider disposal.
- Turning leaks into red tests means a skipped `dispose()`/`removeRigidBody` fails CI, not prod.

### Alternatives Considered
- **NullEngine + raw `scene.meshes/materials/textures` counts (client)** — rejected: the managers'
  canvas/shader APIs don't load under bare node NullEngine, and the result would measure mock
  bookkeeping, not real disposal.
- **Real-GPU CI** — rejected: cost and flakiness (GPU-in-CI is a non-goal).
- **Manual eyeballing** — rejected: that's the exact failure mode this work removes.

### Consequences
- ✅ Mesh/material/pool and physics-body leaks now fail as tests on both client and server.
- ✅ Server has a real test runner (`pnpm --filter @coin-pusher/game test`), unblocking all server
  self-verification (determinism, economy).
- ⚠️ The client tests assert manager-owned counters, not raw scene totals — they catch our leak
  class, not engine-internal leaks. Real-GPU screenshots cover the visual layer on demand.
- ⚠️ Server vitest needs a `.js`→`.ts` resolve plugin (NodeNext specifiers) and a 30s timeout for
  Rapier WASM + sim trials.

### Related
- Plan WS2 / KTD-2 · `game/client/src/scene/__tests__/leakHarness.ts` · `game/server/vitest.config.ts`
- Commits: U1–U4 (leak harness, client/server leak tests, server runner)

---

## D-004: Keep WebSocket for real-time state sync; do not adopt WebTransport/UDP
**Status**: Accepted
**Date**: 2026-06-25 · **Component**: networking / game-server ↔ client transport

### Context
Physics state syncs server→client over a single reliable, ordered WebSocket (binary protobuf
`state_delta` at 15 Hz, multiplexed with chat/`megaspeaker`, rewards, slot/wheel events, abilities,
ping/pong). This raises two head-of-line (HOL) concerns: (A) a large/slow message type stalling
physics frames behind it on the shared socket, and (B) TCP-layer HOL — a lost physics packet forces
retransmit and holds back later, already-arrived deltas. The question was whether to move physics to
an unreliable channel (WebTransport datagrams over QUIC/UDP) to eliminate HOL.

### Decision
Stay on WebSocket. Do **not** adopt WebTransport (or WebRTC) for state sync. If HOL is *measured*
to hurt real players, escalate by **splitting into two WebSocket connections** (physics on its own
socket, everything else on a second) before considering any UDP-based transport. WebTransport stays
on the table only as a last resort, and only ever *added in front of* WebSocket as a fallback —
never as a replacement.

### Rationale
- **Genre doesn't need it.** Coin pusher is server-authoritative, non-twitch; the client already
  hides latency with an adaptive 100–500 ms interpolation buffer + extrapolation. 100–200 ms is
  imperceptible here, so UDP's "last 5–10% of jitter" win is near-zero value.
- **Reliability is an asset, not a cost, for a money game.** Server-authoritative + reliable ordered
  delivery aligns with the accounting ledger's correctness/anti-cheat needs.
- **Dual-transport is the real price of UDP, and it's permanent.** WebTransport can't replace WS:
  iOS support is gated on WebKit version (one cutoff kills all iOS browsers, since they're all
  WebKit), and some networks block UDP/443 outright — so a WS fallback is mandatory forever. Native
  studios pay the same tax (UDP primary + TCP fallback, e.g. Photon/GameNetworkingSockets); the only
  reason it looks cheap for them is mature SDKs hide it.
- **Maintenance cost is high relative to our ops capacity.** HTTP/3 + UDP 443 + nginx/QUIC
  termination + a fallback state machine + encrypted-UDP debugging + an iOS version matrix lands on a
  small team that still deploys by hand and just took a Prometheus-OOM outage (D-001). The expensive
  part isn't LOC — it's the network-dependent "some users on corporate Wi-Fi silently degrade" bugs
  that don't reproduce in our machine room.
- **The cheap escalation covers the likely real cause.** HOL type (A) — chat/rewards stalling
  physics — is fixable by splitting sockets with no new protocol, infra, or debugging skill (~1.1×
  maintenance). Only HOL type (B), pure intra-stream TCP retransmit, actually requires UDP, and it's
  the smaller effect once payloads are small + idempotent (which they already are: sleeping coins
  omitted, full-snapshot deltas, receiver drops stale frames).

### Alternatives Considered
- **WebTransport datagrams for physics** — rejected for now: highest HOL win but mandatory permanent
  WS fallback, HTTP/3 infra, and high maintenance for a latency-insensitive genre. Reconsider only if
  measurement shows intra-stream TCP HOL is materially hurting players *and* the split below isn't
  enough.
- **WebRTC DataChannel (unreliable mode)** — rejected: designed for P2P; using it server↔client drags
  in ICE/STUN/TURN/SFU overhead. WebTransport strictly dominates it for this use case.
- **Smarter app-layer "drop" on the existing WS** (overwrite-latest in the send queue instead of
  blind drop-when-full) — kept as a cheap incremental option, but it only reduces *sender-side* queue
  bloat; it cannot defeat TCP-layer HOL, which is a kernel property the app can't override.

### Consequences
- ✅ Zero new transport/infra to operate; ops surface unchanged; reliability guarantees retained for
  the money path.
- ⚠️ TCP-layer HOL (type B) remains theoretically possible; we accept it as unmeasured-and-likely-
  negligible until proven otherwise.
- 🔮 Escalation path is staged and reversible: **measure (instrument real interp-delay / frame-drop /
  RTT to Grafana) → split into two WebSockets → (only if still bad) WebTransport + WS fallback.** Next
  concrete step is the two-WebSocket split, not a transport change.

### Related
- Transport map: `game/server/src/game/GameLoop.ts` (15 Hz broadcast), `game/server/src/nats/NATSClient.ts`,
  `backend/business/web/ws/{relay,hub,connection,handler}.go`, `game/client/src/net/{WebSocketClient,StateBuffer,Interpolator}.ts`
- `docs/spec.md` (multiplayer/economy intent) · supersedes nothing

---

## D-005: Seed the physics RNG for replay; keep slot/wheel outcomes on crypto

**Status**: Accepted · **amended 2026-08-05** — the boundary below was drawn in the wrong place;
see *Amendment* at the end of this entry before relying on any of it.
**Date**: 2026-08-02 · **Component**: game-server (RNG, economy)

### Context — where does randomness decide money?

The game server draws randomness in two very different places:

1. **Physics perturbation** — drop-slot X jitter, tornado/lightning/explosion force jitter,
   bonus-rain placement, sponsor slot choice, `fillPlatform` scatter. These decide where coins
   land, and where coins land decides RTP.
2. **Discrete payout outcomes** — slot machine reel symbols, jackpot wheel segment.

Until now (1) was `Math.random()` throughout the live loop, while (2) already used
`node:crypto.randomInt`. The offline `SimLoop` harness had a seeded path, but the loop that
actually takes players' money did not. Consequences: a disputed round could not be replayed and
arbitrated, and a physics parameter change could not be regression-tested — you could only observe
that RTP moved and guess why.

The obvious reflex is "seed everything so the whole session replays". That is wrong for (2).

### Decision

Seed category (1) from a per-session RNG (`xoshiro128**`, seeded at process start, recorded in
logs ~~and in every `world_snapshot` as `rng_seed`~~ — **server-side only, see the Amendment**).
Leave category (2) on `node:crypto.randomInt`.

`SESSION_RNG_SEED` (32 hex characters) overrides the minted seed, which is how a recorded session
is re-run against a changed build.

### Rationale

- ~~For physics randomness, reproducibility is the valuable property and predictability costs
  nothing: knowing the coin-scatter stream does not let a player choose a better moment to
  insert — the pusher phase and pile state dominate, and they are not secret anyway.~~
  **False — see the Amendment.** It considered only coin inserts, where the player's timing
  barely moves the outcome, and missed abilities, where it moves it a great deal.
- For reel and wheel outcomes, unpredictability **is** the security property. A seeded stream that
  a player can observe (they see every spin result) or that leaks (it is in the snapshot) turns
  into a jackpot-prediction exploit. Auditability there is better served by recording the drawn
  outcomes than by making them derivable.
- `xoshiro128**` over `mulberry32` (which `simulation/Rng.ts` uses for tests): 128-bit state and
  a 2^128-1 period suit a process that draws continuously for weeks, where a 32-bit state does
  not. Over BigInt-based `xorshift128+`: pure 32-bit ops, so no allocation in a function called
  several times per tick inside the frame budget.

### Alternatives Considered

- **Seed everything, including reels** — rejected: makes jackpots predictable from a value we
  publish in the world snapshot. Replayability is not worth an exploit on the payout path.
- **Keep `Math.random()` and record outcomes instead** — rejected: recording every physics
  perturbation is far more data than one seed, and still does not let you re-run the session
  against a modified build.
- **Reuse `mulberry32` from the sim harness** — rejected on state size (see above), though it
  stays in place for the existing offline tests rather than churning them.

### Consequences

- ✅ A session's coin scatter replays bit-for-bit from the recorded seed on the same build;
  asserted by `game/server/src/game/__tests__/gameLoop.determinism.test.ts`.
- ✅ Physics parameter changes are now regression-testable against a fixed input.
- ⚠️ **Replay is partial.** Reel and wheel draws are not derivable from the seed, so a full
  session replay also needs those outcomes recorded. Anyone building an arbitration tool must
  capture them separately.
- ⚠️ Determinism holds for the same Rapier WASM build on the same platform. Rapier does not
  guarantee cross-platform bit-identical results; do not claim replay across architectures.
- 🔮 If reel/wheel arbitration becomes a requirement, the answer is a commit-reveal scheme
  (publish a hash of the outcome before the spin, reveal after), not seeding.

### Related

- `game/server/src/rng.ts` · `game/server/src/game/{GameLoop,DropScheduler,SponsorManager,GameState}.ts`
- `game/shared/proto/game.proto` (`WorldSnapshot` field 5, now `reserved`)
- Tests: `src/__tests__/rng.test.ts` · `src/game/__tests__/gameLoop.determinism.test.ts`

### Amendment (2026-08-05): the seed is secret, and the boundary is exposure — not "physics vs payout"

**What was wrong.** The rationale above claimed physics randomness has no security value because
a player cannot time an insert to exploit it. True for inserts, false for abilities. Lightning
draws each of its ~22 strike positions from the seeded stream (`GameLoop.updateLightning`), and
the player chooses when to spend the scroll — so anyone who can follow the stream can start a
storm at a moment when the upcoming strikes land on the biggest pile. The published `rng_seed`
handed them exactly that. Tornado and bonus-rain placement sit on the same footing.

**What changed.**

1. `rng_seed` is out of `WorldSnapshot` (field 5 `reserved`). Nothing ever consumed it — the
   client-side replay it was added for was never built — so it was pure exposure. The seed lives
   in the process log and `GameState.getRngSeed()`, which is where replay and arbitration
   actually read it.
2. The seed is 128 bits, drawn straight from the CSPRNG. It was one 32-bit word expanded through
   splitmix32, so the effective search space was 2^32 however wide the generator's state was —
   an offline brute force, not a wall.
3. A malformed `SESSION_RNG_SEED` now refuses to start instead of parsing to `NaN` and landing on
   state word 0, which produced a "replay" on a seed nobody chose.

**The boundary, restated.** It is not physics-vs-payout. It is: *can an observer obtain the
stream state?*

- Seeded stream, for everything that must replay — **conditional on the seed never leaving the
  server.** Publishing it, in any form, voids this entry.
- `node:crypto`, for outcomes valuable enough that a single seed leak would compromise them
  retroactively across the whole session: reel symbols, wheel segments.

**Residual risk, stated plainly.** `xoshiro128**` is not cryptographically secure; its state is
recoverable from enough raw outputs. Players do not see raw outputs — they see coin positions
after a lossy, non-invertible physics simulation — so recovery is hard, but "hard" is not
"impossible" and this is an accepted risk, not an absent one. If ability outcomes ever need to be
provably unpredictable, move those specific draws to `node:crypto`; abilities already break
replay (their timing comes off `performance.now()`), so that costs nothing that is not already
lost.

**If public verifiability is ever wanted**, the answer is commit-reveal — publish `sha256(seed)`
live, reveal the seed when the session closes — not a field on the snapshot.

**Related:** `docs/solutions/integration-issues/game-server-outage-charged-players-2026-08-05.md`

---

## D-006: Gate all fund/item-consuming paths on a game-server liveness heartbeat
**Status**: Accepted
**Date**: 2026-08-02 · **Component**: backend (Go) / game server sync

### Context

`slot_status` (game server → NATS, every ~30 ticks ≈ 1s) is the only signal the backend has that
the game server is running. `SubscribeSlotStatus` overwrites `h.coinCount` / `h.slotCounts` but
has no timeliness check: when the game server stops publishing, those values freeze at their last
reading. The cap checks keep passing, the debit commits, and the NATS command publishes to a
subject with no subscriber — NATS core has no JetStream persistence here, so the message is
dropped on the floor. The client still receives `batch_insert_ack` reporting success.

This is not hypothetical: every deploy, restart, and crash of the game server opens this window
today. It predates and is independent of the tick circuit breaker work on
`fix/server-tick-and-sync`.

Four paths were exposed, not one: WS `batch_insert`, HTTP `POST /v1/game/batch-insert`, the bot
scheduler's insert, and the five scroll abilities (which destroy an inventory item instead of a
balance, but fail identically).

### Decision

Introduce `ws.GameLiveness` — an atomic last-heartbeat timestamp touched by the `slot_status`
subscriber — and require `Live()` before *any* operation that debits balance or consumes
inventory. The gate is **fail-closed**: the zero value and a nil pointer both read as dead, so a
backend that has never received a `slot_status`, or one wired up incorrectly, refuses these
operations rather than accepting them optimistically. TTL is 5s (five consecutive missed
heartbeats).

For abilities the gate lives inside `consumeScroll`, the single function all five handlers funnel
through, so a sixth ability cannot be added without inheriting it.

### Rationale

- The failure mode is silent fund loss with a success ack. Fail-closed costs a rejected insert;
  fail-open costs the player's money with no way to detect it after the fact.
- 5s over 1–2s: absorbs a GC pause or NATS reconnect blip without gating live play. 5s over 10s+:
  bounds the loss window to a handful of inserts.
- Liveness lives in `business/web/ws` because all three callers already import that package; no
  new import edge, and no `business/core` → `business/web` inversion beyond what exists.
- Deliberately not solved by adding JetStream: durability would let commands survive the outage,
  but replaying a backlog of inserts into a freshly restarted, empty table is a worse outcome than
  refusing them. Revisit only if table state gains persistence.

### Alternatives Considered

- **NATS request/reply health probe before each insert** — rejected: adds a round-trip to the hot
  path and a second failure mode (probe timeout) for a signal already being broadcast.
- **Gate on NATS connection state (`nc.IsConnected()`)** — rejected: proves the broker is up, not
  the game server. The exact incident being fixed has a healthy broker.
- **Fail-open with a warning log** — rejected: it is the current behaviour, and the loss is
  invisible to both player and operator.
- **A `GAME_LIVENESS_ENABLED` escape hatch for local dev** — rejected: a kill switch for a
  fail-closed money guard is the first thing to get left on in production.

### Consequences

- ✅ A dead game server stops costing players money within 5s, on every insert path.
- ✅ Ops signal: `coinpusher_game_unavailable_rejects_total{path}` going nonzero means the game
  server is gone — a directly alertable metric that did not exist before.
- ⚠️ Backend startup and NATS reconnects now have a ≤5s window where inserts are refused. Any
  environment without a running game server cannot insert coins at all — intended, but it will
  surprise anyone running the API standalone.
- ⚠️ Ability handlers stamp their cooldown before reaching the gate, so a refused ability still
  burns it (≤10s for tornado). Accepted to keep one choke point.
- ⚠️ The gate does not cover HTTP `batch-insert`'s pre-existing gap: that path never enforced
  `maxActiveCoins` or the per-slot cap, so it can still overfill the table while the game server
  is healthy. Tracked separately; not fixed here.
- 🔮 If table state ever gains persistence across restarts, revisit the JetStream rejection —
  durable commands become safe once the table they target survives.

### Related

- `backend/business/web/ws/{liveness,handler}.go` · `backend/app/services/api/handlers/v1/gamegrp/gamegrp.go`
- `backend/business/core/bot/scheduler.go` · `game/server/src/game/GameLoop.ts:412` (heartbeat source)
- `game/client/src/App.tsx` (renders the `game_unavailable` ack)
- The tick breaker in `GameLoop.tripBreaker()` depends on this gate: it stops the game loop on
  repeated failures, which stops `slot_status`, which is what makes stopping safe. Its 10s
  restart delay is chosen to clear the 5s TTL here.
- `docs/solutions/integration-issues/game-server-outage-charged-players-2026-08-05.md`

---

## D-007: Shared-passcode admin login as a wallet-free operator channel
**Status**: Accepted
**Date**: 2026-09-03 · **Component**: backend auth · client login

### Context — admin controls need a wallet the operator's phone doesn't have
Admin-only actions (clear platform, fill/spawn stacks, scene editor) are gated on
`role=admin` in the JWT, and the only way to get a JWT was a wallet signature. On a
phone with an empty wallet the operator could not reach any of them. We needed a
second door that is trivial to use and does not touch the wallet login path.

### Decision — `POST /v1/auth/admin/login` exchanges a shared passcode for an admin JWT on one fixed account
- Passcode comes from `BACKEND_AUTH_ADMIN_PASSCODE` (compose: `${ADMIN_PASSCODE:-}`); empty
  leaves the route unregistered, non-empty must be ≥ 4 chars.
- Login always resolves to the single account `auth_providers(passcode, "admin")`, created on
  first use and force-promoted to `role=admin` on every login. Existing wallet-admin accounts
  are untouched.
- Compare is constant-time; a process-wide throttle rejects every attempt (right or wrong)
  with 429 once 3 failures land inside 10 minutes.
- Client: a quiet "Admin" toggle on the login card reveals a passcode form; on success it
  reuses the normal `onSuccess` path so all existing `role === "admin"` UI lights up.

### Rationale
- Simplest thing that works on a phone: one input, no wallet, no extra deploy surface.
- A dedicated account keeps the audit trail clean (every passcode login is visibly that
  account) and means the secret never grants access to a real wallet's balance.
- Short passcodes were requested for phone typing; the 3-strike lockout is what makes
  that acceptable — brute force is bounded by the window, not by key length.

### Alternatives Considered
- Promote the user's existing wallet account on passcode entry — rejected: ties a shared
  secret to a funded account and to whichever wallet happens to be connected.
- Dev-mode-only `/v1/auth/login` with provider spoofing — rejected: dev mode is off in prod.
- Per-IP lockout in the app instead of global — rejected: nginx already does per-IP
  (`limit_req` on the route, keyed by the Cloudflare-aware `$real_client_ip`); the app-level
  global lockout is the backstop that holds even if the proxy is misconfigured.

### Consequences
- ✅ Any device can reach admin tools with one short secret.
- ⚠️ The secret is root-equivalent for game state; rotate by changing the env and restarting.
  Revocation is the passcode, not the account: `admin set-role` demotion is undone on the next
  passcode login by design, and tokens already issued live out their 24h unless the JWT
  signing key is rotated too.
- ⚠️ A hostile client can lock the operator out for 10 minutes by burning 3 guesses; nginx
  caps the route per-IP (`auth_login` zone) so that costs more than one loop.
- 🔮 If more admins appear, replace the single account with per-operator passcodes or TOTP.

### Related
- `backend/app/services/api/handlers/v1/usergrp/usergrp.go` (`AdminLogin`) ·
  `game/client/src/ui/WalletLogin.tsx` · `game/client/src/net/auth.ts` (`adminLogin`)

---

## ADR template (copy for new entries)

```markdown
## D-XXX: <Short title>
**Status**: Accepted | Proposed | Superseded by D-YYY | Deprecated
**Date**: YYYY-MM-DD · **Component**: <area>

### Context — <what problem / forces?>
### Decision — <the choice, as a complete sentence>
### Rationale — <why; bullets OK>
### Alternatives Considered — <Alt A — rejected because …>
### Consequences — ✅ <positive> · ⚠️ <tradeoff> · 🔮 <future implication>
### Related — <solutions/ link · commits · related D-YYY>
```
