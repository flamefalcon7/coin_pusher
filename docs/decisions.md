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
network, perf) as the agent's eyes now, plus a **Babylon docs/API-search MCP** to kill
`@babylonjs/core@^6` API drift. The off-the-shelf servers + the existing headless harnesses cover
~90% of the need.

### Rationale
- Chrome DevTools MCP is zero-maintenance and immediately gives screenshots + console reads, which
  is exactly what the "can't see the frame" pain needs.
- A docs/API MCP addresses the top drift source (guessing v6 APIs) without any custom code.
- Pairs with the scrapeable HUD (`window.__coinpusher_debug`) so the agent reads exact counts
  rather than eyeballing.

### Alternatives Considered
- **Custom BabylonJS/Rapier MCP** — rejected (for now): high maintenance, must track engine
  versions; revisit only if live scene-graph introspection becomes necessary.
- **No MCP** — rejected: leaves the agent blind, which is the root problem this work fixes.
- **Playwright MCP for driving interactions** — deferred to follow-up (optional later).

### Consequences
- ✅ Any session in this repo inherits screenshot + console eyes on the client.
- ⚠️ `npx`-launched MCP servers are environment-sensitive; the Babylon docs MCP choice is left open
  (KTD-4) and not yet wired so a clean boot stays error-free.
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
