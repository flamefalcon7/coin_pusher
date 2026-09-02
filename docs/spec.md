# Coin Pusher - Product Spec

## 1. Core Game Loop

### 1.1 What is this game?

A multiplayer online coin pusher — the arcade machine where you drop coins onto a moving platform, hoping to push other coins off the edge for rewards. This version runs in the browser with server-authoritative 3D physics, real-time multiplayer, and a crypto-based economy (USDC deposit/withdraw via multi-chain).

### 1.2 Core Experience Pillars

The game is designed around four reinforcing pillars:

| Pillar | What it feels like | What drives it |
|---|---|---|
| **Physical Satisfaction** | Watching a wall of coins cascade off the edge | Rapier 3D physics, dynamic pusher amplitude, BabylonJS rendering |
| **Multiplayer Tension** | Competing for the same falling coins in real-time | Heat-based reward distribution, shared platform |
| **Strategic Depth** | Choosing where, when, and how much to invest | Slot targeting, ability timing, batch insert sizing |
| **Economic Thrill** | The uncertainty of risk vs reward | House edge economy, slot machine jackpots, variable payout |

These aren't independent — the physical cascade creates the payout event, which triggers the competitive tension, which motivates strategic coin placement, which feeds back into bigger cascades.

### 1.3 Player Session Flow

```
Deposit USDC (multi-chain) → Receive chips (in-game balance)
    → Insert coins (spend chips)
    → Watch physics play out on shared platform
    → Coins fall off edges → Earn rewards (chips)
    → Withdraw chips as USDC
```

**House edge**: Long-term RTP < 100%. The platform takes a cut on net payouts. Players can win in the short term through skill and luck, but the math favors the house over time.

> Status: Ethereum wallet login implemented. Three-currency balance model exists (BalanceUSDC, BalancePlay, BalanceCash). Deposit indexer and withdrawal API not yet implemented — currently free-play with unlimited coins.

### 1.4 The Core Cycle (Second-by-Second)

**Drop** — Player chooses a slot (5 positions across the platform) and batch-inserts coins. Coins spawn at the top of the back wall and fall through a pin field that randomizes their landing position.

**Push** — The pusher oscillates forward and back at 0.6 Hz. Each forward stroke nudges coins toward the front edge. The more coins on the platform, the larger the pusher's amplitude (dynamic difficulty: keeps the action flowing when the board is loaded, prevents stagnation).

**Cascade** — Coins near the edge get pushed off. Due to physics stacking, a single push can trigger a chain reaction — this is the core dopamine moment. The unpredictability of which coins fall and how many is what makes each push exciting.

**Reward** — Coins that fall off the front edge are distributed to all active players proportional to their "heat" (recent investment). Side-wall exits feed the slot machine counter.

**Reinvest** — Player decides: insert more coins to maintain heat share, use an ability to trigger a bigger cascade, or wait and conserve.

### 1.5 Why the Pusher Amplitude Scales

| Coin Count | Amplitude | Effect |
|---|---|---|
| < 250 | 0.08m (base) | Normal pace, coins accumulate |
| 250–400 | 0.08m → 0.24m (smoothstep) | Increasing action as board fills |
| > 400 | 0.24m (max) | Aggressive pushing, frequent cascades |

**Design intent**: Prevents the "dead board" problem where too many coins pile up and nothing moves. As the board fills, the pusher automatically works harder, ensuring a steady flow of payoff events. This also creates a natural rhythm — the board loads up, then clears in a satisfying wave.

### 1.6 Drop Mechanics & Fairness

Players don't drop coins one at a time — they batch-insert into one of 5 slots. Each slot has an independent queue with round-robin dispatch across users.

**Why 5 fixed slots (not free-aim)?**
- Pin field is aligned with slot positions — each slot feeds a consistent physics path
- Prevents "pixel-perfect aiming" from dominating — there's still randomness from pin bounces
- Enables strategic choice: left/right slots feed side-wall exits (slot machine), center slots maximize front-edge cascades

**Why round-robin?**
- If player A queues 100 coins and player B queues 10, they alternate turns: A, B, A, B... until B runs out, then A continues. No one can flood a slot and starve others.

**Why per-slot caps (500)?**
- Prevents a single player from locking up a slot for minutes. If you hit the cap, you must wait for coins to drain before queuing more.

### 1.7 Coin Physics & Feel

Coins spawn at the top of the back wall, fall through a pin field, and land on the pusher platform.

**Pin field**: 5 rows of staggered pins on the back wall. Each pin collision applies a small random lateral impulse — this is what turns a predictable drop into a chaotic scatter. The pin layout is aligned with slot positions so each slot has a distinct but overlapping distribution of landing zones.

**Platform tilt**: 2° forward tilt. Coins naturally want to roll toward the front edge, but friction (0.7) keeps them in place until the pusher shoves them. This creates tension — coins are always "almost" falling.

