---
module: game-server
date: 2026-08-02
problem_type: correctness
component: physics-loop
severity: high
symptoms:
  - "Pusher Z broadcast to clients disagrees with the pusher's real physics position by ~10mm (222mm during a super push)"
  - "Simulated time falls behind wall clock over long runs, with no individual tick ever looking slow"
  - "Every coin on the table keeps CCD enabled, including ones asleep in the pile"
  - "Coins dequeued from DropScheduler at the body cap are discarded — player debited, coin never appears"
  - "A single throw inside tick() terminates the process and disconnects the whole room"
  - "The live game loop cannot be replayed: physics randomness comes from Math.random()"
tags:
  - rapier
  - kinematic-body
  - fixed-timestep
  - determinism
  - rtp
---

# Server tick and sync audit (2026-08-02)

Eight defects in the game server's physics loop, found by static audit and each
confirmed with a failing test before it was fixed. Commits `4eb373e`..`4594124`
on `fix/server-tick-and-sync`.

## Provenance note: the handover was stale

The audit started from a handover document written against an earlier PoC
(`server/src/**`, a Node process owning its own WebSocket server). The current
code is `game/server/src/**` and runs as a NATS worker behind a Go relay. Of
13 reported bugs, 7 still existed, 1 was partially fixed, and 5 were already
fixed or no longer applicable:

| Reported | Status when audited |
|---|---|
| Pusher double integration | live |
| No coin cap | partial — cap existed, but only on one of six spawn paths |
| Unseeded `Math.random()` | live, and wider than reported |
| CCD flag desync | live |
| `setInterval` with no accumulator | live |
| Pusher on `Date.now()` | live |
| O(N) msgpack encode per connection | **obsolete** — no WS layer in the server since the NATS move |
| `logStats` double-encode | **already fixed** — rewritten as a percentile report |
| `state_delta` is a full snapshot | **already fixed** — sleeping coins skipped, 15Hz |
| WebSocket startup race | **obsolete** — NATS subscriptions register after physics init |
| No `try/catch` in `tick()` | live |
| Side-wall quaternion not normalized | **already fixed** — uses `sin(θ/2)`/`cos(θ/2)` |
| Quantized quaternion not re-normalized | live (client side) |

Lesson: audit a handover against the tree before acting on it. Half of this
one described code that no longer exists.

## Root causes and fixes

### 1. Pusher broadcast ≠ pusher physics position

The body was `kinematicVelocityBased` and each tick set **both** a velocity and
an absolute translation to the analytic value. Rapier integrated the velocity
on top of the position already written, so the body finished each step a full
tick of travel past the value being broadcast. `PhysicsWorld.step()` also runs
`SUBSTEPS=2` solver steps while the pusher was updated once per tick, so that
velocity was integrated twice.

Fixed by switching to `kinematicPositionBased` + `setNextKinematicTranslation()`
— Rapier's documented approach for a body whose position is a formula, which
derives contact velocity from the position delta and makes double integration
impossible by construction — and by advancing the pusher once per substep from
inside `PhysicsWorld.step()`.

The hand-derived analytic velocities in the super-push state machine were
deleted with it; each phase now yields a target position only.

**Risk checked, not assumed:** `setNextKinematicTranslation()` has no `wakeUp`
flag, unlike the `setLinvel(..., true)` it replaced. `pusher.contact.test.ts`
pins that a coin forced asleep inside the stroke is still woken and moved.
Rapier does wake dynamic bodies on kinematic contact.

### 2. Coins dequeued and thrown away at the cap

`MAX_ACTIVE_COINS` was checked *inside* the loop over `dropScheduler.tick()`
results, with a `break`. But `tick()` decrements the queue as it hands out
drops, so every drop dequeued after the cap bit was destroyed — the player had
already been debited.

Fixed by testing the cap **before** dequeuing, so the queue is held and those
coins drop later. Cost: a bounded overshoot of (slots − 1) = 4 bodies, since
one tick can return one drop per slot.

The cap was also missing from five other spawn paths (`coin_insert`,
`spawn_stack`, sponsor coins, slot bonus rain, wheel key-coin rain,
`fillPlatform`). All now go through `atCoinCap()`; the two rain paths check at
`setTimeout` fire time, not schedule time, because the table fills while the
rain is in flight.

### 3. Drift, and two clocks

