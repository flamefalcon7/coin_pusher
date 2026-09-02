---
title: "perf: Increase state_delta frequency from 15Hz to 30Hz"
type: perf
status: abandoned
date: 2026-03-29
reviewed: 2026-09-02
outcome: "Implemented in 4bdc56e, reverted same day (966bdbe, 40e02eb). State delta stays at 15Hz."
---

# perf: Increase state_delta frequency from 15Hz to 30Hz

## Overview

Coin collisions with pins feel "fake" over network compared to local play. Root cause: state_delta publishes at 15Hz (every 67ms), but collisions complete in 2-3 physics frames (66-100ms). Linear interpolation (LERP) between these sparse frames smooths out sharp collision bounces into straight-line slides.

```
Server physics (30Hz):
  T=0:    coin at (0, 1.0) moving down
  T=33ms: coin at (0, 0.8) moving down
  T=67ms: coin HITS PIN → bounces to (0.1, 0.85) moving right+up

Client sees at 15Hz:
  Delta 1 (T=0):    coin at (0, 1.0)
  Delta 2 (T=67ms): coin at (0.1, 0.85)
  LERP: smooth diagonal slide from A→B. No bounce visible.
```

Doubling to 30Hz captures pre-collision and post-collision positions at 33ms intervals, preserving collision detail through interpolation.

## Proposed Solution

Change one constant:

```typescript
// game/shared/src/types.ts:390
NETWORK_SEND_INTERVAL: 1,  // was 2. Now publishes state_delta every physics tick (30Hz)
```

## Technical Considerations

### Bandwidth Impact

state_delta only includes non-sleeping (moving) coins. The skip condition is `coin.isSleeping()`, not "position unchanged since last frame," so every awake coin is included regardless of movement magnitude. This means each delta has roughly the same number of coins at both 15Hz and 30Hz. Typical awake count: 20-50.

| Metric | 15Hz (current) | 30Hz (proposed) |
|--------|----------------|-----------------|
| Deltas per second | 15 | 30 |
| Avg coins per delta | ~40 | ~40 (same — all awake coins included) |
| Approx bytes per delta | ~1.3KB | ~1.3KB |
| Per-player bandwidth | ~20KB/s | ~40KB/s |
| 10 players | ~200KB/s | ~400KB/s |

This is a true 2x bandwidth increase. Still well within acceptable range: ~400KB/s for 10 players is 1/6 of a YouTube 720p stream, and fits easily within DO's 1TB/month included bandwidth (~1.04TB/month at 400KB/s continuous).

### CPU Impact (WASM calls)

`GameLoop.ts:248-312`: State collection reads position + rotation from Rapier WASM for every non-sleeping coin. The original comment says: "Saves ~600 translation() WASM calls per skipped tick."

At 30Hz, these WASM FFI calls happen every tick instead of every other tick:
- Current: ~600 calls × 15Hz = 9,000 WASM calls/s (for state collection)
- Proposed: ~600 calls × 30Hz = 18,000 WASM calls/s

The physics step itself (substeps, collision detection) already runs at 30Hz and is the dominant cost. State collection is just `getPosition()` + `getRotation()` reads, much cheaper than simulation. But this should be verified with the existing per-phase profiling (`stateCollectMs` in tick timings).

### Client Interpolation Impact

- `Interpolator.ts`: No code changes needed. LERP/SLERP work at any frequency.
- `StateBuffer.ts`: Ring buffer holds 100 states. At 30Hz = 3.3s of history (currently 6.6s at 15Hz). Still sufficient for the max interpolation delay of 500ms.
- `ClockSync.ts`: State-delta offset samples at 30Hz instead of 15Hz. More samples per second → faster convergence. No negative effect.
- Adaptive interpolation delay formula (`max(RTT * 1.5, 110ms)`) is RTT-based, unaffected by publish rate.

### Despawn Timing

Despawn detection (`GameLoop.ts:252-278`) is currently only on network ticks. At 30Hz, despawns are detected every tick. Coins falling below `DESPAWN_Y` will be caught ~33ms sooner. No functional issue, slightly faster cleanup.

## Acceptance Criteria

- [ ] `PHYSICS_CONFIG.NETWORK_SEND_INTERVAL` changed from `2` to `1` in `game/shared/src/types.ts`
- [ ] Update comment on that line from "2 = 15Hz" to "1 = 30Hz"
- [ ] Update comment at `GameLoop.ts:250` and `GameLoop.ts:386` to reflect 30Hz
- [ ] Verify game runs without errors locally
- [ ] Compare collision feel: play locally → deploy → play over network, specifically coin-pin bounces
- [ ] Monitor `stateCollectMs` profiling metric to confirm CPU impact is acceptable (<2ms per tick)

## Context

### Files Changed

| File | Change |
|------|--------|
| `game/shared/src/types.ts:390` | `NETWORK_SEND_INTERVAL: 2` → `1` |
| `game/server/src/game/GameLoop.ts:250` | Update comment |
| `game/server/src/game/GameLoop.ts:386` | Update comment |

### Rollback

If CPU impact is too high or bandwidth is problematic, revert to `NETWORK_SEND_INTERVAL: 2`. One-line change, zero risk.

### Future Optimization (if 30Hz still not enough)

Add velocity vectors to state_delta protobuf (`velX`, `velY`, `velZ`) and switch interpolator from LERP to Hermite spline. This preserves collision direction changes even with lower publish rates. Higher effort: protobuf schema change + server + client interpolator rewrite.
