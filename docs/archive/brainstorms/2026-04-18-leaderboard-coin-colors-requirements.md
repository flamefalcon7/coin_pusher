---
date: 2026-04-18
topic: leaderboard-coin-colors
status: superseded
reviewed: 2026-09-02
outcome: "Became docs/plans/2026-04-18-001, shipped."
---

# Leaderboard Coin Colors

## Problem Frame

Players see a heat leaderboard ranking the top 5, but have no visual connection between those names and activity on the board. Coins from top players look identical to everyone else's. This makes the leaderboard feel like a detached scoreboard rather than a reflection of live competition.

By coloring top players' coins with their rank color, players can perceive who is actively pushing and feel the competitive pressure directly on the game board.

## Requirements

**Rank Colors**
- R1. Top 5 leaderboard ranks use fixed colors: #1 Red, #2 Orange, #3 Purple, #4 Blue, #5 Green
- R2. Leaderboard UI name text uses the corresponding rank color
- R3. When a top-5 player drops a coin, its highlight overlay renders in their rank color (same duration as current highlight)

**Own Coin Highlight**
- R4. Non-ranked players' coin highlight changes from cyan to grey
- R5. If the player is in the top 5, their own coins use their rank color instead of grey

**Rank Transitions**
- R6. When rankings change (via heat_update), newly dropped coins use the updated rank color. Already-highlighted coins keep their original color until they expire naturally.

## Success Criteria

- A spectator can identify which top-5 player dropped a coin without checking the leaderboard
- Players feel increased competitive awareness from seeing rank-colored coins on the board
- No perceptible frame rate impact vs current highlight system

## Scope Boundaries

- No changes to heat calculation or leaderboard ranking logic
- No particle effects or additional animations beyond the existing highlight overlay
- No color customization by players
- Board coins that are no longer highlighted (older than ~2-3s) remain default gold — rank colors only appear during the highlight window

## Key Decisions

- **Fixed rank colors over player-chosen colors**: Simpler, no UI needed, universally understood rarity convention (red > orange > purple > blue > green)
- **Grey for non-ranked players**: Neutral, doesn't clash with any rank color, clear semantic of "unranked"
- **One thin instance mesh per color (approach A)**: Max ~30 highlighted coins across 6 meshes (5 ranks + grey). Negligible GPU cost vs single-mesh custom shader approach, and requires no shader changes.

## Dependencies / Assumptions

- `coin_spawn` message already includes `owner_id`, so the client can map coins to leaderboard players without server changes

## Outstanding Questions

### Deferred to Planning
- [Affects R3][Technical] Exact hex values for each rank color that look good as overlays on gold coins — may need tuning
- [Affects R1][Technical] Whether to reuse the existing `createToonMaterial` or create simpler unlit materials for colored highlights

## Next Steps

-> `/ce:plan` for structured implementation planning