`GameLoop` drove physics from a bare `setInterval`. `setInterval` only promises
"not earlier than", so every late firing loses time that nothing repays.
`TickScheduler` already existed with a comment promising drift correction but
was dead code — `GameLoop` held its own `setInterval`.

Separately, coins advanced by fixed dt (simulated time) while `Pusher` read
`Date.now()` (wall time). Drift between them silently changed the phase
relationship between the pusher and the coins it pushes.

Fixed by implementing the accumulator pattern in `TickScheduler` (measure real
elapsed time with `process.hrtime.bigint()`, spend it in whole dt steps, carry
the remainder), driving `GameLoop` through it, and deriving pusher time from
the tick index.

Two decisions worth keeping in mind:
- **Catch-up is capped at 5 steps (~166ms).** Beyond that the debt is dropped
  and counted rather than replayed; replaying a long stall costs more than the
  stall and spirals.
- **Only the last step of a burst emits network state.** Clients interpolate
  against arrival time, so several snapshots in one millisecond make them jump.
  Discrete events (spawn/despawn/ability) still publish on every step.

### 4. CCD flag that could never be cleared

`Coin`, `KeyCoin` and `SponsorCoin` each declared `ccdEnabled = false` as a TS
shadow copy while the constructor called `rigidBody.enableCcd(true)`. The two
never agreed, so the "disable CCD once slow and low" branch was guarded by a
flag that was already false and could never run.

Fixed by deleting the shadow state and reading/writing the flag on the rigid
body itself.

**The performance rationale did not survive measurement — see below.**

### 5. Unguarded tick

A throw inside a `setInterval` callback becomes an `uncaughtException`, and
Node terminates by default. Stale coin references are a live failure mode:
`Coin.destroy()` nulls the rigid body, so a coin left in the map throws on
every subsequent access.

`tick()` is now a guard around `runTick()` that logs, counts
(`coinpusher_game_tick_errors_total`), and sweeps out coins whose rigid body no
longer answers — turning a permanent crash loop into one lost tick. After 30
consecutive failures it stops deliberately rather than spinning at 30Hz writing
stack traces. `index.ts` gained `uncaughtException` / `unhandledRejection`
handlers that drain and exit non-zero.

### 6. Unseeded physics randomness

All physics perturbation came from `Math.random()`, so a disputed round could
not be replayed and a physics parameter change could not be regression-tested.
Now drawn from a per-session `xoshiro128**` seed, logged and carried in
`world_snapshot.rng_seed`, overridable via `SESSION_RNG_SEED`.

Slot reels and the wheel segment deliberately stay on `node:crypto` — see
**ADR D-005**, which also records that replay is therefore partial and that
Rapier only guarantees determinism for the same WASM build on the same
platform.

### 7. Quantized quaternions are not unit quaternions

The server normalizes rotations and *then* quantizes to 3 decimals, so what
arrives is off the unit sphere by up to 7.9e-5. SLERP does not repair it. Fixed
on the client (`Interpolator.slerpInto`), which is where the value is finally
used as a rotation and the only place that can promise unit length.

## Before / after

| Measure | Before | After | How measured |
|---|---|---|---|
| Pusher broadcast vs physics Z, steady | **10.05 mm** | **2.7e-8 m** | `pusher.sync.test.ts`, 900 ticks |
| Pusher broadcast vs physics Z, super push | **221.7 mm** | **2.8e-8 m** | same, full super-push cycle |
| Tick drift, timer 2ms late every firing | **5.7 %** | **< 0.5 %** | `tickScheduler.test.ts`, 10 simulated minutes |
| Catch-up after a 10s stall | 300 ticks replayed | 5 steps + 1 recorded spiral event | `tickScheduler.test.ts` |
| Coins with CCD on after settling (20 coins) | **20 / 20** | **0 / 20** | `coin.ccd.test.ts` |
| Physics step cost, 400 coins | 5.05 ms/tick | 4.84 ms/tick (**−4.2 %**) | interleaved A/B, median of 6 |
| Physics step cost, 200 coins | 2.01 ms/tick | 1.98 ms/tick (**−1.7 %**) | interleaved A/B, median of 6 |
| Coins lost at the cap (40 queued, 400 ticks) | **4 destroyed** | **0** | `gameLoop.coinCap.test.ts`, mutation-tested |
| Live-loop replay from a seed | impossible | bit-identical | `gameLoop.determinism.test.ts` |
| Interpolated quaternion norm error | 7.9e-5 | < 1e-6 | `Interpolator.quaternion.test.ts` |
| Aggregate RTP (seed 7) | — | **2.67 %** (band 0–50 %) | `economy.test.ts` |

