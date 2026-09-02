---
title: "feat: Color-code top-5 leaderboard players' coin highlights"
type: feat
status: completed
date: 2026-04-18
origin: docs/archive/brainstorms/2026-04-18-leaderboard-coin-colors-requirements.md
reviewed: 2026-09-02
outcome: "Shipped in a71d63f + 02e8737, merged 6b6248c."
---

# Color-Code Top-5 Leaderboard Players' Coin Highlights

## Overview

Top-5 heat leaderboard players' newly dropped coins will render with rank-colored highlight overlays (red/orange/purple/blue/green), making competitive activity visible on the game board. Non-ranked players' highlights change from cyan to grey.

## Problem Frame

Players see a heat leaderboard but can't connect those names to activity on the board. All coins look identical regardless of who dropped them. This makes competition feel abstract. Rank-colored coin highlights create direct visual feedback of competitive behavior. (see origin: `docs/archive/brainstorms/2026-04-18-leaderboard-coin-colors-requirements.md`)

## Requirements Trace

- R1. Top 5 ranks use fixed colors: #1 Red, #2 Orange, #3 Purple, #4 Blue, #5 Green
- R2. Leaderboard UI name text uses the corresponding rank color
- R3. Top-5 players' new coins get rank-colored highlight overlay (same duration as current)
- R4. Non-ranked players' highlight changes from cyan to grey
- R5. If player is top-5, their own coins use rank color instead of grey
- R6. Rank changes apply to newly dropped coins only; existing highlights expire naturally

## Scope Boundaries

- No changes to heat calculation or ranking logic
- No particle effects beyond existing highlight overlay
- No player-customizable colors
- Only recently dropped coins (within highlight window) show rank colors; older coins stay gold

## Context & Research

### Relevant Code and Patterns

- **Sponsor coin system** (`game/client/src/scene/CoinMeshManager.ts:55-57, 573-669`): Per-sponsor prototype meshes with independent thin-instance buffers. This is the direct precedent — same pattern of "N colored mesh variants with separate buffer management."
- **Current highlight system** (`CoinMeshManager.ts:65-74, 197-216, 754-845`): Single cyan toon-material mesh, swap-and-pop buffer management, 2s expiry timers, per-frame position sync from source coin buffers.
- **Coin spawn handler** (`game/client/src/App.tsx:289-302`): Already receives `owner_id` per coin. Currently only highlights when `owner_id === myUserId`.
- **Heat update handler** (`App.tsx:304-322`): Sorts players by share, slices top 5, stores as `LeaderboardEntry[]` state.
- **Leaderboard UI** (`game/client/src/ui/Leaderboard.tsx`): Rank 1 gets "on-fire" styling. Other ranks are unstyled.
- **Toon material** (`game/client/src/scene/ToonMaterial.ts:180-265`): `createToonMaterial({ baseColor, thinInstances: true })` — straightforward to create per-rank materials.

### Institutional Learnings

- No relevant documented solutions in `docs/solutions/` for this feature area.
- Memory note: BabylonJS `ParticleSystem.dispose()` also disposes shared textures — not directly relevant here but good to be aware of during material cleanup.

## Key Technical Decisions

- **Per-rank highlight mesh (approach A) over single-mesh custom shader (approach B):** Max ~30 concurrent highlights across 6 meshes (5 ranks + grey). 6 draw calls is negligible. No shader modifications needed. Mirrors the proven sponsor coin pattern.
- **Rank color lookup via Map<string, number> (userId → rankIndex):** Rebuilt on every `heat_update` (1Hz). O(1) lookup per coin spawn. Simple, no stale state.
- **Grey (not cyan) for non-ranked:** Clear semantic separation. Avoids confusion with any rank color.

## Open Questions

### Resolved During Planning

- **Where to define rank colors?** In `game/shared/src/types.ts` alongside `HEAT_CONFIG` — both client UI and scene code can import from one place.
- **Buffer capacity per rank highlight mesh?** 10 per rank (50 total across 5 ranks), 20 for grey. Auto-resize if exceeded, matching existing highlight pattern.

### Deferred to Implementation

- Exact hex values for each rank color that look good as toon-material overlays on gold coins — may need visual tuning
- Whether highlight duration should stay at 2s or increase to 3s for better visibility of rank colors

## High-Level Technical Design

> *This illustrates the intended approach and is directional guidance for review, not implementation specification.*

