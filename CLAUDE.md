# Coin Pusher Game

## Tech Stack

- Server: TypeScript, Rapier 3D physics (WASM), WebSocket + MessagePack
- Client: TypeScript, BabylonJS, Vite
- Shared: TypeScript protocol types and config
- Monorepo: pnpm workspace

## Project Structure

- `server/src/` - Game server (physics, game loop, WebSocket)
- `client/src/` - Game client (rendering, interpolation, UI)
- `shared/src/` - Shared types and config
- `docker-compose*.yml` - Deployment configs

## Skills

This project has skills in `.agents/skills/`. When working on tasks, auto-detect and load relevant skills based on the task context and each skill's triggers.

| Skill | Path | Triggers | Use When |
|-------|------|----------|----------|
| game-developer | `.agents/skills/game-developer/SKILL.md` | game physics, networking, optimization, ECS, performance | Game systems, physics tuning, performance optimization, multiplayer networking |
| microservices-architect | `.agents/skills/microservices-architect/SKILL.md` | distributed systems, service mesh, observability, event sourcing | Server architecture, scaling, observability, deployment patterns |
| frontend-design | `.agents/skills/frontend-design/SKILL.md` | web UI, components, styling, layout | Client UI design, HUD, visual polish |
| golang-pro | `.agents/skills/golang-pro/SKILL.md` | Go, goroutines, channels, gRPC | Go language tasks (if applicable) |

### How to use skills

1. Read the matching `SKILL.md` to understand the role, constraints, and workflow
2. Load relevant `references/*.md` files based on the specific subtask
3. Follow the skill's constraints (MUST DO / MUST NOT DO) during implementation
4. When spawning team agents, include the relevant skill path in the agent's prompt so it can load the skill context
