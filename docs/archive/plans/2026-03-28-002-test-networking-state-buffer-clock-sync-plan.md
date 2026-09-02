---
title: "test: Unit tests for StateBuffer and ClockSync"
type: test
status: completed
date: 2026-03-28
reviewed: 2026-09-02
outcome: "Shipped in 85cd2c8: StateBuffer + ClockSync unit tests."
---

# test: Unit tests for StateBuffer and ClockSync

## Overview

`game/client/src/net/` has zero test coverage. StateBuffer and ClockSync are the two highest-value targets: pure math, no DOM/BabylonJS dependencies, no mocking needed. Both have had real bugs in production (EMA convergence too slow, clock sync to wrong machine, binary search edge cases).

## Problem Statement

We've already shipped 3 bugs in this code path that were only caught by manual profiling:
1. Clock sync calibrated to Go backend instead of Game Server (caused 56% extrapolation)
2. EMA smoothing converged too slowly (caused extrapolation spikes on connect)
3. Interpolation delay reduction made extrapolation worse (parameter regression)

Tests would have caught #2 and #3 before deploy.

## Scope

**In scope:**
- `StateBuffer.ts` — ring buffer, binary search, wrap-around, edge cases
- `ClockSync.ts` — median offset, RTT measurement, state_delta sync, ping interval

**Out of scope:**
- `Interpolator.ts` — needs StateBuffer + ClockSync mocks, more complex setup. Add later.
- `GameClient.ts` — callback wiring, needs WebSocket mock. Low value.
- `WebSocketClient.ts` — browser API wrapper. Not worth testing.

## Technical Approach

### Test Framework

Vitest (already configured in `game/client/vitest.config.ts`). Environment: node. Globals enabled.

### File Structure

```
game/client/src/net/__tests__/
  StateBuffer.test.ts
  ClockSync.test.ts
```

### StateBuffer Test Cases

StateBuffer is a ring buffer with capacity 100, O(1) add, binary search for interpolation.

```
StateBuffer
├── addState()
│   ├── adds states and increments count
│   ├── wraps around at capacity (ring buffer behavior)
│   └── overwrites oldest when full
│
├── getStatesForInterpolation(targetTime)
│   ├── returns null when buffer has < 2 states
│   ├── finds correct before/after pair for targetTime between two states
│   ├── finds correct pair when targetTime is near boundaries
│   ├── returns null when targetTime is before all states (too old)
│   ├── returns null when targetTime is after all states (too new)
│   ├── works correctly after ring buffer wraps around
│   └── reuses result object (same reference returned)
│
├── getNewestState() / getNewestTime() / getOldestTime()
│   ├── returns null/0 when empty
│   ├── returns correct state before wrap
│   └── returns correct state after wrap
│
├── getPreviousState(currentState)
│   ├── returns null when < 2 states
│   ├── returns the state before the given state
│   └── returns null when given state is the oldest
│
├── clear()
│   └── resets count, head, all entries null
│
└── getBufferSize()
    └── returns correct count at 0, partial, and full capacity
```

### ClockSync Test Cases

ClockSync manages clock offset via state_delta timestamps (median of 30 samples) and RTT via ping/pong.

```
ClockSync
├── recordStateDeltaTime(gameServerTime)
│   ├── single sample: offset = gameServerTime - clientNow
│   ├── multiple samples: offset = median (not mean)
│   ├── caps at 30 samples (oldest dropped)
│   ├── handles outliers (median rejects them)
│   └── handles clock jump (new median converges)
│
├── getServerTime()
│   └── returns Date.now() + offset
│
├── getOffset()
│   └── returns current offset value
│
├── recordPong(clientSendTime, serverTime)
│   ├── calculates RTT correctly
│   ├── caps samples at RTT_SAMPLES (12)
│   └── no longer affects offset (only RTT)
│
├── getRTT()
│   ├── returns 0 when no samples
│   ├── returns median RTT (not mean)
│   └── handles outlier RTT values
│
└── shouldSendPing()
    ├── returns true on first call
    ├── returns false before PING_INTERVAL
    └── returns true after PING_INTERVAL elapsed
```

### Key Test Patterns

**Time control:** Use `vi.useFakeTimers()` + `vi.setSystemTime()` to control `Date.now()`. This lets us test ClockSync without real network latency.

```typescript
vi.useFakeTimers();
vi.setSystemTime(1000);
clockSync.recordStateDeltaTime(1050); // server is 50ms ahead
expect(clockSync.getOffset()).toBe(50);
```

**Ring buffer verification:** Fill buffer to capacity, then add more. Verify oldest is evicted and binary search still works across the wrap boundary.

**Median stability:** Feed 30 samples with one outlier, verify the outlier doesn't affect the result (median property).

## Acceptance Criteria

- [ ] `StateBuffer.test.ts` — all branches covered including ring buffer wrap-around
- [ ] `ClockSync.test.ts` — all branches covered including median stability and time control
- [ ] `pnpm --filter @coin-pusher/client exec vitest run src/net/__tests__/` passes
- [ ] No mocking of external modules (these are pure math classes)

## Sources

- `game/client/src/net/StateBuffer.ts` — 129 lines, ring buffer + binary search
- `game/client/src/net/ClockSync.ts` — 94 lines, median offset + RTT
- `game/client/vitest.config.ts` — test framework config
- `game/shared/src/types.ts:431` — NETWORK_CONFIG constants
- Existing test examples: `game/client/src/scene/__tests__/SceneManager.test.ts`
