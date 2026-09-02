---
title: "Research: Coin Damping Analysis"
type: research
status: completed
date: 2026-03-29
reviewed: 2026-09-02
outcome: "Recommendation applied in 4d520a0 (damping 4.0/5.0 -> 3.0/4.0). Debug sliders never added."
---

# Research: Coin Damping Analysis

## Overview

Analysis of whether the current coin damping values (linear=4.0, angular=5.0) in the Rapier3D physics engine are reasonable for a coin pusher game. The user chose these values empirically for feel. This document validates that choice with math, explains the tradeoffs, and identifies if any adjustments are worth exploring.

## Current Configuration

```
game/server/src/physics/Coin.ts:42-43
game/server/src/physics/KeyCoin.ts:42-43

.setLinearDamping(4.0)
.setAngularDamping(5.0)
```

Related physics parameters:

| Parameter | Value | File |
|-----------|-------|------|
| Tick rate | 30Hz (2 substeps = 60 physics steps/s) | `shared/src/types.ts:382` |
| Gravity | -9.81 m/s² | `shared/src/types.ts` |
| Coin mass | 0.01 kg | `shared/src/types.ts` |
| Coin friction | 0.7 | `shared/src/types.ts` |
| Coin restitution | 0.3 | `shared/src/types.ts` |
| Pin restitution | 0.95 | `server/src/physics/SceneBuilder.ts` |
| Sleep threshold | 0.1 m/s linear, 0.1 rad/s angular | `server/src/physics/config.ts` |

## How Rapier Damping Works

### The Formula

Each physics substep, Rapier multiplies velocity by a decay factor:

```
v_new = v_old × (1 / (1 + dt × damping))
```

This is an implicit Euler approximation of exponential decay `e^(-d×t)`. It's always stable (never overshoots to negative), which is why physics engines prefer it.