```
heat_update (1Hz)
  → rebuild userId→rankIndex Map (top 5 only)
  → store as ref in App.tsx

coin_spawn
  → for each coin:
      if owner_id in top5Map → addRankHighlight(coinId, rankIndex)
      else if owner_id === myUserId → addRankHighlight(coinId, GREY_INDEX)
      (else → no highlight)

CoinMeshManager:
  rankHighlightMeshes[6]  — index 0-4 = rank colors, index 5 = grey
  rankHlBuffers[6]        — per-mesh { matrix, idToIndex, timers, ... }
  
  addRankHighlight(coinId, colorIndex):
    same logic as current addHighlight but targets rankHlBuffers[colorIndex]
  
  updateRankHighlights():
    for each of 6 buffers: expire, sync positions, push to GPU
```

## Implementation Units

- [ ] **Unit 1: Define rank color constants**

**Goal:** Single source of truth for the 5 rank colors + grey

**Requirements:** R1, R4

**Dependencies:** None

**Files:**
- Modify: `game/shared/src/types.ts`

**Approach:**
- Add `RANK_COLORS` array (6 entries: 5 rank hex strings + grey) near `HEAT_CONFIG`
- Export rank index constants (`RANK_1 = 0` through `RANK_5 = 4`, `RANK_NONE = 5`)

**Patterns to follow:**
- `HEAT_CONFIG` const block in same file

**Test expectation:** none — pure constants, no behavior

**Verification:** Both `Leaderboard.tsx` and `CoinMeshManager.ts` can import and use the constants

---

- [ ] **Unit 2: Per-rank highlight meshes in CoinMeshManager**

**Goal:** Replace single cyan highlight mesh with 6 rank-colored highlight meshes (5 ranks + grey), each with independent thin-instance buffers

**Requirements:** R1, R3, R4

**Dependencies:** Unit 1

**Files:**
- Modify: `game/client/src/scene/CoinMeshManager.ts`

**Approach:**
- Replace `highlightMesh`, `hlBuffer`, `hlIdToIndex`, `hlIndexToId`, `hlActive`, `hlTimers`, `hlPending` with arrays of 6 (one per color index)
- New `createRankHighlightPrototypes()` creates 6 meshes using `createToonMaterial` with each rank color's `Color3.FromHexString()`
- `addHighlight(coinId)` → `addRankHighlight(coinId, colorIndex)` — same swap-and-pop logic but targets the indexed buffer
- `updateHighlights()` → iterates all 6 buffers, same expire/sync/GPU-push logic per buffer
- `removeHighlight(coinId)` needs a `coinToColorIndex` Map to find which buffer the coin is in
- Initial capacity: 10 per rank buffer, 20 for grey
- Cleanup in `clear()` and `dispose()` must handle all 6 meshes

**Patterns to follow:**
- `sponsorPrototypes` / `sponsorBuffers` pattern for per-variant mesh management
- Current `addHighlight` / `removeHighlight` / `updateHighlights` for buffer logic

**Test scenarios:**
- Happy path: `addRankHighlight(coinId, 0)` allocates in rank-0 buffer, visible for HIGHLIGHT_DURATION then auto-expires
- Happy path: `addRankHighlight(coinId, 5)` allocates in grey buffer (non-ranked player)
- Edge case: coin removed before highlight expires — highlight cleaned up without errors
- Edge case: buffer at capacity — auto-resizes and highlight still added
- Edge case: `addRankHighlight` called before coin is in main buffer — deferred via pending set per color index
- Integration: `updateRankHighlights()` syncs positions from source coin buffer for all 6 color groups in one frame tick

**Verification:**
- 6 highlight meshes created on init, each with distinct toon material color
- Adding highlights to different color indices populates the correct buffers
- Expired highlights are removed from the correct buffer

---

- [ ] **Unit 3: Update SceneManager API**

**Goal:** Expose `addRankHighlight(coinId, colorIndex)` through SceneManager

**Requirements:** R3

**Dependencies:** Unit 2

**Files:**
- Modify: `game/client/src/scene/SceneManager.ts`

**Approach:**
- Replace `addCoinHighlight(coinId)` with `addCoinHighlight(coinId, colorIndex)` (or add colorIndex as optional param defaulting to RANK_NONE for backwards compat)
- `updateCoinHighlights()` unchanged — delegates to CoinMeshManager which now iterates all 6 buffers

**Test expectation:** none — thin passthrough, tested via Unit 2

**Verification:** App.tsx can call `sceneManager.addCoinHighlight(coinId, rankIndex)`

---

- [ ] **Unit 4: Wire coin spawn to rank-colored highlights**

**Goal:** On `coin_spawn`, look up each coin's owner in the top-5 map and apply the correct rank color highlight (or grey for self if unranked)

**Requirements:** R3, R4, R5, R6

**Dependencies:** Unit 1, Unit 3

**Files:**
- Modify: `game/client/src/App.tsx`