**The RTP row was wrong when first written.** It read 7.33%, measured against a SimLoop that had
not been migrated to the per-substep pusher contract and was therefore simulating a pusher the live
server does not have (double-speed for half the tick, frozen for the rest). With the harness fixed,
the same seed and config give 2.67%. The corrected number is the one that describes production —
and the drop is the honest consequence of the pusher fix, which replaced a lurching overshoot with
correct constant-velocity contact. Whether 2.67% is the right target is a tuning decision, not a
code one. The 0–50% band is far too wide to have caught either the error or the shift.

## Corrected misdiagnosis: CCD was not the CPU problem

The handover asserted that always-on CCD was "the main cause of the CPU blow-up".
Measurement does not support that. Retiring CCD saves **1.7 % at 200 coins and
4.2 % at 400** — real, but an order of magnitude short of the claim.

Two methodology traps produced much more dramatic (and wrong) numbers first:

1. **Comparing two separately-settled worlds.** They end up with different
   surviving and sleeping coin counts, which swamps the effect. Measure both
   arms on one settled world.
2. **Measuring A then B.** JIT and cache drift over the run swings the result by
   20–38 % and *flips its sign* depending on which arm runs first. Interleaving
   A/B/A/B and taking medians brought it to a stable ±few percent.

Why the effect is small: in a dense pile only ~7 of ~373 coins actually reach
Rapier's sleep thresholds, and CCD's sweep test is cheap for slow bodies, so
the flag being set costs little for exactly the coins that were keeping it set.

The fix is still right — it removed a shadow state that could not agree with
Rapier and a branch that could never execute — but it should be justified as
correctness, not throughput.

## What a code review of this work then found

The eight fixes above were reviewed by nine independent reviewers. It found five further defects —
three of them introduced or left incomplete by these very commits — and four tests that passed
against the code they were written to protect. Fixed in `1f8fd26` and `628a80e`:

- **Sponsor quota charged for coins that never spawned.** Adding the cap guard to the sponsor spawn
  path turned a never-fires return into a routinely-fires one, and the caller still decremented the
  quota — over-reporting delivered impressions to a paying advertiser.
- **SimLoop never adopted the per-substep pusher contract** (the RTP correction above).
- **`evictUnusableCoins()` released neither the Rapier body nor a despawn message.**
- **xoshiro128\*\* applied its scrambler to `s[0]`**, not `s[1]` as the reference does — verified
  against `prng.di.unimi.it`. Period held; the output was not the tested function.
- **Client quaternion normalisation covered 1 of 5 paths**, missing extrapolation — the path that
  runs exactly when updates are starved.

Two claims made in this document's first version were overstated and are corrected above and in the
README: the server does **not** run on a single clock (tornado and lightning still measure duration
against `performance.now()`), and replay is therefore not end-to-end for any session containing an
ability. The determinism test only enqueues coin drops, so it went green while the claim was false.

Still open, both needing a product decision rather than a patch:

1. **The tick-error breaker leaves a zombie.** After 30 consecutive failures the loop stops but does
   not exit or unsubscribe, so `batch_insert` keeps enqueuing coins the backend has already debited
   into a simulation that no longer runs. Options: exit non-zero and let the supervisor restart, or
   unsubscribe and serve degraded with a readiness signal.
2. **The seeded/crypto boundary is drawn one call site too wide.** Lightning strike coordinates come
   from the published seed while the player chooses when to spend the scroll — a predictable,
   payout-affecting outcome under player control, which is the exact class D-005 argues belongs on
   `node:crypto`. Note that a 32-bit seed is brute-forceable from broadcast data, so simply removing
   `rng_seed` from the snapshot is not sufficient on its own.

## Watch items

- `coinpusher_game_tick_errors_total` — any non-zero value means a lost tick.
- `coinpusher_coin_spawns_rejected_total{source}` — capacity signal, not an error.
- `TickScheduler` spiral events in logs — sustained occurrences mean ticks are
  routinely overrunning, not that the cap is wrong.
- Side-shelf coins (`TOP_Y=1.5m`) sit above `CCD_DISABLE_HEIGHT=0.5m` and keep
  CCD forever. Bounded and deliberately left alone; noted in `coin.ccd.test.ts`.
- The RTP band assertion is wide (0–50 %). It catches sign and accounting bugs,
  not tuning regressions.
