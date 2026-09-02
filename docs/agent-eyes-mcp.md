# Agent Eyes — MCP Setup & Verification

The AI agent gets **eyes on the running client** via MCP servers declared in the
repo-root `.mcp.json`. Any Claude Code session opened in this repo inherits them.
This closes the "codes blind" feedback gap (see
`docs/archive/plans/2026-06-25-001-feat-ai-dev-feedback-loop-plan.md`, WS1, and ADR
**D-002** in `docs/decisions.md`).

## What's committed

- **Chrome DevTools MCP** (`chrome-devtools-mcp`) — launch the client, navigate,
  capture screenshots, read the console, inspect network/perf. This is the
  agent's primary "look at the frame and the console" tool.

## Babylon docs / API MCP — decided: not wired (use pinned source instead)

**Resolution (2026-06-25, KTD-4 open question):** we deliberately do **not** wire a
Babylon docs/API MCP. For `@babylonjs/core` API drift, the house rule "read the
actual `node_modules` source before matching another system's behavior" is
**strictly more accurate** here: that source is pinned to the exact installed
version (**v6.49**), whereas every docs MCP evaluated tracks *latest*. See ADR
**D-002** for the full reasoning.

Candidates evaluated and why each was rejected:
- **`immersiveidea/babylon-mcp`** — the only real docs/API/source-search one, but no
  npx (local clone + build), ~2GB index + 30–45 min setup, and **no version
  pinning** → indexes latest Babylon (v8), not our v6.49 → would *introduce* drift.
- **`davidvanstory/babylonjs-mcp`** — a *scene-control* MCP (create/delete 3D
  objects via text), not a docs MCP; same category we rejected as a custom MCP.
- **Context7 (`@upstash/context7-mcp`)** — viable, npx-able, version-aware general
  docs MCP; deferred because Babylon v6 coverage is unconfirmed and the pinned
  `node_modules` fallback already wins on accuracy.

**Revisit** Context7 if it confirms Babylon v6 coverage, or if multi-library doc
lookup (React/Vite/etc.) becomes valuable — then add it under `mcpServers` and
re-run the verification ritual below.

## Verification ritual (manual)

1. `claude mcp list` (or `/mcp` in-session) shows `chrome-devtools` connected.
2. Start the client: `pnpm --filter @coin-pusher/client dev`.
3. Open the dev URL in the MCP browser, capture a screenshot — confirm a
   non-empty render.
4. **Read the console — assert zero errors/warnings on a clean boot.**
5. Prefer reading the scrapeable HUD `window.__coinpusher_debug` (gated by
   `?debug=1`) for exact counts (fps, draw calls, meshes, active coins, active
   bursts) over eyeballing — see `game/client/src/scene/DebugReadout.ts`.

## Notes / gotchas

- `npx` package execution can be environment-sensitive. If `npx -y
  chrome-devtools-mcp@latest` fails to resolve in a constrained environment, run
  it through the available proxy (e.g. `rtk proxy npx ...`) or pre-install the
  package, then retry `claude mcp list`.
- GPU is on-demand/local only — there is no GPU-in-CI gate (non-goal). Headless
  logic/count tests live in the client/server vitest suites; real-GPU
  screenshots run here, via this MCP. The per-ability GPU smoke ritual is in
  `docs/solutions/workflow/gpu-smoke-screenshots.md` (U11).
