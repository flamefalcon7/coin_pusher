# Coin Pusher Game

## Tech Stack

- Game Server: TypeScript, Rapier 3D physics (WASM), WebSocket + MessagePack, NATS JetStream to backend
- Client: TypeScript, BabylonJS, React 18, Vite
- Shared: TypeScript protocol types and config; protobuf via buf (`game/shared/src/gen/`)
- Backend: Go 1.24, PostgreSQL, chi router, Zap logger, NATS (Ardan Labs layout)
- Chain: Base (EVM). USDC deposits via HD-derived addresses; no SUI code remains
- Monorepo: pnpm workspace (TS) + Go module (backend)

## Project Structure

- `game/server/src/` - Game server
  - `game/` - GameLoop, TickScheduler, CoinManager, DropScheduler, StackSpawner, SponsorManager, GameState
  - `physics/` - Rapier world + scene builder
  - `simulation/` - Headless SimLoop, RNG, economy/RTP simulator (`run.ts` CLI via Makefile)
  - `nats/` - NATSClient (commands in, events out)
- `game/client/src/` - Game client
  - `scene/` - BabylonJS rendering, VFX, debug tooling
  - `net/` - WebSocket, state buffer, interpolation, REST clients
  - `ui/`, `pages/` - React UI and routed pages
  - `editor/` - In-browser scene editor
- `game/shared/src/` - Shared protocol types, config, generated protobuf
- `backend/` - Go backend (Ardan Labs layout)
  - `app/services/api/` - API server entry point + HTTP handlers
  - `app/tooling/admin/` - CLI: DB migration, seeding, bot subcommands
  - `app/tooling/indexer/` - Polls Base chain for USDC deposits
  - `app/tooling/executor/` - Processes approved withdrawals, sweeps deposit addresses
  - `app/tooling/heatsim/` - Monte-Carlo simulator for the heat engine
  - `business/core/` - Domains: user, accounting (ledger), deposit, inventory, progress, sponsor, bot, heat, game, outbox (transactional outbox → NATS). Each domain owns its `stores/`
  - `business/web/` - auth, middleware (`mid/`), v1 response helpers, `ws/` hub relaying game state
  - `foundation/` - database, logger, keystore (JWT RSA), metrics, nats, ethereum (ERC-20), ethrpc (multi-provider RPC failover), wallet (BIP-32 HD)
- `deploy/` - nginx, prometheus, grafana, fail2ban configs + droplet setup scripts
- `docker-compose.{dev,prod,game,services}.yml` - Deployment configs
- `docs/` - see sections below. `docs/archive/` holds shipped or abandoned plans; historical only, never a source of current truth

## Definition of Done (verification gate)

- **Restate before executing**: before any multi-step or planned work (ce-plan / ce-work / any feature task), restate the original goal + success criteria in 1–2 lines and get confirmation. Guards against intent drift.
- **Evidence before "done"**: any change with a visible or behavioural effect MUST ship with evidence — green headless test (leak/SimLoop harness) and, for anything rendered, a screenshot via Chrome DevTools MCP. Follow `.agents/skills/self-verification`; "please check if it looks right" is a failure mode. A feature nobody has seen render is not done. (Retro: `docs/solutions/workflow/claude-code-session-retro-2026-07.md`.)
- **Never commit on red**: run the affected package's test suite before commit. CI (`.github/workflows/ci.yml`) runs `pnpm -r test` + `go test ./backend/...` on every push/PR to main.

## Product Spec

Read `docs/spec.md` for product design intent: game loop, abilities, economy, multiplayer, and planned features. This captures the "why" behind design decisions that code alone doesn't convey.

## Documented Solutions

`docs/solutions/` — documented solutions to past problems (bugs, best practices, workflow patterns), organized by category with YAML frontmatter (`module`, `tags`, `problem_type`, `component`). Relevant when implementing or debugging in documented areas. Search by grep on tags or module before starting work in an area you don't already know.

## Decisions (ADR log)

`docs/decisions.md` — the **why** behind non-obvious architecture / infra / tech choices, especially the alternatives we rejected (`docs/solutions/` is the "what broke + how fixed"; this is "why we chose X"). Respect `Accepted` decisions; don't reopen unless asked. Use the template at the bottom of that file; number sequentially `D-XXX`, never reuse numbers.

## Decision Capture & Incident Documentation Protocol

Proactively propose documentation — don't wait to be asked:

- **Before implementing a non-obvious decision** (picking one tool/library/service over another; an architectural pattern; a data model / contract shape; a tradeoff or constraint; reversing a prior decision): pause, propose a short ADR for `docs/decisions.md`, confirm the text, then implement. Skip for routine naming/layout/syntax or anything already covered in `docs/spec.md`.
- **After resolving an incident or a bug that took > 15 min** (especially infra/outages, data-integrity, cross-layer bugs): propose a `docs/solutions/<category>/` entry using the existing frontmatter convention — symptoms, root-cause chain, the diagnostic commands that worked, the fix, and watch-items. Capture corrected misdiagnoses too (they're the most valuable part).
- **When a fix is config/infra applied to a live server**, note in the write-up whether git is the source of truth or the server has drifted, so the next deploy reconciles deliberately.

## Skills

Project skills live in `.agents/skills/`. **Before starting any non-trivial coding or debugging task, list `.agents/skills/*/SKILL.md` and consult the ones whose triggers match the work.** They encode this project's house conventions — using them is how output stays consistent instead of drifting. Skills are added over time, so always discover from the folder; never rely on a hardcoded list.

For a matching skill:

1. Read its `SKILL.md` for role, triggers, and MUST DO / MUST NOT DO constraints — and follow them.
2. Load only the `references/*.md` files the current subtask needs.
3. When delegating to a sub-agent, pass the skill path in its prompt so it loads the same context.