**Approach:**
- Add a `top5MapRef = useRef<Map<string, number>>()` — maps userId → rank index (0-4)
- In `onHeatUpdate` handler: rebuild `top5MapRef.current` from sorted top-5 entries
- In `onCoinSpawn` handler: for each coin:
  - If `owner_id` in `top5MapRef` → `addCoinHighlight(coin.id, top5MapRef.get(owner_id))`
  - Else if `owner_id === myUserId` → `addCoinHighlight(coin.id, RANK_NONE)` (grey)
  - Else → no highlight (other players not in top 5)
- R5 is handled naturally: if player is top-5, their userId is in the map, so their coins get rank color
- R6 is handled naturally: only new coin spawns use the current map state; existing highlights are unaffected

**Patterns to follow:**
- Existing `onCoinSpawn` handler structure at App.tsx:289-302
- `keyCoinIdsRef` / `sponsorCoinIdsRef` ref pattern

**Test scenarios:**
- Happy path: top-5 player's coin gets rank-colored highlight matching their position
- Happy path: own coin gets grey highlight when not in top 5
- Happy path: own coin gets rank color when in top 5 (R5)
- Edge case: `coin_spawn` arrives before first `heat_update` — no top5Map entries, own coins still get grey
- Edge case: player drops from top 5 between heat updates — new coins get grey, old highlights keep rank color until expiry (R6)
- Integration: heat_update rebuilds map → next coin_spawn uses updated ranks

**Verification:**
- Top-5 players' coins show rank-colored overlays on the board
- Own coins show grey when unranked, rank color when ranked
- Rank changes reflected in subsequent coin drops, not retroactively

---

- [ ] **Unit 5: Leaderboard UI rank colors**

**Goal:** Color each player's name text in the leaderboard with their rank color

**Requirements:** R2

**Dependencies:** Unit 1

**Files:**
- Modify: `game/client/src/ui/Leaderboard.tsx`
- Modify: `game/client/src/ui/Leaderboard.css`

**Approach:**
- Import `RANK_COLORS` from shared types
- Apply `style={{ color: RANK_COLORS[entry.rank - 1] }}` to each player's username span
- Rank 1 "on-fire" styling should incorporate the red rank color (may need adjustment to ensure fire effects still read well with red text)
- Player's own rank row (below divider, if shown) also gets their rank color

**Patterns to follow:**
- Existing inline style patterns in Leaderboard.tsx
- Current rank-1 "on-fire" CSS class

**Test scenarios:**
- Happy path: each of 5 leaderboard rows shows username in its rank color
- Happy path: own rank row (below divider) shows rank color when in top 5
- Edge case: rank 1 fire effects remain visually distinct with red text
- Edge case: leaderboard transitions (rank swap) — colors update smoothly with position animation

**Verification:**
- Leaderboard names visually match the coin highlight colors on the board
- Fire effects on rank 1 still look good with red-colored text

## System-Wide Impact

- **Interaction graph:** `heat_update` → top5Map ref → `coin_spawn` handler → `SceneManager.addCoinHighlight` → `CoinMeshManager.addRankHighlight`. No callbacks or middleware affected.
- **Error propagation:** If rank highlight mesh creation fails, coins simply won't highlight — no crash risk. Same resilience as current single-highlight system.
- **State lifecycle risks:** `top5MapRef` and highlight buffers are independent. Heat updates can arrive at any time without breaking in-flight highlights.
- **API surface parity:** No server changes. `coin_spawn` and `heat_update` message formats unchanged.
- **Integration coverage:** The full flow (heat_update → map rebuild → coin_spawn → colored highlight → frame update → expiry) should be traced manually during visual testing.
- **Unchanged invariants:** Key coin highlights, sponsor coin rendering, and regular coin buffer management are untouched. Sponsor coins with highlights will use the rank color overlay (same as current cyan overlay behavior).

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| Rank colors don't look good as toon-material overlays on gold coins | Tune hex values during implementation; test all 5 colors visually |
| 6 extra draw calls on mobile performance | Monitor FPS; highlight coin count is capped at ~30, negligible vs 700+ regular coin instances |
| Sponsor coins + rank highlights interaction | Rank highlight overlays sponsor coins the same way cyan currently does — no special handling needed |

## Sources & References

- **Origin document:** [docs/archive/brainstorms/2026-04-18-leaderboard-coin-colors-requirements.md](docs/archive/brainstorms/2026-04-18-leaderboard-coin-colors-requirements.md)
- Sponsor coin pattern: `game/client/src/scene/CoinMeshManager.ts:55-57, 573-669`
- Current highlight system: `game/client/src/scene/CoinMeshManager.ts:65-74, 197-845`
- Heat update flow: `game/client/src/App.tsx:304-322`
- Coin spawn handler: `game/client/src/App.tsx:289-302`
