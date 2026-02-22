# Heat System

Players buy coins and insert them into a shared machine. When coins fall off the front edge, value is distributed proportionally based on each player's **heat** (recent investment intensity). Side wall drops are house profit.

## Data Flow

```
Client                     Go Backend                    Game Server (TS)
──────                     ──────────                    ────────────────
batch_insert(slot, count)
         ──── WS ────►     1. Validate balance
                           2. DB: balance -= count
                           3. AddHeat(user, count)
                           4. NATS: cmd.batch_insert
                                    ──── NATS ────►     5. Enqueue(user, slot, count)
                           6. Return ack to client       7. Round-robin tick:
                                                            dequeue 1 coin → spawn
                                                            tag coin with owner_id
                                                         8. NATS: coin_spawn → client

                                                         On despawn:
                                                         9. Classify zone (front/left/right/other)
                                                        10. NATS: evt.coin_despawn

                          11. If front_edge:
                              distribute via GetShares()
                              accumulate rewards
                          12. Every 10s: flush to DB
                              NATS: reward → client

                          13. Every 1s: broadcast
                              heat_update → client
```

## Heat Formula

### Exponential Decay

Heat decays continuously. Applied lazily on read:

```
decayed = RawHeat * e^(-lambda * dt)
lambda  = ln(2) / halfLife
```

### Share Calculation

1. Compute effective heat per player (diminishing returns):
   ```
   effective = decayed ^ alpha
   ```

2. Sum all effective heat. If player count `n * guaranteed >= 1.0`, split evenly.
   Otherwise:
   ```
   share = guaranteed + (1 - n * guaranteed) * (effective / totalEffective)
   ```

3. Front-edge distribution:
   ```
   reward[player] = coinCount * share[player]
   ```
   Fractional rewards accumulate in memory, flushed to DB every 10s.

## Tunable Parameters

| Parameter | Value | Location | Effect |
|-----------|-------|----------|--------|
| `HALF_LIFE` | 180s | `heat.go`, `shared/types.ts` | How fast heat decays. Lower = more recency bias |
| `ALPHA` | 0.7 | `heat.go`, `shared/types.ts` | Diminishing returns. Lower = whales get less edge |
| `GUARANTEED_MIN` | 0.05 | `heat.go`, `shared/types.ts` | Floor share per active player. At 20+ players, reverts to even split |
| `DROP_INTERVAL_TICKS` | 2 | `shared/types.ts` | Ticks between coin drops. At 30Hz = ~15 drops/sec |
| `MAX_QUEUE` | 100 | `shared/types.ts` | Max coins queued per player |
| `FRONT_Z_THRESHOLD` | 0.55 | `SLOT_MACHINE_CONFIG.Z_MAX_THRESHOLD` | z > this = front edge (player reward) |
| `REWARD_FLUSH_INTERVAL` | 10s | `main.go` | How often accumulated rewards are written to DB |
| `BROADCAST_INTERVAL` | 1s | `main.go` | How often heat shares are broadcast to clients |

## Despawn Zones

Coins are classified when they leave the play area:

| Zone | Condition | Outcome |
|------|-----------|---------|
| `front` | `z > 0.55` | Distributed to players via heat shares |
| `left_wall` | `x < -0.5 && z < 0.55` | House profit + slot machine counter |
| `right_wall` | `x > 0.5 && z < 0.55` | House profit |
| `other` | Everything else | House profit |

## NATS Topics

| Topic | Direction | Encoding | Purpose |
|-------|-----------|----------|---------|
| `game.{room}.cmd.batch_insert` | Backend -> Game Server | JSON | `{user_id, slot_x, count}` |
| `game.{room}.evt.coin_despawn` | Game Server -> Backend | JSON | `{coins: [{id, zone, owner_id}], tick}` |
| `game.{room}.heat_update` | Backend -> Client (relay) | msgpack | `{op, players: [{user_id, share, raw_heat}]}` |
| `game.{room}.coin_spawn` | Game Server -> Client (relay) | msgpack | `{op, coins: [{id, owner_id}]}` |
| `game.{room}.queue_update` | Game Server -> Client (relay) | msgpack | `{op, user_id, pending}` |
| `game.{room}.reward` | Backend -> Client (relay) | msgpack | `{op, user_id, amount, balance}` |

## Key Design Decisions

- **Heat on commit, not on physical drop** — batch insert immediately builds heat, no gaming the queue
- **No house base heat** — physics (side wall geometry) is the only house edge
- **Ephemeral heat** — in-memory only, no DB persistence. Half-life is 3 min so state is inherently short-lived
- **Batch reward flush** — accumulate fractional rewards, write to DB every 10s to reduce writes
- **Coin highlighting** — client shows own coins in cyan for 2s via separate thin-instance mesh, then reverts to theme color