**Front lip**: A small wedge (0.035m) at the front edge. Coins don't just slide off — they need enough momentum to clear the lip. This makes near-edge coins more valuable (one more push might send them over) and creates the "will it fall?" anticipation.

**Sleeping optimization**: Coins that stop moving go to sleep (no physics cost). They only wake when the pusher or another coin hits them. This allows 1000+ coins on the board without killing performance.

### 1.8 Reward Distribution (Heat System)

When coins fall off the front edge, they're not credited to whoever "pushed" them — that's impossible to attribute in a shared physics simulation. Instead, rewards are distributed based on **heat** (recent investment).

**How heat works**:
- Insert coins → gain heat
- Heat decays exponentially (half-life: 180 seconds)
- Your share = your effective heat / total effective heat
- Effective heat = raw_heat ^ 0.7 (diminishing returns)
- Every player gets at least 5% guaranteed floor

**Why this design?**

| Rule | Prevents | Enables |
|---|---|---|
| Exponential decay (180s) | AFK leeching — stop investing, your share drops to zero in ~15 min | Active play rewarded |
| Diminishing returns (α=0.7) | Whale domination — spending 10× more doesn't give 10× the share | Smaller players stay competitive |
| 5% guaranteed floor | New player gets nothing on first join | Immediate reward feedback, encourages continued play |

### 1.9 Side Exits & Slot Machine

Coins can also exit through openings in the left and right side walls.

**Left wall exits** feed a slot machine counter. Every 10 coins that exit through the left wall trigger a slot spin with 3 reels (BTC/ETH/SOL symbols).

- **Jackpot** (all 3 match): 3 winning combos out of 27 total = **1/9 probability** → 100 bonus coins rain onto the platform
- **No match**: Spin animation plays, no bonus

**Design intent**: Side exits are the "bonus game within the game." Players can strategically target left slots to feed the slot machine, but it comes at the cost of fewer front-edge cascades. The 1/9 jackpot rate with 100-coin payout creates high-variance excitement — most spins give nothing, but a jackpot floods the board and benefits everyone.

**Right wall exits** feed a jackpot wheel. Every 10 coins that exit through the right wall trigger a wheel spin with 8 segments (rewards: [1, 1, 1, 2, 1, 1, 1, 3] key coins). The wheel spins and drops **key coins** onto the platform — visually distinct, 33% larger coins that follow normal physics. When key coins fall off the front edge, they're awarded to a random active player via lucky draw and added to that player's inventory.

> Slot machine numbers (1/9, 100 coins) and wheel segment rewards are placeholder values, not yet tuned for target RTP.

---

## 2. Abilities

### 2.1 Design Philosophy

Abilities are the player's tools to **actively influence physics** instead of passively watching the pusher work. They serve three purposes:

1. **Agency** — Without abilities, the game is "insert coin and wait." Abilities give the player meaningful decisions every few seconds.
2. **Spectacle** — Tornado, lightning, explosions create visual drama. Even when they don't optimize rewards, they're fun to watch and feel powerful.
3. **Strategic tradeoffs** — Each ability has different strengths. Choosing the right one at the right time separates skilled players from random button-mashers.

All abilities are **server-authoritative** — the client sends a request, the Go backend validates cooldowns and consumes a scroll charge, then forwards the command to the game server which executes the physics. No client-side prediction for abilities.

### 2.2 Ability Roster

#### Shock — The Bread and Butter

| | |
|---|---|
| **Cooldown** | 2 seconds |
| **Effect** | Instant — wakes all coins stuck in the pin zone and nudges them forward |
| **Target** | Automatic (pin zone near back wall) |
| **Radius** | ~25cm from back wall, pin Y-range |

**What it does**: Coins that get stuck between pins stop contributing to cascades. Shock dislodges them with a small forward + random lateral impulse, feeding them back into the pusher zone.

**When to use**: Whenever you see coins piling up on the back wall. At 2s cooldown, this is meant to be spammed — it's the "basic attack" of the ability kit.

**Strategic role**: Maintenance. Keeps coins flowing from back wall → pusher zone → front edge. Without shock, a significant portion of dropped coins would get stuck and never pay out.

#### Tornado — Area Control

| | |
|---|---|
| **Cooldown** | 10 seconds |
| **Duration** | 4 seconds (0.5s ramp up, 3s full, 0.5s ramp down) |
| **Effect** | Swirling vortex that pulls coins inward + upward + rotates them |
| **Target** | Player-aimed (x, z position) |
| **Radius** | 0.4m |

**What it does**: Creates a sustained vortex at a chosen location. Coins within range get pulled toward the center with centripetal force, spun tangentially, and lifted (capped at 0.9m to stay on-screen). When the tornado fades, coins scatter outward from the gathered cluster.

**When to use**:
- **Gather-and-drop**: Place tornado at a coin-dense area to gather coins, then let them scatter toward the front edge when it ends
- **Feed side walls**: Aim tornado near a side wall opening to funnel coins through for slot machine triggers
- **Disruption**: In competitive play, disrupt an opponent's carefully placed coin stack

