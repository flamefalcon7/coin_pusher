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

## Skills

This project has agent skills in `.agents/skills/`. Before starting a task, scan the folder for available skills by listing `.agents/skills/*/SKILL.md`. Read each relevant `SKILL.md` to check its triggers and decide if it applies to the current task.

### How to use skills

1. List `.agents/skills/` to discover all available skills (do not rely on a hardcoded list)
2. Read the matching `SKILL.md` to understand the role, constraints, and workflow
3. Load relevant `references/*.md` files based on the specific subtask
4. Follow the skill's constraints (MUST DO / MUST NOT DO) during implementation
5. When spawning team agents, include the relevant skill path in the agent's prompt so it can load the skill context
