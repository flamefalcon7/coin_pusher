# Agent Eyes — MCP Setup & Verification

The AI agent gets **eyes on the running client** via MCP servers declared in the
repo-root `.mcp.json`. Any Claude Code session opened in this repo inherits them.
This closes the "codes blind" feedback gap (see
`docs/plans/2026-06-25-001-feat-ai-dev-feedback-loop-plan.md`, WS1, and ADR
**D-002** in `docs/decisions.md`).

## What's committed

- **Chrome DevTools MCP** (`chrome-devtools-mcp`) — launch the client, navigate,
  capture screenshots, read the console, inspect network/perf. This is the
  agent's primary "look at the frame and the console" tool.

## Babylon docs / API MCP (open choice — KTD-4)

A Babylon docs/API-search MCP kills `@babylonjs/core@^6` API drift (guessing v6
APIs is a top source of bugs — see the memory note on reading library source
first). It is **deliberately not yet wired** into `.mcp.json` so a clean boot
stays error-free. Pick one after a quick smoke test, then add it:

Candidates (from the plan's Open Questions):
- official Babylon MCP suite
- `immersiveidea/babylon-mcp`
- `davidvanstory/babylonjs-mcp`

Smoke-test the docs/API-search one first (lowest risk). When chosen, add an entry
to `.mcp.json` under `mcpServers` and re-run the verification ritual below.

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