**Strategic role**: The most tactical ability. Position matters — a well-placed tornado can redirect 20+ coins toward the front edge. A poorly placed one wastes its 10s cooldown on empty space.

#### Explosion — Burst Clear

| | |
|---|---|
| **Cooldown** | 8 seconds |
| **Effect** | Instant — blasts coins outward + upward from center with quadratic falloff |
| **Target** | Player-aimed (x, z position) |
| **Radius** | 0.6m |

**What it does**: One-shot radial blast. Coins at the center get hit hardest (quadratic falloff: center = full force, edge = almost none). Adds random torque for visual tumbling. No sustained effect — it's a single impulse.

**When to use**:
- **Edge clear**: Aim at a dense cluster near the front lip to blast coins over the edge
- **Unstick**: Break up a stubborn coin pile that shock can't reach
- **Combo**: Use after tornado gathers coins into a tight cluster, then explode the cluster toward the edge

**Strategic role**: High-impact, instant payoff. The largest radius (0.6m) makes it forgiving to aim, but the quadratic falloff means only coins near the center get significant force. Best for converting a dense cluster into immediate front-edge drops.

#### Lightning — Chaos Rain

| | |
|---|---|
| **Cooldown** | 6 seconds |
| **Duration** | 3 seconds (~22 random strikes) |
| **Effect** | Repeated mini-explosions at random positions across the platform |
| **Target** | Automatic (random positions within platform bounds) |
| **Radius** | 0.35m per strike |

**What it does**: Every ~133ms, a lightning bolt strikes a random position on the platform (anywhere from pusher back edge to platform front edge, respecting flare width). Each strike is a mini-explosion with 0.35m radius — same physics as explosion but smaller and weaker. Over 3 seconds, ~22 strikes cover the board with chaotic energy.

**When to use**:
- **Board-wide activation**: When coins are spread across the entire platform and no single ability target is optimal
- **Entertainment**: The most visually dramatic ability — good for "just want to see things happen"
- **Hail mary**: When you can't see a clear strategic play, lightning's randomness might find value you missed

**Strategic role**: The "shotgun" ability. Low precision, high coverage. It won't optimize a specific cluster like tornado+explosion, but it activates sleeping coins across the entire board. Best when the board state is diffuse rather than clustered.

#### Super Push — The Slam

| | |
|---|---|
| **Cooldown** | 12 seconds |
| **Effect** | Pusher performs a dramatic pull-back → explosive forward thrust → hold → recovery |
| **Target** | Automatic (pusher) |
| **Duration** | 1.7 seconds total |

**Phase breakdown**:

| Phase | Duration | Motion | Easing |
|---|---|---|---|
| Pullback | 400ms | Current → -0.05m (pull back) | easeInCubic (slow start, fast end) |
| Thrust | 350ms | -0.05m → 0.6m (slam forward) | easeOutExpo (explosive start, smooth stop) |
| Hold | 250ms | Stay at 0.6m | Linear |
| Recovery | 700ms | 0.6m → resume normal oscillation | easeInOutQuad (smooth both ends) |

**What it does**: The pusher pulls back dramatically, then slams forward to z=0.6m — far beyond its normal oscillation range (max 0.24m amplitude). This pushes the entire front half of the board forward in one massive stroke.

**When to use**:
- **Board loaded**: Maximum value when there are many coins near the front edge — the slam pushes them all over at once, creating the biggest cascade possible
- **Combo finisher**: Use after tornado gathers coins to the front, then slam to finish

**Strategic role**: The "ultimate." Longest cooldown (12s), biggest single-event impact. The pullback phase is intentional — it briefly creates a gap that can let some coins settle, building anticipation before the slam. This is the ability most likely to generate the satisfying "coin avalanche" moment.

### 2.3 Ability Economy & Cooldown Design

| Ability | Cooldown | Fires per minute | Role |
|---|---|---|---|
| Shock | 2s | 30 | Maintenance — always available |
| Lightning | 6s | 10 | Filler — use between big cooldowns |
| Explosion | 8s | 7.5 | Tactical burst |
| Tornado | 10s | 6 | Setup / positioning |
| Super Push | 12s | 5 | Ultimate — plan around it |

**Cooldown progression** is intentional: low-impact abilities cycle fast, high-impact abilities cycle slow. This creates a natural rhythm:

```
[shock] [shock] [shock] [lightning] [shock] [shock] [explosion] [shock] [shock] [tornado] ....... [SUPER PUSH]
```

The player always has *something* to press (shock is almost always ready), but the powerful abilities require timing and planning.

### 2.4 Emergent Combos

Abilities are not designed with explicit combo chains in mind. However, because they operate on real physics, players naturally discover effective sequences through play:

- Tornado gathers coins → explosion scatters the cluster toward the edge
- Shock feeds coins off the back wall → tornado or super push clears them
- Lightning wakes sleeping coins across the board → super push clears the front

