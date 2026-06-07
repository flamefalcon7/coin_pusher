# Coin Pusher Game

## Tech Stack

- Game Server: TypeScript, Rapier 3D physics (WASM), WebSocket + MessagePack
- Client: TypeScript, BabylonJS, Vite
- Shared: TypeScript protocol types and config
- Backend: Go 1.22+, PostgreSQL, chi router, Zap logger (Ardan Labs layout)
- Monorepo: pnpm workspace (TS) + Go module (backend)

## Project Structure

- `game/server/src/` - Game server (physics, game loop, WebSocket)
- `game/client/src/` - Game client (rendering, interpolation, UI)
- `game/shared/src/` - Shared TypeScript protocol types and config
- `backend/` - Go backend service (Ardan Labs layout)
  - `app/services/api/` - Main API server entry point & HTTP handlers
  - `app/tooling/admin/` - CLI for DB migration/seeding
  - `app/tooling/indexer/` - SUI chain event listener
  - `business/core/user/` - User domain (auth, login, balance)
  - `business/core/accounting/` - Ledger domain (deposit, withdraw, game events)
  - `business/web/` - Web framework (auth, middleware, response helpers)
  - `foundation/` - Reusable libs (database, logger, keystore, SUI SDK wrapper)
  - `zarf/` - Config & deploy (Docker, K8s)
- `docker-compose*.yml` - Deployment configs

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

This project has agent skills in `.agents/skills/`. Before starting a task, scan the folder for available skills by listing `.agents/skills/*/SKILL.md`. Read each relevant `SKILL.md` to check its triggers and decide if it applies to the current task.

### How to use skills

1. List `.agents/skills/` to discover all available skills (do not rely on a hardcoded list)
2. Read the matching `SKILL.md` to understand the role, constraints, and workflow
3. Load relevant `references/*.md` files based on the specific subtask
4. Follow the skill's constraints (MUST DO / MUST NOT DO) during implementation
5. When spawning team agents, include the relevant skill path in the agent's prompt so it can load the skill context