Source: [rapier/src/dynamics/rigid_body_components.rs](https://github.com/dimforge/rapier/blob/master/src/dynamics/rigid_body_components.rs)

### Rapier Defaults

Both linear and angular damping default to **0.0** (no damping). Objects retain velocity indefinitely unless collisions or other forces act on them.

## Analysis of Current Values

### Velocity Decay Rate

With 30Hz tick rate + 2 substeps, each substep dt = 1/60 ≈ 0.0167s:

| Damping | Per-step multiplier | After 0.5s | After 1s | After 2s |
|---------|-------------------|------------|----------|----------|
| 0.5 | 0.9917 | 60.7% | 36.8% | 13.5% |
| 1.0 | 0.9836 | 37.0% | 13.7% | 1.9% |
| 2.0 | 0.9677 | 13.7% | 1.9% | 0.04% |
| **4.0** | **0.9375** | **1.9%** | **0.04%** | **~0%** |
| **5.0** | **0.9231** | **0.7%** | **0.005%** | **~0%** |
| 10.0 | 0.8571 | 0.01% | ~0% | ~0% |

**Your coins lose ~98% of free velocity within 0.5 seconds.** This is aggressive by general physics game standards, but makes sense for a coin pusher (more on this below).

### Terminal Fall Velocity

Damping opposes all velocity, including gravity-induced. Terminal velocity:

```
v_terminal ≈ gravity / damping = 9.81 / 4.0 = 2.45 m/s
```

Without damping, a coin dropped from spawn height (1.5m) would hit at `√(2 × 9.81 × 1.5) ≈ 5.4 m/s`. With damping=4.0, it's capped at ~2.45 m/s. This reduces collision energy on landing, which improves stability.

### Spin Decay

Angular damping of 5.0 is higher than linear (4.0), meaning spin stops faster than sliding. After 0.5s, only 0.7% of angular velocity remains. Coins essentially stop spinning within half a second of losing contact.

## Is Damping=4.0 Reasonable?

### Context: What Other Games Use

| Use Case | Typical Damping | Notes |
|----------|----------------|-------|
| Space / zero-G | 0.0 | No drag |
| Realistic air resistance | 0.01-0.1 | Large dense objects |
| Tabletop / board games | 0.5-2.0 | Pieces slide but eventually stop |
| Coin pusher / arcade | 2.0-5.0 | Objects should stop quickly |
| Viscous / water | 5.0-10.0 | Barely any coasting |
| Instant stop | 10.0+ | Objects freeze on release |

**Your value of 4.0 is on the high end of the "coin pusher" range.** It's not unreasonable, but it's a specific choice with tradeoffs.

### What Damping=4.0 Gives You (Pros)

1. **Coins stop quickly on the platform** - after the pusher retracts, coins settle fast instead of sliding around. This prevents chaotic sliding.
2. **Predictable pusher interaction** - coins only move when directly contacted by the pusher. The "influence zone" is narrow. Player can predict which coins will move.
3. **Stability with 500+ coins** - high damping reduces total kinetic energy in the system, meaning fewer chaotic multi-body interactions. This is why you previously bumped damping to 10.0 for stability.
4. **Reduced tunneling risk** - slower velocities mean less chance of thin coins passing through colliders.
5. **Terminal velocity cap** - coins can't fall faster than 2.45 m/s, which helps CCD and collision stability.

### What Damping=4.0 Costs You (Cons)

1. **"Heavy" or "sticky" feel** - coins feel like they're moving through honey. They don't coast or slide naturally after being bumped. This is the main feel issue with high damping.
2. **Pusher cascade is limited** - when the pusher hits the front row, momentum doesn't propagate far into the coin field because each coin's velocity decays before it can bump the next coin effectively. This reduces the satisfying "chain reaction" effect.
3. **Pin bounces are damped quickly** - coins hitting pins at 0.95 restitution bounce off, but the bounce velocity decays so fast (98% gone in 0.5s) that the bounce trajectory is very short. This was the original "fake collision" complaint.
4. **Gravity compensation** - damping fights gravity equally, so coins on the 2° tilted platform barely slide forward under their own weight. The tilt becomes less effective at migrating coins toward the edge.

### The Tradeoff Triangle

```
    STABILITY (high damping)
        /\
       /  \
      /    \
     / 4.0  \     ← you are here
    /________\
NATURAL     CASCADE
FEEL        RANGE
(low damp)  (medium damp)
```

- **Damping 1.0-2.0**: More natural sliding, longer cascade chains, but potentially chaotic with 400+ coins
- **Damping 2.0-3.0**: Sweet spot for many arcade physics games. Coins slide a bit, pin bounces travel further, cascade effect is stronger
- **Damping 4.0-5.0**: Very controlled. Coins stop fast. Stable but less dynamic. Your current choice.

## Damping Value History

| Date | Linear | Angular | Reason |
|------|--------|---------|--------|
| Nov 2025 | 5.0 | ? | Initial values |
| Nov 30, 2025 | 10.0 | 10.0 | Stability with 500+ coins, chamfered cylinder |
| Dec 3, 2025 | 5.0 | 5.0 | Enhanced responsiveness |
| Mar 13, 2026 | **4.0** | **5.0** | "More natural movement", removed pin impulse system |

The trend is downward: 10 → 5 → 4. Each reduction improved feel at the cost of some stability.

## Recommendation

**Your current values are reasonable for the stability-first approach.** Damping=4.0 is a legitimate choice for a coin pusher with 400+ coins. The feel tradeoff (coins stopping too quickly) is real, but your pin restitution of 0.95 partially compensates by giving coins a strong initial bounce.

### If You Want to Experiment

The one parameter worth testing is **lowering linear damping to 2.0-3.0**:

| Change | Expected Effect | Risk |
|--------|----------------|------|
| Linear 4.0 → 3.0 | Coins slide ~3x further after contact. Pin bounces travel further. Cascade chains longer. | Slightly less stable with high coin counts |
| Linear 4.0 → 2.0 | Coins feel much more "alive". Significant cascade improvement. Platform tilt becomes more effective. | May need to reduce pusher amplitude to compensate for increased coin mobility |
| Angular 5.0 → 3.0 | Coins spin more after bouncing off pins. More visual variety. | Spinning coins can feel chaotic |

**If you test this**: use the debug panel (`?debug=1`) approach. Add damping sliders to `debugConfig.ts` and `DebugPanel.ts`, same as the interpolation params. Tune live, find the sweet spot, then hardcode.

### What NOT to Change

- Don't go below 1.0 linear damping. Coins will slide off the platform too easily.
- Don't change angular damping without also changing linear. Keep angular ≥ linear.
- Don't reduce damping without first testing with 400+ coins. The stability regression is real.

## Sources

- [Rapier source: rigid_body_components.rs](https://github.com/dimforge/rapier/blob/master/src/dynamics/rigid_body_components.rs) (damping formula)
- [Rapier JS damping docs](https://rapier.rs/docs/user_guides/javascript/rigid_body_damping/)
- [Bullet Physics coin pusher thread](https://pybullet.org/Bullet/phpBB3/viewtopic.php?t=3623)
- `game/server/src/physics/Coin.ts:42-43` (current values)
- Git history: commits d20d756, 215707a, 5155e17 (damping evolution)