These emerge from physics interactions, not from coded combo bonuses. Whether to encourage or reward these patterns is an open design question.

### 2.5 Ability Activation: Scroll System

Every ability requires a **scroll charge** to activate. Scrolls are ability-specific tokens stored in the player's inventory. When a player fires an ability, the backend consumes one scroll of the matching type — if none are available, the ability is rejected and the client receives an `ability_error` message.

**Scroll types**: `shock`, `tornado`, `explosion`, `lightning`, `super_push`

**How scrolls are earned**:

1. **Jackpot wheel** (right wall) drops **key coins** onto the platform
2. Key coins follow normal physics — they can be pushed, stacked, etc.
3. When a key coin falls off the front edge, it's awarded to a random active player via lucky draw
4. Players spend key coins to **open chests** (1 key coin = 1 chest)
5. Each chest awards 1 scroll via weighted random roll:

| Scroll | Weight | Probability |
|---|---|---|
| Shock | 30 | 30% |
| Tornado | 20 | 20% |
| Explosion | 20 | 20% |
| Lightning | 20 | 20% |
| Super Push | 10 | 10% |

**Design intent**: This changes abilities from "free cooldown buttons" to a **resource earned through play**. Strategic implications:

- Abilities are scarce — you can't spam shock every 2 seconds unless you've collected enough scrolls
- Key coins on the platform create targeting decisions — do you aim for regular coins (immediate reward) or push key coins off the edge (future ability power)?
- Chest opens add another layer of variable reward (which scroll did I get? will I get the rare super push?)
- Players who invest in pushing key coins off the edge are rewarded with more tools to create bigger cascades

**Full loop**:
```
Right wall exit → wheel drops key coins onto platform
    → push key coins off front edge → lucky draw awards key coins to a player
    → spend key coins to open chest → receive scroll charge
    → use scroll to activate ability → trigger cascades → more coins fall off → more rewards
```

**Client UI**: Ability buttons show a scroll count badge and are disabled when count reaches 0. Inventory updates are pushed in real-time via WebSocket after every scroll consumption or chest open.

---

## 3. Economy & RTP

### 3.1 Economic Model Overview

```
Real money (USDC)          In-game economy                    Real money (USDC)
─────────────────     ────────────────────────────────     ─────────────────────
                      ┌─────────┐
Deposit (multi-chain) │ Deposit │ ← spent inserting coins (not withdrawable;
        ──────────────│ Chips   │    consumed first during play-first draw)
                      └────┬────┘
                           │ insert coins
                           ▼
                      ┌─────────┐
                      │ Physics │ ← coins + key coins on platform
                      │Platform │
                      └────┬────┘
                   ┌───────┼───────┐
                   ▼       ▼       ▼
                 Front    Left   Right    Other
                 Edge     Wall   Wall     (lost)
                   │       │       │
                   ▼       │       ▼
                ┌──────┐   │   ┌────────┐
                │Reward│   │   │Jackpot │ ← drops key coins onto platform
                │Chips │   │   │ Wheel  │
                └──┬───┘   │   └────────┘
                   │       ▼
                   │    ┌──────┐
                   │    │ Slot │ ← jackpot returns 100 coins to platform
                   │    │Machine│
                   │    └──────┘
                   ▼
             Withdraw as USDC
```

### 3.2 Two-Chip System (Unified Wallet)

| Chip Type | Source | Can Insert | Can Withdraw |
|---|---|---|---|
| **Deposit Chips** (`balance_play`) | USDC deposit | Yes | No |
| **Reward Chips** (`balance_cash`) | Front-edge coin drops, progress rewards, chest rewards | Yes (play-first draw) | Yes |

**Unified wallet UI.** The client displays a single `Balance` total (sum of both chips) with a `Withdrawable` sub-indicator showing the reward-chip portion. Internally the two balances remain distinct for accounting integrity.

**Play-first draw order.** An insert debits `balance_play` first; only once it is exhausted does the insert draw from `balance_cash`. This protects the user's withdrawable balance from being silently consumed when they have deposit chips available, and makes the economic model intuitive: "my bought-in coins get spent before my winnings."

**Why separate the two types?**
- Prevents instant deposit → withdraw arbitrage — the withdraw endpoint only accepts `balance_cash`.
- Players must actually play (push coins through physics) to generate withdrawable value.
- House edge is enforced by physics: not all deposited coins make it to the front edge.

**Compounding.** Reward chips can be re-invested (inserted back into the game) once deposit chips are exhausted. A lucky streak can sustain play without additional deposits, which keeps players engaged longer. The house edge still applies on every cycle through the physics, so compounding doesn't break the math.

**Ledger integrity.** Every insert writes one ledger entry per currency actually debited (one `GAME_INSERT` row for PLAY + one for CASH when split), all sharing the same `reference_id` so the split is auditable. Refunds mirror the split exactly and are idempotent by deterministic `<insert-ref>:refund` key.

**Retry contract (for automated clients):**
- `POST /v1/game/batch-insert` (and the WS `batch_insert` op) is **not** idempotent on its own — each call generates a fresh `reference_id` server-side. Clients must not auto-retry a 2xx-but-network-failed insert, because the server may have both debited and successfully published the insert to the physics layer. A retry would double-debit.
- When the server returns a 5xx **specifically from NATS publish failure**, the server self-heals by issuing the refund before returning the error. Callers can treat the 5xx as "insert did not happen, funds are not consumed" for this specific failure mode.
- **Refund is idempotent.** `ProcessGameInsertRefund` is keyed on the deterministic `<insert-ref>:refund` correlation ID and guarded by a `QueryByReference` check inside the tx (same pattern as deposit idempotency, `docs/security-audit.md` P0-8). A replay silently returns the current post-refund balances with no additional ledger writes. This means any retry loop *internal to the server* (not a client retry) is safe.

### 3.3 Where the House Edge Lives

The house edge is **embedded in the physics itself**, not as an explicit fee or tax:

1. **Front edge drops** → distributed as rewards to players (this is the player's return)
2. **Side wall drops** → platform revenue (not returned to players)
3. **Other drops** (bottom, stuck, etc.) → lost (neither player nor platform)

The ratio of front-edge drops to total drops determines the base RTP. This ratio is controlled by:

- Platform geometry (tilt angle, lip height, wall opening size)
- Pusher amplitude and frequency
- Coin physics (friction, restitution, mass)
- Pin field layout (scatter pattern)

**Key insight**: The house doesn't "take" money — coins physically exit through side walls instead of the front edge. This feels fair to the player because they can see it happening. It's the same mechanic as a real arcade coin pusher.

### 3.4 RTP Variables

RTP is not a single fixed number. It's a complex function of multiple interacting systems:

| Variable | Effect on RTP | Direction |
|---|---|---|
| **Platform tilt** | Steeper = more coins reach front edge | ↑ RTP |
| **Front lip height** | Higher = harder to push coins over | ↓ RTP |
| **Side wall opening size** | Larger = more coins exit to house | ↓ RTP |
| **Pusher amplitude** | Larger = more aggressive pushing | ↑ RTP |
| **Coin friction** | Higher = coins stick, need more pushes | ↓ RTP |
| **Pin field scatter** | More scatter = more side wall hits | ↓ RTP |
| **Abilities** | More abilities = more coins pushed off | ↑ RTP |
| **Slot machine** | Jackpot returns coins to platform | ↑ RTP |
| **Scroll system** | Ability scarcity = fewer forced cascades | ↓ RTP |

### 3.5 RTP Calibration Strategy

RTP is not designed analytically — it's **measured empirically** through simulation:

1. **Local Monte Carlo simulation**: Run headless physics simulation with automated coin insertion, measure front-edge drops / total drops over millions of iterations
2. **Parameter tuning**: Adjust physics parameters (tilt, lip, friction, openings) until simulated RTP hits target range
3. **Production monitoring**: Track live RTP in real-time, alert if it deviates from target
4. **Guardrails** (planned): Dynamic parameter adjustment when live RTP deviates from target. Which parameters to adjust is an open design question — candidates include pusher amplitude, side wall opening size, coin friction, or slot machine payout. The choice affects player experience (some knobs are more noticeable to players than others)

> Status: Monte Carlo simulation infrastructure exists (`game/server/src/simulation/`). Target RTP range not yet defined — requires simulation runs to understand the parameter space before setting a target.

**Why not analytical RTP?**
- The physics simulation is chaotic — small changes in coin placement create vastly different outcomes
- Abilities introduce high-variance events that are hard to model analytically
- Slot machine jackpots are rare but high-impact (100 coins)
- Player behavior (where they drop, when they use abilities) is unpredictable
- Empirical measurement is the only reliable approach for a physics-based system

### 3.6 Revenue Flows

```
Player deposits USDC
    → Platform holds deposit
    → Player inserts coins (deposit chips consumed)
    → Physics plays out
    → Front edge: reward chips created (player can withdraw)
    → Left wall: slot machine trigger (jackpot recycles 100 coins to platform)
    → Right wall: jackpot wheel trigger (drops key coins → scroll economy)
    → Player withdraws reward chips as USDC
    → Platform pays out from deposit pool

Net platform revenue = total deposits - total withdrawals
```

### 3.7 Slot Machine Economics

The slot machine is a **secondary reward loop** that recycles coins back onto the platform:

- **Input**: 10 coins exit through left wall (these are already "house revenue")
- **Output**: On jackpot, 100 coins rain onto the platform
- **Jackpot**: 3 reels × 3 symbols (BTC/ETH/SOL). All 3 must match. 3 winning combos out of 27 total = **1/9 probability**
- **Expected value per trigger**: 100 × (1/9) ≈ 11.1 coins returned to platform

The slot machine returns more coins than it consumes per trigger (~111%), but those recycled coins re-enter the physics simulation where the house edge applies again. A portion will exit through side walls (house revenue), so the effective return is lower than 111%. The slot machine's net effect on RTP depends on the base front-edge-to-side-wall ratio of the physics simulation.

### 3.7b Jackpot Wheel Economics

The jackpot wheel is a **key coin generator** that feeds the scroll economy:

- **Input**: 10 coins exit through right wall (these are already "house revenue")
- **Output**: Wheel spins, awards key coins (1-3 per spin depending on segment)
- **Segments**: 8 segments with rewards [1, 1, 1, 2, 1, 1, 1, 3]
- **Expected value per trigger**: (5×1 + 1×2 + 1×1 + 1×3) / 8 = **1.375 key coins**

Key coins are not regular coins — they don't contribute to chip-based RTP directly. Instead, they feed the scroll economy (key coin → chest → scroll → ability use). The wheel's net effect on gameplay is indirect: more key coins → more abilities available → more coins pushed off edges → higher effective RTP.

> Numbers are placeholder. Trigger threshold (10), segment count (8), and segment rewards are all tunable parameters.

### 3.8 Scroll & Chest Economics

The scroll system adds an economic layer on top of the base coin economy:

- **Key coins** have no direct cash value — they're a **utility token** within the game
- **Chests** convert key coins into scroll charges (1 key coin = 1 chest = 1 scroll)
- **Scrolls** enable abilities, which influence RTP (more abilities = more coins pushed off = higher return)
- This creates an indirect economic loop: more key coins → more chests → more scrolls → more abilities → bigger cascades → higher personal RTP

The key coin spawn rate is controlled by the jackpot wheel (right wall trigger count and segment rewards). Tuning these parameters adjusts how many scrolls enter the economy per unit time, which directly impacts ability frequency and therefore RTP.

> The scroll system's impact on overall RTP should be factored into Monte Carlo simulations. Current simulation infrastructure exists at `game/server/src/simulation/` but does not yet model scroll-gated abilities.

---

## 4. Multiplayer & Social

### 4.1 Core Social Dynamic: Cooperative Competition

The game creates a paradox: **players must cooperate to generate value, but compete to capture it.**

- **Cooperation**: The more coins everyone inserts, the more loaded the board gets, the bigger the cascades. A single player on an empty board gets small, boring drops. A crowded board with 500+ coins creates satisfying avalanches. Players benefit from each other's investment.
- **Competition**: When those cascades happen, rewards are split by heat share. You want the biggest possible cascade (requires everyone investing), but you also want the largest possible slice (requires you investing more than others).

This is a **positive-sum game in the short term** (more players = more action) with a **zero-sum reward split** (your gain is someone else's loss of share). The tension between these two forces is the social engine.

### 4.2 The Heat Arms Race

The heat system creates an implicit social pressure:

```
You invest 50 coins → your heat share is 60%
Another player joins and invests 30 coins → your share drops to 45%
You invest 20 more to stay ahead → your share recovers to 55%
But now there are 100 coins on the board → bigger cascades incoming
```

**Nobody explicitly competes** — there's no "attack" or PvP mechanic. The competition is purely economic: who has the higher heat share when coins fall. This makes the game feel social without feeling hostile.

**The decay creates urgency**: If you stop investing, your share decays to zero in ~15 minutes. You can't "coast" on an early lead. Active play is always rewarded, and leaving the game means giving up your share to remaining players.

### 4.3 Room System

**Single lobby**: All players share one room and one physics platform. There is no matchmaking, room creation, or player caps.

**Why single lobby?**
- Maximizes coin density on the board → bigger cascades → more exciting gameplay
- Creates a persistent "world" that players drop into and out of
- Simpler architecture — one game server instance, one physics simulation
- The heat system naturally handles player scaling (more players = each gets smaller share, but bigger total pool)

**Scaling considerations**: If player count exceeds what a single physics simulation can handle (CPU-bound on Rapier WASM), future options include:
- Multiple lobbies with different minimum bet sizes (whale room vs casual room)
- Geographic lobbies (Asia, US, EU) for latency
- Themed lobbies with different physics parameters or ability sets

> Current implementation: Single room named "main". The NATS topic scheme (`game.{room}.*`) already supports multiple rooms at the protocol level.

### 4.4 What Players See of Each Other

Players share a platform but have limited visibility into each other's actions:

| Visible | Not Visible |
|---|---|
| All coins on the platform (physics state) | Who dropped which coin |
| Ability effects (tornado, explosion, etc.) | Who activated which ability |
| Heat shares (broadcast 1Hz to all clients) | Other players' exact chip balance |
| Slot machine spins (broadcast to all) | Other players' deposit/withdraw history |
| Coin drops from all slots | Which user is queued in which slot |

**Design intent**: Players feel each other's presence through the shared physics (coins appearing, abilities firing, board state changing) without needing avatars, chat, or explicit social features. The game is "social through physics."

### 4.5 Implicit Social Signals

Even without direct communication, players broadcast intent through their actions:

- **Heavy investment in left slot** → this player is farming the slot machine
- **Rapid batch inserts** → someone is going aggressive, expect heat competition
- **Tornado near the front edge** → someone is trying to trigger a cascade, maybe ride the wave
- **Long pause in drops** → a player might be leaving, your heat share will grow

Skilled players read these signals and adjust their strategy. This creates a "metagame" layer that doesn't require chat or explicit social features.

### 4.6 The Free Rider Problem

The cooperative-competitive tension creates a potential free rider issue:

**Scenario**: A player inserts 1 coin, gets the 5% guaranteed floor, and waits for other players' coins to cascade. They earn rewards without meaningful investment.

**How heat addresses this**:
- 5% floor is small — in a room with 5+ active players, the floor player gets minimal rewards
- The guaranteed floor exists for **onboarding** (new player gets immediate feedback), not as a viable strategy
- Diminishing returns (α=0.7) makes moderate investment competitive against whale spending, but the floor (near-zero investment) is not competitive at all
- The decay means even the floor share requires periodic re-investment to maintain

**Known vulnerability: multi-account abuse**. A player can open multiple accounts to claim multiple 5% guaranteed floors. With 10 accounts, that's 50% of rewards captured with near-zero investment per account. The guaranteed floor mechanism needs hardening — possible mitigations include:

- Minimum investment threshold before floor kicks in
- Floor only activates after N coins inserted in the session
- Anti-sybil measures (wallet linkage detection, IP/device fingerprinting)
- Replace fixed floor with a dynamic minimum (e.g., floor = f(active player count))

> This is an open problem. The current 5% fixed floor is a placeholder for onboarding UX and will need revision before real-money play.

### 4.7 Megaspeaker — Broadcast Chat

Players can spend a **megaspeaker charge** to broadcast a text message to all players in the room. Messages appear in a collapsible message panel that holds the most recent 50 messages.

#### How Megaspeaker Charges Are Earned

Megaspeaker charges are obtained from chests, alongside scrolls. The chest loot table becomes:

| Item | Weight | Probability |
|---|---|---|
| Shock scroll | 30 | ~26.1% |
| Tornado scroll | 20 | ~17.4% |
| Explosion scroll | 20 | ~17.4% |
| Lightning scroll | 20 | ~17.4% |
| Super Push scroll | 10 | ~8.7% |
| **Megaspeaker** | **15** | **~13.0%** |

(Total weight: 115. Megaspeaker weight is tunable.)

**Cost**: 1 charge per broadcast.

#### Message Rules

| Rule | Value |
|---|---|
| Max length | 150 UTF-8 characters (e.g. 150 Chinese characters, 150 ASCII, or any mix) |
| Min content | At least 1 non-whitespace character |
| Emoji | Allowed |
| Profanity filter | Client-side only — matched words replaced with `***` (loose matching) |

#### Message Data

Each broadcast message contains:

| Field | Type | Description |
|---|---|---|
| `speaker_name` | string | Display name (or truncated wallet address if no custom name) |
| `message` | string | Raw text content (unfiltered — client applies filter on render) |
| `timestamp` | number | Server Unix timestamp (milliseconds) |

#### Scope

- **Room-level**: Broadcast reaches all players in the current room only
- Currently single room (`"main"`), single-instance only (direct hub broadcast, no NATS relay)

#### Storage

- **In-memory ring buffer** (50 messages) maintained by the relay/hub on the backend
- No database persistence — messages are lost on server restart
- New or reconnecting players receive the full buffer on WebSocket connect (as individual `megaspeaker` messages)

#### Data Flow

**Sending a message**:
```
Client → WS send { op: "megaspeaker", message: string }
    → Relay: validate message (1–150 runes, non-whitespace), check megaspeaker charge ≥ 1
    → Deduct 1 megaspeaker charge from inventory
    → Resolve display_name (fallback: user_id[:8] + "...")
    → hub.AddMegaspeakerMsg() (ring buffer) + hub.Broadcast() to all WS clients
    → Each client appends to local message list, plays sound effect
    → Relay sends inventory_update to sender (updated megaspeaker count)
```

**Receiving history on connect**:
```
Player connects → WebSocket handshake completes
    → Relay sends each buffered megaspeaker message individually (up to 50)
    → Client appends to message panel
```

#### Client UI

| Aspect | Behavior |
|---|---|
| Panel position | Bottom-right (or side), overlaying game canvas |
| Default state | **Collapsed** — only shows a megaspeaker icon with unread count badge |
| Expanded state | Scrollable list of up to 50 messages, newest at bottom |
| Message format | `[username] message content` with relative timestamp (e.g. "剛剛", "3分鐘前", "1小時前") |
| Send UI | Text input + send button, visible only when expanded and player has ≥ 1 charge |
| Charge display | Badge on send button showing remaining charges |
| Sound effect | Short notification sound on new message received |
| Visual effect | None (no animation or particle effects) |

#### Inventory Integration

The `inventory_update` WebSocket message adds a new field:

| Field | Type | Description |
|---|---|---|
| `megaspeaker` | number | Remaining megaspeaker charges |

Chest open result can now return `"megaspeaker"` as the item type (in addition to existing scroll types).

#### Design Notes

- **No cooldown**: Players can send messages as fast as the API allows. If rapid spam becomes a problem, consider adding a 2–3 second minimum interval server-side.
- **Client-side profanity filter only**: Raw messages are stored and broadcast. Malicious clients (modified JS) can bypass the filter. Server-side filtering can be added later if abuse occurs.
- **No message editing or deletion**: Once sent, messages are immutable. Admin tools for message moderation are out of scope for v1.
- **Sound can be muted**: Client should respect a mute/volume setting (shared with other game sounds).

---

## 5. Planned Features (TODO)

### 5.1 Multi-Chain Deposit System

> Depends on: Backend wallet infrastructure

Players need a blockchain address to deposit USDC. The onboarding flow:

1. Player registers → backend generates and assigns a **Base chain address** to the player
2. Player sends USDC to their assigned address
3. Backend indexer detects the deposit → credits deposit chips to player balance
4. Player can now insert coins in the game

**Phase 1**: Base chain only (EVM, low fees, Coinbase ecosystem)

**Future expansion**: Support additional chains:
- ~~**SUI**~~ — dropped; backend now targets Base (EVM) via `foundation/ethereum/` + `foundation/ethrpc/`
- **Solana** — high throughput, large crypto-gaming audience
- Additional EVM chains as needed

**Per-chain implementation**:
- Each chain needs: address generation, deposit indexer, withdrawal signer
- Player can have multiple deposit addresses (one per chain), all feeding the same chip balance
- Withdrawal chain selected by player at withdrawal time

> Open questions: Custodial vs MPC wallet? Minimum deposit amount? Deposit confirmation time per chain? Withdrawal fee structure?

### 5.2 Referral System

> Depends on: User registration (5.1)

Every player gets a unique **referral code** on registration. When a new player signs up using a referral code:

- **Referrer** receives a reward (bonus chips, loot coins, or progress points — TBD)
- **Referee** may receive a welcome bonus (TBD)

Referral tracking:
- Store referrer → referee relationship in backend
- Track referee's lifetime activity for ongoing referral rewards (if applicable)

> Open questions: Reward structure (one-time vs ongoing rev-share?), referral code format (random vs custom — see 5.3), anti-abuse (self-referral, referral farming)?

### 5.3 Progress System

> Depends on: Deposit tracking, referral system (5.2)

A progression track that rewards cumulative engagement:

**Progress sources**:
- Total USDC deposited (lifetime)
- Number of successful referrals

**Milestone rewards** (unlock at thresholds):

| Milestone | Example Threshold | Reward |
|---|---|---|
| Custom username | Deposit $50 or 3 referrals | Replace anonymous ID with chosen name |
| Custom referral code | Deposit $100 or 5 referrals | Replace random code with personalized one |
| ... | ... | Additional tiers TBD |

**Design intent**: Gives players long-term goals beyond individual sessions. The custom username/referral code rewards are social — they create identity and make referrals more personal ("use code ALICE" vs "use code X7K9M2").

> Open questions: Full milestone table, can progress be lost (decay/reset)?, visual indicators (badges, borders, profile flair)?, leaderboard integration with heat system?

---

## 6. Infrastructure TODO

### 6.1 Deployment Optimization ✅

**Done.** Two-machine architecture with separate CI/CD and graceful drain. See `docs/DEPLOYMENT.md` for full details.

1. ~~**GitHub Actions CI/CD**~~ — `deploy-services.yml` and `deploy-game.yml`, path-filtered, with migration and health check.
2. ~~**Split to two machines**~~ — Game server on dedicated droplet; Services (Backend, PostgreSQL, NATS, Nginx, Executor, Indexer) on another. NATS over VPC (no auth for now).
3. ~~**Game server graceful drain**~~ — SIGTERM → unsubscribe commands → cancel abilities → drain DropScheduler queue → wait for coins to settle (60s timeout) → exit. Docker `stop_grace_period: 90s`.

### 6.2 Monitoring

**Current state**: No monitoring. Server goes down = nobody knows until a player complains.

**Planned improvements**:

1. **Uptime monitoring (phase 1)** — External service (e.g. Betterstack free tier) pings health endpoint every 30s, alerts on downtime via Slack/email
2. **Prometheus + Grafana (phase 2)** — Self-hosted on services machine (~500MB RAM). Backend exposes `/metrics` on debug port 4010. Key metrics: HTTP request rate/latency, DB connection pool, WebSocket connection count, NATS message throughput, indexer block lag
3. **Log aggregation (phase 3)** — Loki + Promtail for centralized container log search and alerting
